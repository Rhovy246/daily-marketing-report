import { round2 } from "@/lib/format";
import {
  describeRecommendations,
  type ReportArtifactInput,
} from "@/lib/insights";

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
  const { meta, hubspot, dateLabel, insights, targets } = input;
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

  // --- Per-ad table (which creatives are working) ---
  lines.push(row("ADS (YESTERDAY)"));
  lines.push(
    row(
      "Ad",
      "Campaign",
      "Spend (USD)",
      "Impressions",
      "Clicks",
      "CTR (%)",
      "CPC (USD)",
      "Reach",
      "Frequency",
      "Leads",
      "Cost per lead (USD)",
    ),
  );
  if (meta) {
    if (meta.yesterday.ads.length === 0) {
      lines.push(row("No ad activity yesterday"));
    } else {
      for (const a of meta.yesterday.ads) {
        lines.push(
          row(
            a.adName,
            a.campaignName,
            round2(a.spend),
            Math.round(a.impressions),
            Math.round(a.clicks),
            round2(a.ctr),
            round2(a.cpc),
            Math.round(a.reach),
            round2(a.frequency),
            Math.round(a.leads),
            a.costPerLead === null ? "" : round2(a.costPerLead),
          ),
        );
      }
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

  // --- Members & conversion (CRM) ---
  lines.push("");
  lines.push(row("MEMBERS & CONVERSION"));
  lines.push(row("Metric", "Value"));
  if (hubspot) {
    lines.push(row("New members yesterday", hubspot.newMembers.total));
    lines.push(
      row("New members from paid social", hubspot.newMembers.fromPaidSocial),
    );
    lines.push(
      row(
        `Paid-social leads this month (${hubspot.paidSocialFunnel.monthLabel})`,
        hubspot.paidSocialFunnel.leads,
      ),
    );
    lines.push(row("...of those, visited", hubspot.paidSocialFunnel.visited));
    lines.push(row("...of those, became members", hubspot.paidSocialFunnel.members));
  } else {
    lines.push(row("HubSpot CRM data", "UNAVAILABLE"));
  }

  // --- Location split (Miami vs Fort Lauderdale) ---
  lines.push("");
  lines.push(row("BY LOCATION (YESTERDAY)"));
  lines.push(row("Location", "Spend (USD)", "Leads", "Cost per lead (USD)"));
  if (insights && insights.marketSplit.length > 0) {
    for (const m of insights.marketSplit) {
      lines.push(
        row(
          m.market,
          round2(m.spend),
          Math.round(m.leads),
          m.costPerLead === null ? "" : round2(m.costPerLead),
        ),
      );
    }
  } else {
    lines.push(row("Not available"));
  }

  // --- Targets & pacing ---
  lines.push("");
  lines.push(row("TARGETS & PACING"));
  lines.push(row("Metric", "Value"));
  lines.push(row("Target cost per lead (USD)", targets.targetCpl ?? ""));
  lines.push(
    row(
      "Yesterday cost per lead (USD)",
      meta && meta.yesterday.totals.costPerLead !== null
        ? round2(meta.yesterday.totals.costPerLead)
        : "",
    ),
  );
  lines.push(row("Monthly ad budget (USD)", targets.monthlyBudget ?? ""));
  if (insights?.budget) {
    lines.push(row("Spend month-to-date (USD)", round2(insights.budget.mtdSpend)));
    lines.push(
      row("Expected spend by now (USD)", round2(insights.budget.expectedToDate)),
    );
  }
  lines.push(row("Monthly lead goal", targets.monthlyLeadGoal ?? ""));
  if (insights) {
    lines.push(row("Leads month-to-date", Math.round(insights.mtdLeads)));
    lines.push(
      row(
        "Cost per lead month-to-date (USD)",
        insights.mtdCpl === null ? "" : round2(insights.mtdCpl),
      ),
    );
  }
  if (insights?.leads) {
    lines.push(
      row("Expected leads by now", Math.round(insights.leads.expectedToDate)),
    );
    if (insights.leads.impliedCplForGoal !== null) {
      lines.push(
        row(
          "CPL needed to hit goal on budget (USD)",
          round2(insights.leads.impliedCplForGoal),
        ),
      );
    }
  }

  // --- What to change today ---
  lines.push("");
  lines.push(row("WHAT TO CHANGE TODAY"));
  if (insights) {
    for (const rec of describeRecommendations(insights)) lines.push(row(rec));
  } else {
    lines.push(row("Recommendations unavailable (Meta data missing)."));
  }

  // CRLF line endings are the safest for Excel across platforms.
  return lines.join("\r\n") + "\r\n";
}
