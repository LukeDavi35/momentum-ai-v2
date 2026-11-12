import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppConfig } from "../config/index.js";
import type { Db } from "../db/db.js";
import type { Logger } from "../logger.js";
import { probe, run, type Runner } from "../media/exec.js";
import { PROVIDERS } from "./providers.js";
import { recentlyUsed } from "./store.js";
import { clipKey, type FootageClip, type FootageContext, type FootageRef } from "./types.js";

export const MAX_DOWNLOAD_MB = 80;
export const USER_AGENT = "momentum-ai-v2/2.0 (sports video automation; contact: see repository)";

export interface FootageDeps {
  cfg: AppConfig;
  db: Db;
  log: Logger;
  fetchImpl?: typeof fetch;
  runner?: Runner;
  now: () => Date;
}

export const creditLine = (c: Pick<FootageClip, "provider" | "author" | "licenseLabel" | "license">): string => {
  const who = c.provider === "pexels" ? `${c.author} / Pexels` : c.provider === "commons" ? `${c.author} / Wikimedia Commons, ${c.licenseLabel}` : c.author;
  return `Footage: ${who}`.slice(0, 120);
};

/** Streams a clip to the cache. Refuses anything over the size cap or that isn't served as video. Returns the local path. */
export async function downloadClip(clip: FootageClip, cacheDir: string, fetchImpl: typeof fetch, maxMb = MAX_DOWNLOAD_MB): Promise<string> {
  if (!clip.downloadUrl) throw new Error("clip has no download URL");
  mkdirSync(cacheDir, { recursive: true });
  const ext = extname(new URL(clip.downloadUrl).pathname) || ".mp4";
  const safeId = clip.externalId.replace(/[^\w.-]+/g, "_").slice(0, 60);
  const dest = join(cacheDir, `${clip.provider}-${safeId}${ext}`);
  if (existsSync(dest) && statSync(dest).size > 0) return dest; // cache hit

  const res = await fetchImpl(clip.downloadUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`download responded ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/^(video\/|application\/(octet-stream|ogg))/.test(type)) throw new Error(`download is ${type}, not video`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxMb * 1e6) throw new Error(`clip is ${Math.round(len / 1e6)} MB (cap ${maxMb} MB)`);

  const tmp = `${dest}.part`;
  let bytes = 0;
  const counted = Readable.fromWeb(res.body as any);
  counted.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxMb * 1e6) counted.destroy(new Error(`clip exceeded ${maxMb} MB`));
  });
  try {
    await pipeline(counted, createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return dest;
}

/** Confirms the file really is usable video (a real video stream, long enough, big enough) and reads its true size and length. */
async function verify(cfg: AppConfig, path: string, minS: number, runner: Runner): Promise<{ durationS: number; width: number; height: number } | null> {
  try {
    const info = await probe(cfg, path, runner);
    if (!info.videoCodec || !info.width || !info.height) return null;
    if (info.durationS < minS || Math.min(info.width, info.height) < 360) return null;
    return { durationS: info.durationS, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/**
 * Finds one licensed, downloadable, usable clip for `query`, or null. Providers are tried in the configured order; a
 * provider that errors (network, quota, bad key) is skipped, never fatal — a compilation without footage still renders.
 * `exclude` holds clips already chosen for this video, so two stories never get the same clip.
 */
export async function findFootage(deps: FootageDeps, query: string, exclude: Set<string> = new Set()): Promise<FootageRef | null> {
  const { cfg, db, log } = deps;
  const fcfg = cfg.schedule.highlights.footage;
  if (!fcfg.enabled) return null;
  const runner = deps.runner ?? run;
  const ctx: FootageContext = { fetchImpl: deps.fetchImpl ?? fetch, pexelsKey: cfg.env.PEXELS_API_KEY, dataDir: cfg.env.DATA_DIR, userAgent: USER_AGENT };
  const cooling = await recentlyUsed(db, fcfg.reuseCooldownDays, deps.now());
  const cacheDir = join(cfg.env.DATA_DIR, "footage-cache");

  for (const id of fcfg.providers) {
    const provider = PROVIDERS[id];
    if (!provider) continue;
    if (id === "pexels" && !ctx.pexelsKey) continue;
    let candidates: FootageClip[];
    try {
      candidates = await provider.search(query, ctx);
    } catch (e) {
      log.warn({ provider: id, query, err: (e as Error).message }, "footage search failed; trying the next provider");
      continue;
    }
    const fresh = candidates.filter((c) => !exclude.has(clipKey(c)) && !cooling.has(clipKey(c)));
    for (const clip of fresh.slice(0, 4)) {
      try {
        const localPath = clip.localPath ?? (await downloadClip(clip, cacheDir, ctx.fetchImpl));
        const real = await verify(cfg, localPath, fcfg.minClipSeconds, runner);
        if (!real) {
          log.info({ provider: id, clip: clip.externalId }, "footage clip rejected: not usable video");
          continue;
        }
        return { ...clip, ...real, localPath, credit: creditLine(clip) };
      } catch (e) {
        log.warn({ provider: id, clip: clip.externalId, err: (e as Error).message }, "footage clip skipped");
      }
    }
  }
  return null;
}
