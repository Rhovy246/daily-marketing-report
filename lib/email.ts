import { Resend } from "resend";

/**
 * Email delivery via Resend.
 *
 * Two entry points:
 *  - sendReport:      the finished HTML report to the boss (or ALERT_EMAIL on dry-run).
 *  - sendFailureAlert: a plain-text alert to ALERT_EMAIL when the pipeline fails.
 */

function getResend(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY environment variable.");
  }
  return new Resend(apiKey);
}

export interface ReportAttachment {
  filename: string;
  content: Buffer;
}

export interface SendReportArgs {
  to: string;
  subject: string;
  html: string;
  attachments?: ReportAttachment[];
}

export async function sendReport({
  to,
  subject,
  html,
  attachments,
}: SendReportArgs): Promise<void> {
  const from = process.env.REPORT_FROM_EMAIL;
  if (!from) {
    throw new Error("Missing REPORT_FROM_EMAIL environment variable.");
  }

  const resend = getResend();
  const { error } = await resend.emails.send({
    from,
    to,
    subject,
    html,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  });

  if (error) {
    throw new Error(`Resend failed to send report: ${JSON.stringify(error)}`);
  }
}

/**
 * Best-effort failure alert. Sends plain text to ALERT_EMAIL. If even this
 * throws, the caller logs loudly — we never want the alert path to mask the
 * original error.
 */
export async function sendFailureAlert(message: string): Promise<void> {
  const from = process.env.REPORT_FROM_EMAIL;
  const to = process.env.ALERT_EMAIL;
  if (!from || !to) {
    throw new Error(
      "Cannot send failure alert: missing REPORT_FROM_EMAIL or ALERT_EMAIL.",
    );
  }

  const resend = getResend();
  const { error } = await resend.emails.send({
    from,
    to,
    subject: "⚠️ Daily Marketing Report FAILED",
    text: [
      "The daily marketing report pipeline failed to produce or send a report.",
      "",
      "Details:",
      message,
      "",
      `Timestamp: ${new Date().toISOString()}`,
    ].join("\n"),
  });

  if (error) {
    throw new Error(`Resend failed to send failure alert: ${JSON.stringify(error)}`);
  }
}
