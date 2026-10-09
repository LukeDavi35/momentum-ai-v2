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
}

export async function renderWithFfmpeg(input: FfmpegRenderInput): Promise<RenderResult> {
  const { cfg, template, script, voice, dir } = input;
  const runner = input.runner ?? run;
  const ff = cfg.env.FFMPEG_PATH;
  const D = Math.round((voice.durationS + TAIL_S) * 100) / 100;

  const cues = buildCaptionCues(voice.words, D);
  const captionsPath = join(dir, "captions.ass");
  const visualPath = join(dir, "visual.ass");
  writeFileSync(captionsPath, captionsToAss(cues, THEMES[template].accentBgr));
  writeFileSync(visualPath, buildVisualAss(template, script, voice.beats, D));

  // pass 1: measure the voiceover's loudness so pass 2 can normalise it linearly to the target
  const p1 = await runner(ff, ["-hide_banner", "-nostats", "-i", voice.audioPath, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
  const m = parseLoudnorm(p1.stderr);
  const af =
    `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,` +
    `apad=pad_dur=2,atrim=0:${D.toFixed(2)}`;

  const videoPath = join(dir, "video.mp4");
  const bg = await backgroundSource(cfg, runner, template, D);
  const filter =
    `[0:v]ass=${filterPath(visualPath)},ass=${filterPath(captionsPath)}[base];` +
    `[2:v]format=rgba[bar];[base][bar]overlay=x='-w+w*t/${D.toFixed(2)}':y=H-14:shortest=1[v];` +
    `[1:a]${af}[a]`;
  await runner(
    ff,
    [
      "-y", "-hide_banner", "-nostats",
      ...bg,
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
    renderer: "ffmpeg",
    videoPath,
    coverPath,
    captionsPath,
    visualPath,
    durationS: info.durationS,
    width: info.width ?? 0,
    height: info.height ?? 0,
    fps: info.fps ?? FPS,
    sizeBytes: info.sizeBytes,
    cues,
    loudnessIn: m,
  };
}
