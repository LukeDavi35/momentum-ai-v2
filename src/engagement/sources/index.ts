import { dirname, join } from "node:path";
import type { AppConfig, Platform } from "../../config/index.js";
import type { TokenStore } from "../../publish/tokens.js";
import type { CommentSource } from "../types.js";
import { DryRunCommentSource } from "./dryrun.js";
import { FacebookCommentSource } from "./facebook.js";
import { InstagramCommentSource } from "./instagram.js";
import { YouTubeCommentSource } from "./youtube.js";

/** TikTok's and X's APIs have no comment access - neither gets an entry here. */
export const COMMENT_PLATFORMS: readonly Platform[] = ["instagram", "facebook", "youtube"];

/** DRY_RUN=true can only ever yield dry-run sources: there is no code path to a real API from here. */
export function buildCommentSources(cfg: AppConfig, tokens: TokenStore | undefined, f: typeof fetch = fetch): Partial<Record<Platform, CommentSource>> {
  if (cfg.env.DRY_RUN) {
    const out = join(dirname(cfg.env.MEDIA_DIR), "dryrun");
    return Object.fromEntries(COMMENT_PLATFORMS.map((p) => [p, new DryRunCommentSource(p, out)]));
  }
  if (!tokens) return {};
  return {
    instagram: new InstagramCommentSource(async () => (await tokens.getValidAccessToken("instagram")).accessToken, f),
    facebook: new FacebookCommentSource(async () => (await tokens.getValidAccessToken("facebook")).accessToken, f),
    youtube: new YouTubeCommentSource(async () => (await tokens.getValidAccessToken("youtube")).accessToken, f),
  };
}
