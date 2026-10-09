import { z } from "zod";
import { HOOK_STYLES } from "../ideate/weights.js";

export const claimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(3).max(400),
  /** Alias "S1".."Sn" in the prompt; resolved to a source_items UUID after parsing. null for `general` claims. */
  source: z.string().nullable(),
  kind: z.enum(["fact", "stat", "quote", "general"]),
  /** For kind=quote: the exact words, which must appear verbatim in the source. */
  quote: z.string().nullable().optional(),
});
export type Claim = z.infer<typeof claimSchema> & { sourceItemId?: string | null };

export const beatSchema = z.object({
  id: z.string().min(1),
  /** Exactly what the voiceover says. */
  text: z.string().min(2).max(400),
  /** Short text shown on screen during this beat. */
  onScreen: z.string().max(90).default(""),
  claimIds: z.array(z.string()).default([]),
});
export type Beat = z.infer<typeof beatSchema>;

const hashtags = z.array(z.string().min(1).max(40)).max(12).default([]);

export const scriptWriterSchema = z.object({
  title: z.string().min(3).max(100),
  hookStyle: z.enum(HOOK_STYLES),
  beats: z.array(beatSchema).min(3).max(10),
  claims: z.array(claimSchema).max(30),
  visual: z.object({
    headline: z.string().max(80),
    stat: z.string().max(24).nullable().optional(),
    statLabel: z.string().max(60).nullable().optional(),
    items: z.array(z.string().max(80)).max(6).nullable().optional(),
  }),
  variants: z.object({
    tiktok: z.object({ caption: z.string().max(400), hashtags }),
    instagram: z.object({ caption: z.string().max(1200), hashtags }),
    youtube: z.object({ title: z.string().max(100), description: z.string().max(2000), hashtags }),
  }),
});
export type ScriptWriterOutput = z.infer<typeof scriptWriterSchema>;

/** What is persisted in content.script. */
export interface ScriptDoc extends Omit<ScriptWriterOutput, "claims"> {
  claims: Claim[];
  /** source alias -> source_items.id, kept so the reviewer/QA can re-resolve citations. */
  sourceAliases: Record<string, string>;
  estimatedDurationS: number;
  /** Beat ids removed by the fact-check pre-filter, with the reason — shown on the dashboard. */
  removed: Array<{ beatId: string; reason: string }>;
  generator: "live" | "stub";
}

export const WORDS_PER_SECOND = 2.6; // ~155 wpm, typical TTS pace

export const narrationOf = (s: { beats: Beat[] }): string => s.beats.map((b) => b.text.trim()).join(" ");
export const wordCount = (t: string): number => t.split(/\s+/).filter(Boolean).length;
export const estimateDurationS = (s: { beats: Beat[] }): number => Math.round((wordCount(narrationOf(s)) / WORDS_PER_SECOND) * 10) / 10;
