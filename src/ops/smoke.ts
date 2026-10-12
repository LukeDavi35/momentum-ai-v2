import type { AppConfig, Platform } from "../config/index.js";
import { liveReadinessProblems } from "../bootstrap.js";
import type { Db } from "../db/db.js";
import type { Alerter } from "../safety/alerts.js";
import type { TokenStore } from "../publish/tokens.js";

export interface SmokeCheck {
  name: string;
  status: "ok" | "fail" | "skipped";
  detail: string;
}

type F = typeof fetch;
const t = (ms = 15_000) => AbortSignal.timeout(ms);

async function guarded(name: string, fn: () => Promise<string>): Promise<SmokeCheck> {
  try {
    return { name, status: "ok", detail: await fn() };
  } catch (e) {
    return { name, status: "fail", detail: (e as Error).message.slice(0, 300) };
  }
}
const skipped = (name: string, why: string): SmokeCheck => ({ name, status: "skipped", detail: why });
async function http(f: F, url: string, init: RequestInit = {}): Promise<any> {
  const r = await f(url, { ...init, signal: t() });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Read-only live check of every integration. It NEVER publishes, uploads or creates anything: only identity,
 * quota and "can this token do X" lookups. Run it after filling in .env and connecting accounts, before DRY_RUN=false.
 */
export async function runSmoke(opts: { cfg: AppConfig; db: Db; alerter?: Alerter; tokens?: TokenStore; redisPing?: () => Promise<boolean>; fetchImpl?: F; sendTestAlert?: boolean }): Promise<SmokeCheck[]> {
  const { cfg, db } = opts;
  const e = cfg.env;
  const f = opts.fetchImpl ?? fetch;
  const out: SmokeCheck[] = [];

  out.push(await guarded("postgres", async () => (await db.query("SELECT 1 AS ok")).rows[0]?.ok === 1 ? `reachable (${db.kind})` : "unexpected result"));
  out.push(opts.redisPing ? await guarded("redis", async () => {
        if (!(await opts.redisPing!())) throw new Error("no answer - is Redis running and is REDIS_URL right?");
        return "PONG";
      }) : skipped("redis", "no connection supplied"));

  const problems = liveReadinessProblems({ ...cfg, env: { ...e, DRY_RUN: false } });
  out.push(problems.length ? { name: "live-readiness", status: "fail", detail: `missing: ${problems.join("; ")}` } : { name: "live-readiness", status: "ok", detail: "every prerequisite for DRY_RUN=false is configured" });

  out.push(
    e.ANTHROPIC_API_KEY
      ? await guarded("anthropic", async () => {
          const j = await http(f, "https://api.anthropic.com/v1/models?limit=5", { headers: { "x-api-key": e.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" } });
          const ids: string[] = (j.data ?? []).map((m: any) => m.id);
          const missing = [e.LLM_MODEL_WRITER, e.LLM_MODEL_REVIEWER, e.LLM_MODEL_FAST].filter((m) => !ids.includes(m));
          return `key valid; ${ids.length} models listed${missing.length ? ` (configured models not in the first page: ${missing.join(", ")} - check the names)` : ""}`;
        })
      : skipped("anthropic", "ANTHROPIC_API_KEY not set"),
  );
  out.push(
    e.ELEVENLABS_API_KEY && e.ELEVENLABS_VOICE_ID
      ? await guarded("elevenlabs", async () => {
          const v = await http(f, `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(e.ELEVENLABS_VOICE_ID!)}`, { headers: { "xi-api-key": e.ELEVENLABS_API_KEY! } });
          return `key valid; voice "${v.name ?? e.ELEVENLABS_VOICE_ID}" found`;
        })
      : skipped("elevenlabs", "ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set"),
  );
  out.push(e.OPENAI_API_KEY ? await guarded("openai", async () => (await http(f, "https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${e.OPENAI_API_KEY}` } }), "key valid")) : skipped("openai", "OPENAI_API_KEY not set (fallback TTS/embeddings disabled)"));
  out.push(
    e.REDDIT_CLIENT_ID && e.REDDIT_CLIENT_SECRET
      ? await guarded("reddit", async () => {
          const r = await http(f, "https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${e.REDDIT_CLIENT_ID}:${e.REDDIT_CLIENT_SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", "user-agent": cfg.sources.reddit.userAgent }, body: "grant_type=client_credentials" });
          if (!r.access_token) throw new Error("no access_token returned");
          if (/REPLACE_ME/.test(cfg.sources.reddit.userAgent)) throw new Error("token works, but config/sources.json reddit.userAgent still says REPLACE_ME (Reddit requires a real contact)");
          return "app token issued";
        })
      : skipped("reddit", "optional: not configured"),
  );

  // connected accounts: each uses a READ-ONLY endpoint
  const platformChecks: Record<Platform, (token: { accessToken: string; accountId?: string | null }) => Promise<string>> = {
    tiktok: async (tk) => {
      const j = await http(f, "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", { method: "POST", headers: { authorization: `Bearer ${tk.accessToken}`, "content-type": "application/json; charset=UTF-8" }, body: "{}" });
      const opts = j.data?.privacy_level_options ?? [];
      return `creator_info ok; privacy options: ${opts.join(", ") || "none"}${opts.includes("PUBLIC_TO_EVERYONE") ? "" : "  ⚠ posts will be private (app not audited)"}`;
    },
    instagram: async (tk) => {
      if (!tk.accountId) throw new Error("no Instagram account id stored; reconnect");
      const j = await http(f, `https://graph.instagram.com/v23.0/${tk.accountId}/content_publishing_limit?${new URLSearchParams({ fields: "quota_usage,config", access_token: tk.accessToken })}`);
      const row = j.data?.[0];
      return `publishing limit readable (${row?.quota_usage ?? "?"}/${row?.config?.quota_total ?? "?"} used)`;
    },
    youtube: async (tk) => {
      const j = await http(f, "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: `Bearer ${tk.accessToken}` } });
      const ch = j.items?.[0];
      if (!ch) throw new Error("token valid but no YouTube channel on this account");
      return `channel "${ch.snippet?.title}" reachable`;
    },
  };
  for (const p of ["tiktok", "instagram", "youtube"] as const) {
    if (!cfg.schedule.platforms[p].enabled) {
      out.push(skipped(p, "disabled in config/schedule.json"));
      continue;
    }
    if (!opts.tokens) {
      out.push(skipped(p, "no token store (TOKEN_ENC_KEY missing)"));
      continue;
    }
    out.push(
      await guarded(p, async () => {
        const tk = await opts.tokens!.getValidAccessToken(p); // also exercises the refresh path if the token is near expiry
        return platformChecks[p]({ accessToken: tk.accessToken, accountId: tk.accountId });
      }),
    );
  }

  if (opts.sendTestAlert && opts.alerter) {
    const channels = opts.alerter.configuredChannels();
    out.push(
      channels.length === 0
        ? { name: "alerts", status: "fail", detail: "no alert channel configured" }
        : await guarded("alerts", async () => {
            const r = await opts.alerter!.send({ key: "smoke_test", severity: "info", title: "Momentum smoke test", body: "If you can read this, alerts reach you.", throttleMs: 0 });
            if (r.channels.length === 0) throw new Error(`configured (${channels.join(", ")}) but delivery failed - check the URL/token`);
            return `delivered via ${r.channels.join(", ")}`;
          }),
    );
  }
  return out;
}

export const smokeFailed = (checks: SmokeCheck[]): boolean => checks.some((c) => c.status === "fail");
