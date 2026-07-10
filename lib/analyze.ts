import { z } from "zod";
import type { MetaData } from "@/lib/meta";
import type { HubSpotData } from "@/lib/hubspot";

/**
 * Turns the fetched Meta + HubSpot data into a finished HTML email using the
 * Anthropic Messages API (claude-sonnet-4-6). Called via fetch, no SDK.
 *
 * The model returns a subject line on the first line, then a self-contained
 * HTML email body. We do not compute or invent any metrics here — everything
 * the model sees comes from the fetched data.
 */
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 3000;

export interface AnalyzeInput {
  dateLabel: string;
  meta: MetaData | null;
  metaError: string | null;
  hubspot: HubSpotData | null;
  hubspotError: string | null;
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
- Output the SUBJECT LINE on the very first line, as plain text, with no "Subject:" prefix and no quotes.
- Everything after the first line must be a single valid HTML fragment (start with a <div>). Inline styles ONLY — no <style> tags, no <head>, no external CSS, no <script>, no images. It must render correctly in Gmail and Outlook.
- Do NOT use markdown anywhere. Do NOT add any preamble, explanation, or text outside the HTML.
- Only use numbers that appear in the provided JSON. Never invent, estimate, or extrapolate metrics that aren't present. If a value is missing, say so plainly instead of guessing.
- Use plain business English. No jargon, no acronyms without expansion, no emoji except the warning symbol described below.

EMAIL STRUCTURE (in this order):
1. A short greeting line and the date the report covers.
2. Topline summary: total ad spend, total leads, cost per lead, and new contacts — as a small set of clearly labeled figures.
3. A per-campaign table (campaign name, spend, leads, cost per lead, clicks, click-through rate). Use a simple bordered HTML table with inline styles. If there were no campaigns with activity, say so.
4. A one-line funnel: Meta ad spend -> Meta leads -> HubSpot contacts from paid social. Make the connection explicit.
5. Flags: call out plainly anything that is roughly 20% or more above or below the 7-day daily average (spend, leads, or cost per lead). If nothing is notably off, say "Nothing unusual today." State the direction (up/down) and rough magnitude in plain words.
6. One short "Worth watching today" note — a single practical observation grounded in the data.

DATA AVAILABILITY:
- If a data source is marked unavailable, include a clearly visible notice near the top in a colored box, exactly of the form: "⚠️ [Meta] data unavailable today" or "⚠️ [HubSpot] data unavailable today" (as applicable), then continue the report with whatever data IS available. Do not fabricate the missing numbers.

Format currency as US dollars. Keep the whole email skimmable in under a minute.`;

function buildUserContent(input: AnalyzeInput): string {
  const payload = {
    reportDate: input.dateLabel,
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

  const res = await fetch(ANTHROPIC_API, {
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
  });

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

  return splitSubjectAndBody(text);
}
