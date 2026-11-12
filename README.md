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

## Daily highlights compilation
Once a day (`config/schedule.json → highlights`, default 16:30 local) the system picks the day's top 4 stories from the news it has already ingested — a different sport each where it can, never a death, injury or legal case — and makes **one video**: a hook, a ~20-word beat per story, a sign-off, each story over its own clip, with a numbered title, a per-clip credit and word-by-word captions. It then goes through the same fact-check → QA → publish path as everything else. `npm run highlights` builds today's now (`docker compose --profile tools run --rm tools npm run highlights`).

**What "highlights" means here:** the *stories* of the day over *licensed illustrative footage* (stock/archive b-roll of the same sport), clearly labelled as not being from the events described. It does **not** download or cut actual match clips: leagues and broadcasters own them, and automated compilations of them get accounts struck. Footage comes from your own library (`data/footage/library.json`, see SETUP_CHECKLIST §5c), Pexels (free key) and Wikimedia Commons (no key), and only under CC0 / public domain / CC BY / Pexels / your own licence. With no footage available it still renders, on generated backgrounds.

## Safety rails (always on)
Kill switch (env or dashboard) · per-provider daily/monthly **spend caps** that pause only the affected queues · a hard **posts/day** limit ·
alerts on kill-switch, caps, 3+ consecutive QA failures, publish failures, token expiry, backlog · secrets only in `.env` · OAuth tokens AES-GCM encrypted at rest ·
held (QA-failed) content can never publish automatically.

## Develop
```bash
npm install && npm run typecheck && npm test      # uses embedded Postgres (PGlite); queue tests need Redis (REDIS_TEST_URL)
npm --prefix dashboard install && npm run build:all
```
