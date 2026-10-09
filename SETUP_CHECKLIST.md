# Setup checklist — the one-time things only you can do

Everything else is automated. Do these **in order**. Steps marked ⏱ have a waiting period, so start them first.

> **Status of the code against these services:** the whole pipeline is tested end to end in DRY_RUN
> (real Postgres, Redis, ffmpeg, RSS feeds). The TikTok / Instagram / YouTube / ElevenLabs / Anthropic /
> Reddit integrations are written to each service's documented API and unit-tested against mocked HTTP, but
> **have never run against a live account** (no credentials existed). Expect to fix small things during the
> first live connection — that is what step 12's supervised week is for.

## 0. Decide where it runs
A small VPS (2 vCPU / 4 GB RAM / 40 GB disk is enough; rendering is the heavy part) with Docker + Docker Compose, a domain name, and **HTTPS** in front of port 8080 (Caddy/Traefik/nginx).
Why HTTPS is mandatory: Instagram downloads each video from a public URL, and TikTok/YouTube/Instagram only redirect OAuth to an `https://` address.

## 1. Generate your secrets (2 min)
```bash
openssl rand -hex 32   # run 4×: ADMIN_TOKEN, TOKEN_ENC_KEY, MEDIA_SIGNING_SECRET, POSTGRES_PASSWORD
```
Copy `.env.example` → `.env` and paste them in. **Back up `TOKEN_ENC_KEY`**: losing it means re-connecting all three accounts.
Set `PUBLIC_BASE_URL=https://your.domain`.

## 2. Alerts — so the system can reach you (5 min) — *required before going live*
Pick at least one (the app refuses to start live without one):
- **Discord:** Server Settings → Integrations → Webhooks → New Webhook → copy URL → `DISCORD_WEBHOOK_URL`
- **Telegram:** message `@BotFather` → `/newbot` → token → `TELEGRAM_BOT_TOKEN`; message your bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to read your `chat.id` → `TELEGRAM_CHAT_ID`
- **Email:** any SMTP account → `SMTP_URL=smtp://user:pass@host:587`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`

## 3. Anthropic (the writer + reviewer) (5 min)
[console.anthropic.com](https://console.anthropic.com) → API keys → create → `ANTHROPIC_API_KEY`.
Also set a **spend limit in the Anthropic console** (belt and braces beside `config/limits.json`).
Without a key the system uses a deterministic *stub* that only works in DRY_RUN.

## 4. Voice (10 min)
- **ElevenLabs** (primary): [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) → API key → `ELEVENLABS_API_KEY`. Choose a voice in the Voice Library → copy its Voice ID → `ELEVENLABS_VOICE_ID`.
  Check your plan permits **commercial use** of the chosen voice.
- **OpenAI** (fallback TTS + optional embeddings): [platform.openai.com/api-keys](https://platform.openai.com/api-keys) → `OPENAI_API_KEY`.
  At least one of the two is required for live mode. (The robotic espeak voice is dry-run only and is hard-disabled live.)

## 5. Reddit (optional trend signal) ⏱ approval may take days
[reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → create app (type *script*) → `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`.
Reddit gates Data API access and restricts commercial use — read the [API terms](https://www.reddit.com/wiki/api/) and request access if prompted. Edit the contact in `config/sources.json → reddit.userAgent`.
Skip this and the pipeline simply runs without Reddit signals.

## 5b. Official results feeds (optional, recommended)
No free public results API exists for most federations, so results currently arrive through the news feeds. If you have access to a results feed (World Athletics, a marathon organiser, a league), add it to `config/sources.json` → `rss` with `"kind": "results"`; it is then treated as a citable source, which makes result-based pieces more reliable.

## 6. YouTube ⏱ audit takes days to weeks
1. [Google Cloud Console](https://console.cloud.google.com) → new project → enable **YouTube Data API v3** and **YouTube Analytics API**.
2. OAuth consent screen → *External* → add your Google account as a test user → **then click "Publish app" (In production).**
   ⚠️ While the app is in *Testing*, Google expires refresh tokens after **7 days**, and the pipeline would stop posting weekly.
3. Credentials → Create OAuth client ID → *Web application* → authorised redirect URI:
   `https://your.domain/oauth/youtube/callback` → copy ID/secret → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. ⚠️ **Videos uploaded through an unverified API project are locked to private.** Submit the
   [YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form) to lift it.
   Until it's approved, uploads succeed but stay private (the app warns you when this happens).
5. Quota: the default quota allows only a handful of uploads per day; the audit form is also where you request more.

## 7. Instagram ⏱ review can take days
Requires an Instagram **Professional (Business or Creator)** account.
1. [developers.facebook.com](https://developers.facebook.com) → My Apps → Create app (type *Business*) → add the **Instagram** product → *API setup with Instagram login*.
2. Add your Instagram account as a tester/role; set the redirect URI `https://your.domain/oauth/instagram/callback`.
3. Copy the Instagram app ID/secret → `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`.
4. Needed permissions: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`.
   Posting to **your own** account works in development mode; App Review is only needed to serve other people's accounts. Verify against Meta's current docs — they change often.
5. Hard limit: Instagram allows **100 API-published posts per 24h**. Reels via API are capped at **90 s** (the pipeline caps videos at 60 s).

## 8. TikTok ⏱ audit takes weeks
1. [developers.tiktok.com](https://developers.tiktok.com) → Manage apps → Create app → add products **Login Kit** and **Content Posting API** (enable *Direct Post*).
2. Scopes: `user.info.basic`, `video.publish`, `video.upload`, `video.list`. Redirect URI: `https://your.domain/oauth/tiktok/callback`.
3. Copy client key/secret → `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.
4. ⚠️ **Until TikTok audits your app, every post is forced to private (SELF_ONLY), the account must be private, and only 5 accounts can post per day.**
   Submit the app for the Content Posting audit (it asks you to demonstrate compliant UX; the AI-content flag `is_aigc` is already set on every post).
   The pipeline works in the meantime but nothing will be public on TikTok.

## 9. Start it (still DRY_RUN)
```bash
docker compose up -d --build
docker compose ps            # everything "healthy"
open https://your.domain     # dashboard — log in with ADMIN_TOKEN
```
Dashboard → **Status → Connected accounts → Connect** for each platform and approve on the platform's consent page.
Expected: three green "connected" pills.

## 10. Rehearse before going live (30 min)
0. **Smoke test (read-only, posts nothing):**
   `docker compose --profile tools run --rm tools npm run smoke -- --alert`
   Checks Postgres/Redis, every API key, each connected account (via read-only endpoints: TikTok creator-info, Instagram publishing quota, YouTube channel), whether live mode's prerequisites are met, and sends one test alert. Fix every ✘ before continuing. A TikTok line ending "posts will be private" means the app isn't audited yet.
1. `docker compose --profile tools run --rm tools npm run dryrun` with your real API keys in `.env` — read the three generated pieces.
2. **Alert + kill-switch drill:** click **Pause all publishing** on the dashboard. You should get a *critical* alert on your channel within seconds, and the red "PUBLISHING PAUSED" banner. Click **Resume publishing**.
3. Confirm `config/schedule.json` (timezone, posts per day, peak times) and `config/limits.json` (spend caps, `maxPostsPerDay`) are what you want.

## 11. Go live
Set `DRY_RUN=false` in `.env`, then `docker compose up -d`. The app **refuses to start** until every safety prerequisite above is present, and tells you exactly what's missing.

## 12. Supervise the first week
Check the dashboard daily for 5–7 days: held items, QA scores, the first real analytics, token refreshes, the alert channel. After a clean week, a weekly look at the **Status** tab is enough: it shows one verdict — *All good* or *Needs a look* — with reasons.

---

### Things to know before going zero-touch (honest risks)
- **Platform policy risk.** TikTok, Instagram and YouTube all have rules about AI-generated, automated and mass-produced content (disclosure labels, "inauthentic / repetitive content" monetisation rules). The pipeline labels every post as AI-assisted and cites sources, but a platform can still limit reach or demonetise high-volume automated accounts. Start at a low posting rate.
- **Accuracy risk.** The factual gate is strict (every figure and name must appear in a cited source; quotes must be verbatim; the final script is re-verified), and it fails *closed*. It reduces but cannot eliminate the chance of a wrong or misleading post. Held items are the system choosing caution.
- **Source licensing.** Facts are taken from RSS headlines/summaries and always credited ("Source: BBC Sport"), never copied wholesale. Review each outlet's terms for automated use.
- **Cost.** Caps in `config/limits.json` are enforced in the app; also set limits in each provider's own console.
