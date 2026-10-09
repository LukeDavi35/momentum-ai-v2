import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig, Platform } from "../config/index.js";
import type { RefreshResult, TokenSet } from "./tokens.js";

type FetchLike = typeof fetch;

/**
 * OAuth helpers for the three platforms. Written to each platform's documented endpoints;
 * NOT yet exercised against live apps (no credentials exist) — see SETUP_CHECKLIST.md.
 * The owner completes consent once via GET /oauth/:platform/start on the dashboard server.
 */
export const SCOPES: Record<Platform, string> = {
  tiktok: "user.info.basic,video.publish,video.upload,video.list",
  instagram: "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights",
  youtube: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
};

export function redirectUri(cfg: AppConfig, platform: Platform): string {
  if (!cfg.env.PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL must be set to run OAuth (platforms require an https redirect URI)");
  return `${cfg.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/${platform}/callback`;
}

// --- signed `state` so a callback can't be forged or replayed outside its window ---------

export function makeState(cfg: AppConfig, platform: Platform, now = Date.now()): string {
  const secret = cfg.env.TOKEN_ENC_KEY;
  if (!secret) throw new Error("TOKEN_ENC_KEY required");
  const body = `${platform}.${now}.${randomBytes(8).toString("hex")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyState(cfg: AppConfig, state: string, platform: Platform, now = Date.now(), maxAgeMs = 15 * 60_000): boolean {
  const secret = cfg.env.TOKEN_ENC_KEY;
  if (!secret) return false;
  const i = state.lastIndexOf(".");
  if (i < 0) return false;
  const body = state.slice(0, i);
  const sig = Buffer.from(state.slice(i + 1), "hex");
  const expect = createHmac("sha256", secret).update(body).digest();
  if (sig.length !== expect.length || !timingSafeEqual(sig, expect)) return false;
  const [p, ts] = body.split(".");
  return p === platform && now - Number(ts) >= 0 && now - Number(ts) <= maxAgeMs;
}

export function authUrl(cfg: AppConfig, platform: Platform, state: string): string {
  const e = cfg.env;
  const redirect = redirectUri(cfg, platform);
  if (platform === "tiktok") {
    if (!e.TIKTOK_CLIENT_KEY) throw new Error("TIKTOK_CLIENT_KEY not set");
    return `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({ client_key: e.TIKTOK_CLIENT_KEY, scope: SCOPES.tiktok, response_type: "code", redirect_uri: redirect, state })}`;
  }
  if (platform === "instagram") {
    if (!e.INSTAGRAM_APP_ID) throw new Error("INSTAGRAM_APP_ID not set");
    return `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ client_id: e.INSTAGRAM_APP_ID, redirect_uri: redirect, response_type: "code", scope: SCOPES.instagram, state })}`;
  }
  if (!e.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID not set");
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: e.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: SCOPES.youtube, access_type: "offline", prompt: "consent", state })}`;
}

const addSeconds = (s: number | string | undefined, now: Date): Date | null => (s === undefined || s === null || Number.isNaN(Number(s)) ? null : new Date(now.getTime() + Number(s) * 1000));

async function postForm(url: string, form: Record<string, string>, f: FetchLike): Promise<any> {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.error) throw new Error(`${url} -> HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

export async function exchangeCode(cfg: AppConfig, platform: Platform, code: string, f: FetchLike = fetch, now = new Date()): Promise<TokenSet> {
  const e = cfg.env;
  const redirect = redirectUri(cfg, platform);
  if (platform === "tiktok") {
    const j = await postForm("https://open.tiktokapis.com/v2/oauth/token/", { client_key: e.TIKTOK_CLIENT_KEY ?? "", client_secret: e.TIKTOK_CLIENT_SECRET ?? "", code, grant_type: "authorization_code", redirect_uri: redirect }, f);
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: addSeconds(j.expires_in, now), refreshExpiresAt: addSeconds(j.refresh_expires_in, now), scopes: j.scope, accountId: j.open_id };
  }
  if (platform === "instagram") {
    const short = await postForm("https://api.instagram.com/oauth/access_token", { client_id: e.INSTAGRAM_APP_ID ?? "", client_secret: e.INSTAGRAM_APP_SECRET ?? "", grant_type: "authorization_code", redirect_uri: redirect, code }, f);
    // swap the 1-hour token for a 60-day one
    const longRes = await f(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: e.INSTAGRAM_APP_SECRET ?? "", access_token: short.access_token })}`, { signal: AbortSignal.timeout(20_000) });
    const long = (await longRes.json()) as any;
    if (!longRes.ok || long.error) throw new Error(`instagram long-lived exchange failed: ${JSON.stringify(long).slice(0, 300)}`);
    return { accessToken: long.access_token, expiresAt: addSeconds(long.expires_in, now), accountId: String(short.user_id ?? ""), scopes: SCOPES.instagram };
  }
  const j = await postForm("https://oauth2.googleapis.com/token", { client_id: e.GOOGLE_CLIENT_ID ?? "", client_secret: e.GOOGLE_CLIENT_SECRET ?? "", code, grant_type: "authorization_code", redirect_uri: redirect }, f);
  if (!j.refresh_token) throw new Error("Google returned no refresh_token; revoke the app's access in your Google account and consent again (prompt=consent)");
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: addSeconds(j.expires_in, now), scopes: j.scope };
}

export function makeRefresher(cfg: AppConfig, f: FetchLike = fetch, now: () => Date = () => new Date()) {
  return async (platform: Platform, t: TokenSet): Promise<RefreshResult> => {
    const e = cfg.env;
    if (platform === "tiktok") {
      if (!t.refreshToken) throw new Error("no TikTok refresh token stored");
      const j = await postForm("https://open.tiktokapis.com/v2/oauth/token/", { client_key: e.TIKTOK_CLIENT_KEY ?? "", client_secret: e.TIKTOK_CLIENT_SECRET ?? "", grant_type: "refresh_token", refresh_token: t.refreshToken }, f);
      return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: addSeconds(j.expires_in, now()), refreshExpiresAt: addSeconds(j.refresh_expires_in, now()) };
    }
    if (platform === "instagram") {
      // long-lived IG tokens refresh by presenting themselves (must be >=24h old and not expired)
      const res = await f(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: t.accessToken })}`, { signal: AbortSignal.timeout(20_000) });
      const j = (await res.json()) as any;
      if (!res.ok || j.error) throw new Error(`instagram refresh failed: ${JSON.stringify(j).slice(0, 300)}`);
      return { accessToken: j.access_token, expiresAt: addSeconds(j.expires_in, now()) };
    }
    if (!t.refreshToken) throw new Error("no Google refresh token stored");
    const j = await postForm("https://oauth2.googleapis.com/token", { client_id: e.GOOGLE_CLIENT_ID ?? "", client_secret: e.GOOGLE_CLIENT_SECRET ?? "", grant_type: "refresh_token", refresh_token: t.refreshToken }, f);
    return { accessToken: j.access_token, expiresAt: addSeconds(j.expires_in, now()) };
  };
}
