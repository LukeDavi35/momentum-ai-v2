# Momentum AI v2

[![CI](https://github.com/LukeDavi35/momentum-ai-v2/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LukeDavi35/momentum-ai-v2/actions/workflows/ci.yml)

An autonomous sports & fitness short-video system: it **researches → writes → voices → renders → quality-checks → publishes → learns**,
with a read-only dashboard and a kill switch. Day to day it needs nobody.

| Doc | What it's for |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | what exists, how it fits together, how it's verified |
| [DECISIONS.md](DECISIONS.md) | every judgement call, one line each, with the reason |
| [SETUP_CHECKLIST.md](SETUP_CHECKLIST.md) | the one-time steps only the owner can do (keys, OAuth apps, audits) |
| [RUNBOOK.md](RUNBOOK.md) | deploy, pause, rotate keys, recover from failures |

## Try it in 3 commands (dry run — nothing is ever posted)
```bash
docker compose up -d postgres redis
docker compose --profile tools run --rm tools npm run dryrun     # runs the whole loop, prints 3 generated pieces
docker compose --profile tools run --rm tools npm test           # full suite on real Postgres + Redis + ffmpeg
```
With no `ANTHROPIC_API_KEY` the dry run uses a **labelled deterministic stub** instead of an LLM (its scripts are extractive, not model-written).
Put a real key in `.env` to see real model output — still without posting anything.

## Run it
```bash
cp .env.example .env     # fill it in (SETUP_CHECKLIST.md)
docker compose up -d --build
# dashboard: http://localhost:8080  (log in with ADMIN_TOKEN)
```
`DRY_RUN=true` is the default. `DRY_RUN=false` only starts if every safety prerequisite is configured.

## Compilation generator (daily + weekly highlights)
`config/schedule.json → compilations` is a map of named, independently scheduled profiles — out of the box, `daily` (16:30 local, 24 h lookback, 4 stories) and `weekly` (Sunday mornings, 7-day lookback, 6 stories) — each of which picks that window's top stories from the news already ingested: corroborated by several outlets where possible, a different sport each, columns and previews skipped, never a death, injury or legal case, with a small LLM editor choosing among the strongest candidates. Every profile makes **one video**: a hook, a ~20-word beat per story, a sign-off, each story over its own clip, with a numbered title, a per-clip credit and word-by-word captions. It then goes through the exact same fact-check → QA → publish path as everything else — **there is no separate approval step and no separate "turn on posting" switch for compilations**; once one passes QA it is scheduled into a peak-time slot and posted automatically, same as a single-story piece, gated only by the kill switch and the caps under "Safety rails" below. `npm run highlights [-- <profile>]` builds one profile's compilation now instead of waiting for its cron time (`docker compose --profile tools run --rm tools npm run highlights -- weekly`); defaults to the first configured profile. Add a new cadence (monthly, per-pillar, …) by adding an entry to `compilations` — no code change needed.

**What "highlights" means here:** the *stories* of the period over *licensed illustrative footage* (stock/archive b-roll of the same sport), clearly labelled as not being from the events described. It does **not** download or cut actual match clips: leagues and broadcasters own them, and automated compilations of them get accounts struck. Footage comes from your own library (`data/footage/library.json`, see SETUP_CHECKLIST §5c), Pexels (free key) and Wikimedia Commons (no key — optionally give it a real contact via `WIKIMEDIA_CONTACT`, which makes it less likely to rate-limit you), and only under CC0 / public domain / CC BY / Pexels / your own licence. With no footage available it still renders, on generated backgrounds.

## Autonomy agent
`src/autonomy/agent.ts` (hourly) is what lets the system run itself rather than paging you for things it can reasonably handle on its own: it gives a QA-held item one bonus attempt with something genuinely different before it actually holds (fresh footage for a compilation held over its licence; one extra regeneration otherwise — never for a sensitive-topic hold, that's still an immediate human decision), and it can raise a posting or spend cap itself — by up to 10%, at most once a week, never past `config/limits.json`'s ceiling — once trailing use has stayed comfortably under the current cap with no spend-cap hit and no rise in the QA hold-rate. The same health check gates a wider "fast-adapt" mode for the weekly learning job (bigger, faster strategy swings than the ±25%/update default), switching it back off the moment that check fails. Every change it makes is reported to the alert channel, never silent; see RUNBOOK.md §5 for what it does and doesn't cover (it never touches the kill switch or OAuth — those stay a human action by design).

## Safety rails (always on)
Kill switch (env or dashboard) · per-provider daily/monthly **spend caps** that pause only the affected queues · a hard **posts/day** limit ·
alerts on kill-switch, caps, 3+ consecutive QA failures, publish failures, token expiry, backlog · secrets only in `.env` · OAuth tokens AES-GCM encrypted at rest ·
held (QA-failed) content can never publish automatically.

## Develop
```bash
npm install && npm run typecheck && npm test      # uses embedded Postgres (PGlite); queue tests need Redis (REDIS_TEST_URL)
npm --prefix dashboard install && npm run build:all
```
