import type { WordTiming } from "../voice/types.js";

export interface CaptionCue {
  start: number;
  end: number;
  words: WordTiming[];
}

const MAX_WORDS = 4;
const MAX_CHARS = 26;

/** Groups timed words into short on-screen chunks, breaking at punctuation. Pure; used by render and by QA's sync check. */
export function buildCaptionCues(words: WordTiming[], videoDurationS: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let cur: WordTiming[] = [];
  const flush = () => {
    if (cur.length) cues.push({ start: cur[0]!.s, end: cur[cur.length - 1]!.e, words: cur });
    cur = [];
  };
  for (const w of words) {
    const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    if (cur.length >= MAX_WORDS || (cur.length > 0 && chars > MAX_CHARS)) flush();
    cur.push(w);
    if (/[.!?,;:]$/.test(w.w)) flush();
  }
  flush();
  // hold each cue until just before the next one starts (no flicker), never past the video end
  return cues.map((c, i) => {
    const nextStart = cues[i + 1]?.start ?? videoDurationS;
    return { ...c, end: Math.min(videoDurationS, Math.max(c.end, Math.min(c.end + 0.25, nextStart - 0.02))) };
  });
}

export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** `{`/`}` open ASS override blocks, so spoken text containing braces must be neutralised. */
export const escapeAss = (t: string): string => t.replace(/[{}]/g, "").replace(/\\/g, "").replace(/\r?\n/g, "\\N");

export const FONT = "DejaVu Sans";

export const ASS_HEADER = (extraStyles: string): string => `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${extraStyles}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

/** Karaoke captions: words switch from white to the accent colour as they are spoken. */
export function captionsToAss(cues: CaptionCue[], accentBgr: string): string {
  const style = `Style: Cap,${FONT},74,&H00${accentBgr},&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,7,2,2,80,80,360,1`;
  const lines = cues.map((c) => {
    const text = c.words
      .map((w, i) => {
        const next = c.words[i + 1];
        const cs = Math.max(1, Math.round(((next ? next.s : w.e) - w.s) * 100));
        return `{\\kf${cs}}${escapeAss(w.w)}`;
      })
      .join(" ");
    return `Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${text}`;
  });
  return ASS_HEADER(style) + lines.join("\n") + "\n";
}

/** Reads Dialogue start/end seconds back from an ASS file (QA uses this to check what was actually burned in). */
export function parseAssDialogue(ass: string): Array<{ start: number; end: number; text: string }> {
  const toS = (t: string) => {
    const [h, m, s] = t.split(":");
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  };
  return ass
    .split("\n")
    .filter((l) => l.startsWith("Dialogue:"))
    .map((l) => {
      const parts = l.slice("Dialogue:".length).split(",");
      return { start: toS(parts[1]!.trim()), end: toS(parts[2]!.trim()), text: parts.slice(9).join(",").replace(/\{[^}]*\}/g, "").trim() };
    });
}
