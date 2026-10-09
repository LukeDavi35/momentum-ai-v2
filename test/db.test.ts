import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { ALLOWED_TRANSITIONS, CONTENT_STATUSES, countByStatus, createContent, getContent, listEvents, transition } from "../src/db/content.js";
import { getSetting, setSetting } from "../src/db/settings.js";
import { testDb } from "./helpers.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});

const newIdea = () => ({
  pillar: "running" as const,
  template: "news_flash" as const,
  topic: "Test topic",
  idea: { angle: "x" },
  sourceItemIds: [],
});

describe("content state machine", () => {
  it("creates content in `idea` with a correlation id and an event", async () => {
    const c = await createContent(db, newIdea());
    expect(c.status).toBe("idea");
    expect(c.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    const events = await listEvents(db, c.id);
    expect(events).toHaveLength(1);
    expect(events[0].to_status).toBe("idea");
  });

  it("advances along the happy path and records every transition", async () => {
    const c = await createContent(db, newIdea());
    const path = ["scripted", "voiced", "rendered", "qa_passed", "scheduled", "published", "measured"] as const;
    let from: any = "idea";
    for (const to of path) {
      const row = await transition(db, c.id, from, to, {}, { stage: "test" });
      expect(row?.status).toBe(to);
      from = to;
    }
    const events = await listEvents(db, c.id);
    expect(events.map((e) => e.to_status)).toEqual(["idea", ...path]);
  });

  it("is idempotent: a second transition from the same `from` is a no-op returning null", async () => {
    const c = await createContent(db, newIdea());
    const first = await transition(db, c.id, "idea", "scripted", { script: { a: 1 } }, { stage: "script" });
    const second = await transition(db, c.id, "idea", "scripted", { script: { a: 2 } }, { stage: "script" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const row = await getContent(db, c.id);
    expect(row?.script).toEqual({ a: 1 }); // the duplicate delivery did not overwrite
    expect(await listEvents(db, c.id)).toHaveLength(2);
  });

  it("rejects illegal transitions", async () => {
    const c = await createContent(db, newIdea());
    await expect(transition(db, c.id, "idea", "published", {}, { stage: "x" })).rejects.toThrow(/Illegal/);
  });

  it("never allows a path from `held` straight to scheduled/published", () => {
    expect(ALLOWED_TRANSITIONS.held).toEqual(["idea"]);
    for (const s of CONTENT_STATUSES) {
      if (s !== "qa_passed") expect(ALLOWED_TRANSITIONS[s]).not.toContain("scheduled");
    }
  });

  it("rejects patching a non-whitelisted column (no SQL injection via column name)", async () => {
    const c = await createContent(db, newIdea());
    await expect(transition(db, c.id, "idea", "scripted", { "status; DROP TABLE content": 1 } as any, { stage: "x" })).rejects.toThrow(/not patchable/);
  });

  it("counts by status including zero buckets", async () => {
    await createContent(db, newIdea());
    const counts = await countByStatus(db);
    expect(counts.idea).toBe(1);
    expect(counts.held).toBe(0);
  });
});

describe("settings", () => {
  it("upserts JSON values", async () => {
    await setSetting(db, "k", { a: 1 });
    await setSetting(db, "k", { a: 2 }, "tester");
    expect(await getSetting(db, "k")).toEqual({ a: 2 });
    expect(await getSetting(db, "missing")).toBeUndefined();
  });
});
