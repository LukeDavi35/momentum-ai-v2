import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPILATION_TEMPLATES } from "../src/config/index.js";
import { getContent } from "../src/db/content.js";
import { runHighlights, localDay } from "../src/highlights/agent.js";
import { selectStories } from "../src/highlights/select.js";
import { planCompilation } from "../src/highlights/segments.js";
import type { HighlightStory } from "../src/highlights/types.js";
import type { Cluster } from "../src/ideate/cluster.js";
import { runIdeation } from "../src/ideate/agent.js";
import { storeItems } from "../src/ingest/store.js";
import type { RawItem, SourceItem } from "../src/ingest/types.js";
import { StubProvider } from "../src/llm/stub.js";
import type { Runner } from "../src/media/exec.js";
import { HANDLERS } from "../src/queue/handlers.js";
import { installSchedules } from "../src/queue/scheduler.js";
import { runScript } from "../src/script/agent.js";
import { makeDeps } from "./helpers.js";

const NOW = new Date("2026-11-12T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);

const item = (source: string, title: string, summary: string, hoursAgo: number, pillar: RawItem["pillar"] = "sports_news", kind: RawItem["kind"] = "news"): RawItem => ({
  source,
  kind,
  pillar,
  title,
  summary,
  bodyText: `${summary} The match drew a large crowd and the result was confirmed by officials afterwards.`,
  url: `https://ex.test/${encodeURIComponent(title)}`,
  publishedAt: ago(hoursAgo),
});

const DAY: RawItem[] = [
  item("bbc-sport", "Wimbledon final goes to five sets as the champion survives a scare", "The tennis champion won the Wimbledon final in five sets on Centre Court.", 2),
  item("guardian-sport", "Wimbledon champion survives five set scare in final", "The Wimbledon final went the distance before the champion won the title.", 3),
  item("bbc-sport", "Arsenal beat Chelsea in a Premier League thriller", "Arsenal beat Chelsea with a late goal in the Premier League on Sunday evening.", 4),
  item("espn-top", "Buccaneers beat Cowboys after a huge third quarter", "The Buccaneers scored twenty points in the third quarter to win the football game.", 5),
  item("bbc-athletics", "London Marathon organisers confirm a new course for next year", "Organisers said the revised marathon route will pass the river twice.", 6, "running"),
  item("bbc-sport", "Young cyclist dies after a race crash", "The rider died in hospital after a crash during the race.", 1),
  item("trend", "football", "search trend", 1, "sports_news", "trend"),
];

const probeOk: Runner = async () => ({ stdout: JSON.stringify({ format: { duration: "10", size: "1000" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1" }] }), stderr: "" });

/** Pexels answers every query with two distinct clips (ids derived from the query), and any download with bytes. */
const footageFetch: typeof fetch = (async (url: string) => {
  const u = String(url);
  if (u.includes("api.pexels.com")) {
    const q = new URL(u).searchParams.get("query") ?? "";
    const base = [...q].reduce((n, ch) => n + ch.charCodeAt(0), 0) * 10;
    return new Response(JSON.stringify({ videos: [0, 1].map((k) => ({ id: base + k, url: `https://www.pexels.com/video/${base + k}/`, duration: 10, user: { name: `Author ${base + k}` }, video_files: [{ file_type: "video/mp4", width: 1080, height: 1920, link: `https://v.test/${base + k}.mp4` }] })) }));
  }
  return new Response("video-bytes", { headers: { "content-type": "video/mp4" } });
}) as unknown as typeof fetch;

async function setup(opts: { items?: RawItem[]; pexels?: boolean; provider?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hl-"));
  const ctx = await makeDeps({
    now: NOW,
    env: { DATA_DIR: dir, ...(opts.pexels === false ? {} : { PEXELS_API_KEY: "key" }) },
    fetchImpl: footageFetch,
    ...(opts.provider === false ? {} : { provider: new StubProvider() }),
  });
  ctx.deps.runner = probeOk;
  await storeItems(ctx.db, ctx.deps.embedder, opts.items ?? DAY, NOW);
  return ctx;
}

// ---------------------------------------------------------------- pure logic

const fakeCluster = (id: string, headline: string, velocity: number, citable = 1, pillar: Cluster["pillar"] = "sports_news"): Cluster => {
  const items = Array.from({ length: Math.max(citable, 1) }, (_, i) => ({ id: `${id}-i${i}`, kind: "news", title: headline }) as unknown as SourceItem);
  return { id, headline, velocity, pillar, items, citable: items.slice(0, citable) } as unknown as Cluster;
};

describe("selectStories", () => {
  it("takes the strongest stories, one sport each first, in ranking order", () => {
    const picked = selectStories(
      [
        fakeCluster("c1", "Wimbledon final goes to five sets", 0.9),
        fakeCluster("c2", "Wimbledon semi final upset", 0.8),
        fakeCluster("c3", "Arsenal beat Chelsea in the Premier League", 0.7),
        fakeCluster("c4", "London Marathon confirms new course", 0.5, 1, "running"),
        fakeCluster("c5", "NFL quarterback signs extension", 0.4),
      ],
      4,
    );
    expect(picked.map((p) => p.clusterId)).toEqual(["c1", "c3", "c4", "c5"]); // the second tennis story waits behind a new sport
    expect(picked.map((p) => p.query)).toEqual(["tennis match", "soccer match", "marathon runners", "american football"]);
  });

  it("repeats a sport only when there are not enough different ones, and never exceeds the limit", () => {
    const picked = selectStories([fakeCluster("c1", "Wimbledon one", 0.9), fakeCluster("c2", "Wimbledon two", 0.8), fakeCluster("c3", "Wimbledon three", 0.7)], 2);
    expect(picked.map((p) => p.clusterId)).toEqual(["c1", "c2"]);
  });

  it("ignores clusters with no factual source", () => {
    expect(selectStories([fakeCluster("c1", "Wimbledon one", 0.9, 0), fakeCluster("c2", "Arsenal win", 0.5, 1)], 4).map((p) => p.clusterId)).toEqual(["c2"]);
  });

  it("puts factual sources first and keeps at most three", () => {
    const c = fakeCluster("c1", "Wimbledon one", 0.9, 4);
    (c as any).items = [{ id: "signal", kind: "reddit" }, ...c.citable];
    expect(selectStories([c], 1)[0]!.sourceItemIds).toEqual(["c1-i0", "c1-i1", "c1-i2"]);
  });
});

const story = (i: number, ids: string[]): HighlightStory => ({ clusterId: `c${i}`, headline: `Story ${i} headline`, pillar: "sports_news", sourceItemIds: ids, query: "q", footage: null });
const claim = (id: string, sourceItemId: string | null) => ({ id, text: id, source: null, kind: "fact" as const, sourceItemId });
const beat = (id: string, claimIds: string[] = [], onScreen = "") => ({ id, text: `text ${id} with enough words`, onScreen, claimIds });

describe("planCompilation", () => {
  const stories = [story(1, ["a1", "a2"]), story(2, ["b1"]), story(3, ["c1"])];

  it("assigns beats to stories from what they cite; hook and sign-off belong to no story", () => {
    const plan = planCompilation(
      { beats: [beat("b1"), beat("b2", ["k1"], "First title"), beat("b3", ["k2"], "Second title"), beat("b4", ["k3"]), beat("b5")], claims: [claim("k1", "a2"), claim("k2", "b1"), claim("k3", "c1")] },
      stories,
      "2026-11-12",
    );
    expect(plan.introBeatIds).toEqual(["b1"]);
    expect(plan.outroBeatIds).toEqual(["b5"]);
    expect(plan.segments.map((s) => [s.storyIndex, s.beatIds])).toEqual([[0, ["b2"]], [1, ["b3"]], [2, ["b4"]]]);
    expect(plan.segments[0]!.headline).toBe("First title");
    expect(plan.segments[2]!.headline).toBe("Story 3 headline"); // no onScreen text: falls back to the story's headline
  });

  it("keeps a story's follow-on beat that cites nothing with the story before it", () => {
    const plan = planCompilation({ beats: [beat("b1"), beat("b2", ["k1"]), beat("b3"), beat("b4", ["k2"]), beat("b5")], claims: [claim("k1", "a1"), claim("k2", "b1")] }, stories, "d");
    expect(plan.segments.map((s) => s.beatIds)).toEqual([["b2", "b3"], ["b4"]]);
    expect(plan.outroBeatIds).toEqual(["b5"]);
  });

  it("drops a story the script left out, and orders segments as the video tells them", () => {
    const plan = planCompilation({ beats: [beat("b1"), beat("b2", ["k2"]), beat("b3", ["k1"]), beat("b4")], claims: [claim("k1", "a1"), claim("k2", "c1")] }, stories, "d");
    expect(plan.segments.map((s) => s.storyIndex)).toEqual([2, 0]);
  });

  it("a script citing nothing has no story segments (QA rejects it)", () => {
    const plan = planCompilation({ beats: [beat("b1"), beat("b2"), beat("b3")], claims: [] }, stories, "d");
    expect(plan.segments).toEqual([]);
    expect(plan.introBeatIds).toEqual(["b1", "b2", "b3"]);
  });

  it("truncates long on-screen titles at a word", () => {
    const plan = planCompilation({ beats: [beat("b1", ["k1"], "An extremely long title for a single story that cannot possibly fit")], claims: [claim("k1", "a1")] }, stories, "d");
    expect(plan.segments[0]!.headline.length).toBeLessThanOrEqual(44);
    expect(plan.segments[0]!.headline.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------- the daily job

describe("runHighlights", () => {
  it("builds one compilation from the day's top stories, with licensed footage for each, and queues the script", async () => {
    const { deps, db, enqueued } = await setup();
    const r = await runHighlights(deps, { correlationId: "x", kind: "highlights" });
    expect(r).toMatchObject({ stories: 4, withFootage: 4 });
    const row = (await getContent(db, r.created!))!;
    expect(row).toMatchObject({ template: "daily_highlights", status: "idea" });
    const hl = (row.idea as any).highlights;
    expect(hl.date).toBe("2026-11-12");
    expect(hl.stories).toHaveLength(4);
    expect(new Set(hl.stories.map((s: HighlightStory) => s.footage!.externalId)).size).toBe(4); // no clip twice
    expect(hl.stories.every((s: HighlightStory) => s.footage!.credit.startsWith("Footage: "))).toBe(true);
    expect(hl.stories.map((s: HighlightStory) => s.query)).toEqual(expect.arrayContaining(["tennis match", "soccer match", "american football", "marathon runners"]));
    expect(enqueued).toEqual([{ queue: "script", data: { contentId: row.id, correlationId: row.correlationId, regen: 0 }, opts: undefined }]);
    // the audit trail records each clip
    const clips = await db.query(`SELECT provider, license, use_count, last_content_id FROM footage_clips`);
    expect(clips.rows).toHaveLength(4);
    expect(clips.rows.every((c: any) => c.provider === "pexels" && c.license === "pexels" && c.use_count === 1 && c.last_content_id === row.id)).toBe(true);
  });

  it("never builds a story from a death, injury or legal case", async () => {
    const { deps, db } = await setup();
    const r = await runHighlights(deps, { correlationId: "x" });
    const row = (await getContent(db, r.created!))!;
    const ids = (row.idea as any).highlights.stories.flatMap((s: HighlightStory) => s.sourceItemIds);
    const titles = (await db.query<{ title: string }>(`SELECT title FROM source_items WHERE id = ANY($1::uuid[])`, [ids])).rows.map((t) => t.title);
    expect(titles.join(" ")).not.toMatch(/cyclist|dies/i);
  });

  it("uses only factual sources (news/results), never trend or reddit signals", async () => {
    const { deps, db } = await setup();
    const r = await runHighlights(deps, { correlationId: "x" });
    const row = (await getContent(db, r.created!))!;
    const kinds = (await db.query<{ kind: string }>(`SELECT kind FROM source_items WHERE id = ANY($1::uuid[])`, [row.sourceItemIds])).rows.map((k) => k.kind);
    expect(new Set(kinds)).toEqual(new Set(["news"]));
  });

  it("builds only one compilation per local day, but rebuilds after a failed one", async () => {
    const { deps, db, enqueued } = await setup();
    const first = await runHighlights(deps, { correlationId: "x" });
    const second = await runHighlights(deps, { correlationId: "y" });
    expect(second).toMatchObject({ skippedReason: "already_built", stories: 0 });
    expect(enqueued).toHaveLength(1);
    await db.query(`UPDATE content SET status = 'failed' WHERE id = $1`, [first.created]);
    expect((await runHighlights(deps, { correlationId: "z" })).created).toBeTruthy();
  });

  it("still builds (with generated visuals) when no footage can be found", async () => {
    const { deps, db } = await setup({ pexels: false });
    deps.fetchImpl = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch; // Commons is down too
    const r = await runHighlights(deps, { correlationId: "x" });
    expect(r).toMatchObject({ stories: 4, withFootage: 0 });
    const row = (await getContent(db, r.created!))!;
    expect((row.idea as any).highlights.stories.every((s: HighlightStory) => s.footage === null)).toBe(true);
    expect((await db.query(`SELECT 1 FROM footage_clips`)).rows).toHaveLength(0);
  });

  it("does nothing with fewer than two usable stories, or when disabled", async () => {
    const one = await setup({ items: [DAY[0]!] });
    expect(await runHighlights(one.deps, { correlationId: "x" })).toMatchObject({ skippedReason: "not_enough_stories" });
    expect(one.enqueued).toHaveLength(0);
    const off = await setup();
    off.deps.cfg.schedule.highlights.enabled = false;
    expect(await runHighlights(off.deps, { correlationId: "x" })).toMatchObject({ skippedReason: "disabled" });
  });

  it("only looks at the lookback window", async () => {
    const old = DAY.map((d) => ({ ...d, publishedAt: ago(60) }));
    const { deps } = await setup({ items: old });
    expect(await runHighlights(deps, { correlationId: "x" })).toMatchObject({ skippedReason: "not_enough_stories" });
  });

  it("is what the ideate queue runs for kind=highlights", async () => {
    const { deps, db } = await setup();
    await HANDLERS.ideate(deps, { kind: "highlights", correlationId: "x" });
    expect((await db.query(`SELECT 1 FROM content WHERE template = 'daily_highlights'`)).rows).toHaveLength(1);
  });

  it("uses the schedule timezone for 'today'", () => {
    expect(localDay(new Date("2026-11-12T23:30:00Z"), "Europe/London")).toBe("2026-11-12");
    expect(localDay(new Date("2026-06-12T23:30:00Z"), "Europe/London")).toBe("2026-06-13"); // BST
  });
});

describe("the per-story ideation cycle never proposes the compilation template", () => {
  it("drops an idea that picks daily_highlights", async () => {
    expect(COMPILATION_TEMPLATES).toContain("daily_highlights");
    let prompt = "";
    const { deps } = await makeDeps({
      now: NOW,
      reply: (req) => {
        prompt = req.prompt;
        return { ideas: [{ clusterId: "c1", template: "daily_highlights", topic: "Everything today", angle: "all of it", hookStyle: "news", templateFit: 9 }] };
      },
    });
    await storeItems(deps.db, deps.embedder, DAY, NOW);
    const r = await runIdeation(deps, { correlationId: "x" });
    expect(r.created).toEqual([]);
    expect(prompt).not.toContain("daily_highlights:");
  });
});

// ---------------------------------------------------------------- the script stage

describe("script stage for a compilation", () => {
  it("writes a hook, one beat per story and a sign-off, and records which beat tells which story and its clip", async () => {
    const { deps, db } = await setup();
    const { created } = await runHighlights(deps, { correlationId: "x" });
    expect(await runScript(deps, { contentId: created!, correlationId: "x", regen: 0 })).toBe("scripted");
    const row = (await getContent(db, created!))!;
    const script = row.script as any;
    expect(script.generator).toBe("stub");
    expect(script.beats).toHaveLength(6); // hook + 4 stories + sign-off
    const c = script.compilation;
    expect(c.date).toBe("2026-11-12");
    expect(c.segments).toHaveLength(4);
    expect(c.introBeatIds).toEqual(["b1"]);
    expect(c.outroBeatIds).toEqual(["b6"]);
    expect(c.segments.map((s: any) => s.beatIds)).toEqual([["b2"], ["b3"], ["b4"], ["b5"]]);
    expect(c.segments.every((s: any) => s.footage?.localPath && s.footage.credit)).toBe(true);
    // every story beat's claim resolves to a source that belongs to that story
    const stories = (row.idea as any).highlights.stories as HighlightStory[];
    c.segments.forEach((seg: any, i: number) => {
      const claimId = script.beats.find((b: any) => b.id === seg.beatIds[0]).claimIds[0];
      const sid = script.claims.find((k: any) => k.id === claimId).sourceItemId;
      expect(stories[seg.storyIndex]!.sourceItemIds).toContain(sid);
      expect(seg.storyIndex).toBe(i);
    });
    expect(script.estimatedDurationS).toBeLessThanOrEqual(55);
  });

  it("gives the writer the stories, in order, each with its own source aliases", async () => {
    const { deps, provider } = await setup({ provider: false });
    const { created } = await runHighlights(deps, { correlationId: "x" });
    provider.calls.length = 0;
    // the fake returns a script that cites nothing: that fails grounding, which is fine here - this test only reads the prompt
    await runScript(deps, { contentId: created!, correlationId: "x", regen: 0 }).catch(() => undefined);
    const call = provider.calls.find((c) => c.task === "script.write")!;
    expect(call.prompt).toContain("COMPILATION");
    expect(call.prompt).toContain("STORIES (tell exactly these 4");
    for (const n of [1, 2, 3, 4]) expect(call.prompt).toMatch(new RegExp(`Story ${n} \\[sources: S\\d`));
    expect(call.prompt).toMatch(/Use between 3 and 6 beats/);
    expect((call.input as any).stories).toHaveLength(4);
  });
});

// ---------------------------------------------------------------- scheduling

describe("scheduling", () => {
  it("registers a daily highlights job at the configured local time, and none when disabled", async () => {
    const calls: Array<{ id: string; repeat: any; template: any }> = [];
    const q = { upsertJobScheduler: async (id: string, repeat: any, template: any) => void calls.push({ id, repeat, template }) };
    const qs: any = { queues: { ingest: q, ideate: q }, maintenance: q };
    const { deps } = await makeDeps();
    deps.cfg.schedule.highlights.dailyAt = "17:45";
    const ids = await installSchedules(qs, deps.cfg);
    expect(ids).toContain("daily-highlights");
    const hl = calls.find((c) => c.id === "daily-highlights")!;
    expect(hl.repeat).toEqual({ pattern: "45 17 * * *", tz: "Europe/London" });
    expect(hl.template.data.kind).toBe("highlights");

    deps.cfg.schedule.highlights.enabled = false;
    expect(await installSchedules(qs, deps.cfg)).not.toContain("daily-highlights");
  });
});

describe("housekeeping prunes the footage cache", () => {
  it("deletes cached clips older than a month and keeps recent ones", async () => {
    const { mkdirSync, writeFileSync, utimesSync, existsSync } = await import("node:fs");
    const { housekeeping } = await import("../src/queue/maintenance.js");
    const dir = mkdtempSync(join(tmpdir(), "hk-"));
    const { deps } = await makeDeps({ now: NOW, env: { DATA_DIR: dir } });
    const cache = join(dir, "footage-cache");
    mkdirSync(cache);
    for (const [name, daysOld] of [["old.mp4", 45], ["new.mp4", 3]] as const) {
      const p = join(cache, name);
      writeFileSync(p, "x");
      const t = new Date(NOW.getTime() - daysOld * 86400_000);
      utimesSync(p, t, t);
    }
    expect(await housekeeping(deps)).toMatchObject({ footageRemoved: 1 });
    expect(existsSync(join(cache, "old.mp4"))).toBe(false);
    expect(existsSync(join(cache, "new.mp4"))).toBe(true);
  });
});
