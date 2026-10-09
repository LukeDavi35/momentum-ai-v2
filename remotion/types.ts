export type TemplateId = "news_flash" | "stat_spotlight" | "race_recap" | "training_tip" | "quick_explainer";

/** Everything the composition needs, JSON-serialisable so it can be passed as Remotion inputProps. */
export type MomentumProps = {
  template: TemplateId;
  durationS: number;
  fps: number;
  theme: { label: string; c0: string; c1: string; accent: string };
  headline: string;
  stat: string | null;
  statLabel: string | null;
  items: string[];
  /** Seconds at which each item chip appears (aligned with its beat in the voiceover). */
  itemTimes: number[];
  /** Per-beat on-screen cards, used when a template has no items/stat. */
  cards: Array<{ text: string; start: number; end: number }>;
  /** Seconds at which the stat appears. */
  statAt: number;
};
