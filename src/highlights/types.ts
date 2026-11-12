import type { Pillar } from "../config/index.js";
import type { FootageRef } from "../footage/types.js";

/** One story picked for the day's compilation. Stored on the content row's idea so the script stage knows what to write about. */
export interface HighlightStory {
  clusterId: string;
  headline: string;
  pillar: Pillar;
  /** source_items ids, factual (news/results) first. The script may only state what these say. */
  sourceItemIds: string[];
  /** Search words for illustrative footage (about the sport, never the named people). */
  query: string;
  footage: FootageRef | null;
}

export interface HighlightsIdea {
  /** Local calendar day this compilation is for, "YYYY-MM-DD" in the schedule timezone. One compilation per day. */
  date: string;
  stories: HighlightStory[];
}

/** One story's stretch of the video: its beats and the clip behind them. The first segment also covers the hook, the last the call to action. */
export interface CompilationSegment {
  storyIndex: number;
  headline: string;
  /** Beats that tell this story (the intro hook / outro CTA are in `introBeatIds` / `outroBeatIds`). */
  beatIds: string[];
  footage: FootageRef | null;
}

export interface Compilation {
  date: string;
  segments: CompilationSegment[];
  introBeatIds: string[];
  outroBeatIds: string[];
}
