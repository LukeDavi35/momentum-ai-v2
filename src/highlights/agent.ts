import { PILLARS, type Pillar } from "../config/index.js";
import { createContent } from "../db/content.js";
import { findFootage } from "../footage/search.js";
import { recordUse } from "../footage/store.js";
import { clipKey } from "../footage/types.js";
import { clusterItems } from "../ideate/cluster.js";
import { listRecentItems } from "../ingest/store.js";
import { findSensitive } from "../qa/sensitivity.js";
import type { Deps, JobData } from "../queue/types.js";
import { selectStories } from "./select.js";
import type { HighlightsIdea, HighlightStory } from "./types.js";

export interface HighlightsResult {
  created?: string;
  skippedReason?: "disabled" | "already_built" | "not_enough_stories";
  stories: number;
  withFootage: number;
}

/** The local calendar day in the schedule timezone, "YYYY-MM-DD". */
export const localDay = (d: Date, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const niceDate = (d: Date, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long" }).format(d);

/**
 * Builds today's highlights compilation: picks the day's top stories from the news already ingested, finds licensed
 * illustrative footage for each (never fatal), and creates ONE content row that then travels the normal pipeline
 * (script → voice → render → QA → publish). Runs once per local day; a second run the same day does nothing.
 */
export async function runHighlights(deps: Deps, _data: JobData): Promise<HighlightsResult> {
  const { cfg, db, log } = deps;
  const hc = cfg.schedule.highlights;
  const now = deps.now();
  if (!hc.enabled) return { skippedReason: "disabled", stories: 0, withFootage: 0 };

  const date = localDay(now, cfg.schedule.timezone);
  const existing = await db.query<{ id: string }>(`SELECT id FROM content WHERE template = 'daily_highlights' AND idea->>'highlightsDate' = $1 AND status <> 'failed' LIMIT 1`, [date]);
  if (existing.rows[0]) {
    log.info({ date, contentId: existing.rows[0].id }, "highlights: today's compilation already exists");
    return { skippedReason: "already_built", stories: 0, withFootage: 0 };
  }

  const items = (await listRecentItems(db, hc.lookbackHours, now)).filter((i) => i.kind === "news" || i.kind === "results");
  // brand safety: a highlights reel must not include deaths, serious injuries, abuse allegations or legal cases
  const clusters = clusterItems(items, now).filter((c) => findSensitive(...c.items.flatMap((i) => [i.title, i.summary])).length === 0);
  const picked = selectStories(clusters, hc.maxStories);
  if (picked.length < 2) {
    log.info({ date, clusters: clusters.length }, "highlights: fewer than two usable stories; nothing built");
    return { skippedReason: "not_enough_stories", stories: picked.length, withFootage: 0 };
  }

  const stories: HighlightStory[] = [];
  const chosen = new Set<string>();
  for (const p of picked) {
    const footage = await findFootage({ cfg, db, log, fetchImpl: deps.fetchImpl, runner: deps.runner, now: deps.now }, p.query, chosen);
    if (footage) chosen.add(clipKey(footage));
    stories.push({ ...p, footage });
  }

  const counts = new Map<Pillar, number>();
  for (const s of stories) counts.set(s.pillar, (counts.get(s.pillar) ?? 0) + 1);
  const pillar = [...counts.entries()].sort((a, b) => b[1] - a[1] || PILLARS.indexOf(a[0]) - PILLARS.indexOf(b[0]))[0]![0];

  const idea: HighlightsIdea = { date, stories };
  const row = await createContent(db, {
    pillar,
    template: "daily_highlights",
    topic: `Sports highlights, ${niceDate(now, cfg.schedule.timezone)}`,
    hookStyle: "news",
    sourceItemIds: [...new Set(stories.flatMap((s) => s.sourceItemIds))],
    idea: { angle: `The ${stories.length} biggest sports stories of the day in one video`, evergreen: false, highlightsDate: date, highlights: idea, llm: deps.llm.isStub ? "stub" : "live" },
  });
  for (const s of stories) if (s.footage) await recordUse(db, s.footage, row.id, now);
  await deps.enqueue("script", { contentId: row.id, correlationId: row.correlationId, regen: 0 });
  const withFootage = stories.filter((s) => s.footage).length;
  log.info({ contentId: row.id, correlationId: row.correlationId, date, stories: stories.length, withFootage }, "highlights compilation created");
  return { created: row.id, stories: stories.length, withFootage };
}
