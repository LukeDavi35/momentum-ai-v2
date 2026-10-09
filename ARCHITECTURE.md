# Momentum AI v2 — Architecture

## 0. Phase 0 audit result (read this first)

The brief describes an existing "Momentum AI v2" (Node.js/Express backend, React frontend,
prompt-to-video pipeline, five sports templates, 30-second human approval). **That codebase
does not exist on this machine.** Searched: all of `~/Claude Projects`, a recursive search of
`$HOME` for `remotion` / `track and field` / `bullmq` / Express `package.json`s, and
`~/Desktop/Momentum-Ai` (an empty directory). The only "momentum-ai" present is the earlier
Python/FastAPI/Celery clip-pipeline project (`../momentum-ai`), which is a different product
(long-form video → clips, rights gate) and has no sports templates, Node code or 30-second approval.

Decision (asked, answered by the owner): **build the brief greenfield as a new Node/TypeScript
project** in this directory. Consequently the "audit" below is of the *brief's described current
state*, not of code, and everything described as "current" is **unverified and treated as absent**.
Anything that needs to exist is built here, so there is nothing to migrate.

### 0.1 Human touchpoints in the described current system → automated replacement

| # | Described human step | Replaced by | Phase |
|---|----------------------|-------------|-------|
| 1 | Human types the prompt / chooses the topic | Scheduled ingest (RSS, trends, Reddit, results, own analytics) → LLM ideation scoring → top-N per cycle | 2 |
| 2 | Human picks one of five templates | Template-fit score in ideation; template chosen by the script stage, mix tuned weekly by the learning loop | 2, 6 |
| 3 | Human reviews script/caption wording | LLM reviewer (separate prompt from writer) + deterministic policy rules | 4 |
| 4 | Human fact-checks claims | Claim extraction → verified against ingested sources; unverifiable claims removed/rewritten | 4 |
| 5 | **30-second human approval click** | Automated QA gate (factual, reviewer scores, technical, policy). Fail → regenerate ≤2× → `held` queue (never auto-publishes) | 4 |
| 6 | Human uploads / downloads the video and posts it | Official-API publishers (TikTok, Instagram, YouTube) with automatic OAuth refresh | 5 |
| 7 | Human chooses post time | Scheduler: peak-time slots + jitter, learned weekly | 1, 6 |
| 8 | Human looks at analytics and adjusts | 1h/24h/7d analytics pulls → weekly weight update → `WEEKLY_REPORT.md`, with rollback | 6 |
| 9 | Human watches for breakage | Alerting (Discord/Telegram/email/webhook) + read-only dashboard + health checks | 7, 8 |
| 10 | Human can stop things | Kill switch (env + dashboard toggle) — the one deliberately *kept* human control | 7 |

Touchpoints that **cannot** be automated (one-time, owner only) are in `SETUP_CHECKLIST.md`:
API keys, OAuth app approvals/audits, connecting the three social accounts.

### 0.2 External services (target)

| Service | Used for | Official API only? |
|---------|----------|--------------------|
| Anthropic API | ideation scoring, scripts, reviewer, claim verification | yes |
| ElevenLabs (+ OpenAI TTS fallback) | voiceover (+ character timestamps for captions) | yes |
| OpenAI embeddings (optional) | semantic dedupe; local n-gram embedding fallback | yes |
| RSS feeds (BBC Sport, ESPN, Guardian, …) | sports/athletics news + results | public feeds |
| Google Trends trending-searches RSS | trend velocity | public feed |
| Reddit Data API (OAuth) | r/running, r/trackandfield, r/fitness trend signals | yes |
| TikTok Content Posting API | publish + video stats | yes |
| Instagram Graph API | publish Reels + insights | yes |
| YouTube Data API v3 (+ Analytics) | publish Shorts + stats | yes |
| Redis | BullMQ queues | — |
| Postgres | all state | — |
| Discord / Telegram / SMTP | alerts | yes |

### 0.3 Gaps the build has to close (from the brief)

No scheduler, no idempotency/DLQ discipline, no persistent content state machine, no QA beyond a
click, no spend controls, no kill switch, no learning loop, no monitoring, no tests, no deployment
story. All built in Phases 1–9.

---

## 1. Architecture (as built)

```
 BullMQ job schedulers (config/schedule.json)             one correlation ID per piece, on every log line, job and DB event
        │
        ▼
 ingest ─▶ ideate ─▶ script ─▶ voice ─▶ render ─▶ qa ─▶ publish ─▶ analytics        ← 8 pipeline queues
   │         │          │         │         │       │       │           │
 RSS,      cluster +   LLM +    TTS +    ffmpeg   fact-  schedule +  1h/24h/7d
 Trends,   velocity +  fact-    word     + ASS    check + dry-run /    snapshots
 Reddit,   novelty +   check    timing   captions policy  real API    │
 own top   rotation    pre-             + loudnorm + tech.             ▼
 posts                 filter                     + LLM   kill switch  weekly learning ─▶ weights vN ─▶ ideation, slots
                                                  review  + caps       (+ WEEKLY_REPORT.md, rollback)
 maintenance queue: reconcile · monitor (backlog, spend-resume) · token refresh · weekly learning · housekeeping

 Postgres  = source of truth (content state machine, events, QA results, publications, snapshots, weights, spend, tokens, alerts)
 Redis     = queues only (AOF, noeviction)
 api       = Express: token-guarded read-only dashboard API, kill switch, signed media, OAuth callbacks, static React dashboard
```

### 1.1 Content state machine
```
idea → scripted → voiced → rendered → qa_passed → scheduled → published → measured
                                  └─▶ qa_failed ─▶ idea      (content failure: regenerate with reviewer feedback, ≤ 2×)
                                               ├─▶ scripted  (technical-only failure: keep script, re-voice + re-render)
                                               └─▶ held      (budget spent: NEVER publishes; only `npm run release` can move it)
any in-flight state ─▶ failed  (dead-lettered)
```
Every transition is `UPDATE … WHERE id = $1 AND status = $from` inside a transaction that also writes an audit row to `content_events`. A re-delivered job finds the status already advanced, gets `null` back, and no-ops — this *is* the idempotency guarantee. Illegal moves throw (`ALLOWED_TRANSITIONS`), and there is no path from `held` to `scheduled`/`published`.

### 1.2 Reliability model
| Concern | Mechanism |
|---|---|
| Idempotent jobs | Deterministic job ids (`queue__content__publication__kind__checkpoint__rN`); BullMQ ignores a duplicate `add`. Handlers re-check state first. |
| Retries | 5 attempts, exponential backoff (5 s → 40 s). |
| Dead letters | On final failure: `dead_letters` row + `dead-letter` queue + content → `failed` + critical alert. |
| Crash between "commit" and "enqueue next" | Reconciler (every 10 min) re-enqueues in-flight items that sit > 20 min with no live job. |
| Double posting | Publication row is *claimed* with a conditional UPDATE; publish concurrency is 1; errors after the irreversible call are *ambiguous* and never auto-retried; a worker that dies mid-publish is parked as "outcome unknown". |
| Kill switch | env OR dashboard flag; checked at job start **and** immediately before each platform call (`assertLive`). Blocked jobs are *delayed*, not failed. |
| Spend caps | Ledger per provider; each LLM/TTS/render call is guarded *before* it is made; a breach pauses only the affected queues and auto-resumes. |
| Posting caps | Rolling-24h global hard cap (min of env and `limits.json`) + per-platform caps; over-cap posts move to a later slot. |
| Graceful shutdown | SIGTERM → workers stop taking jobs, drain in-flight ones (≤ `SHUTDOWN_TIMEOUT_MS`), then close queues/Redis/DB. |

### 1.3 The QA gate (replaces the 30-second human click)
1. **Factual** — every claim re-verified on the *final* script: figures and names must appear in the cited source, quotes verbatim, then an LLM entailment judge; narration is audited for figures/names/quotes that bypass the claims list. Fails closed.
2. **Policy** — blunt deterministic rules (medical/dosage/injury advice, guarantees, doping, abuse), AI-disclosure present on every platform's text, per-platform length/hashtag limits.
3. **Technical** (on the real file) — duration, 1080×1920, H.264/AAC, size, integrated loudness and true peak, black frames, speech present, captions on disk match speech and timing, hook ≤ N words and starts promptly.
4. **Independent LLM reviewer** — separate prompt; scores accuracy / brand voice / hook / clarity / policy safety 1–10; all must be ≥ threshold (`config/qa.json`). Skipped (to save spend) when a deterministic check already failed.

### 1.4 Layout
```
src/config      zod-validated env + JSON configs          src/publish     publishers, tokens, OAuth, slot planner, metadata
src/db          Db interface (pg | PGlite), migrations,    src/analytics   snapshot pulls
                content state machine, settings           src/learning    performance score, weight update, report
src/queue       queues, worker wrapper, scheduler,         src/api         Express server
                maintenance, handlers                     src/safety      kill switch, spend, posting caps, alerts
src/llm         Anthropic provider, labelled stub, client  src/media       ffmpeg/ffprobe runner
src/ingest      RSS/Atom, Trends, Reddit, store            dashboard/      React (Vite) control room
src/ideate      clustering, scoring, weights, embeddings   scripts/        dryrun, release, rollback
src/script      writer, templates, types                   test/           217 tests (see §2)
src/voice       ElevenLabs, OpenAI, dev voice, alignment   config/         schedule, pillars, qa, limits, pricing, sources
src/render      captions, visuals, ffmpeg + Remotion renderers, shared assembly
remotion/       React compositions (Momentum.tsx) bundled by @remotion/bundler
src/qa          factcheck, policy, technical, reviewer, gate
```

## 2. How it is verified
- **217 tests**, run inside Docker against **real Postgres 16, real Redis 7 and real ffmpeg** (`docker compose --profile tools run --rm tools npm test`); locally the DB falls back to PGlite and the ffmpeg tests skip.
- Real BullMQ tests cover idempotent enqueue, retry/backoff, dead-lettering, kill-switch delay, spend-cap pause/resume, graceful shutdown, and a full ideate→measured run.
- The ffmpeg test renders **all five templates** and runs the *real* QA technical gate on each output.
- `npm run dryrun` runs the whole loop with real feeds and prints three complete pieces; nothing in DRY_RUN can reach a platform API (`buildPublishers` has no live branch when `DRY_RUN=true`).

## 3. Known limits (also in DECISIONS.md)
- Publishers/OAuth/ElevenLabs/Anthropic/Reddit have **not run against live accounts**.
- Platform audits (TikTok, YouTube) gate public posting; see SETUP_CHECKLIST.md.
- The default renderer is FFmpeg-only typography on animated gradients (no stock footage). `RENDERER=remotion` (needs `WITH_CHROMIUM=true`) draws richer animated visuals; both share one FFmpeg assembly. Remotion is slow on small machines (2–4 min per video on the dev laptop).
- Caption timing from providers without alignment (OpenAI TTS) is *estimated* from the audio length; ElevenLabs gives true per-character timing.
