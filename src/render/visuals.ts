import type { Template } from "../config/index.js";
import type { ScriptDoc } from "../script/types.js";
import type { BeatTiming } from "../voice/align.js";
import { assTime, ASS_HEADER, escapeAss, FONT } from "./captions.js";

export interface Theme {
  label: string;
  /** Background gradient endpoints as 0xRRGGBB for ffmpeg. */
  c0: string;
  c1: string;
  /** Accent as ASS BGR hex (no &H / alpha). */
  accentBgr: string;
}

export const THEMES: Record<Template, Theme> = {
  news_flash: { label: "NEWS FLASH", c0: "0x0b1736", c1: "0x1d4ed8", accentBgr: "00E5FF" },
  stat_spotlight: { label: "STAT SPOTLIGHT", c0: "0x2a0b3a", c1: "0xbe185d", accentBgr: "5EE7FF" },
  race_recap: { label: "RACE RECAP", c0: "0x3a1405", c1: "0xea580c", accentBgr: "FFFFFF" },
  training_tip: { label: "TRAINING TIP", c0: "0x052e22", c1: "0x0d9488", accentBgr: "9DF5C7" },
  quick_explainer: { label: "QUICK EXPLAINER", c0: "0x14123a", c1: "0x4338ca", accentBgr: "FFD36B" },
};

const WHITE = "&H00FFFFFF";

const STYLES = (accent: string) =>
  [
    `Style: Brand,${FONT},38,&H00${accent},&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,6,0,1,0,0,7,70,70,90,1`,
    `Style: Label,${FONT},38,${WHITE},&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,4,0,1,0,0,9,70,70,90,1`,
    `Style: Headline,${FONT},84,${WHITE},&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,3,8,80,80,190,1`,
    `Style: Stat,${FONT},250,&H00${accent},&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,8,4,5,60,60,0,1`,
    `Style: StatLabel,${FONT},58,${WHITE},&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,5,110,110,0,1`,
    `Style: Card,${FONT},68,${WHITE},&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,3,5,100,100,0,1`,
    `Style: Chip,${FONT},56,${WHITE},&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,4,110,90,0,1`,
    `Style: Disclosure,${FONT},30,&H99FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,2,0,1,0,0,1,70,70,70,1`,
  ].join("\n");

/**
 * The "template" in the FFmpeg renderer: a second ASS track holding everything that isn't a
 * caption — brand tag, template label, headline, stat / progressive item chips / per-beat cards,
 * and the on-video AI-voice disclosure.
 */
export function buildVisualAss(template: Template, script: ScriptDoc, beats: BeatTiming[], durationS: number): string {
  const theme = THEMES[template];
  const ev: string[] = [];
  const add = (layer: number, start: number, end: number, style: string, text: string, margins = "0,0,0") =>
    ev.push(`Dialogue: ${layer},${assTime(start)},${assTime(Math.min(end, durationS))},${style},,${margins},,${text}`);

  add(0, 0, durationS, "Brand", "MOMENTUM");
  add(0, 0, durationS, "Label", theme.label);
  if (script.visual.headline) add(0, 0, durationS, "Headline", `{\\fad(250,0)}${escapeAss(script.visual.headline)}`);

  const second = beats[1]?.start ?? 0.9;
  if (template === "stat_spotlight" && script.visual.stat) {
    add(0, second, durationS, "Stat", `{\\fad(250,0)\\fscx70\\fscy70\\t(0,300,\\fscx100\\fscy100)}${escapeAss(script.visual.stat)}`, "0,0,0");
    if (script.visual.statLabel) add(0, second + 0.2, durationS, "StatLabel", `{\\fad(300,0)\\pos(540,1180)}${escapeAss(script.visual.statLabel)}`);
  } else {
    const items = script.visual.items ?? [];
    if (items.length > 0) {
      items.forEach((item, i) => {
        // each chip appears when its beat begins (item i <-> beat i+1, after the hook) and stays
        const at = beats[Math.min(i + 1, beats.length - 1)]?.start ?? second + i * 1.5;
        const y = 820 + i * 135;
        add(0, at, durationS, "Chip", `{\\fad(200,0)\\pos(110,${y})}{\\c&H${theme.accentBgr}&\\b1}${i + 1}{\\c${WHITE}&}   ${escapeAss(item)}`);
      });
    } else {
      script.beats.forEach((b, i) => {
        const t = beats.find((x) => x.id === b.id);
        const text = b.onScreen?.trim();
        if (!t || !text || i === 0) return;
        add(0, t.start, Math.max(t.end, t.start + 1), "Card", `{\\fad(180,120)}${escapeAss(text)}`);
      });
    }
  }
  add(0, 0, durationS, "Disclosure", "AI-assisted video · synthetic voice");
  return ASS_HEADER(STYLES(theme.accentBgr)) + ev.join("\n") + "\n";
}

/** Cover frame: the hook as a big headline over a frame from the video. */
export function buildCoverAss(template: Template, hook: string): string {
  const theme = THEMES[template];
  const style = [
    `Style: Brand,${FONT},44,&H00${theme.accentBgr},&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,6,0,1,0,0,8,70,70,120,1`,
    `Style: Hook,${FONT},96,${WHITE},&H00FFFFFF,&H00000000,&HAA000000,-1,0,0,0,100,100,0,0,1,10,4,5,90,90,0,1`,
  ].join("\n");
  return (
    ASS_HEADER(style) +
    `Dialogue: 0,0:00:00.00,0:00:10.00,Brand,,0,0,0,,MOMENTUM · ${theme.label}\n` +
    `Dialogue: 0,0:00:00.00,0:00:10.00,Hook,,0,0,0,,${escapeAss(hook.length > 90 ? `${hook.slice(0, 87)}...` : hook)}\n`
  );
}
