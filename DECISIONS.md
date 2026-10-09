# Decisions

One line each: decision — rationale. Newest at the bottom of each section.

## Scope / environment
- **Greenfield Node/TS project, not an extension of `../momentum-ai`** — the described v2 codebase doesn't exist; owner chose greenfield when asked.
- **Directory `momentum-ai-v2/`, own git repo** — keeps it separate from the unrelated Python project.
- **TypeScript (ESM), Node ≥ 20, Express 5, BullMQ, pino, zod, vitest** — matches the brief's stack; Node 24 is installed locally.
- **The five "existing" sports templates are re-defined here:** `news_flash`, `stat_spotlight`, `race_recap`, `training_tip`, `quick_explainer` — the originals aren't available; these cover the four pillars.
- **One video file per piece, platform-specific metadata per platform** — all three platforms accept 1080×1920 H.264/AAC; capping at 60 s satisfies every platform's strictest limit, so one render serves all.

## Data
- **Postgres in production, PGlite (real Postgres in WASM) for tests and local dry-run** — the same SQL runs everywhere, no mocks of the DB, no Docker needed for unit tests.
- **Embeddings: OpenAI `text-embedding-3-small` if a key exists, else a deterministic local character-n-gram hash vector** — Anthropic has no embeddings API; the fallback keeps dedupe working offline.

## Safety / policy
- **Kill switch = env `KILL_SWITCH` OR a DB flag; checked at three points (scheduler, publish job start, immediately before each platform API call)** — a stale queued job can't slip through.
- **`MAX_POSTS_PER_DAY` hard cap is global, enforced in the publish handler against the DB, independent of schedule config** — per the brief's "regardless of schedule config".
- **Reddit/Trends/news are used as topic signals only; claims are re-derived from source facts, never quoted from users** — avoids republishing third-party text and user content.
- **AI disclosure is applied to every post** — sets the platform's native flag where one exists (TikTok `is_aigc`, YouTube `containsSyntheticMedia`) and adds a caption line everywhere, so it is on even where no API flag exists (Instagram).
- **Held items never publish; there is no code path from `held` to `scheduled` except a manual release** — safest default for a zero-touch system.

## Honesty / testing limits
- **Publishers, ElevenLabs, Reddit and Anthropic calls are written to documented API shapes and unit-tested against mocked HTTP; none have been run against live accounts** — no credentials exist yet; marked "untested live" in `SETUP_CHECKLIST.md`.
- **Dry-run with no LLM key uses a deterministic stub LLM, and its output is labelled as stub output** — so a demo can't be mistaken for real model quality.

## Orchestration
- **A ninth `maintenance` queue beside the eight pipeline queues** — housekeeping (reconcile, monitor, token refresh, weekly learning) must keep running when a spend cap pauses a pipeline queue.
- **Status is committed first, next job enqueued second; a reconciler repairs the gap** — a true transactional outbox needs Redis and Postgres in one transaction, which they can't share; compare-and-set + reconciliation gives the same outcome with less machinery.
- **Kill switch and spend caps *delay* jobs (`moveToDelayed`) instead of failing them** — a pause is not a failure: no retry budget is burned and nothing is dead-lettered.
- **Publish concurrency is 1 and render concurrency is 1** — serialising publishes makes the posting caps race-free; rendering is the RAM/CPU hog on small hosts.
- **Dry-run "fast mode" compresses publish slots and analytics checkpoints to a few seconds (`DRY_RUN_FAST`)** — lets a demo and the e2e test finish in minutes; it is ignored unless `DRY_RUN=true`.
- **The jobId for a re-published step includes a regeneration/reschedule counter** — otherwise BullMQ's duplicate-id rule would swallow legitimate retries.

## Content & QA
- **"Rewrite or remove unverifiable claims" = remove the beats in the script stage, regenerate (with reviewer feedback) in the QA stage** — an LLM rewrite can silently introduce new unverified facts; regenerating re-runs the whole gate on fresh text.
- **QA re-verifies the final script from scratch; the script-stage fact-check is only a cost-saving pre-filter** — the gate must not trust an earlier stage.
- **Only `news` and `results` items are citable; Reddit/Trends/internal are topic signals** — we won't present a Reddit post or a search trend as a fact.
- **Evergreen templates (`training_tip`, `quick_explainer`) may use unsourced `general` claims, but only with no figures or names and no medical advice** — lets fitness content exist without inventing citations.
- **The LLM reviewer is skipped when a deterministic check already failed** — it would only restate the failure, and costs money.
- **Technical-only QA failures re-voice + re-render but keep the script** — no reason to rewrite good copy because ffmpeg misbehaved.
- **Regeneration budget (2) is shared by "couldn't be grounded" and "failed QA"** — one ceiling on spend per idea.
- **Hook = first beat ≤ 14 words and speech starting ≤ 0.8 s** — measurable proxy for "hook in the first 2 seconds".
- **Held content is never auto-released** — the only way out is `npm run release` (a human decision).

- **No "official results feed" is configured by default** — World Athletics and most federations publish no free public API/RSS for results. Results arrive via the news feeds (BBC/Guardian/ESPN), and any federation or results feed you do have can be added to `config/sources.json` with `"kind": "results"` (it is then citable like news). Listed as an open item in SETUP_CHECKLIST.
- **Our own top-performing posts are ingested as `internal` items and shown to the ideation LLM as "what worked", but are never clustered as stories or cited** — they steer format/angle, not facts.

## Publishing
- **Ambiguous publish outcomes (timeout after the irreversible call) are parked as failed + critical alert, never retried** — a retry could double-post; a human checks the account.
- **Late posts (> 6 h after their slot, e.g. after a pause) are rescheduled, not posted stale** — stale "breaking news" is worse than a gap.
- **OAuth consent is done through the app's own HTTPS callback, with an HMAC-signed, 15-min `state`; the admin token never appears in a URL** — platforms require https redirects and the token must not leak into history/logs.
- **TikTok posts use FILE_UPLOAD (no domain verification) and fall back to `SELF_ONLY` when creator_info doesn't offer public** — matches unaudited-app behaviour instead of failing.
- **Instagram uses "API with Instagram Login" and signed public media URLs** — no Facebook Page required; Instagram must fetch the video itself.
- **Every post carries an AI-assisted disclosure line plus the native flag where the API has one (TikTok `is_aigc`, YouTube `containsSyntheticMedia`)** — Instagram has no API flag, so the caption line is the disclosure there.
- **Slot planner: configured peak times × learned hour weights, ±jitter, min 90 min gap, 10 % exploration of off-peak hours** — peak times are priors, the weekly loop corrects them, exploration lets it discover new ones.

## Learning
- **Performance score is log-relative to the platform's own median and skips metrics a platform doesn't report** — TikTok exposes no retention/saves/follows; scoring them as 0 would punish it unfairly.
- **Weight updates: η = 0.15, shrink n/(n+5), ≤ ±25 % per update, bounds [0.4, 2.5], re-centred to mean 1 per dimension** — slow, bounded, self-normalising; one viral post can't capture the strategy.
- **In DRY_RUN the weekly job reports but never saves; dry-run rows are excluded when live** — synthetic metrics must never steer a real account.
- **Weights are append-only; rollback appends a copy of an old version** — the full history of what was live stays auditable.

## Ops
- **`DRY_RUN=false` refuses to boot unless LLM, TTS, token key, admin token, https URL, signing secret, Postgres and an alert channel are all present** — an unattended system must not half-run.
- **Dashboard is a single static React app served by the API, one bearer token, per-IP rate limit + lockout** — smallest thing that is safe to expose.
- **No Remotion in the default image** — see below.

## Rendering
- **Two renderers behind one interface; both end in the same FFmpeg assembly (two-pass loudness normalisation, burned-in word-highlighted captions, progress bar, cover)** — QA therefore judges every video identically regardless of how its visuals were drawn.
- **Default `RENDERER=ffmpeg` (typography on animated gradients, no browser); `RENDERER=remotion` is opt-in** — Remotion needs Chromium (~400 MB image, ~1 GB RAM per render, 2–4 min per video on the dev laptop), which a small host may not want. Remotion gives richer animation (springs, glass cards, drifting orbs) and was verified end to end with a real Chromium, passing the real QA technical gate. Switch with `WITH_CHROMIUM=true` at build + `RENDERER=remotion`.
- **Remotion refuses to run without an explicit `CHROMIUM_PATH`** — otherwise it silently downloads a browser at render time.
- **Visuals are generated (gradients, type, shapes); no stock footage, no scraped footage, no music** — nothing to license, and nothing that can trigger a copyright claim.
- **Loudness: target −14 LUFS with a −2.5 dBTP limiter ceiling (+1 dB headroom per QA retry), while QA enforces ≤ −1 dBTP on the encoded file** — found by the first real dry-run: AAC encoding overshot a −1.5 ceiling to −0.34 dBTP and the gate (correctly) rejected the piece three times. The fix is regression-tested with real espeak speech.
- **A technical QA retry is never an identical re-run** — it carries the attempt number so the renderer can change its parameters.
