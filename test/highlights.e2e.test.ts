import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getContent } from "../src/db/content.js";
import { runHighlights } from "../src/highlights/agent.js";
import { storeItems } from "../src/ingest/store.js";
import type { RawItem } from "../src/ingest/types.js";
import { StubProvider } from "../src/llm/stub.js";
import { probe } from "../src/media/exec.js";
import { buildPlatformMetadata } from "../src/publish/metadata.js";
import { runQa } from "../src/qa/gate.js";
import { runRender } from "../src/render/agent.js";
import { runScript } from "../src/script/agent.js";
import { runVoice } from "../src/voice/agent.js";
import { makeDeps } from "./helpers.js";

const ff = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
const hasMedia = ff.status === 0 && /\bass\b/.test(ff.stdout) && spawnSync("espeak-ng", ["--version"]).status === 0;

const NOW = new Date("2026-11-12T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const news = (source: string, title: string, summary: string, h: number): RawItem => ({ source, kind: "news", pillar: "sports_news", title, summary, bodyText: `${summary} The result was confirmed by officials after the match.`, url: `https://ex.test/${encodeURIComponent(title)}`, publishedAt: ago(h) });

const DAY: RawItem[] = [
  news("bbc-sport", "Wimbledon final goes to five sets as the champion survives a scare", "The tennis champion won the Wimbledon final in five sets on Centre Court.", 2),
  news("bbc-sport", "Arsenal beat Chelsea in a Premier League thriller", "Arsenal beat Chelsea with a late goal in the Premier League on Sunday evening.", 4),
  news("espn-top", "Buccaneers beat Cowboys after a huge third quarter", "The Buccaneers scored twenty points in the third quarter to win the football game.", 5),
  news("bbc-athletics", "London Marathon organisers confirm a new course for next year", "Organisers said the revised marathon route will pass the river twice.", 6),
];

/**
 * The whole path for the daily compilation with the REAL parts: highlights job -> script (labelled stub LLM, real fact-check)
 * -> voice (real espeak) -> render (real ffmpeg montage over real clips) -> the real QA gate. Only the network is faked
 * (Pexels serves one real, ffmpeg-made portrait clip) and the LLM is the deterministic stub.
 */
describe.skipIf(!hasMedia)("daily highlights end to end (real ffmpeg + espeak, stub LLM, fake Pexels)", () => {
  it("builds the day's compilation and it passes the real QA gate, credits and all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hl-e2e-"));
    const clip = join(dir, "clip.mp4");
    const mk = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    expect(mk.status).toBe(0);
    const bytes = readFileSync(clip);

    const fetchImpl = (async (url: string) => {
      if (String(url).includes("api.pexels.com")) {
        const q = new URL(String(url)).searchParams.get("query") ?? "";
        const base = [...q].reduce((n, c) => n + c.charCodeAt(0), 0) * 10;
        return new Response(JSON.stringify({ videos: [0, 1].map((k) => ({ id: base + k, url: `https://www.pexels.com/video/${base + k}/`, duration: 6, user: { name: `Photographer ${base + k}` }, video_files: [{ file_type: "video/mp4", width: 720, height: 1280, link: `https://v.test/${base + k}.mp4` }] })) }));
      }
      return new Response(bytes, { headers: { "content-type": "video/mp4" } });
    }) as unknown as typeof fetch;

    const { deps, db, enqueued } = await makeDeps({ provider: new StubProvider(), now: NOW, fetchImpl, env: { DATA_DIR: dir, MEDIA_DIR: join(dir, "media"), PEXELS_API_KEY: "key", FONT_FILE: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" } });
    await storeItems(db, deps.embedder, DAY, NOW);

    const made = await runHighlights(deps, { correlationId: "e2e", kind: "highlights" });
    expect(made).toMatchObject({ stories: 4, withFootage: 4 });
    const id = made.created!;
    const data = { contentId: id, correlationId: (await getContent(db, id))!.correlationId, regen: 0 };

    expect(await runScript(deps, data)).toBe("scripted");
    expect(await runVoice(deps, data)).toBe("voiced");
    expect(await runRender(deps, data)).toBe("rendered");
    const outcome = await runQa(deps, data);

    const row = (await getContent(db, id))!;
    const qa = row.qa as any;
    expect(outcome, JSON.stringify(qa?.failures)).toBe("passed");
    expect(row.status).toBe("qa_passed");
    expect(qa.failures).toEqual([]);

    // the rendered file is a real, spec-compliant vertical video
    const render = row.render as any;
    expect(existsSync(render.videoPath)).toBe(true);
    expect(await probe(deps.cfg, render.videoPath)).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac" });
    expect(render.renderer).toBe("ffmpeg");

    // every story has its own clip and the post text credits them all and says the footage is illustrative
    const script = row.script as any;
    expect(script.compilation.segments).toHaveLength(4);
    const m = buildPlatformMetadata("youtube", row, script, []);
    for (const seg of script.compilation.segments) expect(m.caption).toContain(seg.footage.credit);
    expect(m.caption).toContain("illustrative");
    expect(enqueued.at(-1)).toMatchObject({ queue: "publish", data: { contentId: id, kind: "schedule" } });
  }, 1_200_000);
});
