import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATES, type Template } from "../src/config/index.js";
import { probe, run } from "../src/media/exec.js";
import { runTechnicalChecks } from "../src/qa/technical.js";
import { adaptiveLimiter, audioPlan, renderWithFfmpeg } from "../src/render/ffmpegRenderer.js";
import { beatTimings, estimateWordTimings } from "../src/voice/align.js";
import type { ScriptDoc } from "../src/script/types.js";
import { testConfig } from "./helpers.js";

const ff = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
const hasFfmpeg = ff.status === 0 && /\bass\b/.test(ff.stdout);

const BEATS = [
  "Faith Kipyegon just broke the world record.",
  "She ran three forty nine point oh four in Paris on Thursday night.",
  "The time took thirty eight hundredths of a second off her own mark.",
  "She led from the front and kicked clear over the final lap.",
  "Organisers said the whole crowd stayed on its feet.",
  "Follow Momentum for more sports updates.",
];

function script(template: Template): ScriptDoc {
  return {
    title: "Kipyegon breaks the 1500m world record",
    hookStyle: "news",
    beats: BEATS.map((text, i) => ({ id: `b${i + 1}`, text, onScreen: text.split(" ").slice(0, 5).join(" "), claimIds: [] })),
    claims: [],
    visual: { headline: "Kipyegon breaks 1500m world record", stat: "3:49.04", statLabel: "new 1500m world record", items: template === "stat_spotlight" ? [] : ["Ran 3:49.04 in Paris", "0.38s off her own mark", "Led from the front"] },
    variants: { tiktok: { caption: "c", hashtags: [] }, instagram: { caption: "c", hashtags: [] }, youtube: { title: "t", description: "d", hashtags: [] } },
    sourceAliases: {},
    estimatedDurationS: 18,
    removed: [],
    generator: "live",
  };
}

describe.skipIf(!hasFfmpeg)("real ffmpeg render + real QA technical checks", () => {
  const cfg = testConfig({ FONT_FILE: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" });
  const frames = join(process.cwd(), "out", "test-frames");
  mkdirSync(frames, { recursive: true });

  it.each(TEMPLATES)("renders the %s template to a spec-compliant, loudness-normalised, caption-synced video", async (template) => {
    const dir = mkdtempSync(join(tmpdir(), `r-${template}-`));
    const audio = join(dir, "voice.wav");
    // a 16s tone with a speech-like amplitude wobble stands in for the voiceover audio
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=f=180:d=16,tremolo=f=4:d=0.7,volume=0.35", audio], { encoding: "utf8" });
    const durationS = (await probe(cfg, audio)).durationS;
    const s = script(template);
    const words = estimateWordTimings(BEATS.join(" "), durationS);
    const voice = { provider: "dev-espeak", fallbackUsed: false, attempts: [], audioPath: audio, durationS, words, timingSource: "estimated" as const, beats: beatTimings(s.beats, words), chars: 300, devVoice: true };

    const out = await renderWithFfmpeg({ cfg, template, script: s, voice, dir });
    expect(statSync(out.videoPath).size).toBeGreaterThan(50_000);

    // The real QA technical gate on the real file
    const checks = await runTechnicalChecks({ cfg, videoPath: out.videoPath, captionsPath: out.captionsPath, cues: out.cues, voice, hookWords: BEATS[0]!.split(" ").length });
    const failed = checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    const info = await probe(cfg, out.videoPath);
    expect(info).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac" });
    expect(info.durationS).toBeCloseTo(durationS + 0.7, 0);

    // overlays must actually be drawn: the frame with text/captions is much heavier than the bare gradient
    const withText = join(frames, `${template}.png`);
    await run("ffmpeg", ["-y", "-ss", "5", "-i", out.videoPath, "-frames:v", "1", withText]);
    const bare = join(dir, "bare.png");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=0x0b1736:s=1080x1920:d=1", "-frames:v", "1", bare]);
    expect(statSync(withText).size).toBeGreaterThan(statSync(bare).size * 5);
    expect(statSync(out.coverPath).size).toBeGreaterThan(10_000);
  }, 180_000);
});

const hasEspeak = spawnSync("espeak-ng", ["--version"]).status === 0;

describe.skipIf(!hasFfmpeg || !hasEspeak)("regression: loud, high-crest TTS speech must come out at -14 LUFS under the true-peak ceiling", () => {
  // The first real dry-runs held pieces: linear-only loudnorm overshot to -0.34 dBTP after AAC, and with a lower
  // ceiling came out at -19 LUFS. Real espeak speech reproduces both; a sine wave reproduces neither.
  const renderEspeak = async (attempt: number) => {
    const cfg = testConfig();
    const dir = mkdtempSync(join(tmpdir(), `r-espeak-${attempt}-`));
    const audio = join(dir, "voice.wav");
    const text = BEATS.join(" ");
    spawnSync("espeak-ng", ["-v", "en-gb", "-s", "160", "-p", "45", "-w", audio, text]);
    const durationS = (await probe(cfg, audio)).durationS;
    const s = script("quick_explainer");
    const words = estimateWordTimings(text, durationS);
    const voice = { provider: "dev-espeak", fallbackUsed: false, attempts: [], audioPath: audio, durationS, words, timingSource: "estimated" as const, beats: beatTimings(s.beats, words), chars: text.length, devVoice: true };
    const out = await renderWithFfmpeg({ cfg, template: "quick_explainer", script: s, voice, dir, attempt });
    return { cfg, out, voice, checks: await runTechnicalChecks({ cfg, videoPath: out.videoPath, captionsPath: out.captionsPath, cues: out.cues, voice, hookWords: 7 }) };
  };

  it("first attempt passes BOTH the loudness and the true-peak checks on real speech", async () => {
    const { checks } = await renderEspeak(0);
    const lufs = checks.find((c) => c.name === "loudness")!;
    const peak = checks.find((c) => c.name === "true_peak")!;
    expect(lufs.ok, lufs.message).toBe(true);
    expect(peak.ok, peak.message).toBe(true);
  }, 240_000);

  it("the strongest retry strategy also passes", async () => {
    const { checks } = await renderEspeak(2);
    expect(checks.filter((c) => !c.ok), JSON.stringify(checks.filter((c) => !c.ok))).toEqual([]);
  }, 240_000);
});

describe("audio plan (pure logic, always runs)", () => {
  it("each retry is a genuinely different strategy (tighter crest budget), bounded at the strongest", () => {
    expect(audioPlan(0).crestBudgetDb).toBeGreaterThan(audioPlan(1).crestBudgetDb);
    expect(audioPlan(1).crestBudgetDb).toBeGreaterThan(audioPlan(2).crestBudgetDb);
    expect(audioPlan(1).pre).not.toBe(audioPlan(0).pre);
    expect(audioPlan(99)).toEqual(audioPlan(2));
    expect(audioPlan(-5)).toEqual(audioPlan(0));
  });

  it("the limiter ceiling is relative to the voice's own loudness, so natural voices are not crushed", () => {
    const plan = audioPlan(0); // +9 dB crest budget
    expect(adaptiveLimiter({ input_i: "-20.1", input_tp: "-1.0" }, plan)).toMatch(/limit=0\.2786/); // -11.1 dBFS
    expect(adaptiveLimiter({ input_i: "-20.1", input_tp: "-14.0" }, plan)).toBeNull(); // peaks already under the ceiling
    expect(adaptiveLimiter({ input_i: "-10.0", input_tp: "-0.5" }, plan)).toMatch(/limit=0\.7079/); // clamped: never above -3 dBFS
    expect(adaptiveLimiter({ input_i: "-40", input_tp: "-1" }, plan)).toMatch(/limit=0\.0631/); // never below -24 dBFS
    expect(adaptiveLimiter({ input_i: "-inf", input_tp: "-1" }, plan)).toBeNull();
    expect(adaptiveLimiter({ input_i: "-20.1", input_tp: "-1.0" }, audioPlan(2))).not.toBe(adaptiveLimiter({ input_i: "-20.1", input_tp: "-1.0" }, plan));
  });
});
