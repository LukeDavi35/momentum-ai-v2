import type { Cluster } from "../ideate/cluster.js";
import { footageQuery } from "../footage/query.js";
import type { HighlightStory } from "./types.js";

/**
 * Picks the day's stories from clustered, safety-filtered news: strongest first (velocity, then number of independent
 * factual sources), but preferring a different sport for each slot so the video isn't four versions of the same match.
 * Only clusters with a factual (news/results) source qualify — the script may cite nothing else. Pure; unit-tested.
 */
export function selectStories(clusters: Cluster[], max: number): Omit<HighlightStory, "footage">[] {
  const pool = clusters
    .filter((c) => c.citable.length > 0)
    .map((c) => ({ c, query: footageQuery(c.headline, c.pillar) }))
    .sort((a, b) => b.c.velocity - a.c.velocity || b.c.citable.length - a.c.citable.length || a.c.id.localeCompare(b.c.id));

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
  }));
}
