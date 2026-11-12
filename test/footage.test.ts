import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyLicense } from "../src/footage/licenses.js";
import { footageQuery } from "../src/footage/query.js";
import { commonsProvider, libraryProvider, parseCommons, pexelsProvider, pickPexelsFile } from "../src/footage/providers.js";
import { creditLine, downloadClip, findFootage } from "../src/footage/search.js";
import { recentlyUsed, recordUse } from "../src/footage/store.js";
import type { FootageClip, FootageContext } from "../src/footage/types.js";
import type { Runner } from "../src/media/exec.js";
import { silentLogger, testConfig, testDb } from "./helpers.js";

describe("licence classification", () => {
  it.each([
    ["CC0", "cc0", false],
    ["CC0 1.0 Universal", "cc0", false],
    ["Public domain", "public_domain", false],
    ["PD-USGov-NASA", "public_domain", false],
    ["CC BY 4.0", "cc_by", true],
    ["CC BY 2.0", "cc_by", true],
    ["Pexels License", "pexels", false],
    ["owned", "owned", false],
  ])("accepts %s", (label, id, attribution) => {
    expect(classifyLicense(label)).toEqual({ id, attributionRequired: attribution });
  });

  it.each(["CC BY-SA 4.0", "CC BY-NC 2.0", "CC BY-ND 3.0", "CC BY-NC-SA 4.0", "GFDL", "All rights reserved", "Fair use", "", "unknown", "Standard YouTube License", "Some custom licence"])(
    "rejects %j (not-commercial, no-derivatives, share-alike and unknown licences never qualify)",
    (label) => {
      expect(classifyLicense(label)).toBeNull();
    },
  );
  it("rejects null/undefined", () => {
    expect(classifyLicense(undefined)).toBeNull();
    expect(classifyLicense(null)).toBeNull();
  });
});

describe("footage query", () => {
  it("searches for the sport, never the people", () => {
    expect(footageQuery("Kipyegon breaks 1500m world record in Paris", "track_and_field")).toBe("sprinter track");
    expect(footageQuery("Buccaneers beat Cowboys after a huge third quarter", "sports_news")).toBe("american football");
    expect(footageQuery("Wimbledon final goes to five sets", "sports_news")).toBe("tennis match");
    expect(footageQuery("London Marathon confirms a new course", "running")).toBe("marathon runners");
  });
  it("falls back to the pillar when no sport is named", () => {
    expect(footageQuery("Governing body announces new rules", "sports_news")).toBe("stadium crowd");
    expect(footageQuery("A new approach to recovery weeks", "running")).toBe("running");
  });
});

const ctx = (fetchImpl: typeof fetch, extra: Partial<FootageContext> = {}): FootageContext => ({ fetchImpl, dataDir: "./data/test", userAgent: "test-agent", ...extra });
const jsonFetch = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("pexels provider", () => {
  const payload = {
    videos: [
      {
        id: 111,
        url: "https://www.pexels.com/video/runner-on-track-111/",
        duration: 14,
        user: { name: "Jane Doe", url: "https://www.pexels.com/@jane" },
        video_files: [
          { quality: "sd", file_type: "video/mp4", width: 540, height: 960, link: "https://v.pexels/sd.mp4" },
          { quality: "hd", file_type: "video/mp4", width: 1080, height: 1920, link: "https://v.pexels/hd.mp4" },
          { quality: "uhd", file_type: "video/mp4", width: 2160, height: 3840, link: "https://v.pexels/uhd.mp4" },
          { quality: "hd", file_type: "video/webm", width: 1080, height: 1920, link: "https://v.pexels/x.webm" },
        ],
      },
      { id: 222, url: "https://www.pexels.com/video/x-222/", duration: 0, video_files: [] },
    ],
  };

  it("returns nothing without a key (and makes no request)", async () => {
    let called = false;
    const f = (async () => ((called = true), new Response("{}"))) as typeof fetch;
    expect(await pexelsProvider.search("tennis", ctx(f))).toEqual([]);
    expect(called).toBe(false);
  });

  it("maps videos, picking the largest mp4 within HD, with the key as the Authorization header", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const f = (async (url: string, init: RequestInit) => ((seen = { url, headers: init.headers as Record<string, string> }), new Response(JSON.stringify(payload)))) as unknown as typeof fetch;
    const clips = await pexelsProvider.search("tennis match", ctx(f, { pexelsKey: "KEY" }));
    expect(seen!.url).toContain("query=tennis%20match");
    expect(seen!.url).toContain("orientation=portrait");
    expect(seen!.headers.Authorization).toBe("KEY");
    expect(clips).toHaveLength(1); // the 0-second / no-file entry is dropped
    expect(clips[0]).toMatchObject({ provider: "pexels", externalId: "111", downloadUrl: "https://v.pexels/hd.mp4", license: "pexels", author: "Jane Doe", durationS: 14, attributionRequired: false });
  });

  it("surfaces an HTTP error so the caller can skip the provider", async () => {
    await expect(pexelsProvider.search("x", ctx(jsonFetch({}, 401), { pexelsKey: "bad" }))).rejects.toThrow(/401/);
  });

  it("pickPexelsFile ignores non-mp4 and oversize renditions", () => {
    expect(pickPexelsFile([{ file_type: "video/webm", width: 720, height: 1280, link: "a" }])).toBeNull();
    expect(pickPexelsFile([{ file_type: "video/mp4", width: 2160, height: 3840, link: "a" }])).toBeNull();
    expect(pickPexelsFile([{ file_type: "video/mp4", width: 720, height: 1280, link: "a" }])?.link).toBe("a");
  });
});

describe("wikimedia commons provider", () => {
  const page = (id: number, title: string, license: string, mime = "video/webm") => ({
    pageid: id,
    title: `File:${title}.webm`,
    imageinfo: [{ url: `https://upload.wikimedia.org/${id}.webm`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${title}`, mime, width: 1280, height: 720, duration: 12.5, extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="x">Some <b>Author</b></a>' } } }],
  });
  const json = { query: { pages: { a: page(1, "Sprint start", "CC BY 4.0"), b: page(2, "Relay", "CC BY-SA 4.0"), c: page(3, "Olympic opening", "CC BY-NC 2.0"), d: page(4, "Old race", "Public domain"), e: page(5, "Sound only", "CC0", "audio/ogg"), f: page(6, "Mystery", "") } } };

  it("keeps only accepted licences and real video, and strips HTML from the author", () => {
    const clips = parseCommons(json);
    expect(clips.map((c) => c.externalId).sort()).toEqual(["1", "4"]);
    const cc = clips.find((c) => c.externalId === "1")!;
    expect(cc).toMatchObject({ license: "cc_by", attributionRequired: true, author: "Some Author", title: "Sprint start", durationS: 12.5 });
  });

  it("sends the descriptive User-Agent Wikimedia requires", async () => {
    let ua = "";
    const f = (async (_u: string, init: RequestInit) => ((ua = (init.headers as Record<string, string>)["User-Agent"]!), new Response(JSON.stringify(json)))) as unknown as typeof fetch;
    await commonsProvider.search("sprint", ctx(f));
    expect(ua).toBe("test-agent");
  });

  it("tolerates an empty result", () => {
    expect(parseCommons({})).toEqual([]);
    expect(parseCommons({ query: { pages: {} } })).toEqual([]);
  });
});

describe("library provider (the owner's own footage)", () => {
  it("matches by tags/title, drops missing files and unlicensed entries, and returns the resolved path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lib-"));
    mkdirSync(join(dir, "footage"));
    writeFileSync(join(dir, "footage", "serve.mp4"), "x");
    writeFileSync(join(dir, "footage", "golf.mp4"), "x");
    writeFileSync(
      join(dir, "footage", "library.json"),
      JSON.stringify({
        clips: [
          { file: "serve.mp4", title: "Club final", tags: ["tennis", "serve"], license: "owned", author: "Me" },
          { file: "golf.mp4", title: "Golf", tags: ["golf"], license: "All rights reserved" },
          { file: "missing.mp4", title: "Missing", tags: ["tennis"], license: "owned" },
          { file: "serve.mp4", title: "Other", tags: ["cricket"], license: "owned" },
        ],
      }),
    );
    const out = await libraryProvider.search("tennis match", ctx(jsonFetch({}), { dataDir: dir }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ provider: "library", license: "owned", author: "Me", downloadUrl: null, localPath: join(dir, "footage", "serve.mp4") });
  });

  it("returns nothing when there is no library", async () => {
    expect(await libraryProvider.search("tennis", ctx(jsonFetch({}), { dataDir: mkdtempSync(join(tmpdir(), "nolib-")) }))).toEqual([]);
  });
});

describe("downloadClip", () => {
  const clip: FootageClip = { provider: "pexels", externalId: "9", title: "t", pageUrl: "", downloadUrl: "https://v.test/a.mp4", license: "pexels", licenseLabel: "Pexels License", author: "A", attributionRequired: false, durationS: 10, width: 1080, height: 1920 };
  const video = (body: string, headers: Record<string, string> = {}): typeof fetch => (async () => new Response(body, { status: 200, headers: { "content-type": "video/mp4", ...headers } })) as typeof fetch;

  it("downloads once and reuses the cached file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-"));
    let calls = 0;
    const f = (async () => (calls++, new Response("0123456789", { headers: { "content-type": "video/mp4" } }))) as typeof fetch;
    const a = await downloadClip(clip, dir, f);
    const b = await downloadClip(clip, dir, f);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });
  it("refuses non-video responses, oversize clips and HTTP errors, leaving no partial file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-"));
    await expect(downloadClip(clip, dir, video("<html>", { "content-type": "text/html" }))).rejects.toThrow(/not video/);
    await expect(downloadClip(clip, dir, video("x", { "content-length": String(200e6) }))).rejects.toThrow(/cap/);
    await expect(downloadClip(clip, dir, (async () => new Response("no", { status: 404 })) as typeof fetch)).rejects.toThrow(/404/);
    await expect(downloadClip(clip, dir, video("x".repeat(3000)), 0.001)).rejects.toThrow(/exceeded/);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("findFootage", () => {
  const probeOk = (durationS: number, width = 1080, height = 1920): Runner => async () => ({ stdout: JSON.stringify({ format: { duration: String(durationS), size: "1000" }, streams: [{ codec_type: "video", codec_name: "h264", width, height, avg_frame_rate: "30/1" }] }), stderr: "" });
  const NOW = new Date("2026-11-12T12:00:00Z");

  function pexelsFetch(ids: number[]): typeof fetch {
    return (async (url: string) => {
      if (String(url).includes("api.pexels.com")) {
        return new Response(JSON.stringify({ videos: ids.map((id) => ({ id, url: `https://www.pexels.com/video/v-${id}/`, duration: 10, user: { name: `Author ${id}` }, video_files: [{ file_type: "video/mp4", width: 1080, height: 1920, link: `https://v.test/${id}.mp4` }] })) }));
      }
      return new Response("video-bytes", { headers: { "content-type": "video/mp4" } });
    }) as unknown as typeof fetch;
  }
  const depsFor = async (env: Record<string, string | undefined>, fetchImpl: typeof fetch, runner: Runner) => {
    const dir = mkdtempSync(join(tmpdir(), "ff-"));
    const cfg = testConfig({ DATA_DIR: dir, ...env });
    return { cfg, db: await testDb(), log: silentLogger(), fetchImpl, runner, now: () => NOW };
  };

  it("returns a verified, credited clip from Pexels", async () => {
    const d = await depsFor({ PEXELS_API_KEY: "k" }, pexelsFetch([1, 2]), probeOk(9.5));
    const ref = await findFootage(d, "tennis match");
    expect(ref).toMatchObject({ provider: "pexels", externalId: "1", durationS: 9.5, credit: "Footage: Author 1 / Pexels" });
    expect(ref!.localPath).toMatch(/footage-cache\/pexels-1\.mp4$/);
  });

  it("skips clips already chosen for this video and clips used within the cooldown", async () => {
    const d = await depsFor({ PEXELS_API_KEY: "k" }, pexelsFetch([1, 2, 3]), probeOk(9));
    const first = (await findFootage(d, "q"))!;
    const second = await findFootage(d, "q", new Set(["pexels:1"]));
    expect(second!.externalId).toBe("2");
    await recordUse(d.db, first, null, NOW);
    expect(await recentlyUsed(d.db, 7, NOW)).toEqual(new Set(["pexels:1"]));
    const third = await findFootage(d, "q");
    expect(third!.externalId).toBe("2"); // clip 1 is cooling down
    expect(await recentlyUsed(d.db, 7, new Date(NOW.getTime() + 8 * 86400_000))).toEqual(new Set()); // ...and free again after the cooldown
  });

  it("rejects files that are not usable video (too short, too small, no video stream) and moves on", async () => {
    const d = await depsFor({ PEXELS_API_KEY: "k", }, pexelsFetch([1]), probeOk(1.2));
    expect(await findFootage(d, "q")).toBeNull(); // shorter than minClipSeconds (3)
    const tiny = await depsFor({ PEXELS_API_KEY: "k" }, pexelsFetch([2]), probeOk(9, 200, 300));
    expect(await findFootage(tiny, "q")).toBeNull();
    const broken: Runner = async () => {
      throw new Error("ffprobe failed");
    };
    expect(await findFootage(await depsFor({ PEXELS_API_KEY: "k" }, pexelsFetch([3]), broken), "q")).toBeNull();
  });

  it("falls through to the next provider when one fails, and uses Commons without any key", async () => {
    const f = (async (url: string) => {
      if (String(url).includes("api.pexels.com")) return new Response("{}", { status: 500 });
      if (String(url).includes("commons.wikimedia.org/w/api.php")) {
        return new Response(JSON.stringify({ query: { pages: { x: { pageid: 77, title: "File:Marathon.webm", imageinfo: [{ url: "https://upload.wikimedia.org/77.webm", mime: "video/webm", width: 1280, height: 720, duration: 20, extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, Artist: { value: "Runner Photographer" } } }] } } } }));
      }
      return new Response("bytes", { headers: { "content-type": "video/webm" } });
    }) as unknown as typeof fetch;
    const d = await depsFor({ PEXELS_API_KEY: "k" }, f, probeOk(20, 1280, 720));
    const ref = await findFootage(d, "marathon runners");
    expect(ref).toMatchObject({ provider: "commons", externalId: "77", license: "cc_by", attributionRequired: true });
    expect(ref!.credit).toBe("Footage: Runner Photographer / Wikimedia Commons, CC BY 4.0");
  });

  it("returns null when disabled, when nothing is found, or when every provider fails", async () => {
    const none = (async () => new Response(JSON.stringify({ videos: [], query: {} }))) as unknown as typeof fetch;
    expect(await findFootage(await depsFor({ PEXELS_API_KEY: "k" }, none, probeOk(9)), "q")).toBeNull();
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await findFootage(await depsFor({ PEXELS_API_KEY: "k" }, down, probeOk(9)), "q")).toBeNull();
    const d = await depsFor({}, pexelsFetch([1]), probeOk(9));
    d.cfg.schedule.highlights.footage.enabled = false;
    expect(await findFootage(d, "q")).toBeNull();
  });

  it("builds credit lines per provider", () => {
    expect(creditLine({ provider: "pexels", author: "A", licenseLabel: "Pexels License", license: "pexels" })).toBe("Footage: A / Pexels");
    expect(creditLine({ provider: "library", author: "Me", licenseLabel: "owned", license: "owned" })).toBe("Footage: Me");
  });
});
