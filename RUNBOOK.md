# Runbook

Day-to-day you should not need this. It is for **deploying, pausing, rotating keys and recovering from failures**.
Commands assume the repo root on the server. Ops scripts run in the `tools` container:
`docker compose --profile tools run --rm tools <command>`.

## 1. Deploy / upgrade
```bash
cp .env.example .env && $EDITOR .env      # see SETUP_CHECKLIST.md
docker compose up -d --build              # postgres, redis, api, worker
docker compose ps                         # all "healthy"
docker compose logs -f worker             # structured JSON (pino); filter by correlationId
```
- **Upgrade:** `git pull && docker compose up -d --build`. The worker has `stop_grace_period: 90s`: on stop it takes no new jobs and lets in-flight ones (a render is ~1 minute) finish, so deploys never cut a post in half. Anything still queued stays in Redis (AOF) and resumes.
- **Schema migrations** run automatically at start-up (`schema_migrations` table); they are additive.
- **Live mode is guarded:** with `DRY_RUN=false` the app *refuses to start* and lists what is missing (LLM key, TTS key, token key, admin token, https URL, alert channel…).

### Optional: the Remotion renderer
Richer animation, heavier on CPU/RAM. Build with Chromium and select it:
```bash
WITH_CHROMIUM=true docker compose up -d --build     # installs /usr/bin/chromium in the image
# .env:  RENDERER=remotion   (CHROMIUM_PATH is set by the image)
```
Budget ~1 GB RAM and 2–4 minutes per video on a small host; the first render also builds the webpack bundle (~20 s). Revert with `RENDERER=ffmpeg`.

## 2. Pause everything (the kill switch)
Any one of these stops **all publishing** (ideation/rendering continue so nothing is lost; posts wait in the queue):
1. **Dashboard** → red **Pause all publishing** button (alerts you, takes effect on the next publish check — seconds).
2. **Environment:** set `KILL_SWITCH=true` in `.env`, `docker compose up -d`. This cannot be cleared from the dashboard (deliberately).
3. **Emergency, nothing else works:** `docker compose stop worker` (graceful), or `docker compose kill worker`.

The switch is checked at three points — when a publish job starts, again immediately before every platform API call, and by the scheduler — so a stale queued post cannot slip past it. Posts that miss their slot while paused are moved to the next slot when you resume (they are never posted stale).
**Resume:** dashboard → *Resume publishing* (or unset `KILL_SWITCH`).

### Health check of all integrations
`docker compose --profile tools run --rm tools npm run smoke` is read-only (it never posts). Run it after rotating a key or reconnecting an account; add `-- --alert` to also test the alert channel.

## 3. Rotate keys
| Secret | How |
|---|---|
| `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `REDDIT_*` | edit `.env` → `docker compose up -d` (api + worker restart gracefully). Revoke the old key at the provider. |
| `ADMIN_TOKEN` | edit `.env` → `docker compose up -d api`. Everyone is logged out. |
| `MEDIA_SIGNING_SECRET` | edit `.env` → `up -d`. Outstanding signed video links stop working (they live 6 h; in-flight Instagram uploads retry). |
| `TOKEN_ENC_KEY` | Stored OAuth tokens are encrypted with it, so changing it **invalidates them**: pause publishing, change the key, `up -d`, then re-connect all three accounts from the dashboard. |
| Platform app secrets (`TIKTOK_*`, `INSTAGRAM_*`, `GOOGLE_*`) | rotate at the platform, edit `.env`, `up -d`, **re-connect** the account. |
| `POSTGRES_PASSWORD` | change in `.env` *and* `ALTER USER momentum PASSWORD '…'` inside postgres, then `up -d`. |

## 4. Reconnect a social account
Dashboard → Status → Connected accounts → **Connect**. (Alerts tell you when a token refresh fails: "*<platform> token refresh FAILED*".) TikTok/Instagram/YouTube tokens refresh automatically every 30 min when they are within 24 h of expiry; a human is only needed when a refresh token itself lapses (alerted 7 days ahead) or the platform revokes access.

## 5. Failure playbook
| You see | Likely cause | What to do |
|---|---|---|
| **Alert: "Spend cap hit for X — queues paused"** | daily/monthly cap in `config/limits.json` reached | Nothing is lost. Queues resume automatically when the window rolls (UTC day/month). To resume now: raise the cap, `docker compose restart worker`; the monitor resumes within 5 min. |
| **Held items** on the dashboard | QA failed 3× (factual / policy / technical / reviewer), **or** a sensitive story (death, serious injury, abuse allegation, legal case) was held immediately — those say "sensitive topic" and should usually stay held | Open **Held**: each lists the exact reasons. Either leave it (it is the system being careful) or, after fixing the cause (e.g. a source), retry: `docker compose --profile tools run --rm tools npm run release -- <contentId>`. |
| **Alert: "N consecutive QA failures"** | something systemic: bad source feed, broken render, prompt regression | Dashboard → Content → open a failed item → read QA reasons. Technical failures usually mean ffmpeg/fonts; `docker compose logs worker \| grep qa`. |
| **Alert: "<platform> publish OUTCOME UNKNOWN"** | the platform didn't confirm a post after we sent it | **Do not retry blindly.** Check the platform account for the post. If it exists, nothing to do; if not, set the publication back: `UPDATE publications SET status='scheduled', error=NULL WHERE id='…'` and re-enqueue by restarting the worker (the reconciler picks it up), or just let the next ideation cycle replace it. |
| **Alert: "<platform> token refresh FAILED"** | token revoked / app secret changed / audit lapsed | Re-connect (section 4). Publishing to that platform pauses itself (jobs retry, then alert). |
| **Alert: "Job dead-lettered in <queue>"** | a job failed 5× with backoff | Dashboard → Alerts → *Dead-lettered jobs* shows the error. The content is marked `failed`; the next cycle creates new content, so usually nothing to do. Fix the cause (key, quota) first. |
| **Alert: "Queue backlog"** | worker down / slow render / API outage | `docker compose ps`; `docker compose logs worker`; restart the worker. Backlogs drain on their own. |
| **TikTok/YouTube posts are private** | app not yet audited (see SETUP_CHECKLIST) | Expected until the audit passes; the dashboard shows a warning on the publication. |
| **Worker unhealthy / restart loop** | Redis unreachable, bad config | `docker compose logs worker`; the heartbeat file only updates while Redis answers, so Docker restarts a wedged worker automatically. |
| **Items stuck in a stage > 20 min** | process died between a DB commit and the next enqueue | Self-heals: the reconciler (every 10 min) re-enqueues them. Check *Alerts* if it persists. |
| **Disk filling up** | rendered media | `housekeeping` deletes media of finished pieces > 14 days daily. Held items are kept for review. `docker system df`. |

## 6. Redis / Postgres
- **Redis** is configured `appendonly yes` + `noeviction` (BullMQ requires `noeviction`). If Redis data is lost, content rows survive in Postgres and the reconciler re-creates the missing jobs; scheduled repeat jobs are re-registered when the worker starts.
- **Backups (Postgres is the source of truth):**
  ```bash
  docker compose exec -T postgres pg_dump -U momentum momentum | gzip > backup-$(date +%F).sql.gz
  # restore into an empty DB:  gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U momentum momentum
  ```
  Schedule the dump with cron and copy it off the box. Also keep your `.env` (especially `TOKEN_ENC_KEY`) somewhere safe.

## 7. Weekly learning & rollback
Every Monday 06:00 (configurable) the job re-weights templates, pillars, hook styles, posting hours and length, writes `reports/WEEKLY_REPORT.md` (plus a dated copy), and saves a new weight **version** (never overwriting history).
```bash
docker compose --profile tools run --rm tools npm run rollback              # list versions
docker compose --profile tools run --rm tools npm run rollback -- 3         # restore v3 (as a new version)
```
Changes are bounded (≤ ±25 % per update per multiplier) and ignore small samples, so one lucky post cannot swing strategy. In DRY_RUN the job *reports* but never saves.

## 8. Useful queries
```sql
-- everything about one piece, in order
SELECT at, stage, from_status, to_status, detail FROM content_events WHERE content_id = '…' ORDER BY id;
-- why things were held / failed recently
SELECT topic, status, error FROM content WHERE status IN ('held','failed') ORDER BY status_changed_at DESC LIMIT 20;
-- spend today per provider
SELECT provider, round(sum(usd)::numeric,3) FROM spend_ledger WHERE at >= date_trunc('day', now()) GROUP BY 1;
```
Trace one piece through the logs: `docker compose logs worker | grep <correlationId>` (the correlation ID is on every log line, queue job, and DB event for that piece).
