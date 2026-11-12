import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, Template } from "../config/index.js";
import type { FootageRef } from "../footage/types.js";
import type { Compilation } from "../highlights/types.js";
import type { Runner } from "../media/exec.js";
import type { ScriptDoc } from "../script/types.js";
import type { BeatTiming } from "../voice/align.js";
import { backgroundSource, FPS } from "./ffmpegRenderer.js";

export interface Span {
  /** Index into compilation.segments. */
  segment: number;
  start: number;
  end: number;
  footage: FootageRef | null;
}

/**
 * Turns the compilation into contiguous time spans that exactly cover [0, totalS]: each story's span starts when its
 * first beat is spoken, the first span also covers the hook (starts at 0) and the last also covers the sign-off.
 * Beats missing from the voice timing are ignored, so a span can never start at an undefined time.
 */
export function planSpans(compilation: Compilation, beats: Pick<BeatTiming, "id" | "start">[], totalS: number): Span[] {
  const startOf = new Map(beats.map((b) => [b.id, b.start]));
  const segs = compilation.segments
    .map((seg, segment) => ({ seg, segment, at: seg.beatIds.map((id) => startOf.get(id)).find((t): t is number => t !== undefined) }))
    .filter((s): s is { seg: Compilation["segments"][number]; segment: number; at: number } => s.at !== undefined)
    .sort((a, b) => a.at - b.at);
  return segs.map((s, i) => ({
    segment: s.segment,
    start: i === 0 ? 0 : s.at,
    end: i === segs.length - 1 ? totalS : segs[i + 1]!.at,
    footage: s.seg.footage,
  }));
}

/**
 * Cover-crops footage to 1080x1920 and dims it (plus a soft vignette) so captions and titles stay readable. Footage shorter than its span loops (bounded by -t, never by -shortest:
 * v1 found `-shortest` with a looped input buffers ~10 s of raw frames and exhausts a 2.5 GB VM).
 */
export function footageFilter(): string {
  return [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    "setsar=1",
    `fps=${FPS}`,
    "eq=brightness=-0.12:saturation=0.95",
    "vignette=PI/4", // soft darkening towards the edges, where the titles, captions and credit sit (no hard-edged bands)
    "format=yuv420p",
  ].join(",");
}

// a function, not a constant: ffmpegRenderer and this file import each other, so FPS must only be read at call time
const encodeArgs = (): string[] => ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS)];

/**
 * Renders each span to its own file (one ffmpeg at a time: bounded memory) and joins them with the concat demuxer
 * (stream copy: every piece is encoded identically). The last span runs half a second long so the montage can never be
 * shorter than the voiceover; the final assembly trims to the exact length.
 */
export async function renderMontage(input: { cfg: AppConfig; template: Template; spans: Span[]; dir: string; runner: Runner }): Promise<string> {
  const { cfg, template, spans, dir, runner } = input;
  const ff = cfg.env.FFMPEG_PATH;
  const files: string[] = [];
  for (const [i, span] of spans.entries()) {
    const dur = span.end - span.start + (i === spans.length - 1 ? 0.5 : 0);
    const out = join(dir, `seg${i}.mp4`);
    if (span.footage) {
      await runner(ff, ["-y", "-hide_banner", "-nostats", "-stream_loop", "-1", "-i", span.footage.localPath, "-t", dur.toFixed(3), "-vf", footageFilter(), ...encodeArgs(), out], { timeoutMs: 240_000 });
    } else {
      // no licensed clip for this story: the template's animated gradient, with its own drawbox-free look
      await runner(ff, ["-y", "-hide_banner", "-nostats", ...(await backgroundSource(cfg, runner, template, dur)), "-t", dur.toFixed(3), "-vf", `fps=${FPS},format=yuv420p`, ...encodeArgs(), out], { timeoutMs: 240_000 });
    }
    files.push(out);
  }
  const list = join(dir, "montage.txt");
  writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const montage = join(dir, "montage.mp4");
  await runner(ff, ["-y", "-hide_banner", "-nostats", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", montage], { timeoutMs: 120_000 });
  return montage;
}

/** Lines that must be credited: every clip used, once. */
export const footageCredits = (script: Pick<ScriptDoc, "compilation">): string[] => [...new Set((script.compilation?.segments ?? []).map((s) => s.footage?.credit).filter((c): c is string => !!c))];
