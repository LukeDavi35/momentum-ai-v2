import type { Template } from "../config/index.js";

export interface TemplateSpec {
  structure: string;
  visual: string;
}

/** Per-template writing guidance. `structure` shapes the beats; `visual` says what to put in the `visual` block. */
export const TEMPLATE_SPECS: Record<Template, TemplateSpec> = {
  news_flash: {
    structure:
      "Beat 1 = hook headline (what happened, <=14 words). Then 3 key points (who / what / when-where), then one line on why it matters, then a short follow call-to-action. Only facts from the sources.",
    visual: 'headline = the news in <=8 words; items = the 3 key points as <=6-word chips.',
  },
  stat_spotlight: {
    structure:
      "Beat 1 = hook built around ONE striking number from the source. Then what the number is, the context (who/where/when), how it compares ONLY if the source gives the comparison, and a short call-to-action.",
    visual: 'headline = what the stat is about; stat = the number exactly as in the source (e.g. "3:49.04"); statLabel = what it measures (e.g. "new 1500m world record").',
  },
  race_recap: {
    structure:
      "Beat 1 = hook with the headline result. Then winner and the result, the key moment of the race, notable reactions or consequences from the source, and what happens next if the source says. Short call-to-action.",
    visual: 'headline = event name; items = result lines such as "1. Name - time" ONLY if each is in a source.',
  },
  training_tip: {
    structure:
      "Beat 1 = hook promising 3 quick tips. Then exactly 3 tips, one beat each, each a plain general-interest statement (kind=general claims, NO numbers or names). Final beat: remind viewers this is general information, not personal advice, and ask them to follow.",
    visual: 'headline = the tip theme; items = the 3 tips as <=6-word chips.',
  },
  quick_explainer: {
    structure:
      "Beat 1 = hook as a question the viewer wants answered. Then explain ONE concept in 3 simple beats (what it is, how it works, why it matters), using general-interest statements only (kind=general, NO numbers or names unless sourced). Short call-to-action.",
    visual: 'headline = the concept in <=6 words; items = 3 plain-language steps as <=6-word chips.',
  },
};

export const PLATFORM_NOTES = `Platform variants (all required):
- tiktok: caption <= 150 chars (the hook, no hashtags inside), hashtags: 3-5 relevant tags without the # symbol.
- instagram: caption <= 300 chars, hashtags: 3-6 tags without #.
- youtube: title <= 90 chars (descriptive, not clickbait), description <= 300 chars, hashtags: 2-4 tags without #.`;
