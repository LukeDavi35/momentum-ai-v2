import type { Cluster } from "../ideate/cluster.js";
import { footageQuery } from "../footage/query.js";
import type { HighlightStory } from "./types.js";

/** Columns, previews and listicles read as "stories" to a clusterer but aren't news a highlights reel can fact-check. */
export const NOT_A_NEWS_STORY = /\b(mailbag|power rankings?|predictions?|picks|preview|podcast|newsletter|quiz|how to watch|live blog|as it happened|awards?|slate|football daily)\b|^[^|]{3,40}\s\|\s/i;

/**
 * Picks the day's stories from clustered, safety-filtered news: corroborated stories (two or more outlets) first, then
 * strongest (velocity, then number of independent factual sources), skipping columns and previews, but preferring a different sport for each slot so the video isn't four versions of the same match.
 * Only clusters with a factual (news/results) source qualify — the script may cite nothing else. Pure; unit-tested.
 */
export type PickedStory = Omit<HighlightStory, "footage"> & { /** independent outlets covering it */ outlets: number; /** lead article summary, for whoever (or whatever) chooses between candidates */ summary: string };

export function selectStories(clusters: Cluster[], max: number): PickedStory[] {
  const factual = clusters.filter((c) => c.citable.length > 0);
  const news = factual.filter((c) => !NOT_A_NEWS_STORY.test(c.headline));
  const pool = (news.length >= 2 ? news : factual) // a quiet news day falls back to columns rather than to no video
    .map((c) => ({ c, query: footageQuery(c.headline, c.pillar, c.items.slice(0, 3).map((i) => i.summary ?? "").join(" ")) }))
    .sort(
      (a, b) =>
        Number((b.c.sources?.length ?? 0) >= 2) - Number((a.c.sources?.length ?? 0) >= 2) ||
        b.c.velocity - a.c.velocity ||
        b.c.citable.length - a.c.citable.length ||
        a.c.id.localeCompare(b.c.id),
    );

  const picked: typeof pool = [];
  const seenQueries = new Set<string>();
  // first pass: one story per sport; second pass: fill any remaining slots with the best of what is left
  for (const p of pool) {
    if (picked.length >= max) break;
    if (seenQueries.has(p.query)) continue;
    seenQueries.add(p.query);
    picked.push(p);
  }
  for (const p of pool) {
    if (picked.length >= max) break;
    if (!picked.includes(p)) picked.push(p);
  }
  // keep the ranking order in the video (best story first), not the order the passes picked them
  picked.sort((a, b) => pool.indexOf(a) - pool.indexOf(b));

  return picked.map(({ c, query }) => ({
    clusterId: c.id,
    headline: c.headline,
    pillar: c.pillar,
    sourceItemIds: [...c.citable, ...c.items.filter((i) => !c.citable.includes(i))].slice(0, 3).map((i) => i.id),
    query,
    outlets: c.sources?.length ?? 1,
    summary: (c.citable[0]?.summary ?? c.items[0]?.summary ?? "").slice(0, 200),
  }));
}
