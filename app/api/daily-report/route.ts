import type { NextRequest } from "next/server";
import { fetchMetaData, type MetaData } from "@/lib/meta";
import { fetchHubSpotData, type HubSpotData } from "@/lib/hubspot";
import { analyze } from "@/lib/analyze";
import { sendReport, sendFailureAlert, type ReportAttachment } from "@/lib/email";
import { getYesterdayRangeET } from "@/lib/dates";
import { buildReportCsv } from "@/lib/csv";
import { buildReportPdf } from "@/lib/pdf";

/**
 * Daily marketing report handler.
 *
 * Invoked by Vercel Cron every day (see vercel.json: "0 12 * * *" = 12:00 UTC).
 *
 * NOTE ON DST: 12:00 UTC is 8:00 AM Eastern Daylight Time (summer). During
 * Eastern Standard Time (winter) it lands at 7:00 AM Eastern. Vercel Cron does
 * not support timezones, so the send time shifts by an hour across DST changes.
 * This is acceptable for a morning report; adjust the cron expression if a
 * fixed local time is required.
 *
 * Pipeline:
 *   1. Verify the Authorization header equals `Bearer ${CRON_SECRET}`.
 *   2. Fetch Meta and HubSpot data independently (one failing does not stop the
 *      other; the report still goes out with a visible "data unavailable" notice).
 *   3. Have Claude write the email.
 *   4. Send via Resend — to the boss normally, or to ALERT_EMAIL on ?test=1.
 *   5. If everything fails or the send fails, send a plain-text alert to
 *      ALERT_EMAIL. If even that throws, log loudly.
 */

// Allow the pipeline (three external APIs + Claude) up to 60s on Vercel.
export const maxDuration = 60;

// Never cache a cron endpoint.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  // --- 1. Auth -------------------------------------------------------------
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const isTest = request.nextUrl.searchParams.get("test") === "1";
  const { label: dateLabel, isoDate } = getYesterdayRangeET();

  // --- 2. Fetch data (independent, resilient) ------------------------------
  let meta: MetaData | null = null;
  let metaError: string | null = null;
  let hubspot: HubSpotData | null = null;
  let hubspotError: string | null = null;

  try {
    meta = await fetchMetaData();
    // Log the raw analyzed data so Vercel logs show exactly what Claude saw.
    console.log("[daily-report] Meta data:", JSON.stringify(meta));
  } catch (err) {
    metaError = err instanceof Error ? err.message : String(err);
    console.error("[daily-report] Meta fetch failed:", metaError);
  }

  try {
    hubspot = await fetchHubSpotData();
    console.log("[daily-report] HubSpot data:", JSON.stringify(hubspot));
  } catch (err) {
    hubspotError = err instanceof Error ? err.message : String(err);
    console.error("[daily-report] HubSpot fetch failed:", hubspotError);
  }

  // --- 3 & 4. Analyze + send -----------------------------------------------
  try {
    // If BOTH sources failed, there is nothing meaningful to report — treat it
    // as a hard failure and alert instead of emailing an empty report.
    if (!meta && !hubspot) {
      throw new Error(
        `Both data sources unavailable. Meta: ${metaError}. HubSpot: ${hubspotError}.`,
      );
    }

    const email = await analyze({
      dateLabel,
      meta,
      metaError,
      hubspot,
      hubspotError,
    });

    const to = isTest
      ? requireEnv("ALERT_EMAIL")
      : requireEnv("REPORT_TO_EMAIL");

    const subject = isTest ? `[TEST] ${email.subject}` : email.subject;

    // Build the PDF + CSV attachments from the same data. These are an
    // enhancement, not the core deliverable — if either fails to generate we
    // log it and still send the email (with whatever attachments succeeded).
    const attachments = await buildAttachments({ dateLabel, meta, hubspot }, isoDate);

    await sendReport({ to, subject, html: email.html, attachments });

    console.log(
      `[daily-report] Report sent to ${to}${isTest ? " (test mode)" : ""} for ${dateLabel}.`,
    );

    return Response.json({
      ok: true,
      test: isTest,
      sentTo: to,
      dateLabel,
      metaAvailable: Boolean(meta),
      hubspotAvailable: Boolean(hubspot),
    });
  } catch (err) {
    // --- 5. Failure alert (best effort) ------------------------------------
    const message = err instanceof Error ? err.message : String(err);
    console.error("[daily-report] Pipeline failed:", message);

    try {
      await sendFailureAlert(
        [
          `Report date: ${dateLabel}`,
          `Test mode: ${isTest}`,
          `Meta available: ${Boolean(meta)}${metaError ? ` (error: ${metaError})` : ""}`,
          `HubSpot available: ${Boolean(hubspot)}${hubspotError ? ` (error: ${hubspotError})` : ""}`,
          "",
          `Failure: ${message}`,
        ].join("\n"),
      );
    } catch (alertErr) {
      // If even the alert path throws, log as loudly as we can.
      console.error(
        "[daily-report] CRITICAL: failure alert ALSO failed to send:",
        alertErr instanceof Error ? alertErr.message : String(alertErr),
      );
    }

    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }
  return value;
}

/**
 * Build the CSV + PDF attachments. Each is generated independently and never
 * throws — a failure to build one attachment logs and is skipped so the email
 * still goes out.
 */
async function buildAttachments(
  data: { dateLabel: string; meta: MetaData | null; hubspot: HubSpotData | null },
  isoDate: string,
): Promise<ReportAttachment[]> {
  const attachments: ReportAttachment[] = [];

  try {
    const csv = buildReportCsv(data);
    attachments.push({
      filename: `marketing-report-${isoDate}.csv`,
      content: Buffer.from(csv, "utf-8"),
    });
  } catch (err) {
    console.error(
      "[daily-report] CSV build failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    const pdfBytes = await buildReportPdf(data);
    attachments.push({
      filename: `marketing-report-${isoDate}.pdf`,
      content: Buffer.from(pdfBytes),
    });
  } catch (err) {
    console.error(
      "[daily-report] PDF build failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return attachments;
}
