import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Template } from "../src/config/index.js";
import { probe, run } from "../src/media/exec.js";
import { runTechnicalChecks } from "../src/qa/technical.js";
import { buildProps, remotionRenderer } from "../src/render/remotionRenderer.js";
import type { ScriptDoc } from "../src/script/types.js";
import { beatTimings, estimateWordTimings } from "../src/voice/align.js";
import { makeDeps } from "./helpers.js";

const CHROMIUM = process.env.CHROMIUM_PATH;
const enabled = !!CHROMIUM && existsSync(CHROMIUM) && spawnSync("ffmpeg", ["-version"]).status === 0;

const BEATS = ["Faith Kipyegon just broke the world record.", "She ran three forty nine point oh four in Paris on Thursday night.", "The time took thirty eight hundredths off her own mark.", "She led from the front and kicked clear over the final lap.", "Follow Momentum for more sports updates."];
const script = (template: Template): ScriptDoc => ({
  title: "Kipyegon breaks the 1500m world record",
  hookStyle: "news",
  beats: BEATS.map((text, i) => ({ id: `b${i + 1}`, text, onScreen: text.split(" ").slice(0, 5).join(" "), claimIds: [] })),
  claims: [],
  visual: { headline: "Kipyegon breaks 1500m world record", stat: "3:49.04", statLabel: "new 1500m world record", items: template === "stat_spotlight" ? [] : ["Ran 3:49.04 in Paris", "0.38s off her own mark", "Led from the front"] },
  variants: { tiktok: { caption: "c", hashtags: [] }, instagram: { caption: "c", hashtags: [] }, youtube: { title: "t", description: "d", hashtags: [] } },
  sourceAliases: {},
  estimatedDurationS: 15,
  removed: [],
  generator: "live",
});

describe("props mapping (no browser needed)", () => {
  it("maps the script/voice timing into composition props", () => {
    const s = script("news_flash");
    const words = estimateWordTimings(BEATS.join(" "), 14);
    const voice: any = { words, beats: beatTimings(s.beats, words), durationS: 14 };
    const p = buildProps("news_flash", s, voice);
    expect(p).toMatchObject({ template: "news_flash", durationS: 14.7, fps: 30, headline: "Kipyegon breaks 1500m world record" });
    expect(p.theme.c0).toBe("#0b1736");
    expect(p.theme.accent.toLowerCase()).toBe("#ffe500"); // ASS BGR 00E5FF -> CSS RGB
    expect(p.itemTimes).toHaveLength(3);
    expect(p.itemTimes[0]).toBeCloseTo(voice.beats[1].start, 5);
    expect(p.itemTimes.every((t, i, a) => i === 0 || t >= a[i - 1]!)).toBe(true);
  });
});

describe.skipIf(!enabled)("Remotion renderer with a real Chromium + real QA technical checks", () => {
  it.each(["stat_spotlight", "training_tip"] as Template[])("renders %s through Remotion + FFmpeg assembly and passes the QA technical gate", async (template) => {
    const { deps } = await makeDeps({ env: { RENDERER: "remotion", CHROMIUM_PATH: CHROMIUM, DATA_DIR: mkdtempSync(join(tmpdir(), "rd-")) } });
    const dir = mkdtempSync(join(tmpdir(), `rm-${template}-`));
    const audio = join(dir, "voice.wav");
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=f=180:d=12,tremolo=f=4:d=0.7,volume=0.35", audio]);
    const durationS = (await probe(deps.cfg, audio)).durationS;
    const s = script(template);
    const words = estimateWordTimings(BEATS.join(" "), durationS);
    const voice: any = { provider: "dev", fallbackUsed: false, attempts: [], audioPath: audio, durationS, words, timingSource: "estimated", beats: beatTimings(s.beats, words), chars: 200, devVoice: true };

    const out = await remotionRenderer({ deps, template, script: s, voice, dir });
    expect(out.renderer).toBe("remotion");
    expect(statSync(out.videoPath).size).toBeGreaterThan(50_000);
    const checks = await runTechnicalChecks({ cfg: deps.cfg, videoPath: out.videoPath, captionsPath: out.captionsPath, cues: out.cues, voice, hookWords: 7 });
    expect(checks.filter((c) => !c.ok), JSON.stringify(checks.filter((c) => !c.ok))).toEqual([]);
    mkdirSync(join(process.cwd(), "out", "test-frames"), { recursive: true });
    await run("ffmpeg", ["-y", "-ss", "6", "-i", out.videoPath, "-frames:v", "1", join(process.cwd(), "out", "test-frames", `remotion-${template}.png`)]);
  }, 300_000);
});
