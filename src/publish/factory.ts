import { dirname, join } from "node:path";
import type { AppConfig, Platform } from "../config/index.js";
import { DryRunPublisher } from "./publishers/dryrun.js";
import { InstagramPublisher } from "./publishers/instagram.js";
import { TikTokPublisher } from "./publishers/tiktok.js";
import { YouTubePublisher } from "./publishers/youtube.js";
import type { TokenStore } from "./tokens.js";
import type { Publisher } from "./types.js";

/** DRY_RUN=true can only ever yield dry-run publishers: there is no code path to a real API from here. */
export function buildPublishers(cfg: AppConfig, tokens: TokenStore | undefined, f: typeof fetch = fetch): Record<Platform, Publisher> {
  if (cfg.env.DRY_RUN) {
    const out = join(dirname(cfg.env.MEDIA_DIR), "dryrun");
    return { tiktok: new DryRunPublisher("tiktok", out), instagram: new DryRunPublisher("instagram", out), youtube: new DryRunPublisher("youtube", out) };
  }
  if (!tokens) throw new Error("live publishing needs a TokenStore (TOKEN_ENC_KEY must be set)");
  return {
    tiktok: new TikTokPublisher(async () => (await tokens.getValidAccessToken("tiktok")).accessToken, f),
    instagram: new InstagramPublisher(async () => {
      const t = await tokens.getValidAccessToken("instagram");
      if (!t.accountId) throw new Error("Instagram account id missing; reconnect the account");
      return { accessToken: t.accessToken, accountId: t.accountId };
    }, f),
    youtube: new YouTubePublisher(async () => (await tokens.getValidAccessToken("youtube")).accessToken, f),
  };
}
