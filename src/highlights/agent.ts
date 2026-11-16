import { z } from "zod";
import { PILLARS, type AppConfig, type Pillar } from "../config/index.js";
import { createContent, type Content } from "../db/content.js";
import { alternateQueries } from "../footage/query.js";
import { findFootage } from "../footage/search.js";
import { recordUse } from "../footage/store.js";
import { clipKey } from "../footage/types.js";
import { clusterItems } from "../ideate/cluster.js";
import { listRecentItems } from "../ingest/store.js";
import { findSensitive } from "../qa/sensitivity.js";
import type { Deps, JobData } from "../queue/types.js";
import { BRAND_VOICE } from "../prompts.js";
import { selectStories, type PickedStory } from "./select.js";
import type { HighlightsIdea, HighlightStory } from "./types.js";

export interface HighlightsResult {
  created?: string;
  skippedReason?: "disabled" | "unknown_profile" | "already_built" | "not_enough_stories";
  stories: number;
  withFootage: number;
}

/** Candidates the editor chooses from: generous relative to how many stories the profile actually wants. */
export const candidateCount = (maxStories: number): number => Math.max(12, maxStories * 3);

const pickSchema = z.object({ picks: z.array(z.object({ id: z.number().int(), why: z.string().max(240).default("") })).max(12) });

/**
 * An editor pass over the best candidates: keeps real news (results, decisions, announcements, transfers) and drops the
 * columns, features and previews a keyword list can't catch, favouring variety and stories several outlets cover. The
 * LLM only CHOOSES and ORDERS among stories we already vetted (and can't invent one); if it fails or returns nonsense,
 * the deterministic ranking stands.
 */
export async function editorPick(deps: Deps, candidates: PickedStory[], want: number, label: string, correlationId: string): Promise<PickedStory[]> {
  const fallback = candidates.slice(0, want);
  if (candidates.length <= want) return fallback;
  try {
    const list = candidates.map((c, i) => `${i} | outlets=${c.outlets} | sport=${c.query} | ${c.headline}${c.summary ? ` — ${c.summary}` : ""}`).join("\n");
    const out = await deps.llm.json({
      task: "highlights.pick",
      role: "fast",
      system: `${BRAND_VOICE}\n\nYou are the editor of a sports highlights compilation video. Respond with ONLY JSON.`,
      prompt: `Choose the ${want} strongest stories for "${label}" from these candidates:\n${list}\n\nRules: real news only (results, decisions, announcements, transfers, records) - skip columns, features, opinion, previews, rankings, "how to watch" and listicles. Prefer a different sport for each pick and stories covered by more outlets. Order best first.\nJSON: {"picks":[{"id":0,"why":"short reason"}]}`,
      schema: pickSchema,
      maxTokens: 600,
      temperature: 0.2,
      input: { want, candidates: candidates.map((c, i) => ({ id: i, headline: c.headline, outlets: c.outlets, query: c.query })) },
      correlationId,
    });
    const seen = new Set<number>();
    const picked = out.picks.filter((p) => p.id >= 0 && p.id < candidates.length && !seen.has(p.id) && seen.add(p.id)).slice(0, want).map((p) => candidates[p.id]!);
    if (picked.length < 2) return fallback; // an editor who keeps fewer than two stories isn't one
    return picked;
  } catch (e) {
    deps.log.warn({ err: (e as Error).message }, "highlights: editor pass failed; using the deterministic ranking");
    return fallback;
  }
}

/** The allowed footage licences for whichever profile built this content, or undefined (QA's own default) if the profile can't be found - e.g. it was removed from config after the content was created. */
export function profileFootageLicenses(cfg: AppConfig, idea: Record<string, any> | null | undefined): readonly string[] | undefined {
  const profileId = idea?.highlightsProfile as string | undefined;
  return (profileId && cfg.schedule.compilations[profileId]?.footage.licenses) || undefined;
}

/**
 * The one case the autonomy agent's QA-hold remediation (src/qa/gate.ts) can fix with something genuinely
 * different rather than a plain retry: a daily_highlights item held over its footage (missing, or under a
 * licence the profile no longer allows). Re-searches just the offending stories' footage — excluding what
 * was already tried — and returns an updated idea for the caller to patch onto the content row before
 * re-rendering. Returns null if this content isn't a compilation, or its profile no longer exists.
 */
export async function refreshCompilationFootage(deps: Deps, content: Content): Promise<HighlightsIdea | null> {
  const { cfg, db, log } = deps;
  const idea = content.idea as Record<string, any>;
  const highlights = idea?.highlights as HighlightsIdea | undefined;
  const profileId = idea?.highlightsProfile as string | undefined;
  const hc = profileId ? cfg.schedule.compilations[profileId] : undefined;
  if (!highlights || !hc) return null;

  const chosen = new Set(highlights.stories.filter((s) => s.footage).map((s) => clipKey(s.footage!)));
  const stories: HighlightStory[] = [];
  let changed = false;
  for (const s of highlights.stories) {
    if (s.footage && hc.footage.licenses.includes(s.footage.license)) {
      stories.push(s);
      continue;
    }
    if (s.footage) chosen.delete(clipKey(s.footage));
    const footage = await findFootage({ cfg, db, log, fetchImpl: deps.fetchImpl, runner: deps.runner, now: deps.now }, hc.footage, [s.query, ...alternateQueries(s.query)], chosen);
    if (footage) {
      chosen.add(clipKey(footage));
      await recordUse(db, footage, content.id, deps.now());
    }
    changed = changed || Boolean(s.footage) !== Boolean(footage) || footage?.pageUrl !== s.footage?.pageUrl;
    stories.push({ ...s, footage });
  }
  if (!changed) return null; // nothing to try that's actually different
  return { ...highlights, stories };
}

/** The local calendar day in the schedule timezone, "YYYY-MM-DD". */
export const localDay = (d: Date, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const niceDate = (d: Date, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long" }).format(d);

/**
 * Builds today's highlights compilation: picks the day's top stories from the news already ingested, finds licensed
 * illustrative footage for each (never fatal), and creates ONE content row that then travels the normal pipeline
 * (script → voice → render → QA → publish). Runs once per local day; a second run the same day does nothing.
 */
export async function runHighlights(deps: Deps, data: JobData): Promise<HighlightsResult> {
  const { cfg, db, log } = deps;
  const profileId = data.profile ?? Object.keys(cfg.schedule.compilations)[0] ?? "daily";
  const hc = cfg.schedule.compilations[profileId];
  if (!hc) {
    log.warn({ profile: profileId }, "highlights: no such compilation profile configured");
    return { skippedReason: "unknown_profile", stories: 0, withFootage: 0 };
  }
  const now = deps.now();
  if (!hc.enabled) return { skippedReason: "disabled", stories: 0, withFootage: 0 };

  const date = localDay(now, cfg.schedule.timezone);
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM content WHERE template = 'daily_highlights' AND idea->>'highlightsProfile' = $1 AND idea->>'highlightsDate' = $2 AND status <> 'failed' LIMIT 1`,
    [profileId, date],
  );
  if (existing.rows[0]) {
    log.info({ profile: profileId, date, contentId: existing.rows[0].id }, "highlights: this profile's compilation for today already exists");
    return { skippedReason: "already_built", stories: 0, withFootage: 0 };
  }

  const items = (await listRecentItems(db, hc.lookbackHours, now)).filter((i) => i.kind === "news" || i.kind === "results");
  // brand safety: a highlights reel must not include deaths, serious injuries, abuse allegations or legal cases
  const clusters = clusterItems(items, now).filter((c) => findSensitive(...c.items.flatMap((i) => [i.title, i.summary])).length === 0);
  const picked = await editorPick(deps, selectStories(clusters, candidateCount(hc.maxStories)), hc.maxStories, hc.label, data.correlationId);
  if (picked.length < 2) {
    log.info({ profile: profileId, date, clusters: clusters.length }, "highlights: fewer than two usable stories; nothing built");
    return { skippedReason: "not_enough_stories", stories: picked.length, withFootage: 0 };
  }

  const stories: HighlightStory[] = [];
  const chosen = new Set<string>();
  for (const p of picked) {
    const footage = await findFootage({ cfg, db, log, fetchImpl: deps.fetchImpl, runner: deps.runner, now: deps.now }, hc.footage, [p.query, ...alternateQueries(p.query)], chosen);
    if (footage) chosen.add(clipKey(footage));
    const { outlets: _o, summary: _s, ...story } = p;
    stories.push({ ...story, footage });
  }

  const counts = new Map<Pillar, number>();
  for (const s of stories) counts.set(s.pillar, (counts.get(s.pillar) ?? 0) + 1);
  const pillar = [...counts.entries()].sort((a, b) => b[1] - a[1] || PILLARS.indexOf(a[0]) - PILLARS.indexOf(b[0]))[0]![0];

  const idea: HighlightsIdea = { profile: profileId, label: hc.label, date, stories };
  const row = await createContent(db, {
    pillar,
    template: "daily_highlights",
    topic: `${hc.label} — ${niceDate(now, cfg.schedule.timezone)}`,
    hookStyle: "news",
    sourceItemIds: [...new Set(stories.flatMap((s) => s.sourceItemIds))],
    idea: { angle: `The ${stories.length} biggest sports stories in one video`, evergreen: false, highlightsProfile: profileId, highlightsDate: date, highlights: idea, llm: deps.llm.isStub ? "stub" : "live" },
  });
  for (const s of stories) if (s.footage) await recordUse(db, s.footage, row.id, now);
  await deps.enqueue("script", { contentId: row.id, correlationId: row.correlationId, regen: 0 });
  const withFootage = stories.filter((s) => s.footage).length;
  log.info({ contentId: row.id, correlationId: row.correlationId, profile: profileId, date, stories: stories.length, withFootage }, "compilation created");
  return { created: row.id, stories: stories.length, withFootage };
}
