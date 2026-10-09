import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "../../config/index.js";
import type { Metrics, PublishRequest, PublishResult, Publisher } from "../types.js";

/**
 * DRY_RUN stand-in: performs NO network calls. It writes the exact payload that would have been
 * sent to out/dryrun/ so the owner can inspect real output before switching publishing on.
 * Its metrics are deterministic SYNTHETIC numbers (flagged raw.synthetic) used only to exercise the
 * analytics + learning code; the learning loop never persists weights derived from them.
 */
export class DryRunPublisher implements Publisher {
  readonly live = false;
  constructor(readonly platform: Platform, private readonly outDir: string) {}

  async publish(req: PublishRequest): Promise<PublishResult> {
    await req.assertLive();
    mkdirSync(this.outDir, { recursive: true });
    const id = `dryrun_${createHash("sha1").update(`${this.platform}:${req.contentId}`).digest("hex").slice(0, 12)}`;
    const file = join(this.outDir, `${this.platform}-${req.contentId}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          note: "DRY_RUN — nothing was sent to the platform. This is the payload that would have been posted.",
          platform: this.platform,
          wouldPost: { title: req.meta.title, caption: req.meta.caption, hashtags: req.meta.hashtags, aiDisclosure: req.meta.aiDisclosure, sourceCredit: req.meta.sourceCredit },
          video: { path: req.videoPath, durationS: req.durationS, publicUrl: req.mediaUrl ?? null },
          cover: req.coverPath ?? null,
        },
        null,
        2,
      ),
    );
    return { externalId: id, url: `dryrun://${this.platform}/${id}`, warnings: [`dry run: payload written to ${file}`] };
  }

  async metrics(externalId: string): Promise<Metrics> {
    const h = createHash("sha1").update(externalId).digest();
    const views = 200 + h.readUInt16BE(0) % 5000;
    return {
      views,
      likes: Math.round(views * (0.03 + (h[2]! % 50) / 1000)),
      comments: Math.round(views * 0.004),
      shares: Math.round(views * (0.005 + (h[3]! % 20) / 1000)),
      saves: Math.round(views * 0.008),
      follows: Math.round(views * 0.002),
      avgViewDurationS: 8 + (h[4]! % 15),
      retentionPct: 35 + (h[5]! % 40),
      raw: { synthetic: true },
    };
  }
}
