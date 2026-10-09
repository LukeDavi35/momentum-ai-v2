import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/index.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

/** Runs a binary with a timeout. ffmpeg writes progress/analysis to stderr, so both streams are returned. */
export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 180_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { code?: string | number };
        reject(new Error(`${cmd} failed (${e.code ?? "?"}): ${(stderr || e.message).toString().slice(-1500)}`));
      } else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });

/** Per-piece working directory: <MEDIA_DIR>/<contentId>/r<regen>/ */
export function workDir(cfg: AppConfig, contentId: string, regen: number): string {
  const dir = join(cfg.env.MEDIA_DIR, contentId, `r${regen}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface MediaInfo {
  durationS: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  sizeBytes: number;
  hasAudio: boolean;
}

export async function probe(cfg: AppConfig, path: string, runner: Runner = run): Promise<MediaInfo> {
  const { stdout } = await runner(cfg.env.FFPROBE_PATH, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  const j = JSON.parse(stdout);
  const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
  const a = (j.streams ?? []).find((s: any) => s.codec_type === "audio");
  const [num, den] = String(v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationS: Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0),
    width: v?.width,
    height: v?.height,
    fps: den ? Math.round(((num ?? 0) / den) * 100) / 100 : undefined,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    sizeBytes: Number(j.format?.size ?? 0),
    hasAudio: !!a,
  };
}
