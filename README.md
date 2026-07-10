# Daily Marketing Report — Powerhouse Gym

A **headless serverless service** that emails a daily marketing performance report.
No database, no UI — just a Vercel Cron job that runs once each morning.

Every day at **8:00 AM Eastern** it:

1. Fetches **yesterday's Meta (Facebook/Instagram) ad performance** and a 7-day baseline.
2. Fetches **yesterday's HubSpot CRM activity** (new contacts).
3. Has **Claude** write a plain-English analysis email.
4. Sends it to the boss via **Resend**.

If a data source is down, the report still goes out with a visible
"⚠️ [source] data unavailable today" notice. If the whole thing fails, you get a
plain-text failure alert.

---

## How it works

```
Vercel Cron ──GET──▶ /api/daily-report
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   lib/meta.ts       lib/hubspot.ts    (independent, resilient)
        └───────┬─────────┘
                ▼
          lib/analyze.ts  ── Claude writes the HTML email
                ▼
          lib/email.ts    ── Resend delivers it
```

| File | Responsibility |
| --- | --- |
| `app/api/daily-report/route.ts` | Main handler (GET). Auth, orchestration, resilience, alerts. |
| `lib/meta.ts` | Meta Graph API v25.0 client — campaign + ad-level insights, frequency, month-to-date, cost-per-lead. |
| `lib/hubspot.ts` | HubSpot CRM v3 search — new contacts, paid-social attribution. |
| `lib/config.ts` | Optional performance targets (CPL / lead goal / budget) from env vars. |
| `lib/insights.ts` | Computes pacing + the "what to change" recommendations from the data. |
| `lib/analyze.ts` | Anthropic Messages API (`claude-sonnet-4-6`) — turns data + insights into an email. |
| `lib/email.ts` | Resend — report send + failure alerts. |
| `lib/dates.ts` | "Yesterday in America/New_York" + month pacing (DST-aware, no date library). |
| `vercel.json` | Cron config. |

Dependencies are intentionally minimal: **`zod`** (validating flaky external API
responses) and **`resend`**. Meta, HubSpot, and Anthropic are all called with
plain `fetch` — no SDKs.

---

## Setup

### 1. Install & run locally

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

### 2. Environment variables

Set these in `.env.local` (local) **and** in the Vercel dashboard
(Settings → Environment Variables) for production. See `.env.example` for
inline notes on where to generate each one.

| Variable | What it is |
| --- | --- |
| `META_ACCESS_TOKEN` | Meta System User token with `ads_read`. |
| `META_AD_ACCOUNT_ID` | Ad account ID (`1234567890` or `act_1234567890`). |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot Private App token (`crm.objects.contacts.read`). |
| `ANTHROPIC_API_KEY` | Anthropic API key. |
| `RESEND_API_KEY` | Resend API key. |
| `REPORT_TO_EMAIL` | Recipient of the daily report (the boss). |
| `REPORT_FROM_EMAIL` | Verified Resend sender, e.g. `Powerhouse Reports <reports@yourdomain.com>`. |
| `ALERT_EMAIL` | Your email — failure alerts and `?test=1` dry-runs go here. |
| `TARGET_CPL` | *(optional)* Target cost per lead in USD, e.g. `10`. Powers pacing + advice. |
| `MONTHLY_LEAD_GOAL` | *(optional)* Monthly lead goal, e.g. `1000`. |
| `MONTHLY_AD_BUDGET` | *(optional)* Monthly ad budget in USD, e.g. `6500`. |
| `CRON_SECRET` | Random secret. Generate with `openssl rand -hex 32`. |

> **About `CRON_SECRET`:** when this variable is set on a Vercel project, Vercel
> Cron automatically includes `Authorization: Bearer <CRON_SECRET>` on every cron
> invocation. The route rejects any request whose header doesn't match, returning
> `401`. Set the same value locally so you can test.

### 3. Deploy to Vercel

```bash
npm i -g vercel      # if you don't have it
vercel link          # link this directory to a Vercel project
vercel --prod        # deploy
```

Add all the environment variables in the Vercel dashboard (or `vercel env add`),
then redeploy. The cron schedule in `vercel.json` is picked up automatically on
deploy — no extra configuration needed.

---

## Testing

### Dry run (real pipeline, safe recipient)

Add `?test=1` to run the **entire** pipeline — fetch, analyze, send — but deliver
the email to `ALERT_EMAIL` instead of `REPORT_TO_EMAIL`. The subject is prefixed
with `[TEST]`. You still need the `CRON_SECRET` header:

```bash
# Local
curl -s "http://localhost:3000/api/daily-report?test=1" \
  -H "Authorization: Bearer $CRON_SECRET" | jq

# Production
curl -s "https://<your-project>.vercel.app/api/daily-report?test=1" \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

A successful run returns JSON like:

```json
{
  "ok": true,
  "test": true,
  "sentTo": "you@example.com",
  "dateLabel": "Wednesday, July 9, 2026",
  "metaAvailable": true,
  "hubspotAvailable": true
}
```

### Real run

Same request without `?test=1` sends to the boss. Or just wait for the cron
trigger. Every run logs the raw fetched JSON (`console.log`) so the Vercel logs
show exactly what Claude analyzed.

### Type-check

```bash
npm run typecheck
```

---

## The 8 AM Eastern / DST caveat

The cron schedule is `0 12 * * *` — **12:00 UTC**.

- **Summer (EDT, UTC−4):** 12:00 UTC = **8:00 AM Eastern**. ✅
- **Winter (EST, UTC−5):** 12:00 UTC = **7:00 AM Eastern**.

Vercel Cron runs in UTC and has no timezone setting, so the local send time
shifts by one hour twice a year. For a morning report this is fine. If you need
a fixed local time, you'd have to run two crons and gate them in code, or adjust
the expression seasonally.

Note: this only affects the **send time**. The *data* is always "yesterday in
America/New_York" — `lib/dates.ts` resolves EST/EDT correctly, so the reporting
window is always the gym's true local day regardless of when the email goes out.

---

## Notes

- **Meta Graph API version:** pinned to `v25.0` in `lib/meta.ts`. Meta ships a new
  version roughly twice a year; bump `GRAPH_API_VERSION` before the pinned one
  sunsets (~2-year support window).
- **Paid-social attribution:** `lib/hubspot.ts` counts a contact as paid-social if
  its `hs_analytics_source` or `hs_latest_source` matches Facebook / Instagram /
  Meta / paid-social hints. Adjust `PAID_SOCIAL_HINTS` there if your CRM uses
  different source labels.
- **No invented metrics:** the analyzer is instructed to use only numbers present
  in the fetched data and to flag missing values rather than guess.
