import type { WordTiming } from "./types.js";

/** ElevenLabs returns per-CHARACTER start/end times; fold them into whitespace-delimited words. */
export function wordsFromCharAlignment(chars: string[], starts: number[], ends: number[]): WordTiming[] {
  const words: WordTiming[] = [];
  let cur = "";
  let s = 0;
  let e = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (/\s/.test(ch)) {
      if (cur) words.push({ w: cur, s, e });
      cur = "";
      continue;
    }
    if (!cur) s = starts[i] ?? e;
    cur += ch;
    e = ends[i] ?? e;
  }
  if (cur) words.push({ w: cur, s, e });
  return words;
}

/**
 * Fallback when a provider gives no timing: spread the real (probed) audio duration across the
 * words in proportion to their length, with a little extra weight after punctuation (pauses).
 * Approximate by nature — the QA caption-sync check measures it against the real audio.
 */
export function estimateWordTimings(text: string, durationS: number, leadInS = 0.05): WordTiming[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || durationS <= 0) return [];
  const weight = (t: string) => t.length + 2 + (/[.!?]$/.test(t) ? 3 : /[,;:]$/.test(t) ? 1.5 : 0);
  const total = tokens.reduce((s, t) => s + weight(t), 0);
  const usable = Math.max(0.1, durationS - leadInS);
  let at = leadInS;
  return tokens.map((t) => {
    const len = (weight(t) / total) * usable;
    const w = { w: t, s: round(at), e: round(at + len) };
    at += len;
    return w;
  });
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface BeatTiming {
  id: string;
  start: number;
  end: number;
  wordStart: number;
  wordEnd: number;
}

/** Map each beat to its time span by counting its words against the flat word-timing list. */
export function beatTimings(beats: Array<{ id: string; text: string }>, words: WordTiming[]): BeatTiming[] {
  const out: BeatTiming[] = [];
  let idx = 0;
  for (const b of beats) {
    const n = b.text.split(/\s+/).filter(Boolean).length;
    const first = words[Math.min(idx, words.length - 1)];
    const last = words[Math.min(idx + n - 1, words.length - 1)];
    if (!first || !last) break;
    out.push({ id: b.id, start: first.s, end: last.e, wordStart: idx, wordEnd: idx + n });
    idx += n;
  }
  return out;
}
