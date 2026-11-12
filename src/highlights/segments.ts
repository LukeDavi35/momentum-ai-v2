import type { SourceItem } from "../ingest/types.js";
import type { ScriptDoc } from "../script/types.js";
import type { Compilation, HighlightStory } from "./types.js";

const TITLE_MAX = 44;
const shorten = (s: string, max = TITLE_MAX): string => {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : cut.length)}…`;
};

/**
 * Decides which beats belong to which story, from what the script actually cites: a beat whose claims come from story
 * k's sources is story k's. Beats with no claims inherit position — before the first story's beat it is the hook,
 * after the last it is the call to action, in between it belongs to the story just before it. A story the writer
 * left out (or whose beats were stripped by the fact-check) simply has no segment. Pure; unit-tested.
 */
export function planCompilation(script: Pick<ScriptDoc, "beats" | "claims">, stories: HighlightStory[], date: string): Compilation {
  const storyOfSource = new Map<string, number>();
  stories.forEach((s, i) => s.sourceItemIds.forEach((id) => storyOfSource.has(id) || storyOfSource.set(id, i)));
  const claimStory = new Map<string, number>();
  for (const c of script.claims) {
    const k = c.sourceItemId ? storyOfSource.get(c.sourceItemId) : undefined;
    if (k !== undefined) claimStory.set(c.id, k);
  }

  const owner = script.beats.map((b) => {
    const votes = new Map<number, number>();
    for (const id of b.claimIds) {
      const k = claimStory.get(id);
      if (k !== undefined) votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  });
  const firstOwned = owner.findIndex((o) => o !== null);
  const lastOwned = owner.length - 1 - [...owner].reverse().findIndex((o) => o !== null);

  const segments = new Map<number, { beatIds: string[]; title: string }>();
  const intro: string[] = [];
  const outro: string[] = [];
  let current: number | null = null;
  script.beats.forEach((b, i) => {
    if (firstOwned === -1 || i < firstOwned) return void intro.push(b.id);
    if (i > lastOwned && owner[i] === null) return void outro.push(b.id);
    if (owner[i] !== null) current = owner[i];
    if (current === null) return void intro.push(b.id);
    const seg = segments.get(current) ?? { beatIds: [], title: "" };
    seg.beatIds.push(b.id);
    if (!seg.title && owner[i] !== null) seg.title = shorten(b.onScreen?.trim() || stories[current]!.headline);
    segments.set(current, seg);
  });

  return {
    date,
    introBeatIds: intro,
    outroBeatIds: outro,
    segments: [...segments.entries()]
      .sort((a, b) => script.beats.findIndex((x) => x.id === a[1].beatIds[0]) - script.beats.findIndex((x) => x.id === b[1].beatIds[0]))
      .map(([k, v]) => ({ storyIndex: k, headline: v.title || shorten(stories[k]!.headline), beatIds: v.beatIds, footage: stories[k]!.footage })),
  };
}

/** Source ids of the stories actually told (for credits and QA). */
export const tellsSources = (c: Compilation, stories: HighlightStory[], sources: SourceItem[]): SourceItem[] => {
  const ids = new Set(c.segments.flatMap((s) => stories[s.storyIndex]?.sourceItemIds ?? []));
  return sources.filter((s) => ids.has(s.id));
};
