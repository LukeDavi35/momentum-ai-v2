import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, Template } from "../config/index.js";
import { probe, run, type Runner } from "../media/exec.js";
import type { ScriptDoc } from "../script/types.js";
import type { VoiceDoc } from "../voice/agent.js";
import { buildCaptionCues, captionsToAss, type CaptionCue } from "./captions.js";
import { buildCoverAss, buildVisualAss, THEMES } from "./visuals.js";

export const TAIL_S = 0.7;
export const FPS = 30;

export interface LoudnessMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export interface RenderResult {
  renderer: "ffmpeg" | "remotion";
  videoPath: string;
  coverPath: string;
  captionsPath: string;
  visualPath?: string;
  durationS: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  cues: CaptionCue[];
  loudnessIn?: LoudnessMeasure;
}

/** Escape a path for use inside an ffmpeg filtergraph option value. */
export const filterPath = (p: string): string => p.replace(/([\\:',[\]])/g, "\\$1");

/** Parses the JSON block loudnorm prints to stderr when print_format=json. */
export function parseLoudnorm(stderr: string): LoudnessMeasure {
  const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) throw new Error("could not find loudnorm measurement in ffmpeg output");
  const j = JSON.parse(m[0]);
  if (!Number.isFinite(Number(j.input_i))) throw new Error("the voiceover audio is silent or unmeasurable");
  return { input_i: j.input_i, input_tp: j.input_tp, input_lra: j.input_lra, input_thresh: j.input_thresh, target_offset: j.target_offset };
}

let gradientsSupported: boolean | undefined;
async function hasGradients(cfg: AppConfig, runner: Runner): Promise<boolean> {
  if (gradientsSupported !== undefined) return gradientsSupported;
  try {
    const { stdout } = await runner(cfg.env.FFMPEG_PATH, ["-hide_banner", "-filters"]);
    gradientsSupported = /\bgradients\b/.test(stdout);
  } catch {
    gradientsSupported = false;
  }
  return gradientsSupported;
}

async function backgroundSource(cfg: AppConfig, runner: Runner, template: Template, durationS: number): Promise<string[]> {
  const t = THEMES[template];
  const src = (await hasGradients(cfg, runner))
    ? `gradients=s=1080x1920:r=${FPS}:d=${durationS.toFixed(2)}:c0=${t.c0}:c1=${t.c1}:x0=0:y0=0:x1=300:y1=1920:nb_colors=2:speed=0.015`
    : `color=c=${t.c0}:s=1080x1920:r=${FPS}:d=${durationS.toFixed(2)}`;
  return ["-f", "lavfi", "-i", src];
}

export interface FfmpegRenderInput {
  cfg: AppConfig;
  template: Template;
  script: ScriptDoc;
  voice: VoiceDoc;
  dir: string;
  runner?: Runner;
  /** QA retry number (0 = first render). Each retry adds 1 dB of true-peak headroom, so a retry is never an identical re-run. */
  attempt?: number;
}

/** What the visuals come from: a generated gradient + ASS visual track (FFmpeg renderer) or a pre-rendered video (Remotion). */
export type VisualBase = { kind: "gradient"; visualAssPath: string } | { kind: "video"; path: string };

export interface AssembleInput extends FfmpegRenderInput {
  base: VisualBase;
  renderer: RenderResult["renderer"];
}

/**
 * How the voiceover is levelled to -14 LUFS under a true-peak ceiling.
 *
 * Why it is adaptive: linear loudnorm can only reach -14 LUFS if the voice's crest factor (peak minus average
 * loudness) is under ~11 dB, and TTS speech is typically 15-19 dB (the flat dev voice measured -20 LUFS with
 * -1 dBTP peaks). Compressors don't tame short peaks; a LIMITER ahead of loudnorm does (measured on real speech:
 * -17.6 LUFS without it, -14.6 with it). But a fixed ceiling would crush natural voices, so the ceiling is set
 * relative to the measured loudness: `loudness + crestBudgetDb`. Each QA retry tightens the budget, so a retry is
 * a genuinely different attempt. A final brick-wall limiter keeps the AAC encode from overshooting QA's -1 dBTP.
 */
export interface AudioPlan {
  pre: string;
  crestBudgetDb: number;
  tp: number;
  finalLimiter: string;
  label: string;
}
export function audioPlan(attempt = 0): AudioPlan {
  const steps = [
    { r: 2, t: 0.063, budget: 9, label: "gentle compression, adaptive limiter (+9 dB crest budget)" },
    { r: 3, t: 0.05, budget: 7, label: "firmer compression, tighter limiter (+7 dB)" },
    { r: 4, t: 0.04, budget: 5, label: "heavy compression, tight limiter (+5 dB)" },
  ] as const;
  const st = steps[Math.min(Math.max(attempt, 0), steps.length - 1)]!;
  return {
    pre: `acompressor=threshold=${st.t}:ratio=${st.r}:attack=15:release=150`,
    crestBudgetDb: st.budget,
    tp: -3,
    finalLimiter: "alimiter=limit=0.708:attack=5:release=50:level=disabled", // -3 dBFS: leaves ~2 dB for AAC overshoot before QA's -1 dBTP limit
    label: st.label,
  };
}

/** Pre-loudnorm limiter for a measured voice, or null when its peaks already fit under the ceiling. */
export function adaptiveLimiter(measured: { input_i: string; input_tp: string }, plan: AudioPlan): string | null {
  const lufs = Number(measured.input_i);
  const peak = Number(measured.input_tp);
  if (!Number.isFinite(lufs) || !Number.isFinite(peak)) return null;
  const ceilingDb = Math.min(-3, Math.max(-24, lufs + plan.crestBudgetDb));
  if (peak <= ceilingDb) return null;
  return `alimiter=limit=${Math.pow(10, ceilingDb / 20).toFixed(4)}:attack=1:release=30:level=disabled`;
}

export const totalDuration = (voice: Pick<VoiceDoc, "durationS">): number => Math.round((voice.durationS + TAIL_S) * 100) / 100;

/**
 * Shared final assembly for BOTH renderers: two-pass loudness normalisation of the voiceover to -14 LUFS,
 * word-highlighted captions burned in, a progress bar, H.264/AAC with faststart, plus the cover image.
 */
export async function assemble(input: AssembleInput): Promise<RenderResult> {
  const { cfg, template, script, voice, dir, base } = input;
  const runner = input.runner ?? run;
  const ff = cfg.env.FFMPEG_PATH;
  const D = totalDuration(voice);

  const cues = buildCaptionCues(voice.words, D);
  const captionsPath = join(dir, "captions.ass");
  writeFileSync(captionsPath, captionsToAss(cues, THEMES[template].accentBgr));

  // measure (after compression) -> choose the limiter ceiling from the voice's own loudness -> measure again -> linear normalise
  const plan = audioPlan(input.attempt);
  const measure = async (chain: string): Promise<LoudnessMeasure> =>
    parseLoudnorm((await runner(ff, ["-hide_banner", "-nostats", "-i", voice.audioPath, "-af", `${chain},loudnorm=I=-14:TP=${plan.tp}:LRA=11:print_format=json`, "-f", "null", "-"])).stderr);
  const m0 = await measure(plan.pre);
  const limiter = adaptiveLimiter(m0, plan);
  const chain = limiter ? `${plan.pre},${limiter}` : plan.pre;
  const m = limiter ? await measure(chain) : m0;
  const af =
    `${chain},loudnorm=I=-14:TP=${plan.tp}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,` +
    `${plan.finalLimiter},apad=pad_dur=2,atrim=0:${D.toFixed(2)}`;

  const videoPath = join(dir, "video.mp4");
  const visualOverlay = base.kind === "gradient" ? `ass=${filterPath(base.visualAssPath)},` : "";
  const bgArgs = base.kind === "gradient" ? await backgroundSource(cfg, runner, template, D) : ["-i", base.path];
  const filter =
    `[0:v]scale=1080:1920,${visualOverlay}ass=${filterPath(captionsPath)}[base];` +
    `[2:v]format=rgba[bar];[base][bar]overlay=x='-w+w*t/${D.toFixed(2)}':y=H-14:shortest=1[v];` +
    `[1:a]${af}[a]`;
  await runner(
    ff,
    [
      "-y", "-hide_banner", "-nostats",
      ...bgArgs,
      "-i", voice.audioPath,
      "-f", "lavfi", "-i", `color=c=white@0.85:s=1080x14:r=${FPS}:d=${D.toFixed(2)}`,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
      "-movflags", "+faststart",
      "-t", D.toFixed(2),
      videoPath,
    ],
    { timeoutMs: 300_000 },
  );

  // cover: clean gradient + the hook as a headline (not a frame of the busy video)
  const coverAss = join(dir, "cover.ass");
  const coverPath = join(dir, "cover.jpg");
  writeFileSync(coverAss, buildCoverAss(template, script.beats[0]?.text ?? script.title));
  await runner(ff, ["-y", "-hide_banner", "-nostats", ...(await backgroundSource(cfg, runner, template, 1)), "-vf", `ass=${filterPath(coverAss)}`, "-frames:v", "1", "-update", "1", "-q:v", "2", coverPath]);

  const info = await probe(cfg, videoPath, runner);
  return {
    renderer: input.renderer,
    videoPath,
    coverPath,
    captionsPath,
    visualPath: base.kind === "gradient" ? base.visualAssPath : base.path,
    durationS: info.durationS,
    width: info.width ?? 0,
    height: info.height ?? 0,
    fps: info.fps ?? FPS,
    sizeBytes: info.sizeBytes,
    cues,
    loudnessIn: m,
  };
}

export async function renderWithFfmpeg(input: FfmpegRenderInput): Promise<RenderResult> {
  const D = totalDuration(input.voice);
  const visualAssPath = join(input.dir, "visual.ass");
  writeFileSync(visualAssPath, buildVisualAss(input.template, input.script, input.voice.beats, D));
  return assemble({ ...input, base: { kind: "gradient", visualAssPath }, renderer: "ffmpeg" });
}
