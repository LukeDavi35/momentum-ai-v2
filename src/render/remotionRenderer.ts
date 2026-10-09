import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Template } from "../config/index.js";
import type { ScriptDoc } from "../script/types.js";
import type { VoiceDoc } from "../voice/agent.js";
import { run } from "../media/exec.js";
import type { Renderer } from "./agent.js";
import { assemble, FPS, totalDuration } from "./ffmpegRenderer.js";
import { THEMES } from "./visuals.js";

/** Matches remotion/types.ts (kept structural so src/ never imports the React code). */
type MomentumProps = {
  template: Template;
  durationS: number;
  fps: number;
  theme: { label: string; c0: string; c1: string; accent: string };
  headline: string;
  stat: string | null;
  statLabel: string | null;
  items: string[];
  itemTimes: number[];
  cards: Array<{ text: string; start: number; end: number }>;
  statAt: number;
};

const hex = (c: string): string => `#${c.replace(/^0x/i, "")}`;
/** ASS colours are BGR; CSS wants RGB. */
const bgrToCss = (bgr: string): string => `#${bgr.slice(4, 6)}${bgr.slice(2, 4)}${bgr.slice(0, 2)}`;

export function buildProps(template: Template, script: ScriptDoc, voice: VoiceDoc): MomentumProps {
  const t = THEMES[template];
  const items = script.visual.items ?? [];
  const D = totalDuration(voice);
  const beatStart = (i: number) => voice.beats[Math.min(i, voice.beats.length - 1)]?.start ?? 0.9 + i * 2;
  return {
    template,
    durationS: D,
    fps: FPS,
    theme: { label: t.label, c0: hex(t.c0), c1: hex(t.c1), accent: bgrToCss(t.accentBgr) },
    headline: script.visual.headline || script.title,
    stat: script.visual.stat ?? null,
    statLabel: script.visual.statLabel ?? null,
    items,
    itemTimes: items.map((_, i) => beatStart(i + 1)),
    cards: script.beats.slice(1).flatMap((b) => {
      const bt = voice.beats.find((x) => x.id === b.id);
      return bt && b.onScreen?.trim() ? [{ text: b.onScreen.trim(), start: bt.start, end: Math.max(bt.end, bt.start + 1) }] : [];
    }),
    statAt: voice.beats[1]?.start ?? 0.9,
  };
}

// The webpack bundle takes ~10-20 s, so build it once per process and reuse it for every render.
let bundled: Promise<string> | undefined;
function getBundle(dataDir: string): Promise<string> {
  bundled ??= (async () => {
    const entry = resolve(process.cwd(), "remotion", "index.ts");
    if (!existsSync(entry)) throw new Error(`Remotion entry point not found at ${entry}`);
    const { bundle } = await import("@remotion/bundler");
    return bundle({ entryPoint: entry, outDir: join(resolve(dataDir), "remotion-bundle") });
  })();
  bundled.catch(() => (bundled = undefined)); // a failed bundle must be retried, not cached
  return bundled;
}

/**
 * Remotion draws the animated visual track (springs, drifting gradient, chips, big stat) to a silent H.264 file;
 * the shared FFmpeg `assemble()` then adds the voiceover (loudness-normalised), burns word-highlighted captions,
 * the progress bar, and makes the cover — the same assembly the FFmpeg renderer uses, so QA treats both identically.
 */
export const remotionRenderer: Renderer = async ({ deps, template, script, voice, dir, attempt }) => {
  const { cfg } = deps;
  const chromium = cfg.env.CHROMIUM_PATH;
  if (!chromium || !existsSync(chromium)) {
    // Never let Remotion silently download a browser at render time: the operator must provide one.
    throw new Error(`RENDERER=remotion needs a Chromium binary: CHROMIUM_PATH=${chromium ?? "(unset)"} does not exist (the Docker image installs one with WITH_CHROMIUM=true)`);
  }
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  const serveUrl = await getBundle(cfg.env.DATA_DIR);
  const inputProps = buildProps(template, script, voice);
  const composition = await selectComposition({ serveUrl, id: "Momentum", inputProps, browserExecutable: chromium });
  const visual = join(dir, "visual.mp4");
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: visual,
    inputProps,
    browserExecutable: chromium,
    concurrency: 1, // one tab: keeps peak memory low on small hosts
    crf: 21,
    x264Preset: "veryfast",
    pixelFormat: "yuv420p",
    imageFormat: "jpeg",
    jpegQuality: 88,
    logLevel: "warn",
    timeoutInMilliseconds: 180_000,
  });
  return assemble({ cfg, template, script, voice, dir, attempt, runner: deps.runner ?? run, base: { kind: "video", path: visual }, renderer: "remotion" });
};
