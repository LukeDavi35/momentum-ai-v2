import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPILATION_TEMPLATES } from "../src/config/index.js";
import { getContent } from "../src/db/content.js";
import { candidateCount, editorPick, profileFootageLicenses, refreshCompilationFootage, runHighlights, localDay } from "../src/highlights/agent.js";
import { NOT_A_NEWS_STORY, selectStories, type PickedStory } from "../src/highlights/select.js";
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

async function setup(opts: { items?: RawItem[]; pexels?: boolean; provider?: boolean; reply?: (req: any) => unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hl-"));
  const ctx = await makeDeps({
    now: NOW,
    env: { DATA_DIR: dir, ...(opts.pexels === false ? {} : { PEXELS_API_KEY: "key" }) },
    fetchImpl: footageFetch,
    ...(opts.reply ? { reply: opts.reply } : {}),
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

describe("story selection quality", () => {
  const withSources = (c: Cluster, n: number): Cluster => ((c as any).sources = Array.from({ length: n }, (_, i) => `outlet${i}`), c);

  it("prefers stories covered by two or more outlets over single-source ones", () => {
    const picked = selectStories([withSources(fakeCluster("solo", "Arsenal beat Chelsea", 0.95), 1), withSources(fakeCluster("pair", "Wimbledon final goes to five sets", 0.4), 2)], 2);
    expect(picked.map((p) => p.clusterId)).toEqual(["pair", "solo"]);
    expect(picked[0]).toMatchObject({ outlets: 2 });
  });

  it.each([
    "Barnwell's NFL mailbag: your questions answered",
    "Premier League predictions: who wins the title",
    "Football Daily | Pochettino readies his outfit",
    "NHL Tonight: an 11-game slate on Thursday",
    "Power rankings: every team from best to worst",
    "How to watch the Wimbledon final",
    "NFL midseason awards: the top candidates",
  ])("skips columns and previews: %s", (headline) => {
    expect(NOT_A_NEWS_STORY.test(headline)).toBe(true);
  });
  it.each(["Crystal Palace sack Pierre Sage", "Kipyegon breaks 1500m world record in Paris", "Buccaneers beat Cowboys after a huge third quarter"])("keeps real news: %s", (headline) => {
    expect(NOT_A_NEWS_STORY.test(headline)).toBe(false);
  });

  it("drops columns when there is real news, but falls back to them rather than to no video on a quiet day", () => {
    const col = fakeCluster("col", "Football Daily | a column", 0.9);
    const a = fakeCluster("a", "Arsenal beat Chelsea", 0.5);
    const b = fakeCluster("b", "Wimbledon final goes to five sets", 0.4);
    expect(selectStories([col, a, b], 3).map((p) => p.clusterId)).toEqual(["a", "b"]);
    expect(selectStories([col, a], 3).map((p) => p.clusterId)).toEqual(["col", "a"]);
  });
});

describe("editorPick (LLM editor over vetted candidates)", () => {
  const cand = (n: number): PickedStory[] => Array.from({ length: n }, (_, i) => ({ clusterId: `c${i}`, headline: `Headline ${i}`, pillar: "sports_news" as const, sourceItemIds: [`s${i}`], query: "q", outlets: 1, summary: "" }));
  const run = async (reply: (req: any) => unknown, n = 8, want = 4) => {
    const ctx = await makeDeps({ now: NOW, reply });
    return { ...ctx, out: await editorPick(ctx.deps, cand(n), want, "Today's sports highlights", "x") };
  };

  it("uses the editor's choice and order", async () => {
    const { out, provider } = await run(() => ({ picks: [{ id: 5, why: "a" }, { id: 1, why: "b" }, { id: 7, why: "c" }] }));
    expect(out.map((c) => c.clusterId)).toEqual(["c5", "c1", "c7"]);
    expect(provider.calls[0]!.task).toBe("highlights.pick");
    expect(provider.calls[0]!.prompt).toContain("0 | outlets=1 | sport=q | Headline 0");
  });
  it("ignores invented, repeated and out-of-range ids, and caps at the number wanted", async () => {
    const { out } = await run(() => ({ picks: [{ id: 99 }, { id: 2 }, { id: 2 }, { id: -1 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }] }));
    expect(out.map((c) => c.clusterId)).toEqual(["c2", "c3", "c4", "c5"]);
  });
  it("falls back to the deterministic order when the editor keeps fewer than two stories", async () => {
    expect((await run(() => ({ picks: [{ id: 3 }] }))).out.map((c) => c.clusterId)).toEqual(["c0", "c1", "c2", "c3"]);
  });
  it("falls back when the call fails or returns something that is not the schema", async () => {
    expect((await run(() => { throw new Error("llm down"); })).out.map((c) => c.clusterId)).toEqual(["c0", "c1", "c2", "c3"]);
    expect((await run(() => "not json at all")).out).toHaveLength(4);
  });
  it("does not call the LLM when there is nothing to choose between", async () => {
    const { out, provider } = await run(() => ({ picks: [] }), 3, 4);
    expect(out).toHaveLength(3);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("runHighlights asks the editor when there are more candidates than slots", () => {
  it("builds the video from the editor's picks", async () => {
    const many: RawItem[] = [
      ...DAY,
      item("espn-top", "Lakers beat Celtics in overtime thriller", "The Lakers beat the Celtics in overtime in the NBA on Thursday night.", 7),
      item("bbc-sport", "Mercedes win the Grand Prix after a late safety car", "Mercedes won the Formula 1 Grand Prix after a late safety car on Sunday.", 8),
    ];
    const ctx = await setup({ items: many, provider: false, reply: (req: any) => (req.task === "highlights.pick" ? { picks: req.input.candidates.slice().reverse().slice(0, 4).map((c: any) => ({ id: c.id, why: "x" })) } : {}) });
    const r = await runHighlights(ctx.deps, { correlationId: "x" });
    expect(ctx.provider.calls.filter((c) => c.task === "highlights.pick")).toHaveLength(1);
    const row = (await getContent(ctx.db, r.created!))!;
    const stories = (row.idea as any).highlights.stories as HighlightStory[];
    const asked = (ctx.provider.calls.find((c) => c.task === "highlights.pick")!.input as any).candidates as Array<{ id: number; headline: string }>;
    expect(stories.map((s) => s.headline)).toEqual(asked.slice().reverse().slice(0, 4).map((c) => c.headline));
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
    off.deps.cfg.schedule.compilations.daily!.enabled = false;
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

describe("refreshCompilationFootage (the autonomy agent's bonus attempt for a footage/licence QA hold)", () => {
  it("returns null when every clip is still under an allowed licence - nothing different to try", async () => {
    const { deps, db } = await setup();
    const r = await runHighlights(deps, { correlationId: "x" });
    const row = (await getContent(db, r.created!))!;
    expect(await refreshCompilationFootage(deps, row)).toBeNull();
  });

  it("re-searches just the stories whose licence the profile no longer allows, and records the new clip's use", async () => {
    const { deps, db } = await setup();
    const r = await runHighlights(deps, { correlationId: "x" });
    const row = (await getContent(db, r.created!))!;
    // tighten the profile after the fact, as if a human had edited config/schedule.json - every existing "pexels"-licensed clip is now disallowed
    deps.cfg.schedule.compilations.daily!.footage.licenses = ["cc0", "public_domain"];
    const refreshed = await refreshCompilationFootage(deps, row);
    expect(refreshed).not.toBeNull();
    // pexels is the only configured provider in this fixture and it only ever returns "pexels"-licensed clips, so there is nothing allowed to find
    expect(refreshed!.stories.every((s) => s.footage === null)).toBe(true);
    expect(refreshed!.stories).toHaveLength(row.idea.highlights.stories.length);
  });

  it("returns null for content that isn't a compilation, or whose profile no longer exists", async () => {
    const { deps, db } = await setup();
    const plain = await db.query<{ id: string }>(
      `INSERT INTO content (id, correlation_id, status, pillar, template, topic, hook_style, idea, source_item_ids) VALUES (gen_random_uuid(), gen_random_uuid(), 'idea', 'running','news_flash','t','stat','{}'::jsonb,'[]'::jsonb) RETURNING id`,
    );
    expect(await refreshCompilationFootage(deps, (await getContent(db, plain.rows[0]!.id))!)).toBeNull();

    const r = await runHighlights(deps, { correlationId: "x" });
    const row = (await getContent(db, r.created!))!;
    delete deps.cfg.schedule.compilations.daily;
    expect(await refreshCompilationFootage(deps, row)).toBeNull();
  });
});

describe("compilation profiles are independent generators sharing the same code", () => {
  it("builds a named profile other than the first, honouring its own window/count/label", async () => {
    const six: RawItem[] = [
      ...DAY,
      item("espn-top", "Lakers beat Celtics in overtime thriller", "The Lakers beat the Celtics in overtime in the NBA on Thursday night.", 7, "sports_news"),
      item("bbc-sport", "Mercedes win the Grand Prix after a late safety car", "Mercedes won the Formula 1 Grand Prix after a late safety car on Sunday.", 8, "sports_news"),
    ];
    const { deps, db } = await setup({ items: six });
    deps.cfg.schedule.compilations.weekly!.lookbackHours = 24; // keep it inside this fixture's window for the test
    const r = await runHighlights(deps, { correlationId: "x", kind: "highlights", profile: "weekly" });
    expect(r).toMatchObject({ stories: 6, withFootage: 6 }); // weekly's maxStories, and six distinct sports are available
    const row = (await getContent(db, r.created!))!;
    const hl = (row.idea as any).highlights;
    expect(hl.profile).toBe("weekly");
    expect(hl.label).toBe(deps.cfg.schedule.compilations.weekly!.label);
    expect(row.topic).toContain(deps.cfg.schedule.compilations.weekly!.label);
  });

  it("defaults to the first configured profile when none is given", async () => {
    const { deps, db } = await setup();
    const r = await runHighlights(deps, { correlationId: "x" });
    const hl = ((await getContent(db, r.created!))!.idea as any).highlights;
    expect(hl.profile).toBe(Object.keys(deps.cfg.schedule.compilations)[0]);
  });

  it("reports unknown_profile for a profile id that isn't configured, without touching the database", async () => {
    const { deps, enqueued } = await setup();
    const r = await runHighlights(deps, { correlationId: "x", profile: "nonexistent" });
    expect(r).toMatchObject({ skippedReason: "unknown_profile", stories: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it("one profile having already run today never blocks a different profile from running the same day", async () => {
    const { deps } = await setup();
    const first = await runHighlights(deps, { correlationId: "x", profile: "daily" });
    expect(first.created).toBeTruthy();
    const again = await runHighlights(deps, { correlationId: "y", profile: "daily" });
    expect(again).toMatchObject({ skippedReason: "already_built" });
    const other = await runHighlights(deps, { correlationId: "z", profile: "weekly" });
    expect(other.created).toBeTruthy();
    expect(other.created).not.toBe(first.created);
  });

  it("candidateCount scales with the profile's story count but is never thin", () => {
    expect(candidateCount(2)).toBe(12);
    expect(candidateCount(4)).toBe(12);
    expect(candidateCount(6)).toBe(18);
  });

  it("profileFootageLicenses reads the licence list from the content's own profile, and is undefined for a missing/removed one", () => {
    const cfg = { schedule: { compilations: { daily: { footage: { licenses: ["cc0", "pexels"] } } } } } as any;
    expect(profileFootageLicenses(cfg, { highlightsProfile: "daily" })).toEqual(["cc0", "pexels"]);
    expect(profileFootageLicenses(cfg, { highlightsProfile: "deleted-profile" })).toBeUndefined();
    expect(profileFootageLicenses(cfg, {})).toBeUndefined();
    expect(profileFootageLicenses(cfg, null)).toBeUndefined();
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
  it("registers one job per enabled compilation profile, each at its own cron time, and skips disabled ones", async () => {
    const calls: Array<{ id: string; repeat: any; template: any }> = [];
    const q = { upsertJobScheduler: async (id: string, repeat: any, template: any) => void calls.push({ id, repeat, template }) };
    const qs: any = { queues: { ingest: q, ideate: q }, maintenance: q };
    const { deps } = await makeDeps();
    deps.cfg.schedule.compilations.daily!.cron = "45 17 * * *";
    const ids = await installSchedules(qs, deps.cfg);
    expect(ids).toEqual(expect.arrayContaining(["compilation-daily", "compilation-weekly"]));

    const daily = calls.find((c) => c.id === "compilation-daily")!;
    expect(daily.repeat).toEqual({ pattern: "45 17 * * *", tz: "Europe/London" });
    expect(daily.template.data).toMatchObject({ kind: "highlights", profile: "daily" });

    const weekly = calls.find((c) => c.id === "compilation-weekly")!;
    expect(weekly.repeat).toEqual({ pattern: deps.cfg.schedule.compilations.weekly!.cron, tz: "Europe/London" });
    expect(weekly.template.data).toMatchObject({ kind: "highlights", profile: "weekly" });

    deps.cfg.schedule.compilations.daily!.enabled = false;
    const idsAfter = await installSchedules(qs, deps.cfg);
    expect(idsAfter).not.toContain("compilation-daily");
    expect(idsAfter).toContain("compilation-weekly");
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
