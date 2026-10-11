import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { PLATFORMS, type Platform } from "../config/index.js";
import { CONTENT_STATUSES, countByStatus, getContent, listEvents, type ContentStatus } from "../db/content.js";
import { getSetting } from "../db/settings.js";
import { listWeightVersions } from "../ideate/weights.js";
import { verifyMediaSignature, type MediaKind } from "../publish/mediaHost.js";
import { authUrl, exchangeCode, makeState, verifyState } from "../publish/oauth.js";
import type { TokenStore } from "../publish/tokens.js";
import { QUEUE_NAMES, MAINTENANCE_QUEUE, type QueueName } from "../queue/names.js";
import type { QueueSet } from "../queue/queues.js";
import type { Deps } from "../queue/types.js";
import { PAUSED_KEY } from "../queue/worker.js";
import { getKillSwitch, setKillSwitch } from "../safety/killswitch.js";

export interface ApiContext {
  deps: Deps;
  qs?: QueueSet;
  tokens?: TokenStore;
  /** Liveness probe of Redis; omitted in tests. */
  pingRedis?: () => Promise<boolean>;
  dashboardDir?: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Fixed-window per-IP limiter. Tiny and dependency-free: protects the admin token from brute force. */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) {
      res.status(429).json({ error: "too many requests" });
      return;
    }
    next();
  };
}

const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);
const intParam = (v: unknown, def: number, min: number, max: number): number => Math.max(min, Math.min(max, Number.isFinite(Number(v)) ? Number(v) : def));

export function createApp(ctx: ApiContext): express.Express {
  const { deps } = ctx;
  const { db, cfg } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "20kb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    next();
  });

  // ---- health (no auth: used by Docker/load balancer; reveals nothing sensitive) ----
  app.get(
    "/healthz",
    asyncRoute(async (_req, res) => {
      let dbOk = false;
      let redisOk: boolean | null = null;
      try {
        await db.query("SELECT 1");
        dbOk = true;
      } catch {
        /* reported below */
      }
      if (ctx.pingRedis) redisOk = await ctx.pingRedis().catch(() => false);
      const ok = dbOk && redisOk !== false;
      res.status(ok ? 200 : 503).json({ ok, db: dbOk, redis: redisOk });
    }),
  );

  // ---- signed media (Instagram fetches the video from here). Path comes from the DB, never from the request. ----
  app.get(
    "/media/:contentId/:regen/:file",
    rateLimiter(300, 60_000),
    asyncRoute(async (req, res) => {
      const { contentId, regen } = req.params as Record<string, string>;
      const file = String(req.params.file);
      const kind: MediaKind | null = file === "video.mp4" ? "video" : file === "cover.jpg" ? "cover" : null;
      const exp = Number(req.query.exp);
      const sig = String(req.query.sig ?? "");
      if (!kind || !/^[0-9a-f-]{36}$/i.test(contentId) || !/^\d+$/.test(regen) || !verifyMediaSignature(cfg, contentId, Number(regen), kind, exp, sig)) {
        res.status(403).json({ error: "invalid or expired link" });
        return;
      }
      const c = await getContent(db, contentId);
      const path = kind === "video" ? c?.render?.videoPath : c?.render?.coverPath;
      if (!path || !existsSync(path)) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.type(kind === "video" ? "video/mp4" : "image/jpeg");
      res.sendFile(resolve(path)); // supports Range requests
    }),
  );

  // ---- OAuth callback: authenticated by the signed, expiring `state`, not by the admin token ----
  app.get(
    "/oauth/:platform/callback",
    rateLimiter(30, 60_000),
    asyncRoute(async (req, res) => {
      const platform = req.params.platform as Platform;
      if (!PLATFORMS.includes(platform) || !ctx.tokens) {
        res.status(404).send("not found");
        return;
      }
      const state = String(req.query.state ?? "");
      const code = String(req.query.code ?? "");
      if (!verifyState(cfg, state, platform) || !code) {
        res.status(400).send("Invalid or expired OAuth state. Start again from the dashboard.");
        return;
      }
      try {
        const tokens = await exchangeCode(cfg, platform, code, deps.fetchImpl ?? fetch, deps.now());
        await ctx.tokens.save(platform, tokens);
        await deps.alerter.send({ key: `oauth_connected:${platform}`, severity: "info", title: `${platform} account connected`, throttleMs: 0 });
        res.status(200).send(`<h3>${platform} connected.</h3><p>You can close this tab and return to the dashboard.</p>`);
      } catch (e) {
        deps.log.error({ platform, err: (e as Error).message }, "oauth exchange failed");
        res.status(502).send(`Could not complete the ${platform} connection: ${(e as Error).message.replace(/[<>&]/g, "")}`);
      }
    }),
  );

  // ---- everything under /api needs the admin token ----
  const authFails = rateLimiter(20, 60_000);
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const expected = cfg.env.ADMIN_TOKEN;
    if (!expected) {
      if (cfg.env.DRY_RUN) return next(); // local dry-run convenience only; bootstrap forbids this in live mode
      res.status(503).json({ error: "ADMIN_TOKEN is not configured" });
      return;
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (m && safeEqual(m[1]!, expected)) return next();
    authFails(req, res, () => res.status(401).json({ error: "unauthorized" }));
  };
  const api = express.Router();
  api.use(requireAuth);

  api.get(
    "/overview",
    asyncRoute(async (_req, res) => {
      const queues: Record<string, unknown> = {};
      if (ctx.qs) {
        for (const name of [...QUEUE_NAMES, MAINTENANCE_QUEUE] as const) {
          const q = name === MAINTENANCE_QUEUE ? ctx.qs.maintenance : ctx.qs.queues[name as QueueName];
          queues[name] = { ...(await q.getJobCounts("waiting", "active", "delayed", "failed", "completed")), paused: await q.isPaused() };
        }
      }
      const posts24h = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM publications WHERE status = 'published' AND published_at > now() - interval '24 hours' AND dry_run = $1`, [cfg.env.DRY_RUN]);
      res.json({
        dryRun: cfg.env.DRY_RUN,
        llm: deps.llm.isStub ? "stub (dry-run only)" : "live",
        killSwitch: await getKillSwitch(db, cfg.env),
        pausedQueues: (await getSetting(db, PAUSED_KEY)) ?? {},
        queues,
        contentByStatus: await countByStatus(db),
        posts24h: Number(posts24h.rows[0]?.n ?? 0),
        maxPostsPerDay: Math.min(cfg.env.MAX_POSTS_PER_DAY, cfg.limits.maxPostsPerDay),
        alertChannels: deps.alerter.configuredChannels(),
        connectedAccounts: (await db.query(`SELECT platform, account_name, expires_at, last_refresh_error FROM oauth_tokens`)).rows,
      });
    }),
  );

  api.get(
    "/content",
    asyncRoute(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : undefined;
      if (status && !CONTENT_STATUSES.includes(status as ContentStatus)) {
        res.status(400).json({ error: "unknown status" });
        return;
      }
      const limit = intParam(req.query.limit, 50, 1, 200);
      const r = await db.query(
        `SELECT id, correlation_id, status, pillar, template, topic, hook_style, score, regen_count, error, failed_stage, created_at, status_changed_at,
                (script->>'generator') AS generator, (voice->>'provider') AS voice_provider, (voice->>'devVoice')::boolean AS dev_voice
           FROM content ${status ? "WHERE status = $2" : ""} ORDER BY created_at DESC LIMIT $1`,
        status ? [limit, status] : [limit],
      );
      res.json(r.rows);
    }),
  );

  api.get(
    "/content/:id",
    asyncRoute(async (req, res) => {
      const id = String(req.params.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: "bad id" });
        return;
      }
      const c = await getContent(db, id);
      if (!c) {
        res.status(404).json({ error: "not found" });
        return;
      }
      // Same snake_case shape as the list endpoint (the dashboard's ContentDetail type); heavy/internal fields are left out.
      res.json({
        id: c.id,
        correlation_id: c.correlationId,
        status: c.status,
        pillar: c.pillar,
        template: c.template,
        topic: c.topic,
        hook_style: c.hookStyle,
        score: c.score,
        regen_count: c.regenCount,
        error: c.error,
        failed_stage: c.failedStage,
        created_at: c.createdAt,
        status_changed_at: c.statusChangedAt,
        qa_feedback: c.qaFeedback,
        generator: c.script?.generator ?? null,
        voice_provider: c.voice?.provider ?? null,
        dev_voice: c.voice?.devVoice ?? null,
        script: c.script ? { generator: c.script.generator, beats: c.script.beats ?? [], removed: c.script.removed ?? [], claims: c.script.claims ?? [] } : null,
        events: await listEvents(db, id),
        qaResults: (await db.query(`SELECT attempt, passed, scores, reasons, created_at FROM qa_results WHERE content_id = $1 ORDER BY id`, [id])).rows,
        publications: (await db.query(`SELECT id, platform, status, scheduled_at, published_at, url, external_id, error, dry_run FROM publications WHERE content_id = $1`, [id])).rows,
      });
    }),
  );

  api.get(
    "/held",
    asyncRoute(async (_req, res) => {
      const r = await db.query(
        `SELECT id, topic, template, pillar, regen_count, error, qa_feedback, qa, status_changed_at FROM content WHERE status = 'held' ORDER BY status_changed_at DESC LIMIT 100`,
      );
      res.json(r.rows.map((x) => ({ id: x.id, topic: x.topic, template: x.template, pillar: x.pillar, attempts: x.regen_count + 1, reason: x.error, failures: x.qa?.failures ?? [], reviewerFeedback: x.qa?.reviewerFeedback ?? [], scores: x.qa?.scores ?? null, heldAt: x.status_changed_at })));
    }),
  );

  api.get(
    "/publications",
    asyncRoute(async (req, res) => {
      const r = await db.query(
        `SELECT p.id, p.platform, p.status, p.scheduled_at, p.published_at, p.url, p.external_id, p.error, p.dry_run, p.metadata->'warnings' AS warnings, c.topic, c.template, c.id AS content_id
           FROM publications p JOIN content c ON c.id = p.content_id ORDER BY COALESCE(p.published_at, p.scheduled_at) DESC LIMIT $1`,
        [intParam(req.query.limit, 100, 1, 500)],
      );
      res.json(r.rows);
    }),
  );

  api.get(
    "/analytics",
    asyncRoute(async (req, res) => {
      const days = intParam(req.query.days, 30, 1, 180);
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const series = await db.query(
        `SELECT date_trunc('day', p.published_at)::date::text AS day, p.platform, COUNT(*)::int AS posts,
                COALESCE(SUM(s.views),0)::float8 AS views, COALESCE(SUM(s.likes),0)::float8 AS likes, COALESCE(SUM(s.shares),0)::float8 AS shares
           FROM publications p LEFT JOIN LATERAL (SELECT * FROM analytics_snapshots a WHERE a.publication_id = p.id ORDER BY CASE a.checkpoint WHEN '7d' THEN 3 WHEN '24h' THEN 2 ELSE 1 END DESC LIMIT 1) s ON true
          WHERE p.status = 'published' AND p.published_at >= $1 AND p.dry_run = $2 GROUP BY 1, 2 ORDER BY 1`,
        [since, cfg.env.DRY_RUN],
      );
      const top = await db.query(
        `SELECT c.topic, c.template, p.platform, p.url, s.views, s.likes, s.shares, s.retention_pct FROM analytics_snapshots s
           JOIN publications p ON p.id = s.publication_id JOIN content c ON c.id = p.content_id
          WHERE p.published_at >= $1 AND p.dry_run = $2 AND s.checkpoint = (SELECT checkpoint FROM analytics_snapshots a WHERE a.publication_id = p.id ORDER BY CASE a.checkpoint WHEN '7d' THEN 3 WHEN '24h' THEN 2 ELSE 1 END DESC LIMIT 1)
          ORDER BY s.views DESC NULLS LAST LIMIT 10`,
        [since, cfg.env.DRY_RUN],
      );
      res.json({ dryRun: cfg.env.DRY_RUN, synthetic: cfg.env.DRY_RUN, series: series.rows, top: top.rows });
    }),
  );

  api.get(
    "/spend",
    asyncRoute(async (_req, res) => {
      const daily = await db.query(`SELECT date_trunc('day', at)::date::text AS day, provider, SUM(usd)::float8 AS usd FROM spend_ledger WHERE at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1`);
      res.json({ summary: await deps.spend.summary(), daily: daily.rows, currency: cfg.limits.currency });
    }),
  );

  api.get(
    "/weights",
    asyncRoute(async (_req, res) => {
      res.json((await listWeightVersions(db, 20)).map((v) => ({ version: v.version, kind: v.kind, reason: v.reason, createdAt: v.createdAt, weights: v.weights })));
    }),
  );

  api.get(
    "/report",
    asyncRoute(async (_req, res) => {
      const path = join(cfg.env.REPORT_DIR, "WEEKLY_REPORT.md");
      if (!existsSync(path)) {
        res.json({ markdown: null, updatedAt: null });
        return;
      }
      res.json({ markdown: readFileSync(path, "utf8"), updatedAt: statSync(path).mtime });
    }),
  );

  api.get(
    "/alerts",
    asyncRoute(async (req, res) => {
      res.json((await db.query(`SELECT key, severity, title, body, channels, suppressed, at FROM alerts_log WHERE suppressed = false ORDER BY id DESC LIMIT $1`, [intParam(req.query.limit, 50, 1, 200)])).rows);
    }),
  );

  api.get(
    "/dlq",
    asyncRoute(async (_req, res) => {
      res.json((await db.query(`SELECT queue, job_id, content_id, error, attempts, at FROM dead_letters ORDER BY id DESC LIMIT 50`)).rows);
    }),
  );

  /** The ONE mutation the dashboard offers. */
  api.post(
    "/killswitch",
    asyncRoute(async (req, res) => {
      const active = req.body?.active;
      if (typeof active !== "boolean") {
        res.status(400).json({ error: "body must be {active: boolean, reason?: string}" });
        return;
      }
      const reason = typeof req.body.reason === "string" ? req.body.reason.slice(0, 200) : undefined;
      await setKillSwitch(db, deps.alerter, active, "dashboard", reason);
      res.json(await getKillSwitch(db, cfg.env));
    }),
  );

  /** Returns the provider consent URL for the dashboard to open (keeps the admin token out of any URL). */
  api.get("/oauth/:platform/url", (req, res) => {
    const platform = req.params.platform as Platform;
    if (!PLATFORMS.includes(platform)) {
      res.status(404).json({ error: "unknown platform" });
      return;
    }
    try {
      res.json({ url: authUrl(cfg, platform, makeState(cfg, platform)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.use("/api", rateLimiter(240, 60_000), api);

  // ---- dashboard (static build) ----
  const dist = ctx.dashboardDir ?? join(process.cwd(), "dashboard", "dist");
  if (existsSync(join(dist, "index.html"))) {
    // index.html must never be cached (it names the current bundle, so a cached copy pins users to a stale app after a
    // deploy); the hashed files under /assets are content-addressed, so they can be cached forever.
    app.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, path) => res.setHeader("Cache-Control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"),
      }),
    );
    app.get(/^\/(?!api|media|oauth|healthz).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(join(resolve(dist), "index.html"));
    });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    deps.log.error({ err: err.message }, "api error");
    res.status(500).json({ error: "internal error" });
  });
  return app;
}
