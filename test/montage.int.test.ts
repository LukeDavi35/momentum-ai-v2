import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FootageRef } from "../src/footage/types.js";
import type { Compilation } from "../src/highlights/types.js";
import { probe } from "../src/media/exec.js";
import { runTechnicalChecks } from "../src/qa/technical.js";
import { renderWithFfmpeg } from "../src/render/ffmpegRenderer.js";
import { renderMontage, planSpans } from "../src/render/montage.js";
import type { ScriptDoc } from "../src/script/types.js";
import { beatTimings, estimateWordTimings } from "../src/voice/align.js";
import { testConfig } from "./helpers.js";

const ff = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
const hasFfmpeg = ff.status === 0 && /\bass\b/.test(ff.stdout);

const BEATS = [
  "Here are today's top sports stories.",
  "The Wimbledon champion survived a five set scare on Centre Court in the final.",
  "Arsenal beat Chelsea with a late goal in a Premier League thriller on Sunday.",
  "The Buccaneers turned their game around with twenty points in the third quarter.",
  "Follow Momentum for tomorrow's highlights.",
];

/** Average colour of the frame at t seconds, as [r,g,b]. */
function avgColour(video: string, t: number): number[] {
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...r.stdout.subarray(0, 3)];
}

describe.skipIf(!hasFfmpeg)("compilation montage with real ffmpeg", () => {
  const cfg = testConfig({ FONT_FILE: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" });
  const frames = join(process.cwd(), "out", "test-frames");
  mkdirSync(frames, { recursive: true });

  function makeClip(dir: string, name: string, src: string, seconds: number): string {
    const path = join(dir, name);
    const r = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `${src}:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return path;
  }
  const ref = (id: string, localPath: string): FootageRef => ({
    provider: "pexels", externalId: id, title: id, pageUrl: "", downloadUrl: null, license: "pexels", licenseLabel: "Pexels License", author: `Author ${id}`, attributionRequired: false,
    durationS: 6, width: 1280, height: 720, localPath, credit: `Footage: Author ${id} / Pexels`,
  });

  async function build() {
    const dir = mkdtempSync(join(tmpdir(), "montage-"));
    // a landscape clip longer than its span, a PORTRAIT clip much SHORTER than its span (must loop), and one story with no clip
    const landscape = makeClip(dir, "land.mp4", "testsrc2=s=1280x720:r=25", 8);
    const portrait = makeClip(dir, "port.mp4", "smptebars=s=720x1280:r=30", 2);
    const audio = join(dir, "voice.wav");
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=f=180:d=22,tremolo=f=4:d=0.7,volume=0.35", audio], { encoding: "utf8" });
    const durationS = (await probe(cfg, audio)).durationS;
    const compilation: Compilation = {
      date: "2026-11-12",
      introBeatIds: ["b1"],
      outroBeatIds: ["b5"],
      segments: [
        { storyIndex: 0, headline: "Wimbledon final", beatIds: ["b2"], footage: ref("1", landscape) },
        { storyIndex: 1, headline: "Arsenal beat Chelsea", beatIds: ["b3"], footage: ref("2", portrait) },
        { storyIndex: 2, headline: "Buccaneers rally", beatIds: ["b4"], footage: null },
      ],
    };
    const script: ScriptDoc = {
      title: "Today's sports highlights",
      hookStyle: "news",
      beats: BEATS.map((text, i) => ({ id: `b${i + 1}`, text, onScreen: "", claimIds: [] })),
      claims: [],
      visual: { headline: "Today's sports highlights", stat: null, statLabel: null, items: [] },
      variants: { tiktok: { caption: "c", hashtags: [] }, instagram: { caption: "c", hashtags: [] }, youtube: { title: "t", description: "d", hashtags: [] } },
      sourceAliases: {},
      estimatedDurationS: 20,
      removed: [],
      generator: "live",
      compilation,
    };
    const words = estimateWordTimings(BEATS.join(" "), durationS);
    const voice = { provider: "dev-espeak", fallbackUsed: false, attempts: [], audioPath: audio, durationS, words, timingSource: "estimated" as const, beats: beatTimings(script.beats, words), chars: 300, devVoice: true };
    return { dir, script, voice, durationS };
  }

  it("renders footage (cropped, looped when short) and a generated background into one spec-compliant, captioned, credited video", async () => {
    const { dir, script, voice, durationS } = await build();
    const out = await renderWithFfmpeg({ cfg, template: "daily_highlights", script, voice, dir });

    const failed = (await runTechnicalChecks({ cfg, videoPath: out.videoPath, captionsPath: out.captionsPath, cues: out.cues, voice, hookWords: 6 })).filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    const info = await probe(cfg, out.videoPath);
    expect(info).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac" });
    expect(info.durationS).toBeCloseTo(durationS + 0.7, 0);

    // the three stretches look different: testsrc2, SMPTE bars (looped), and the template gradient
    const spans = planSpans(script.compilation!, voice.beats, durationS + 0.7);
    const mid = (i: number) => (spans[i]!.start + spans[i]!.end) / 2;
    const [a, b, c] = [0, 1, 2].map((i) => avgColour(out.videoPath, mid(i)));
    const dist = (x: number[], y: number[]) => Math.max(...x.map((v, k) => Math.abs(v - y[k]!)));
    expect(dist(a!, b!)).toBeGreaterThan(8);
    expect(dist(b!, c!)).toBeGreaterThan(8);
    expect(dist(a!, c!)).toBeGreaterThan(8);

    // the looped 2-second clip is still playing well after it would have ended (its span is far longer than 2 s)
    expect(spans[1]!.end - spans[1]!.start).toBeGreaterThan(3);
    expect(dist(avgColour(out.videoPath, spans[1]!.end - 0.3), avgColour(out.videoPath, spans[1]!.start + 0.3))).toBeLessThan(40);

    // titles and credits are in the overlay that was burned in; the credit exists only for stories that have a clip
    const visual = readFileSync(join(dir, "visual.ass"), "utf8");
    expect(visual).toContain("Footage: Author 1 / Pexels");
    expect(visual).toContain("Footage: Author 2 / Pexels");
    expect(visual.match(/,Credit,/g)).toHaveLength(2);
    expect(visual).toContain("1 / 3");

    for (const [i, s] of spans.entries()) {
      const png = join(frames, `highlights-${i}.png`);
      spawnSync("ffmpeg", ["-y", "-ss", String((s.start + s.end) / 2), "-i", out.videoPath, "-frames:v", "1", png]);
      expect(statSync(png).size).toBeGreaterThan(20_000);
    }
    expect(statSync(out.coverPath).size).toBeGreaterThan(10_000);
    expect(existsSync(out.videoPath)).toBe(true);
  }, 900_000);

  it("the montage is never shorter than the voiceover, so the final trim is always exact", async () => {
    const { dir, script, voice, durationS } = await build();
    const total = durationS + 0.7;
    const spans = planSpans(script.compilation!, voice.beats, total);
    const montage = await renderMontage({ cfg, template: "daily_highlights", spans, dir, runner: (await import("../src/media/exec.js")).run });
    expect((await probe(cfg, montage)).durationS).toBeGreaterThanOrEqual(total);
  }, 600_000);
});
