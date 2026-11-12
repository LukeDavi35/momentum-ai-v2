import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { classifyLicense } from "./licenses.js";
import type { FootageClip, FootageContext, FootageProvider } from "./types.js";

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

async function getJson(ctx: FootageContext, url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await ctx.fetchImpl(url, { headers: { "User-Agent": ctx.userAgent, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- Pexels (free key; the Pexels licence allows free commercial use and editing)

/** Pexels offers several renditions per video. We want one that is HD at most (small download, plenty for a 1080-wide frame). */
export function pickPexelsFile(files: any[]): { link: string; width: number; height: number } | null {
  const usable = (files ?? [])
    .filter((f) => f?.file_type === "video/mp4" && typeof f.link === "string" && f.width && f.height && f.width * f.height <= 1920 * 1080 && Math.min(f.width, f.height) >= 540)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const f = usable[0];
  return f ? { link: f.link, width: f.width, height: f.height } : null;
}

export const pexelsProvider: FootageProvider = {
  id: "pexels",
  async search(query, ctx) {
    if (!ctx.pexelsKey) return [];
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=15`;
    const j = await getJson(ctx, url, { Authorization: ctx.pexelsKey });
    const out: FootageClip[] = [];
    for (const v of j.videos ?? []) {
      const file = pickPexelsFile(v.video_files);
      if (!file || !(v.duration > 0)) continue;
      out.push({
        provider: "pexels",
        externalId: String(v.id),
        title: stripTags(String(v.url ?? "").split("/").filter(Boolean).pop()?.replace(/-/g, " ") ?? `Pexels video ${v.id}`),
        pageUrl: String(v.url ?? ""),
        downloadUrl: file.link,
        license: "pexels",
        licenseLabel: "Pexels License",
        author: String(v.user?.name ?? "Pexels contributor"),
        attributionRequired: false,
        durationS: Number(v.duration),
        width: file.width,
        height: file.height,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- Wikimedia Commons (no key; every file states its licence)

export function parseCommons(json: any): FootageClip[] {
  const out: FootageClip[] = [];
  for (const page of Object.values<any>(json?.query?.pages ?? {})) {
    const info = page?.imageinfo?.[0];
    if (!info?.url || !/^video\/(webm|ogg|mp4)/.test(String(info.mime ?? ""))) continue;
    const meta = info.extmetadata ?? {};
    const label = stripTags(String(meta.LicenseShortName?.value ?? ""));
    const verdict = classifyLicense(label);
    if (!verdict) continue; // unknown / NC / ND / SA: never a candidate
    out.push({
      provider: "commons",
      externalId: String(page.pageid),
      title: String(page.title ?? "").replace(/^File:/, "").replace(/\.\w+$/, ""),
      pageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/?curid=${page.pageid}`,
      downloadUrl: info.url,
      license: verdict.id,
      licenseLabel: label,
      author: stripTags(String(meta.Artist?.value ?? "")).slice(0, 80) || "Wikimedia Commons contributor",
      attributionRequired: verdict.attributionRequired,
      durationS: Number(info.duration ?? 0),
      width: Number(info.width ?? 0),
      height: Number(info.height ?? 0),
    });
  }
  return out;
}

export const commonsProvider: FootageProvider = {
  id: "commons",
  async search(query, ctx) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      generator: "search",
      gsrsearch: `${query} filetype:video`,
      gsrnamespace: "6",
      gsrlimit: "12",
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      origin: "*",
    });
    return parseCommons(await getJson(ctx, `https://commons.wikimedia.org/w/api.php?${params}`));
  },
};

// ---------------------------------------------------------------- the owner's own library (footage they shot or hold a licence for)

const librarySchema = z.object({
  clips: z.array(
    z.object({
      file: z.string().min(1),
      title: z.string().default(""),
      tags: z.array(z.string()).default([]),
      /** "owned" / "licensed" for footage you shot or paid for, or any accepted licence label (e.g. "CC0", "CC BY 4.0"). */
      license: z.string(),
      author: z.string().default("Momentum"),
      source: z.string().default(""),
    }),
  ),
});

export const libraryDir = (dataDir: string): string => join(dataDir, "footage");

/**
 * `<DATA_DIR>/footage/library.json`: footage you are entitled to use (your own, or licensed to you). This is the ONLY way
 * real match highlights can enter a compilation, and it is on you to hold the rights: the file is checked for a licence
 * label from the accepted list, not for whether the label is true.
 */
export const libraryProvider: FootageProvider = {
  id: "library",
  async search(query, ctx) {
    const dir = libraryDir(ctx.dataDir);
    const manifest = join(dir, "library.json");
    if (!existsSync(manifest)) return [];
    const parsed = librarySchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const out: Array<FootageClip & { score: number }> = [];
    for (const c of parsed.clips) {
      const verdict = classifyLicense(c.license);
      if (!verdict) continue;
      const path = isAbsolute(c.file) ? c.file : resolve(dir, c.file);
      if (!existsSync(path)) continue;
      const hay = `${c.title} ${c.tags.join(" ")}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length;
      if (score === 0) continue;
      out.push({
        provider: "library",
        externalId: c.file,
        title: c.title || c.file,
        pageUrl: c.source,
        downloadUrl: null,
        localPath: path,
        license: verdict.id,
        licenseLabel: c.license,
        author: c.author,
        attributionRequired: verdict.attributionRequired,
        durationS: 0, // probed after selection
        width: 0,
        height: 0,
        score,
      });
    }
    return out.sort((a, b) => b.score - a.score).map(({ score: _s, ...clip }) => clip);
  },
};

export const PROVIDERS: Record<string, FootageProvider> = { library: libraryProvider, pexels: pexelsProvider, commons: commonsProvider };
