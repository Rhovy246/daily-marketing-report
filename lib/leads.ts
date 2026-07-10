import type { HubSpotData, HubSpotContact } from "@/lib/hubspot";

/**
 * Builds the "new leads" spreadsheet attachment — the actual list of contacts
 * created yesterday (name, email, source), so the sales team can start
 * following up immediately instead of just seeing a count.
 *
 * Contains customer contact details, so it's an internal attachment intended
 * for the team only.
 */

function csvField(value: string | number): string {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(...fields: (string | number)[]): string {
  return fields.map(csvField).join(",");
}

const PAID_SOCIAL_HINTS = [
  "paid_social",
  "paid social",
  "facebook",
  "instagram",
  "meta",
  "fb",
  "ig",
];

function isPaidSocial(contact: HubSpotContact): boolean {
  const sources = [contact.analyticsSource, contact.latestSource]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.toLowerCase());
  return sources.some((source) =>
    PAID_SOCIAL_HINTS.some((hint) => source.includes(hint)),
  );
}

function fullName(c: HubSpotContact): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
}

export function buildLeadsCsv(hubspot: HubSpotData, dateLabel: string): string {
  const lines: string[] = [];
  lines.push(row("Powerhouse Gym - New Leads for follow-up"));
  lines.push(row("Report date", dateLabel));
  lines.push(row("Total new contacts", hubspot.newContactCount));
  lines.push(
    row("From paid social (Facebook/Instagram)", hubspot.paidSocialContactCount),
  );
  lines.push("");
  lines.push(
    row("Name", "Email", "Original Source", "Latest Source", "From Paid Social?", "Created"),
  );

  if (hubspot.contacts.length === 0) {
    lines.push(row("No new contacts yesterday"));
  } else {
    // Paid-social leads first (most relevant to the ad report), then the rest.
    const sorted = [...hubspot.contacts].sort((a, b) => {
      const pa = isPaidSocial(a) ? 0 : 1;
      const pb = isPaidSocial(b) ? 0 : 1;
      return pa - pb;
    });
    for (const c of sorted) {
      lines.push(
        row(
          fullName(c) || "(no name)",
          c.email ?? "",
          c.analyticsSource ?? "",
          c.latestSource ?? "",
          isPaidSocial(c) ? "Yes" : "No",
          c.createdAt ?? "",
        ),
      );
    }
  }

  return lines.join("\r\n") + "\r\n";
}
