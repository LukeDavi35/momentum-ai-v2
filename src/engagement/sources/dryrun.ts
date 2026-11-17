import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "../../config/index.js";
import type { CommentSource, FetchedComment } from "../types.js";

/** DRY_RUN stand-in: never invents comments to react to, and writes any reply/hide payload to out/dryrun/ like DryRunPublisher. */
export class DryRunCommentSource implements CommentSource {
  readonly supportsHide = true;
  constructor(readonly platform: Platform, private readonly outDir: string) {}

  async fetchComments(): Promise<FetchedComment[]> {
    return [];
  }

  async reply(commentId: string, text: string): Promise<string> {
    mkdirSync(this.outDir, { recursive: true });
    const file = join(this.outDir, `reply-${this.platform}-${commentId}.json`);
    writeFileSync(file, JSON.stringify({ note: "DRY_RUN — nothing was sent to the platform.", platform: this.platform, commentId, wouldReply: text }, null, 2));
    return `dryrun_reply_${commentId}`;
  }

  async hide(commentId: string): Promise<void> {
    mkdirSync(this.outDir, { recursive: true });
    const file = join(this.outDir, `hide-${this.platform}-${commentId}.json`);
    writeFileSync(file, JSON.stringify({ note: "DRY_RUN — nothing was sent to the platform.", platform: this.platform, commentId, wouldHide: true }, null, 2));
  }
}
