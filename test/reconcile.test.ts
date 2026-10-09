import { describe, expect, it } from "vitest";
import { createContent, transition } from "../src/db/content.js";
import { reconcile, housekeeping } from "../src/queue/maintenance.js";
import { makeDeps } from "./helpers.js";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = new Date("2026-10-20T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const CID = "00000000-0000-4000-8000-0000000000bb";

async function setup() {
  const ctx = await makeDeps({ now: NOW });
  const mk = async (status: string, ageMin: number, regen = 0) => {
    const c = await createContent(ctx.db, { pillar: "running", template: "news_flash", topic: `t-${status}`, idea: {}, sourceItemIds: [], correlationId: CID });
    await ctx.db.query(`UPDATE content SET status = $2, status_changed_at = $3, regen_count = $4 WHERE id = $1`, [c.id, status, minsAgo(ageMin), regen]);
    return c;
  };
  return { ...ctx, mk };
}
const never = async () => false;
const always = async () => true;

describe("reconcile: stuck content", () => {
  it("re-enqueues the missing next-stage job for items stranded between a commit and the enqueue", async () => {
    const { deps, mk, enqueued } = await setup();
    const idea = await mk("idea", 30);
    const scripted = await mk("scripted", 30);
    const voiced = await mk("voiced", 30);
    const rendered = await mk("rendered", 30);
    const passed = await mk("qa_passed", 30);
    const r = await reconcile(deps, never);
    expect(r.contentRequeued).toBe(5);
    const byContent = Object.fromEntries(enqueued.map((e) => [e.data.contentId, e]));
    expect(byContent[idea.id]!.queue).toBe("script");
    expect(byContent[scripted.id]!.queue).toBe("voice");
    expect(byContent[voiced.id]!.queue).toBe("render");
    expect(byContent[rendered.id]!.queue).toBe("qa");
    expect(byContent[passed.id]).toMatchObject({ queue: "publish", data: { kind: "schedule" } });
    // fresh job id (so a retained completed job with the old id can't swallow it) and the same correlation id
    expect(byContent[idea.id]!.opts!.jobId).toMatch(/^script__.*__r0__rc\d+$/);
    expect(byContent[idea.id]!.data.correlationId).toBe(CID);
  });

  it("leaves alone items that are recent or whose job is still pending", async () => {
    const { deps, mk, enqueued } = await setup();
    await mk("idea", 5); // too recent
    await mk("scripted", 45); // old, but a job exists
    expect((await reconcile(deps, always)).contentRequeued).toBe(0);
    expect((await reconcile(deps, never)).contentRequeued).toBe(1); // only the old one once nothing is pending
    expect(enqueued).toHaveLength(1);
  });

  it("uses the item's current regeneration round in the job id", async () => {
    const { deps, mk, enqueued } = await setup();
    await mk("idea", 40, 2);
    await reconcile(deps, never);
    expect(enqueued[0]!.opts!.jobId).toMatch(/__r2__rc/);
  });
});

describe("reconcile: publications and analytics", () => {
  it("re-enqueues an overdue scheduled publication, but not one that is not yet overdue", async () => {
    const { deps, mk, db, enqueued } = await setup();
    const c = await mk("scheduled", 120);
    await db.query(`INSERT INTO publications (id, content_id, platform, status, scheduled_at, metadata) VALUES (gen_random_uuid(), $1, 'tiktok', 'scheduled', $2, '{"reschedules":1}'::jsonb)`, [c.id, minsAgo(60)]);
    await db.query(`INSERT INTO publications (id, content_id, platform, status, scheduled_at) VALUES (gen_random_uuid(), $1, 'youtube', 'scheduled', $2)`, [c.id, minsAgo(5)]);
    const r = await reconcile(deps, never);
    expect(r.publicationsRequeued).toBe(1);
    const e = enqueued.find((x) => x.queue === "publish")!;
    expect(e.data).toMatchObject({ kind: "publish", contentId: c.id, correlationId: CID, regen: 1 });
  });

  it("parks a publication stuck in `publishing` as OUTCOME UNKNOWN (never auto-retried) with a critical alert", async () => {
    const { deps, mk, db } = await setup();
    const c = await mk("scheduled", 120);
    const stuck = (await db.query(`INSERT INTO publications (id, content_id, platform, status, updated_at) VALUES (gen_random_uuid(), $1, 'instagram', 'publishing', $2) RETURNING id`, [c.id, minsAgo(45)])).rows[0].id;
    const fresh = (await db.query(`INSERT INTO publications (id, content_id, platform, status, updated_at) VALUES (gen_random_uuid(), $1, 'youtube', 'publishing', $2) RETURNING id`, [c.id, minsAgo(2)])).rows[0].id;
    const r = await reconcile(deps, never);
    expect(r.publishingParked).toBe(1);
    const rows = Object.fromEntries((await db.query(`SELECT id, status, error FROM publications`)).rows.map((x) => [x.id, x]));
    expect(rows[stuck].status).toBe("failed");
    expect(rows[stuck].error).toMatch(/outcome unknown/);
    expect(rows[fresh].status).toBe("publishing"); // an in-flight publish is left alone
    expect((await db.query(`SELECT severity FROM alerts_log WHERE key = $1`, [`publish_stuck:${stuck}`])).rows[0].severity).toBe("critical");
  });

  it("re-requests overdue analytics checkpoints that have no snapshot and no pending job", async () => {
    const { deps, mk, db, enqueued } = await setup();
    const c = await mk("published", 60 * 30);
    const pid = (await db.query(`INSERT INTO publications (id, content_id, platform, status, external_id, published_at) VALUES (gen_random_uuid(), $1, 'youtube', 'published', 'x', $2) RETURNING id`, [c.id, minsAgo(60 * 30)])).rows[0].id;
    await db.query(`INSERT INTO analytics_snapshots (publication_id, checkpoint, views) VALUES ($1, '1h', 10)`, [pid]);
    const r = await reconcile(deps, never);
    // 30h old: 1h has a snapshot; 24h is overdue and missing; 7d is not due yet
    expect(r.analyticsRequeued).toBe(1);
    expect(enqueued.find((e) => e.queue === "analytics")!.data).toMatchObject({ publicationId: pid, checkpoint: "24h" });
    expect((await reconcile(deps, always)).analyticsRequeued).toBe(0); // a pending job suppresses the re-request
  });
});

describe("housekeeping", () => {
  it("deletes media of old finished pieces only (never held or recent ones)", async () => {
    const media = mkdtempSync(join(tmpdir(), "hk-"));
    const { deps, mk } = await setup();
    deps.cfg.env.MEDIA_DIR = media;
    const mkMedia = (id: string) => {
      mkdirSync(join(media, id), { recursive: true });
      writeFileSync(join(media, id, "video.mp4"), "x");
    };
    const oldDone = await mk("measured", 60 * 24 * 20);
    const oldFailed = await mk("failed", 60 * 24 * 20);
    const oldHeld = await mk("held", 60 * 24 * 20);
    const recentDone = await mk("measured", 60 * 24 * 2);
    for (const c of [oldDone, oldFailed, oldHeld, recentDone]) mkMedia(c.id);
    expect((await housekeeping(deps)).removed).toBe(2);
    expect(existsSync(join(media, oldDone.id))).toBe(false);
    expect(existsSync(join(media, oldFailed.id))).toBe(false);
    expect(existsSync(join(media, oldHeld.id))).toBe(true); // held items are kept for review
    expect(existsSync(join(media, recentDone.id))).toBe(true);
  });
});
