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
