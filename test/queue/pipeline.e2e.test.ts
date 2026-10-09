import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countByStatus } from "../../src/db/content.js";
import { buildPublishers } from "../../src/publish/factory.js";
import { storeItems } from "../../src/ingest/store.js";
import type { RawItem } from "../../src/ingest/types.js";
import { LlmClient } from "../../src/llm/client.js";
import { StubProvider } from "../../src/llm/stub.js";
import type { Runner } from "../../src/media/exec.js";
import { createRedis } from "../../src/queue/connection.js";
import { HANDLERS } from "../../src/queue/handlers.js";
import { makeMaintenanceHandler } from "../../src/queue/maintenance.js";
import { createQueues, makeEnqueue } from "../../src/queue/queues.js";
import { startWorkers } from "../../src/queue/worker.js";
import type { TtsProvider } from "../../src/voice/types.js";
import { makeDeps } from "../helpers.js";
import { REDIS_TEST_URL, redisUp, waitFor } from "./redis.js";

const up = await redisUp();
const CID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date();

const NEWS: RawItem[] = [
  { source: "bbc-athletics", kind: "news", pillar: "track_and_field", title: "Kipyegon breaks 1500m world record in Paris", summary: "Kenya's Faith Kipyegon ran 3:49.04 in Paris on Thursday night. The time took 0.38 seconds off her own world record.", bodyText: "The two-time Olympic champion led from the front and kicked clear over the final lap. Organisers said the crowd of 40000 stayed on its feet.", url: "https://ex.test/1", publishedAt: new Date(NOW.getTime() - 3600_000) },
  { source: "guardian-athletics", kind: "news", pillar: "track_and_field", title: "Kipyegon smashes her own 1500m record at Paris meeting", summary: "Faith Kipyegon lowered her own mark again in Paris. She said the pacing felt smooth from the first lap.", url: "https://ex.test/2", publishedAt: new Date(NOW.getTime() - 2 * 3600_000) },
  { source: "bbc-sport", kind: "news", pillar: "running", title: "London Marathon organisers confirm a new course for next year", summary: "Organisers said the revised route will pass the river twice and finish near the palace. Entries open in the spring for runners across the country.", url: "https://ex.test/3", publishedAt: new Date(NOW.getTime() - 3 * 3600_000) },
  { source: "espn-top", kind: "news", pillar: "sports_news", title: "Buccaneers beat Cowboys after a huge third quarter", summary: "The Buccaneers scored twenty points in the third quarter to turn the game around. Fans in Tampa stayed to the final whistle to celebrate.", url: "https://ex.test/4", publishedAt: new Date(NOW.getTime() - 4 * 3600_000) },
];

/** Fake ffmpeg/ffprobe: lets the REAL render + QA code (ASS generation, caption-sync, policy, state machine) run without media binaries. */
const fakeRunner: Runner = async (cmd, args) => {
  if (cmd.includes("ffprobe")) {
    const path = args[args.length - 1] ?? "";
    const dur = path.endsWith(".mp4") ? 24.7 : 24;
    return { stdout: JSON.stringify({ format: { duration: String(dur), size: "4000000" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1" }, { codec_type: "audio", codec_name: "aac" }] }), stderr: "" };
  }
  const a = args.join(" ");
  if (a.includes("loudnorm")) return { stdout: "", stderr: '{ "input_i" : "-15.1", "input_tp" : "-2.0", "input_lra" : "6", "input_thresh" : "-25", "target_offset" : "1.0" }' };
  if (a.includes("volumedetect")) return { stdout: "", stderr: "mean_volume: -19.0 dB" };
  return { stdout: "", stderr: "" };
};

const fakeTts: TtsProvider = {
  name: "dev-espeak",
  spendProvider: null,
  async synthesize(_text, outBase) {
    writeFileSync(`${outBase}.wav`, "RIFFfake");
    return { audioPath: `${outBase}.wav` };
  },
};

describe.skipIf(!up)("full pipeline through real BullMQ queues (DRY_RUN, fast mode)", () => {
  let redis: Redis;
  beforeAll(() => {
    redis = createRedis(REDIS_TEST_URL);
  });
  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  it("ideate -> script -> voice -> render -> qa -> schedule -> publish (dry-run) -> analytics -> measured, with one correlation id per piece", async () => {
    await redis.flushdb();
    const media = mkdtempSync(join(tmpdir(), "e2e-media-"));
    const ctx = await makeDeps({ env: { DRY_RUN: "true", DRY_RUN_FAST: "true", DRY_RUN_FAST_STEP_S: "1", MEDIA_DIR: join(media, "media") } });
    const { deps, db } = ctx;
    deps.cfg.schedule.ideate.keepTopN = 2;
    deps.cfg.schedule.plan.inventoryTargetPieces = 4;
    const qs = createQueues(redis);
    deps.enqueue = makeEnqueue(qs);
    deps.llm = new LlmClient(new StubProvider(), deps.spend, deps.cfg.env, deps.log);
    deps.runner = fakeRunner;
    deps.tts = [fakeTts];
    deps.publishers = buildPublishers(deps.cfg, undefined);
    await storeItems(db, deps.embedder, NEWS, NOW);

    const handle = startWorkers(deps, qs, redis, HANDLERS, makeMaintenanceHandler(qs, undefined));
    try {
      await qs.queues.ideate.add("ideate", { kind: "cycle", correlationId: CID }, { jobId: "e2e-ideate" });
      // wait for every created piece to be fully measured
      await waitFor(async () => {
        const c = await countByStatus(db);
        return c.measured >= 2 && c.idea + c.scripted + c.voiced + c.rendered + c.qa_passed + c.scheduled + c.published === 0 ? c : false;
      }, 90_000, 250);

      const counts = await countByStatus(db);
      expect(counts.measured).toBeGreaterThanOrEqual(2);
      expect(counts.failed + counts.held).toBe(0);

      // every piece went through every stage, in order, under ONE correlation id
      const pieces = (await db.query(`SELECT id, correlation_id FROM content WHERE status = 'measured'`)).rows;
      for (const p of pieces) {
        const ev = (await db.query(`SELECT to_status, correlation_id FROM content_events WHERE content_id = $1 AND to_status IS NOT NULL ORDER BY id`, [p.id])).rows;
        expect(ev.map((e) => e.to_status)).toEqual(["idea", "scripted", "voiced", "rendered", "qa_passed", "scheduled", "published", "measured"]);
        expect(new Set(ev.map((e) => e.correlation_id))).toEqual(new Set([p.correlation_id]));
      }

      // a QA result was recorded and passed; all three platforms published via the DRY-RUN publisher only
      const qa = (await db.query(`SELECT passed FROM qa_results`)).rows;
      expect(qa.length).toBe(pieces.length);
      expect(qa.every((r) => r.passed)).toBe(true);
      const pubs = (await db.query(`SELECT platform, status, dry_run, url FROM publications`)).rows;
      expect(pubs).toHaveLength(pieces.length * 3);
      expect(pubs.every((p) => p.status === "published" && p.dry_run === true && String(p.url).startsWith("dryrun://"))).toBe(true);
      const dryDir = join(media, "dryrun");
      expect(existsSync(dryDir)).toBe(true);
      expect(readdirSync(dryDir).filter((f) => f.endsWith(".json"))).toHaveLength(pubs.length);
      const payload = JSON.parse(readFileSync(join(dryDir, readdirSync(dryDir)[0]!), "utf8"));
      expect(payload.note).toMatch(/DRY_RUN/);
      expect(payload.wouldPost.aiDisclosure.applied).toBe(true);

      // analytics: a snapshot per checkpoint per publication
      expect((await db.query(`SELECT COUNT(*)::int AS n FROM analytics_snapshots`)).rows[0].n).toBe(pubs.length * 3);
      // nothing was dead-lettered along the way
      expect((await db.query(`SELECT 1 FROM dead_letters`)).rowCount).toBe(0);
    } finally {
      await handle.close(10_000);
      await qs.close();
    }
  }, 120_000);
});
