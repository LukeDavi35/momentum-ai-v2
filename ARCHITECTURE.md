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

## 1. Target architecture

```
                      ┌───────────────────────── BullMQ (Redis) ─────────────────────────┐
 scheduler ──repeat──▶│ ingest → ideate → script → voice → render → qa → publish → analytics │
 (config/schedule)    └───────────────────────────────────────────────────────────────────┘
                                │ every job: idempotent handler, retries×5 (exp backoff),
                                │ DLQ on final failure, pino logs w/ correlationId
                                ▼
   Postgres: content (state machine) · publications · source_items · embeddings
             analytics_snapshots · weights (+history) · spend_ledger · settings · oauth_tokens · events

   safety: kill switch · spend caps · posts/day hard limit · alerts
   api (Express, read-only + token-guarded kill switch) ──▶ React dashboard
```

### 1.1 Content state machine

```
idea → scripted → voiced → rendered → qa_passed ─▶ scheduled → published → measured
                                   └─▶ qa_failed ─▶ (regen ≤2, back to script with feedback)
                                                 └─▶ held   (never auto-publishes)
```
Every transition is a compare-and-set in Postgres (`UPDATE … WHERE status = $from`), which is what
makes handlers idempotent: a re-delivered job finds the status already advanced and no-ops.

### 1.2 Layout

```
src/config      env (zod) + JSON config loaders
src/db          Db interface (pg in prod, PGlite in tests/dry-run), schema.sql, repositories
src/queue       queue definitions, worker wrapper (retry/DLQ/correlation/pause), enqueue helpers
src/safety      kill switch, spend ledger+caps, posting caps, alerts
src/llm         provider interface (Anthropic, stub), JSON-extraction helper
src/ingest      source adapters (rss, trends, reddit, results, internal)
src/ideate      scoring, dedupe (embeddings), content-pillar rotation
src/script      script writer (per template + platform variants)
src/voice       ElevenLabs, OpenAI TTS, dev providers; alignment
src/render      Remotion compositions, FFmpeg assembly/captions/loudness, thumbnails
src/qa          factual check, LLM reviewer, technical probe, policy rules, gate
src/publish     TikTok / Instagram / YouTube publishers, media host, OAuth token store + refresh
src/analytics   metric pulls (1h/24h/7d), snapshots
src/learning    weekly weight update, report, rollback
src/api         Express server for the dashboard
dashboard/      React (Vite) read-only dashboard
```

(Updated as milestones land — see git log.)
