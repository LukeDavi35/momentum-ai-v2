import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Platform } from "../config/index.js";
import type { Db } from "../db/db.js";
import type { Logger } from "../logger.js";
import type { Alerter } from "../safety/alerts.js";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  scopes?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  meta?: Record<string, unknown>;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
}

/** Per-platform refresh implementation (see oauth.ts). */
export type Refresher = (platform: Platform, current: TokenSet) => Promise<RefreshResult>;

const KEY_BYTES = 32;

/** AES-256-GCM. Output is "v1:" + base64(iv|tag|ciphertext). The key comes from TOKEN_ENC_KEY (64 hex chars). */
export function encrypt(plain: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

export function decrypt(blob: string, keyHex: string): string {
  if (!blob.startsWith("v1:")) throw new Error("unknown token encryption format");
  const raw = Buffer.from(blob.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", parseKey(keyHex), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("TOKEN_ENC_KEY must be 64 hex characters (generate with: openssl rand -hex 32)");
  return Buffer.from(keyHex, "hex");
}

export class TokenStore {
  constructor(
    private readonly db: Db,
    private readonly keyHex: string | undefined,
    private readonly log: Logger,
    private readonly alerter: Alerter,
    private readonly refresher: Refresher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(): string {
    if (!this.keyHex) throw new Error("TOKEN_ENC_KEY is not set; refusing to store or read OAuth tokens");
    return this.keyHex;
  }

  async save(platform: Platform, t: TokenSet): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_tokens (platform, access_token_enc, refresh_token_enc, expires_at, refresh_expires_at, scopes, account_id, account_name, meta, last_refresh_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NULL,now())
       ON CONFLICT (platform) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, oauth_tokens.refresh_token_enc),
         expires_at = EXCLUDED.expires_at, refresh_expires_at = COALESCE(EXCLUDED.refresh_expires_at, oauth_tokens.refresh_expires_at),
         scopes = COALESCE(EXCLUDED.scopes, oauth_tokens.scopes), account_id = COALESCE(EXCLUDED.account_id, oauth_tokens.account_id),
         account_name = COALESCE(EXCLUDED.account_name, oauth_tokens.account_name), meta = oauth_tokens.meta || EXCLUDED.meta, last_refresh_error = NULL, updated_at = now()`,
      [
        platform,
        encrypt(t.accessToken, this.key()),
        t.refreshToken ? encrypt(t.refreshToken, this.key()) : null,
        t.expiresAt?.toISOString() ?? null,
        t.refreshExpiresAt?.toISOString() ?? null,
        t.scopes ?? null,
        t.accountId ?? null,
        t.accountName ?? null,
        JSON.stringify(t.meta ?? {}),
      ],
    );
  }

  async get(platform: Platform): Promise<TokenSet | null> {
    const res = await this.db.query(`SELECT * FROM oauth_tokens WHERE platform = $1`, [platform]);
    const r = res.rows[0];
    if (!r) return null;
    return {
      accessToken: decrypt(r.access_token_enc, this.key()),
      refreshToken: r.refresh_token_enc ? decrypt(r.refresh_token_enc, this.key()) : null,
      expiresAt: r.expires_at ? new Date(r.expires_at) : null,
      refreshExpiresAt: r.refresh_expires_at ? new Date(r.refresh_expires_at) : null,
      scopes: r.scopes,
      accountId: r.account_id,
      accountName: r.account_name,
      meta: r.meta ?? {},
    };
  }

  /** Access token that is valid for at least `minValidMs`, refreshing first if it is about to expire. */
  async getValidAccessToken(platform: Platform, minValidMs = 5 * 60_000): Promise<TokenSet> {
    const t = await this.get(platform);
    if (!t) throw new Error(`No ${platform} account connected (run the OAuth flow; see SETUP_CHECKLIST.md)`);
    if (!t.expiresAt || t.expiresAt.getTime() - this.now().getTime() > minValidMs) return t;
    return this.refresh(platform, t);
  }

  async refresh(platform: Platform, current?: TokenSet | null): Promise<TokenSet> {
    const t = current ?? (await this.get(platform));
    if (!t) throw new Error(`No ${platform} account connected`);
    try {
      const r = await this.refresher(platform, t);
      const next: TokenSet = { ...t, accessToken: r.accessToken, refreshToken: r.refreshToken ?? t.refreshToken, expiresAt: r.expiresAt ?? t.expiresAt, refreshExpiresAt: r.refreshExpiresAt ?? t.refreshExpiresAt };
      await this.save(platform, next);
      this.log.info({ platform, expiresAt: next.expiresAt }, "oauth token refreshed");
      return next;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 400);
      await this.db.query(`UPDATE oauth_tokens SET last_refresh_error = $2, updated_at = now() WHERE platform = $1`, [platform, msg]);
      await this.alerter.send({ key: `token_refresh_failed:${platform}`, severity: "critical", title: `${platform} token refresh FAILED — publishing there will stop`, body: `${msg}\nRe-connect the account (see RUNBOOK.md → "Reconnect a social account").` });
      throw e;
    }
  }

  /**
   * Scheduled job: refresh anything expiring within `withinMs` and warn about long-lived refresh
   * tokens that are about to lapse (they need a human to re-consent, so we alert days ahead).
   */
  async refreshExpiring(platforms: readonly Platform[], withinMs = 24 * 3600_000): Promise<Array<{ platform: Platform; action: "ok" | "refreshed" | "failed" | "missing"; error?: string }>> {
    const out: Array<{ platform: Platform; action: "ok" | "refreshed" | "failed" | "missing"; error?: string }> = [];
    for (const p of platforms) {
      const t = await this.get(p);
      if (!t) {
        out.push({ platform: p, action: "missing" });
        continue;
      }
      if (t.refreshExpiresAt && t.refreshExpiresAt.getTime() - this.now().getTime() < 7 * 86400_000) {
        await this.alerter.send({ key: `refresh_token_expiring:${p}`, severity: "warning", title: `${p} refresh token expires within 7 days`, body: "Reconnect the account before it lapses.", throttleMs: 24 * 3600_000 });
      }
      if (t.expiresAt && t.expiresAt.getTime() - this.now().getTime() < withinMs) {
        try {
          await this.refresh(p, t);
          out.push({ platform: p, action: "refreshed" });
        } catch (e) {
          out.push({ platform: p, action: "failed", error: (e as Error).message });
        }
      } else out.push({ platform: p, action: "ok" });
    }
    return out;
  }
}
