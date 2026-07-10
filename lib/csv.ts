import { round2, type ReportArtifactInput } from "@/lib/format";

/**
 * Builds the spreadsheet attachment (CSV — opens directly in Excel / Google
 * Sheets). Numbers are written as raw values (not "$1,234"), so the boss can
 * sort, sum, and chart them without cleaning anything up.
 */

/** Escape a single CSV field per RFC 4180. */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(...fields: (string | number)[]): string {
  return fields.map(csvField).join(",");
}

export function buildReportCsv(input: ReportArtifactInput): string {
  const { meta, hubspot, dateLabel } = input;
  const lines: string[] = [];

  lines.push(row("Powerhouse Gym - Daily Marketing Report"));
  lines.push(row("Report date", dateLabel));
  lines.push("");

  // --- Topline summary ---
  lines.push(row("TOPLINE SUMMARY"));
  lines.push(row("Metric", "Value"));
  if (meta) {
    const t = meta.yesterday.totals;
    lines.push(row("Total ad spend (USD)", round2(t.spend)));
    lines.push(row("Total impressions", Math.round(t.impressions)));
    lines.push(row("Total clicks", Math.round(t.clicks)));
    lines.push(row("Total leads", Math.round(t.leads)));
    lines.push(
      row("Cost per lead (USD)", t.costPerLead === null ? "" : round2(t.costPerLead)),
    );
  } else {
    lines.push(row("Meta ad data", "UNAVAILABLE"));
  }
  if (hubspot) {
    lines.push(row("New contacts", hubspot.newContactCount));
    lines.push(row("Contacts from paid social", hubspot.paidSocialContactCount));
  } else {
    lines.push(row("HubSpot CRM data", "UNAVAILABLE"));
  }
  lines.push("");

  // --- Per-campaign table ---
  lines.push(row("CAMPAIGNS (YESTERDAY)"));
  lines.push(
    row(
      "Campaign",
      "Spend (USD)",
      "Impressions",
      "Clicks",
      "CTR (%)",
      "CPC (USD)",
      "Leads",
      "Cost per lead (USD)",
    ),
  );
  if (meta) {
    if (meta.yesterday.campaigns.length === 0) {
      lines.push(row("No campaign activity yesterday"));
    } else {
      for (const c of meta.yesterday.campaigns) {
        lines.push(
          row(
            c.campaignName,
            round2(c.spend),
            Math.round(c.impressions),
            Math.round(c.clicks),
            round2(c.ctr),
            round2(c.cpc),
            Math.round(c.leads),
            c.costPerLead === null ? "" : round2(c.costPerLead),
          ),
        );
      }
      const t = meta.yesterday.totals;
      lines.push(
        row(
          "TOTAL",
          round2(t.spend),
          Math.round(t.impressions),
          Math.round(t.clicks),
          "",
          "",
          Math.round(t.leads),
          t.costPerLead === null ? "" : round2(t.costPerLead),
        ),
      );
    }
  } else {
    lines.push(row("Meta ad data unavailable"));
  }
  lines.push("");

  // --- 7-day baseline ---
  lines.push(row("7-DAY DAILY AVERAGE (BASELINE)"));
  lines.push(row("Metric", "Value"));
  if (meta) {
    const a = meta.last7dDailyAverage;
    lines.push(row("Avg daily spend (USD)", round2(a.spend)));
    lines.push(row("Avg daily leads", round2(a.leads)));
    lines.push(
      row("Avg daily cost per lead (USD)", a.costPerLead === null ? "" : round2(a.costPerLead)),
    );
  } else {
    lines.push(row("Meta ad data unavailable"));
  }
  lines.push("");

  // --- Funnel: spend -> leads -> paid-social contacts ---
  lines.push(row("FUNNEL"));
  lines.push(
    row("Meta ad spend (USD)", meta ? round2(meta.yesterday.totals.spend) : "n/a"),
  );
  lines.push(row("Meta leads", meta ? Math.round(meta.yesterday.totals.leads) : "n/a"));
  lines.push(
    row(
      "HubSpot contacts from paid social",
      hubspot ? hubspot.paidSocialContactCount : "n/a",
    ),
  );

  // CRLF line endings are the safest for Excel across platforms.
  return lines.join("\r\n") + "\r\n";
}
