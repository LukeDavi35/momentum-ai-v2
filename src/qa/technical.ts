import { readFileSync } from "node:fs";
import type { AppConfig } from "../config/index.js";
import { probe, run, type MediaInfo, type Runner } from "../media/exec.js";
import { parseAssDialogue, type CaptionCue } from "../render/captions.js";
import type { VoiceDoc } from "../voice/agent.js";
import type { WordTiming } from "../voice/types.js";

export interface Check {
  name: string;
  ok: boolean;
  value?: number | string;
  expected?: string;
  message: string;
}

export interface TechnicalInput {
  cfg: AppConfig;
  videoPath: string;
  captionsPath: string;
  cues: CaptionCue[];
  voice: Pick<VoiceDoc, "words" | "timingSource" | "durationS">;
  hookWords: number;
  runner?: Runner;
}

const ck = (name: string, ok: boolean, message: string, value?: number | string, expected?: string): Check => ({ name, ok, message, value, expected });
const r2 = (n: number): number => Math.round(n * 100) / 100;

// --- pure checks (unit-tested without ffmpeg) -----------------------------------------------

export function checkContainer(info: MediaInfo, t: AppConfig["qa"]["technical"]): Check[] {
  return [
    ck("duration", info.durationS >= t.minDurationS && info.durationS <= t.maxDurationS, `duration ${r2(info.durationS)}s`, r2(info.durationS), `${t.minDurationS}-${t.maxDurationS}s`),
    ck("resolution", info.width === t.width && info.height === t.height, `resolution ${info.width}x${info.height}`, `${info.width}x${info.height}`, `${t.width}x${t.height}`),
    ck("video_codec", info.videoCodec === "h264", `video codec ${info.videoCodec}`, info.videoCodec, "h264"),
    ck("audio_present", info.hasAudio && info.audioCodec === "aac", `audio ${info.audioCodec ?? "missing"}`, info.audioCodec ?? "none", "aac"),
    ck("fps", (info.fps ?? 0) >= 24 && (info.fps ?? 0) <= 60, `fps ${info.fps}`, info.fps, "24-60"),
    ck("file_size", info.sizeBytes <= t.maxFileSizeMB * 1e6, `${r2(info.sizeBytes / 1e6)} MB`, r2(info.sizeBytes / 1e6), `<= ${t.maxFileSizeMB} MB`),
  ];
}

export function checkLoudness(integratedLufs: number, truePeakDb: number, t: AppConfig["qa"]["technical"]): Check[] {
  return [
    ck("loudness", Math.abs(integratedLufs - t.targetLufs) <= t.lufsTolerance, `integrated ${r2(integratedLufs)} LUFS`, r2(integratedLufs), `${t.targetLufs} ±${t.lufsTolerance} LUFS`),
    ck("true_peak", truePeakDb <= t.maxTruePeakDb, `true peak ${r2(truePeakDb)} dBTP`, r2(truePeakDb), `<= ${t.maxTruePeakDb} dBTP`),
  ];
}

export function checkBlackFrames(blackSeconds: number, startsBlack: boolean, t: AppConfig["qa"]["technical"]): Check[] {
  return [
    ck("black_frames", blackSeconds <= t.maxBlackSeconds, `${r2(blackSeconds)}s of black frames`, r2(blackSeconds), `<= ${t.maxBlackSeconds}s`),
    ck("no_black_start", !startsBlack, startsBlack ? "video opens on black" : "video does not open on black"),
  ];
}

/**
 * Caption sync, checked against what was actually written to disk (captions.ass), not just in memory:
 *  - every spoken word appears in the burned-in captions, in order
 *  - each caption starts within `tol` of its first word's start
 *  - nothing starts before 0 or ends after the video
 *  - word timings themselves are monotonic and inside the audio
 * `estimated` timing (providers with no alignment) gets a wider tolerance — documented limitation.
 */
export function checkCaptionSync(args: {
  assText: string;
  cues: CaptionCue[];
  words: WordTiming[];
  timingSource: "provider" | "estimated";
  videoDurationS: number;
  audioDurationS: number;
  tol: number;
}): Check[] {
  const { assText, cues, words, timingSource, videoDurationS, audioDurationS } = args;
  const tol = timingSource === "provider" ? args.tol : Math.max(args.tol, 0.6);
  const burned = parseAssDialogue(assText).filter((d) => d.text.length > 0 && d.start >= 0).filter((d) => !/^(MOMENTUM|AI-assisted)/.test(d.text));
  const checks: Check[] = [];

  const spoken = words.map((w) => w.w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const shown = burned.flatMap((d) => d.text.split(/\s+/)).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  checks.push(ck("captions_match_speech", spoken.length > 0 && spoken.join(" ") === shown.join(" "), spoken.join(" ") === shown.join(" ") ? `${spoken.length} words, all captioned in order` : `captioned ${shown.length} words vs ${spoken.length} spoken`, shown.length, String(spoken.length)));

  let worst = 0;
  cues.forEach((c, i) => {
    const d = burned[i];
    if (d) worst = Math.max(worst, Math.abs(d.start - c.start));
  });
  checks.push(ck("captions_on_disk_match_cues", burned.length === cues.length && worst <= 0.02, `${burned.length}/${cues.length} cues, worst drift ${r2(worst)}s`, r2(worst), "<= 0.02s"));

  const first = words[0];
  const sync = first && cues[0] ? Math.abs(cues[0].start - first.s) : 99;
  checks.push(ck("first_caption_sync", sync <= tol, `first caption ${r2(sync)}s from first word (${timingSource} timing)`, r2(sync), `<= ${tol}s`));

  const inRange = burned.every((d) => d.start >= 0 && d.end <= videoDurationS + 0.05 && d.end > d.start);
  checks.push(ck("captions_in_range", inRange, inRange ? "all captions inside the video" : "a caption starts before 0 or ends after the video end"));

  let monotonic = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.e < w.s || (i > 0 && w.s + 0.001 < words[i - 1]!.s)) monotonic = false;
  }
  const lastEnd = words[words.length - 1]?.e ?? 0;
  checks.push(ck("word_timings_valid", monotonic && lastEnd <= audioDurationS + tol, monotonic ? `speech ends at ${r2(lastEnd)}s of ${r2(audioDurationS)}s audio` : "word timings are not monotonic", r2(lastEnd), `<= ${r2(audioDurationS)}s`));
  return checks;
}

export function checkHook(hookWords: number, firstWordStart: number, t: AppConfig["qa"]["technical"]): Check[] {
  return [
    ck("hook_length", hookWords > 0 && hookWords <= t.maxHookWords, `hook is ${hookWords} words`, hookWords, `1-${t.maxHookWords} words`),
    ck("hook_starts_immediately", firstWordStart <= 0.8, `speech starts at ${r2(firstWordStart)}s`, r2(firstWordStart), "<= 0.8s"),
  ];
}

// --- ffmpeg measurements -----------------------------------------------------------------

export function parseBlackDetect(stderr: string): { total: number; startsBlack: boolean } {
  let total = 0;
  let startsBlack = false;
  for (const m of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    total += Number(m[3]);
    if (Number(m[1]) < 0.05 && Number(m[3]) >= 0.2) startsBlack = true;
  }
  return { total, startsBlack };
}

export function parseVolumeDetect(stderr: string): number | null {
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/);
  return m ? (m[1] === "-inf" ? -120 : Number(m[1])) : null;
}

export async function runTechnicalChecks(input: TechnicalInput): Promise<Check[]> {
  const { cfg, videoPath } = input;
  const t = cfg.qa.technical;
  const runner = input.runner ?? run;
  const ff = cfg.env.FFMPEG_PATH;
  const checks: Check[] = [];

  const info = await probe(cfg, videoPath, runner);
  checks.push(...checkContainer(info, t));

  const loud = await runner(ff, ["-hide_banner", "-nostats", "-i", videoPath, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-vn", "-f", "null", "-"]);
  const j = JSON.parse(loud.stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/)![0]);
  checks.push(...checkLoudness(Number(j.input_i), Number(j.input_tp), t));

  const vol = await runner(ff, ["-hide_banner", "-nostats", "-i", videoPath, "-af", "volumedetect", "-vn", "-f", "null", "-"]);
  const mean = parseVolumeDetect(vol.stderr);
  checks.push(ck("not_silent", mean !== null && mean > -45, `mean volume ${mean} dB`, mean ?? "n/a", "> -45 dB"));

  const black = await runner(ff, ["-hide_banner", "-nostats", "-i", videoPath, "-an", "-vf", "blackdetect=d=0.1:pix_th=0.05:pic_th=0.98", "-f", "null", "-"]);
  const bd = parseBlackDetect(black.stderr);
  checks.push(...checkBlackFrames(bd.total, bd.startsBlack, t));

  checks.push(
    ...checkCaptionSync({
      assText: readFileSync(input.captionsPath, "utf8"),
      cues: input.cues,
      words: input.voice.words,
      timingSource: input.voice.timingSource,
      videoDurationS: info.durationS,
      audioDurationS: input.voice.durationS,
      tol: t.captionSyncToleranceS,
    }),
  );
  checks.push(...checkHook(input.hookWords, input.voice.words[0]?.s ?? 99, t));
  return checks;
}
