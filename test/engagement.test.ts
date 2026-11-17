import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/db.js";
import { runCommentPoll } from "../src/engagement/agent.js";
import { checkReply, isCrisisLanguage, isEmojiOnly, isLikelySpam } from "../src/engagement/policy.js";
import { decide } from "../src/engagement/triage.js";
import type { CommentSource, FetchedComment } from "../src/engagement/types.js";
import { makeDeps } from "./helpers.js";

// ------------------------------------------------------------------ policy.ts

describe("isCrisisLanguage / isLikelySpam / isEmojiOnly", () => {
  it("catches crisis language", () => {
    expect(isCrisisLanguage("I want to end it all")).toBe(true);
    expect(isCrisisLanguage("great video!")).toBe(false);
  });
  it("catches spam", () => {
    expect(isLikelySpam("follow me for follow back!")).toBe(true);
    expect(isLikelySpam("what a finish")).toBe(false);
  });
  it("catches emoji-only comments but not text with emoji in it", () => {
    expect(isEmojiOnly("🔥🔥🔥")).toBe(true);
    expect(isEmojiOnly("")).toBe(false);
    expect(isEmojiOnly("amazing 🔥")).toBe(false);
  });
});

describe("checkReply", () => {
  it("passes a clean, on-topic reply", () => {
    expect(checkReply("Thanks for watching! Glad you enjoyed it.", false).ok).toBe(true);
  });
  it.each([
    ["check out https://example.com", "contains a link"],
    ["only £5 for the full version", "mentions a price"],
    ["dm me and I'll sort it", "invites off-platform contact"],
    ["go ask @someoneelse about that", "mentions another account"],
    ["I'm not AI, I'm a real person", "denies being AI"],
  ])("flags %j", (text) => {
    expect(checkReply(text, false).ok).toBe(false);
  });
  it("requires an honest answer to an explicit AI question", () => {
    expect(checkReply("Thanks for watching!", true).ok).toBe(false);
    expect(checkReply("Yep, this account is AI-assisted!", true).ok).toBe(true);
  });
  it("rejects a reply over the length cap", () => {
    expect(checkReply("x".repeat(281), false).issues).toContain("reply too long (281 > 280)");
  });
});

// ------------------------------------------------------------------ triage.ts

describe("decide", () => {
  it.each([
    ["question", "reply"],
    ["compliment", "reply"],
    ["conversation", "reply"],
    ["ai_question", "reply"],
    ["spam", "hide"],
    ["abusive", "hide"],
    ["sexual", "hide"],
    ["sensitive", "hold"],
    ["commercial", "hold"],
    ["complaint", "hold"],
    ["flirt", "skip"],
    ["other", "skip"],
    ["emoji_only", "skip"],
  ] as const)("%s -> %s", (category, action) => {
    expect(decide(category)).toBe(action);
  });
});

// ------------------------------------------------------------------ agent.ts

class FakeCommentSource implements CommentSource {
  readonly supportsHide = true;
  calls: { fn: string; args: unknown[] }[] = [];
  constructor(readonly platform: "instagram" | "facebook" | "youtube", private comments: FetchedComment[] = []) {}
  async fetchComments(externalId: string): Promise<FetchedComment[]> {
    this.calls.push({ fn: "fetchComments", args: [externalId] });
    return this.comments;
  }
  async reply(commentId: string, text: string): Promise<string> {
    this.calls.push({ fn: "reply", args: [commentId, text] });
    return "reply1";
  }
  async hide(commentId: string): Promise<void> {
    this.calls.push({ fn: "hide", args: [commentId] });
  }
}

const NOW = new Date("2026-11-17T12:00:00Z");

async function seedPublication(db: Db, platform: string, externalId: string, publishedDaysAgo = 1): Promise<string> {
  const contentId = randomUUID();
  const pubId = randomUUID();
  await db.query(`INSERT INTO content (id, correlation_id, status, pillar, template, topic) VALUES ($1, gen_random_uuid(), 'published', 'football', 'news_flash', 'A big match')`, [contentId]);
  await db.query(
    `INSERT INTO publications (id, content_id, platform, status, published_at, external_id, dry_run) VALUES ($1,$2,$3,'published',$4,$5,false)`,
    [pubId, contentId, platform, new Date(NOW.getTime() - publishedDaysAgo * 86_400_000).toISOString(), externalId],
  );
  return pubId;
}

function comment(externalId: string, text: string, overrides: Partial<FetchedComment> = {}): FetchedComment {
  return { externalId, author: "fan1", authorId: "u1", text, postedAt: NOW, ...overrides };
}

describe("runCommentPoll", () => {
  let ctxP: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctxP = makeDeps({ now: NOW, env: { DRY_RUN: "false" } });
  });

  it("does nothing for a platform with replies disabled, even with a CommentSource configured", async () => {
    const { deps, db } = await ctxP;
    await seedPublication(db, "instagram", "ext1");
    const source = new FakeCommentSource("instagram", [comment("c1", "nice video")]);
    const r = await runCommentPoll({ ...deps, commentSources: { instagram: source } });
    expect(r).toEqual({ fetched: 0, triaged: 0, sent: "none" });
    expect(source.calls).toHaveLength(0);
  });

  it("fetches, inserts, and holds crisis language with a critical alert, never queuing a reply", async () => {
    const { deps, db } = await ctxP;
    deps.cfg.schedule.platforms.instagram.replies = true;
    await seedPublication(db, "instagram", "ext1");
    const source = new FakeCommentSource("instagram", [comment("c1", "I just want to end it all")]);
    const sent: Array<{ key: string; severity: string }> = [];
    deps.alerter.send = (async (a: any) => (sent.push(a), { sent: [], suppressed: false })) as any;

    const r = await runCommentPoll({ ...deps, commentSources: { instagram: source } });
    expect(r.fetched).toBe(1);
    expect(r.triaged).toBe(1);
    const row = (await db.query<{ status: string }>(`SELECT status FROM comments WHERE external_id = 'c1'`)).rows[0];
    expect(row?.status).toBe("held");
    expect(sent.some((a) => a.severity === "critical" && a.key.startsWith("comment_crisis"))).toBe(true);
  });

  it("queues likely spam for hiding without any LLM call, and hides it the same tick since it's immediately eligible", async () => {
    const { deps, db, provider } = await ctxP;
    deps.cfg.schedule.platforms.instagram.replies = true;
    await seedPublication(db, "instagram", "ext1");
    const source = new FakeCommentSource("instagram", [comment("c1", "follow me for follow back, free crypto giveaway")]);
    const d = { ...deps, commentSources: { instagram: source }, rng: () => 0 };

    const r = await runCommentPoll(d);
    expect(provider.calls).toHaveLength(0); // no triage LLM call for pre-filtered spam
    expect(r.sent).toBe("hide");
    expect(source.calls.some((c) => c.fn === "hide" && c.args[0] === "c1")).toBe(true);
    const row = (await db.query<{ status: string }>(`SELECT status FROM comments WHERE external_id = 'c1'`)).rows[0];
    expect(row?.status).toBe("hidden");
  });

  it("triages a question via the LLM into a queued reply, which sends once its human-like delay has passed", async () => {
    const reply = vi.fn((req: any) => (req.task === "comment_triage" ? { category: "question", reply: "Great question - it's all sourced from the news!" } : {}));
    const { deps, db } = await makeDeps({ now: NOW, env: { DRY_RUN: "false" }, reply });
    deps.cfg.schedule.platforms.instagram.replies = true;
    await seedPublication(db, "instagram", "ext1");
    const source = new FakeCommentSource("instagram", [comment("c1", "is that stat actually real?")]);

    // delayMinutesMin defaults to 4 - with rng() = 0 the delay is exactly 4 minutes
    await runCommentPoll({ ...deps, commentSources: { instagram: source }, rng: () => 0 });
    const queued = (await db.query<{ status: string; reply_text: string }>(`SELECT status, reply_text FROM comments WHERE external_id = 'c1'`)).rows[0];
    expect(queued).toMatchObject({ status: "queued", reply_text: "Great question - it's all sourced from the news!" });

    // not yet eligible (comment posted at NOW, delay is 4 minutes)
    const tooSoon = await runCommentPoll({ ...deps, commentSources: { instagram: source }, rng: () => 0, now: () => new Date(NOW.getTime() + 60_000) });
    expect(tooSoon.sent).toBe("none");

    // 5 minutes later, past the delay
    const r3 = await runCommentPoll({ ...deps, commentSources: { instagram: source }, rng: () => 0, now: () => new Date(NOW.getTime() + 5 * 60_000) });
    expect(r3.sent).toBe("reply");
    expect(source.calls.some((c) => c.fn === "reply" && c.args[0] === "c1")).toBe(true);
  });

  it("holds a reply that fails the safety check instead of sending it", async () => {
    const reply = vi.fn((req: any) => (req.task === "comment_triage" ? { category: "question", reply: "DM me and I'll explain, https://scam.example" } : {}));
    const { deps, db } = await makeDeps({ now: NOW, env: { DRY_RUN: "false" }, reply });
    deps.cfg.schedule.platforms.instagram.replies = true;
    await seedPublication(db, "instagram", "ext1");
    const source = new FakeCommentSource("instagram", [comment("c1", "how does this work?")]);

    await runCommentPoll({ ...deps, commentSources: { instagram: source }, rng: () => 0 });
    const row = (await db.query<{ status: string; error: string }>(`SELECT status, error FROM comments WHERE external_id = 'c1'`)).rows[0];
    expect(row?.status).toBe("held");
    expect(row?.error).toMatch(/link|contact/);
  });

  it("never sends a second reply within minGapSeconds of the last one", async () => {
    const reply = vi.fn((req: any) => (req.task === "comment_triage" ? { category: "compliment", reply: "Thank you!" } : {}));
    const { deps, db } = await makeDeps({ now: NOW, env: { DRY_RUN: "false" }, reply });
    deps.cfg.schedule.platforms.instagram.replies = true;
    deps.cfg.schedule.comments.minGapSeconds = 600;
    const pubId = await seedPublication(db, "instagram", "ext1");
    // one already sent 1 minute ago - well inside the 10-minute gap
    await db.query(`INSERT INTO comments (id, publication_id, platform, external_id, text, status, acted_at, updated_at) VALUES (gen_random_uuid(), $1, 'instagram', 'prior', 'hi', 'replied', $2, $2)`, [pubId, new Date(NOW.getTime() - 60_000).toISOString()]);
    const source = new FakeCommentSource("instagram", [comment("c1", "lovely stuff")]);

    const r = await runCommentPoll({ ...deps, commentSources: { instagram: source }, rng: () => 0 });
    expect(r.sent).toBe("none");
    expect(source.calls.some((c) => c.fn === "reply")).toBe(false);
  });

  it("never exceeds the daily cap, even with eligible comments waiting", async () => {
    const reply = vi.fn((req: any) => (req.task === "comment_triage" ? { category: "compliment", reply: "Thank you!" } : {}));
    const { deps, db } = await makeDeps({ now: NOW, env: { DRY_RUN: "false" }, reply });
    deps.cfg.schedule.platforms.instagram.replies = true;
    deps.cfg.schedule.comments.dailyCap = 1;
    deps.cfg.schedule.comments.minGapSeconds = 0;
    const pubId = await seedPublication(db, "instagram", "ext1");
    await db.query(`INSERT INTO comments (id, publication_id, platform, external_id, text, status, acted_at, updated_at) VALUES (gen_random_uuid(), $1, 'instagram', 'prior', 'hi', 'replied', $2, $2)`, [pubId, new Date(NOW.getTime() - 60_000).toISOString()]);
    const source = new FakeCommentSource("instagram", [comment("c1", "lovely stuff")]);

    const r = await runCommentPoll({ ...deps, commentSources: { instagram: source }, rng: () => 0 });
    expect(r.sent).toBe("none");
  });
});
