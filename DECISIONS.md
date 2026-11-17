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

- **Sensitive stories (death, serious injury/illness, abuse allegations, legal cases) are skipped at ideation and, if one still reaches QA, HELD immediately for a human — never regenerated** — an upbeat automated brand must not make hype videos about tragedies; rewriting the same story doesn't make it appropriate. Deliberately over-inclusive (flags ~2% of real headlines in testing, including one figurative "assault"): a false positive costs one skipped story, a false negative is a PR incident.

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
- **The weekly learning job pushes a short digest to the alert channel (warning level if anything is held); the full report is on the dashboard's Learning tab** — the owner's weekly check should arrive on their phone, not require remembering to open a dashboard.
- **`DRY_RUN=false` refuses to boot unless LLM, TTS, token key, admin token, https URL, signing secret, Postgres and an alert channel are all present** — an unattended system must not half-run.
- **Dashboard is a single static React app served by the API, one bearer token, per-IP rate limit + lockout** — smallest thing that is safe to expose.
- **No Remotion in the default image** — see below.

## Rendering
- **Two renderers behind one interface; both end in the same FFmpeg assembly (two-pass loudness normalisation, burned-in word-highlighted captions, progress bar, cover)** — QA therefore judges every video identically regardless of how its visuals were drawn.
- **Default `RENDERER=ffmpeg` (typography on animated gradients, no browser); `RENDERER=remotion` is opt-in** — Remotion needs Chromium (~400 MB image, ~1 GB RAM per render, 2–4 min per video on the dev laptop), which a small host may not want. Remotion gives richer animation (springs, glass cards, drifting orbs) and was verified end to end with a real Chromium, passing the real QA technical gate. Switch with `WITH_CHROMIUM=true` at build + `RENDERER=remotion`.
- **Remotion refuses to run without an explicit `CHROMIUM_PATH`** — otherwise it silently downloads a browser at render time.
- **Visuals are generated (gradients, type, shapes); no stock footage, no scraped footage, no music** — nothing to license, and nothing that can trigger a copyright claim. *Single exception: the daily highlights compilation (below), which may use footage under an allow-listed licence.*

## Daily highlights compilation (now a multi-profile generator)
- **The compilation generator is config-driven, not hard-wired to "once a day"** — `config/schedule.json -> compilations` is a map of named profiles (ships with `daily`, 24 h lookback, and `weekly`, 7-day lookback, 6 stories), each with its own cron, lookback window, story count, label and footage settings, all running the identical code path (`runHighlights`, `src/highlights/`). Adding another cadence (e.g. a monthly recap) is a config entry, not new code. One `daily_highlights` content row per profile per local day, deduped on `(profile, date)` so profiles never block each other.
- **No separate "auto-post" switch for compilations — they go through the one pipeline everything else does** — once a compilation passes the same QA gate (factual, policy incl. `checkCompilation`, technical, reviewer), `qa_passed -> scheduled -> published` runs automatically (`publish/agent.ts`), same kill switch, posting caps and peak-time scheduling as any other piece. There is nothing compilation-specific to turn on; the only controls are each profile's `enabled` flag and the platform/global settings everything shares (see "Safety rails" in the README).
- **Built by its own scheduled job per profile, not by per-story ideation** — a compilation needs several stories chosen together (distinct sports, ranked by velocity), and ideation scores one cluster at a time; the template is filtered out of ideation's prompt and validation.
- **"Highlights" means the day's top *stories* (news/results feeds, fact-checked as always) over licensed, illustrative footage — not clips of the matches themselves** — broadcasters and leagues own match footage and nothing licensed lets an automated account cut it into compilations; downloading it from YouTube would breach YouTube's terms and invite copyright strikes. Real match clips can only enter through the owner's own library (`data/footage/library.json`), and holding the rights is then the owner's responsibility.
- **Footage comes only from: the owner's library, Pexels (free key, Pexels licence), Wikimedia Commons (no key, per-file licence)** — in that order, first licensed clip that fits wins; each provider failing is skipped, never fatal, and with no footage at all the compilation renders on the template's generated backgrounds.
- **Accepted licences: CC0, public domain, CC BY, Pexels, owner-stated. Rejected: NC, ND, share-alike, GFDL, fair use, all-rights-reserved, anything unrecognised** — NC because the account may be monetised, ND because a compilation edits the clip, SA because it would pull the whole video under the clip's licence, unknown because not knowing is a no. Re-checked by QA on the final script, so a clip can't get through on a stale record.
- **Footage is searched by the *sport* of a story, never by the people or teams in it** — libraries hold no footage of the actual event, and searching a named athlete would return look-alikes. So every video says so on screen ("Footage is illustrative b-roll, not from the events described") and in every post, next to a per-clip credit line; QA fails a post missing either.
- **A clip is not reused within 7 days; every clip used is logged (provider, licence as stated, author, which video)** — the daily video shouldn't look the same each day, and the licence trail should be auditable.
- **Which beat tells which story is derived from what each beat *cites*, not from what the LLM claims it covers** — a story the writer dropped, or whose beats the fact-check stripped, simply has no segment; QA requires ≥ 2 story segments, so a compilation that lost its stories is regenerated rather than published thin.
- **Wikimedia Commons licence labels are the uploader's claim, and the real data shows why that matters** — a live search returned network broadcasts (e.g. FOX Sports college-football highlights) labelled CC BY 3.0. Commons moderators remove infringements, but not instantly, and we cannot verify the claim. So `footage.licenses` in `config/schedule.json` is an allow-list the operator controls: drop `cc_by` to rely only on CC0 / public domain / Pexels / your own footage (the safest setting; QA enforces the same list).
- **Commons results are filtered before download: the clip's *title* must be about the sport, and the clip must be ≤ 5 minutes, shortest-to-~15 s first, bigger frames first** — Commons search is full-text and noisy (a live "stadium crowd" search returned a Nixon speech, and hour-long recordings are common). Showing irrelevant footage is worse than showing none, so no match means the generated background.
- **A story's footage search uses the headline *and* the article summary, with fallback searches** — headlines often name a club or person but not the sport ("Crystal Palace sack…"); "sprinter track" found nothing on Commons while "athletics" can.
- **Story selection: corroborated (2+ outlets) first, columns/previews/listicles skipped, then an LLM editor chooses among candidates scaled to the profile (`max(12, maxStories*3)`)** — live feeds are full of features that a clusterer treats as stories. The editor can only choose and order from candidates we already vetted (it cannot add a story), costs one small call per run, and any failure or nonsense answer falls back to the deterministic ranking.
- **A rate-limited (HTTP 429) footage provider is abandoned after its first candidate, not hammered through all four** — a live run against the real Wikimedia Commons API showed a tight retry loop (several candidates x several fallback queries) earns 429s fast and then stays throttled. `WIKIMEDIA_CONTACT` (an email/URL, optional) is sent in the User-Agent per Wikimedia's own bot-policy ask, which in practice makes throttling less likely in the first place; Commons sits after Pexels in the default provider order so a configured Pexels key keeps most load off Commons entirely.
- **The montage is rendered per story and concatenated (one ffmpeg at a time), with looped clips bounded by `-t`, never `-shortest`** — memory stays flat on a small host (v1 found `-shortest` over a looped input buffers raw frames and OOMs a 2.5 GB VM).
- **Compilations always use the FFmpeg renderer, even with `RENDERER=remotion`** — the clip montage exists only there; Remotion draws generated visuals.
- **Loudness: target −14 LUFS with a −2.5 dBTP limiter ceiling (+1 dB headroom per QA retry), while QA enforces ≤ −1 dBTP on the encoded file** — found by the first real dry-run: AAC encoding overshot a −1.5 ceiling to −0.34 dBTP and the gate (correctly) rejected the piece three times. The fix is regression-tested with real espeak speech.

## Autonomy agent (added 2026-11-16)
- **A new scheduled job (`src/autonomy/agent.ts`), not a new approval model** — it reuses the existing settings table, alerter, and QA/learning machinery; nothing it does bypasses the kill switch, OAuth, or the alerter.
- **It gets ONE bonus remediation attempt at a QA hold, trying something different where possible, never for a sensitive-topic hold** — a footage/licence hold re-searches footage (`refreshCompilationFootage`); anything else gets one extra regeneration pass. Marked on the content (`idea.autonomyExtraAttemptUsed`) so it can never loop; a second failure holds exactly as before.
- **`config/limits.json` / `MAX_POSTS_PER_DAY` stay the absolute ceiling — a new live override moves the *effective* cap under it, never past it** — raising the ceiling itself still needs a human to edit the file and restart. The override is a settings-table row (`src/safety/capOverrides.ts`), read on every check, so (unlike the static config) it takes effect immediately.
- **A cap only moves by +10%, at most once a week, and only when trailing use stayed under 70% of it with no spend cap hit and no QA hold-rate regression** — conservative by construction; the owner explicitly asked for this to be loosened but a cap that reacts to a single good day isn't safer, it's noisier.
- **Fast-adapt learning (`FAST_ADAPT` in `src/learning/update.ts`: ±45%/update, minimum 3 rows, bounds [0.3, 3.0]) is a mode the agent switches on/off itself based on the same health check, not a permanent change to `computeNewWeights`'s defaults** — the owner asked for bigger, faster swings; gating it on demonstrated stability (rather than turning it on unconditionally) is the difference between "faster learning" and "learning that chases noise since day one." `weight_versions` and `npm run rollback` are untouched either way.
- **Every autonomous change goes through the existing `Alerter` at `info` severity** — the owner's core ask was "don't page me for everything," not "don't tell me anything"; a silent cap change would be worse than the paging it replaces.
- **Account/connection health adds no new OAuth code** — platform consent is a human click by hard constraint (ToS + operating rules); the agent only folds an unresolved `token_refresh_failed` alert into its own run notes so it's visible alongside any cap/strategy change, instead of needing a second place to look.
- **A technical QA retry is never an identical re-run** — it carries the attempt number so the renderer can change its parameters.

## Content expansion: Facebook, milestone_moment, football (added 2026-11-17)
- **Facebook reuses the Instagram script variant instead of asking the writer LLM for a 4th one** — Meta's Graph API treats Page-post and Instagram captions/hashtags near-identically, and the alternative (widening `scriptWriterSchema.variants`, the LLM prompt, and every consumer of it) was a much bigger blast radius for the same output. `buildPlatformMetadata`'s facebook branch is `instagram`'s with Facebook's own `LIMITS` entry.
- **Facebook's single `POST /{page}/videos` call is the one irreversible action, not a separate publish step** — unlike Instagram's create-container-then-media_publish flow, Facebook's upload-by-URL endpoint creates and publishes in one call. `assertLive()` fires immediately before it, and a timeout/5xx after that call is always `ambiguous: true`, never auto-retried.
- **Facebook Page tokens have no refresh flow** — Meta derives them from a long-lived user token with no separate refresh_token of their own. `makeRefresher`'s facebook branch just throws, which routes into `TokenStore`'s existing refresh-failure alert (the same "reconnect the account" path every platform already has) rather than inventing a fake refresh.
- **Facebook starts `enabled: false` in `config/schedule.json`** — same convention a brand-new platform always needs: nothing changes for the owner until they connect it and flip the flag. It's deliberately left out of `dashboard/src/attention.ts`'s "not connected" warning list for the same reason — that list means "expected to be live," and a disabled-by-default platform isn't, yet.
- **`milestone_moment` is a fact-based template (real records, cited sources), not an evergreen one** — it was never added to `EVERGREEN_TEMPLATES`/`EVERGREEN` (`src/ideate/agent.ts`, `src/qa/factcheck.ts`), so it goes through the same sourcing requirements as `news_flash`/`stat_spotlight`, not the "general information" path `training_tip`/`quick_explainer` use.
- **`football` was added as a pillar, not a new sport-detection system** — `src/footage/query.ts`'s `SPORTS` list already had football footage mappings from day one (the footage layer has always been broader than the pillars ideation actually used); this just lets ideation reach a sport the rendering/footage side already understood.
