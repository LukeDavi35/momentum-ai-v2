import { describe, expect, it } from "vitest";
import { createContent, getContent, transition } from "../src/db/content.js";
import { listRecentItems, storeItems } from "../src/ingest/store.js";
import type { RawItem } from "../src/ingest/types.js";
import { StubProvider } from "../src/llm/stub.js";
import { runScript, trimToDuration } from "../src/script/agent.js";
import { estimateDurationS, narrationOf } from "../src/script/types.js";
import { makeDeps } from "./helpers.js";

const CID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-09T12:00:00Z");

const NEWS: RawItem[] = [
  {
    source: "bbc-athletics",
    kind: "news",
    pillar: "track_and_field",
    title: "Kipyegon breaks 1500m world record in Paris",
    summary: "Kenya's Faith Kipyegon ran 3:49.04 in Paris on Thursday night. The time took 0.38 seconds off her own world record.",
    bodyText: "The two-time Olympic champion led from the front and kicked clear over the final lap. Organisers said the crowd of 40000 stayed on its feet.",
    url: "https://ex.test/1",
    publishedAt: new Date("2026-10-09T10:00:00Z"),
  },
  {
    source: "guardian-athletics",
    kind: "news",
    pillar: "track_and_field",
    title: "Kipyegon smashes her own 1500m record at Paris meeting",
    summary: "Faith Kipyegon lowered her own mark again in Paris. She said the pacing felt smooth from the first lap.",
    url: "https://ex.test/2",
    publishedAt: new Date("2026-10-09T09:00:00Z"),
  },
];

async function setup(opts: Parameters<typeof makeDeps>[0] = {}, template: "stat_spotlight" | "training_tip" | "news_flash" = "stat_spotlight") {
  const ctx = await makeDeps({ ...(opts.reply ? {} : { provider: new StubProvider() }), now: NOW, ...opts });
  await storeItems(ctx.db, ctx.deps.embedder, template === "training_tip" ? [] : NEWS, NOW);
  const ids = (await listRecentItems(ctx.db, 48, NOW)).map((i) => i.id);
  const content = await createContent(ctx.db, {
    pillar: template === "training_tip" ? "running" : "track_and_field",
    template,
    topic: template === "training_tip" ? "Three habits for easier running" : "Kipyegon's record time",
    hookStyle: "stat",
    idea: { angle: "the time" },
    sourceItemIds: ids,
    correlationId: CID,
  });
  return { ...ctx, content };
}

describe("runScript with the stub LLM (real fact-check path)", () => {
  it("writes a grounded script: every claim resolves to a source and passes verification, then enqueues voice", async () => {
    const { deps, db, content, enqueued } = await setup();
    expect(await runScript(deps, { contentId: content.id, correlationId: CID, regen: 0 })).toBe("scripted");
    const row = (await getContent(db, content.id))!;
    expect(row.status).toBe("scripted");
    const script = row.script as any;
    expect(script.generator).toBe("stub");
    expect(script.claims.length).toBeGreaterThanOrEqual(3);
    expect(script.claims.every((c: any) => c.sourceItemId)).toBe(true);
    expect(script.removed).toEqual([]);
    expect(script.estimatedDurationS).toBeGreaterThanOrEqual(12);
    expect(script.estimatedDurationS).toBeLessThanOrEqual(55);
    expect(narrationOf(script)).toContain("Kipyegon");
    expect(row.hookStyle).toBe(script.hookStyle);
    expect(enqueued).toEqual([{ queue: "voice", data: { contentId: content.id, correlationId: CID, regen: 0 }, opts: undefined }]);
    const events = (await db.query(`SELECT to_status, stage FROM content_events WHERE content_id = $1 ORDER BY id`, [content.id])).rows;
    expect(events.map((e) => e.to_status)).toEqual(["idea", "scripted"]);
  });

  it("is idempotent: a redelivered job does not rewrite the script or enqueue a second voice job", async () => {
    const { deps, content, enqueued } = await setup();
    await runScript(deps, { contentId: content.id, correlationId: CID, regen: 0 });
    expect(await runScript(deps, { contentId: content.id, correlationId: CID, regen: 0 })).toBe("skipped");
    expect(enqueued.filter((e) => e.queue === "voice")).toHaveLength(1);
  });

  it("evergreen templates use unsourced general claims and need no source items", async () => {
    const { deps, db, content } = await setup({}, "training_tip");
    expect(await runScript(deps, { contentId: content.id, correlationId: CID, regen: 0 })).toBe("scripted");
    const script = ((await getContent(db, content.id))!.script as any);
    expect(script.claims.filter((c: any) => c.kind === "general").length).toBe(3);
    expect(script.claims.every((c: any) => c.sourceItemId === null)).toBe(true);
    expect(narrationOf(script)).toMatch(/not personal advice/i);
  });
});

describe("runScript fact-check pre-filter", () => {
  const writer = (beats: any[], claims: any[]) => ({
    title: "Kipyegon's record time",
    hookStyle: "stat",
    beats,
    claims,
    visual: { headline: "Record", stat: "3:49.04", statLabel: "1500m", items: [] },
    variants: { tiktok: { caption: "c", hashtags: [] }, instagram: { caption: "c", hashtags: [] }, youtube: { title: "t", description: "d", hashtags: [] } },
  });
  const goodBeats = [
    { id: "b1", text: "Faith Kipyegon ran 3:49.04 in Paris on Thursday night.", onScreen: "3:49.04", claimIds: ["c1"] },
    { id: "b2", text: "The time took 0.38 seconds off her own world record.", onScreen: "", claimIds: ["c2"] },
    { id: "b3", text: "She led from the front and kicked clear over the final lap.", onScreen: "", claimIds: ["c3"] },
    { id: "b4", text: "Follow Momentum for more.", onScreen: "", claimIds: [] },
  ];
  const goodClaims = [
    { id: "c1", text: "Faith Kipyegon ran 3:49.04 in Paris on Thursday night.", source: "S1", kind: "fact" },
    { id: "c2", text: "The time took 0.38 seconds off her own world record.", source: "S1", kind: "stat" },
    { id: "c3", text: "She led from the front and kicked clear over the final lap.", source: "S1", kind: "fact" },
  ];
  const supportAll = (req: any) => (req.task === "qa.verify_claims" ? { verdicts: req.input.claims.map((c: any) => ({ id: c.id, verdict: "supported", note: "" })) } : null);

  it("removes a beat that states an unsourced figure and records why, keeping the rest", async () => {
    const beats = [...goodBeats.slice(0, 3), { id: "b9", text: "That is 12 percent faster than the old mark.", onScreen: "", claimIds: [] }, goodBeats[3]!];
    const { deps, db, content } = await setup({ reply: (r) => supportAll(r) ?? writer(beats, goodClaims) });
    expect(await runScript(deps, { contentId: content.id, correlationId: CID, regen: 0 })).toBe("scripted");
    const script = ((await getContent(db, content.id))!.script as any);
    expect(script.beats.map((b: any) => b.id)).toEqual(["b1", "b2", "b3", "b4"]);
    expect(script.removed).toEqual([{ beatId: "b9", reason: expect.stringContaining('unsourced figure "12"') }]);
  });

  it("removes a beat resting on a hallucinated claim even when the LLM judge would approve it", async () => {
    const claims = [...goodClaims, { id: "c4", text: "Jakob Ingebrigtsen finished second in 3:51.00.", source: "S1", kind: "fact" }];
    const beats = [goodBeats[0]!, goodBeats[1]!, goodBeats[2]!, { id: "b5", text: "Jakob Ingebrigtsen was second in 3:51.00.", onScreen: "", claimIds: ["c4"] }, goodBeats[3]!];
    const { deps, db, content } = await setup({ reply: (r) => supportAll(r) ?? writer(beats, claims) });
    await runScript(deps, { contentId: content.id, correlationId: CID, regen: 0 });
    const script = ((await getContent(db, content.id))!.script as any);
    expect(script.beats.map((b: any) => b.id)).not.toContain("b5");
    expect(script.claims.map((c: any) => c.id)).not.toContain("c4");
    expect(script.removed[0].reason).toMatch(/c4/);
  });

  it("drops references to non-existent claims instead of trusting them", async () => {
    const beats = goodBeats.map((b, i) => (i === 3 ? { ...b, claimIds: ["c999"] } : b));
    const { deps, db, content } = await setup({ reply: (r) => supportAll(r) ?? writer(beats, goodClaims) });
    await runScript(deps, { contentId: content.id, correlationId: CID, regen: 0 });
    expect(((await getContent(db, content.id))!.script as any).beats[3].claimIds).toEqual([]);
  });

  it("when too little survives, regenerates with feedback; after the max, fails the idea and alerts", async () => {
    const bad = writer(
      [
        { id: "b1", text: "Mo Farah ran 2:01:09 yesterday.", onScreen: "", claimIds: ["c1"] },
        { id: "b2", text: "It beat 14 rivals easily.", onScreen: "", claimIds: [] },
        { id: "b3", text: "Everyone was stunned by 99 percent.", onScreen: "", claimIds: [] },
      ],
      [{ id: "c1", text: "Mo Farah ran 2:01:09 yesterday.", source: "S1", kind: "fact" }],
    );
    const { deps, db, content, enqueued } = await setup({ reply: (r) => supportAll(r) ?? bad });
    expect(await runScript(deps, { contentId: content.id, correlationId: CID, regen: 0 })).toBe("regenerating");
    let row = (await getContent(db, content.id))!;
    expect(row).toMatchObject({ status: "idea", regenCount: 1 });
    expect(row.qaFeedback).toContain("could not be grounded");
    expect(enqueued.at(-1)).toMatchObject({ queue: "script", data: { regen: 1 } });

    await runScript(deps, { contentId: content.id, correlationId: CID, regen: 1 });
    expect((await getContent(db, content.id))!.regenCount).toBe(2);
    expect(await runScript(deps, { contentId: content.id, correlationId: CID, regen: 2 })).toBe("failed");
    row = (await getContent(db, content.id))!;
    expect(row).toMatchObject({ status: "failed", failedStage: "script" });
    expect((await db.query(`SELECT 1 FROM alerts_log WHERE key LIKE 'script_ungroundable:%'`)).rowCount).toBe(1);
  });

  it("feeds QA feedback from a failed review into the next writer prompt", async () => {
    const seen: string[] = [];
    const { deps, db, content } = await setup({
      reply: (r) => {
        if (r.task === "script.write") seen.push(r.prompt);
        return supportAll(r) ?? writer(goodBeats, goodClaims);
      },
    });
    await db.query(`UPDATE content SET qa_feedback = 'Make the hook punchier.', regen_count = 1 WHERE id = $1`, [content.id]);
    await runScript(deps, { contentId: content.id, correlationId: CID, regen: 1 });
    expect(seen[0]).toContain("A previous version FAILED review");
    expect(seen[0]).toContain("Make the hook punchier.");
    expect(((await getContent(db, content.id))!).qaFeedback).toBeNull(); // consumed
  });
});

describe("duration trimming", () => {
  it("drops trailing beats until under the cap but never below 3 beats", () => {
    const beats = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, text: Array(20).fill("word").join(" "), onScreen: "", claimIds: [] }));
    expect(estimateDurationS({ beats })).toBeGreaterThan(55);
    const t = trimToDuration({ beats });
    expect(estimateDurationS(t)).toBeLessThanOrEqual(55);
    expect(t.beats[0]!.id).toBe("b0"); // hook kept
    const tiny = trimToDuration({ beats: beats.slice(0, 3) }, 1);
    expect(tiny.beats).toHaveLength(3);
  });
  it("transition helper still guards the state machine (sanity)", async () => {
    const { db, content } = await setup();
    expect(await transition(db, content.id, "idea", "scripted", {}, { stage: "x" })).not.toBeNull();
  });
});
