import { z } from "zod";
import type { MetaData } from "@/lib/meta";
import type { HubSpotData } from "@/lib/hubspot";
import type { ReportInsights } from "@/lib/insights";
import type { Targets } from "@/lib/config";
import { fetchWithTimeout } from "@/lib/http";

// Ceiling for the Claude generation call. Kept comfortably below the function's
// overall budget so a slow generation fails fast with an alert rather than
// tripping the platform's hard timeout. Data fetch (parallel) + this + send must
// stay under the serverless limit.
const REQUEST_TIMEOUT_MS = 35000;

/**
 * Turns the fetched Meta + HubSpot data into a finished HTML email using the
 * Anthropic Messages API (claude-sonnet-4-6). Called via fetch, no SDK.
 *
 * The model returns a subject line on the first line, then a self-contained
 * HTML email body. We do not compute or invent any metrics here — everything
 * the model sees comes from the fetched data.
 */
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
// The heavy analysis (flags, pacing, recommendations) is computed in code and
// handed to the model — its job here is mostly to format those results into a
// clean HTML email. A fast model does that well and, critically, keeps the whole
// pipeline inside the serverless time budget (a larger model generating this
// much inline-styled HTML runs ~45-55s, which overruns the function limit).
// If the function limit is raised (e.g. Vercel Pro), this can move back to
// "claude-sonnet-4-6" for slightly richer prose.
const MODEL = "claude-haiku-4-5";
// The email now includes topline, a campaign table, funnel, flags, a
// targets/pacing summary, and a recommendations list. Inline-styled HTML tables
// are token-heavy, so give the model comfortable headroom — 3000 truncated the
// email mid-render once the later sections were added.
const MAX_TOKENS = 8000;

export interface AnalyzeInput {
  dateLabel: string;
  meta: MetaData | null;
  metaError: string | null;
  hubspot: HubSpotData | null;
  hubspotError: string | null;
  targets: Targets;
  insights: ReportInsights | null;
}

export interface AnalyzedEmail {
  subject: string;
  html: string;
}

const MessagesResponseSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
  stop_reason: z.string().nullish(),
});

const SYSTEM_PROMPT = `You are a marketing analyst writing a short daily performance email for the owner of Powerhouse Gym, a busy non-technical business person.

You will be given yesterday's Meta (Facebook/Instagram) ad data, a 7-day daily-average baseline, and HubSpot CRM data, all as JSON. Write a clean, self-contained HTML email that reports on it.

STRICT RULES:
- Output the SUBJECT LINE on the very first line, as plain text, with no "Subject:" prefix and no quotes. Use exactly this format: "Powerhouse Gym | Daily Marketing Report — <report date>" (e.g. "Powerhouse Gym | Daily Marketing Report — Thursday, July 9, 2026"). Do not add anything else to the subject.
- Everything after the first line must be a single valid HTML fragment (start with a <div>). Inline styles ONLY — no <style> tags, no <head>, no external CSS, no <script>, no images. It must render correctly in Gmail and Outlook.
- Do NOT use markdown anywhere. Do NOT add any preamble, explanation, or text outside the HTML.
- Only use numbers that appear in the provided JSON. Never invent, estimate, or extrapolate metrics that aren't present. If a value is missing, say so plainly instead of guessing.
- Use plain business English. No jargon, no acronyms without expansion, no emoji except the warning symbol described below.

EMAIL STRUCTURE (in this order):
1. A short greeting line and the date the report covers.
2. Topline summary as a small set of clearly labeled figures: total ad spend, total leads, cost per lead, total new CRM contacts, and new contacts from paid social. Show the total new contacts AND the paid-social contacts as two distinct figures (do not replace one with the other) — use the HubSpot "newContactCount" for total new contacts and "paidSocialContactCount" for the paid-social figure.
3. A per-campaign table (campaign name, spend, leads, cost per lead, clicks, click-through rate). Use a simple bordered HTML table with inline styles. If there were no campaigns with activity, say so.
4. Top performing ads: a short bordered table of the pre-computed "insights.topAds" (ad name, leads, cost per lead, click-through rate), showing which individual creatives drove the most leads yesterday. If "insights.topAds" is empty, omit this section.
5. By location: a one-line or tiny-table summary of "insights.marketSplit" (Miami vs Fort Lauderdale — spend, leads, cost per lead per location). Omit if marketSplit is empty.
6. A one-line funnel: Meta ad spend -> Meta leads -> HubSpot contacts from paid social. Make the connection explicit.
7. Flags: call out plainly anything that is roughly 20% or more above or below the 7-day daily average (spend, leads, or cost per lead). If nothing is notably off, say "Nothing unusual today." State the direction (up/down) and rough magnitude in plain words.
8. Targets & pacing (include ONLY if the JSON provides target data under "targets"/"insights"): a short, plainly-worded summary using the pre-computed values in "insights" — yesterday's cost per lead vs the target cost per lead, and the month-to-date cost per lead ("insights.mtdCpl") for context; month-to-date spend vs the monthly budget and whether spending is ahead of or behind an even pace; and progress toward the monthly lead goal. Do not recompute or invent any of these numbers.
9. What to change today: a bulleted list of 2-5 direct, practical ACTIONS grounded strictly in the data and the pre-computed "insights" object (use its recommendation lines as your basis) — e.g. scale a well-performing ad, pause or refresh an ad that spent money with no leads or is over the cost-per-lead target, or refresh an ad with high frequency (ad fatigue). Reference specific ads by name. Phrase each as a clear action (e.g. "Scale X", "Refresh the creative on Y", "Pause Z"). Do NOT restate the budget or lead pacing numbers here — those belong only in the Targets & pacing section above; this section is concrete actions on specific ads. The business prioritizes qualified leads over raw volume — never recommend simply spending more to hit the lead goal. If a recommendation is not well-supported by the data, leave it out rather than padding the list.

DATA AVAILABILITY:
- If a data source is marked unavailable, include a clearly visible notice near the top in a colored box, exactly of the form: "⚠️ [Meta] data unavailable today" or "⚠️ [HubSpot] data unavailable today" (as applicable), then continue the report with whatever data IS available. Do not fabricate the missing numbers.

Format currency as US dollars. Keep the whole email skimmable in under a minute.`;

function buildUserContent(input: AnalyzeInput): string {
  const payload = {
    reportDate: input.dateLabel,
    targets: input.targets,
    insights: input.insights,
    meta: input.meta
      ? { status: "available", ...input.meta }
      : { status: "unavailable", error: input.metaError },
    hubspot: input.hubspot
      ? { status: "available", ...input.hubspot }
      : { status: "unavailable", error: input.hubspotError },
  };

  return [
    `Here is the data for ${input.dateLabel}. Write the daily marketing email.`,
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

/**
 * Split the model's output into subject (first line) and HTML body (the rest).
 */
function splitSubjectAndBody(raw: string): AnalyzedEmail {
  const trimmed = raw.trim();
  const newlineIdx = trimmed.indexOf("\n");
  if (newlineIdx === -1) {
    // No body separator — treat the whole thing as the body with a fallback subject.
    return {
      subject: "Daily Marketing Report",
      html: trimmed,
    };
  }
  const subject = trimmed.slice(0, newlineIdx).trim();
  const html = trimmed.slice(newlineIdx + 1).trim();
  return {
    subject: subject || "Daily Marketing Report",
    html,
  };
}

export async function analyze(input: AnalyzeInput): Promise<AnalyzedEmail> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY environment variable.");
  }

  const res = await fetchWithTimeout(
    ANTHROPIC_API,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildUserContent(input),
          },
        ],
      }),
    },
    REQUEST_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Anthropic request failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`,
    );
  }

  const json = await res.json();
  const parsed = MessagesResponseSchema.parse(json);

  const text = parsed.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text as string)
    .join("");

  if (!text.trim()) {
    throw new Error(
      `Anthropic returned no text content (stop_reason=${parsed.stop_reason ?? "unknown"}).`,
    );
  }

  // The email would be truncated mid-HTML if the model ran out of output
  // budget. Surface it loudly in the logs so we can raise MAX_TOKENS rather than
  // silently ship a half-rendered email.
  if (parsed.stop_reason === "max_tokens") {
    console.warn(
      "[analyze] WARNING: email hit max_tokens and may be truncated — raise MAX_TOKENS.",
    );
  }

  return splitSubjectAndBody(text);
}
