import { z } from "zod";

/**
 * Meta (Facebook) Marketing API client.
 *
 * Fetches campaign-level ad insights for yesterday plus a 7-day baseline,
 * extracts lead counts from the `actions` array, and computes cost-per-lead.
 *
 * Uses the Graph API directly via fetch (no SDK). v25.0 is the latest stable
 * version as of this writing — bump GRAPH_API_VERSION when Meta ships a newer
 * stable release (they do roughly twice a year; each version is supported for
 * ~2 years).
 */
const GRAPH_API_VERSION = "v25.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Meta reports lead conversions under one (or both) of these action types.
const LEAD_ACTION_TYPES = new Set([
  "lead",
  "offsite_conversion.fb_pixel_lead",
]);

// --- Response validation ---------------------------------------------------
// APIs return surprises: numeric fields arrive as strings, `actions` may be
// absent, and paging may or may not be present. Keep the schema permissive and
// narrow the numbers ourselves.

const ActionSchema = z.object({
  action_type: z.string(),
  value: z.union([z.string(), z.number()]).optional(),
});

const InsightRowSchema = z.object({
  campaign_name: z.string().optional(),
  spend: z.union([z.string(), z.number()]).optional(),
  impressions: z.union([z.string(), z.number()]).optional(),
  clicks: z.union([z.string(), z.number()]).optional(),
  ctr: z.union([z.string(), z.number()]).optional(),
  cpc: z.union([z.string(), z.number()]).optional(),
  actions: z.array(ActionSchema).optional(),
});

const InsightsPageSchema = z.object({
  data: z.array(InsightRowSchema),
  paging: z
    .object({
      next: z.string().optional(),
    })
    .optional(),
});

type InsightRow = z.infer<typeof InsightRowSchema>;

// --- Shapes we hand to the analyzer ---------------------------------------

export interface MetaCampaign {
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  leads: number;
  costPerLead: number | null;
}

export interface MetaTotals {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  costPerLead: number | null;
}

export interface MetaData {
  yesterday: {
    campaigns: MetaCampaign[];
    totals: MetaTotals;
  };
  /**
   * 7-day baseline expressed as a per-day average, so the analyzer can flag
   * yesterday's numbers against a normal day.
   */
  last7dDailyAverage: MetaTotals;
}

function toNumber(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function extractLeads(actions: InsightRow["actions"]): number {
  if (!actions) return 0;
  let total = 0;
  for (const action of actions) {
    if (LEAD_ACTION_TYPES.has(action.action_type)) {
      total += toNumber(action.value);
    }
  }
  return total;
}

function normalizeAccountId(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

/**
 * Fetch every page of insights for a given date_preset and return the raw rows.
 * There are usually only a handful of campaigns, but we page defensively.
 */
async function fetchInsightRows(
  accountId: string,
  accessToken: string,
  datePreset: string,
): Promise<InsightRow[]> {
  const fields = [
    "campaign_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "actions",
  ].join(",");

  const params = new URLSearchParams({
    level: "campaign",
    date_preset: datePreset,
    fields,
    limit: "100",
    access_token: accessToken,
  });

  let url: string | undefined = `${GRAPH_BASE}/${accountId}/insights?${params.toString()}`;
  const rows: InsightRow[] = [];
  // Bound the loop so a broken `next` cursor can never hang the request.
  let guard = 0;

  while (url && guard < 25) {
    guard += 1;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Meta insights request failed (${res.status} ${res.statusText}) for date_preset=${datePreset}: ${body.slice(0, 500)}`,
      );
    }

    const json = await res.json();
    const page = InsightsPageSchema.parse(json);
    rows.push(...page.data);
    url = page.paging?.next;
  }

  return rows;
}

function rowToCampaign(row: InsightRow): MetaCampaign {
  const spend = toNumber(row.spend);
  const leads = extractLeads(row.actions);
  return {
    campaignName: row.campaign_name ?? "(unnamed campaign)",
    spend,
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
    ctr: toNumber(row.ctr),
    cpc: toNumber(row.cpc),
    leads,
    costPerLead: leads > 0 ? spend / leads : null,
  };
}

function sumTotals(campaigns: MetaCampaign[]): MetaTotals {
  const totals = campaigns.reduce(
    (acc, c) => {
      acc.spend += c.spend;
      acc.impressions += c.impressions;
      acc.clicks += c.clicks;
      acc.leads += c.leads;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, leads: 0 },
  );
  return {
    ...totals,
    costPerLead: totals.leads > 0 ? totals.spend / totals.leads : null,
  };
}

/**
 * Fetch yesterday's campaign performance plus a 7-day daily-average baseline.
 * Throws on any hard failure so the caller can catch it and mark Meta data
 * unavailable while still sending the rest of the report.
 */
export async function fetchMetaData(): Promise<MetaData> {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const rawAccountId = process.env.META_AD_ACCOUNT_ID;

  if (!accessToken || !rawAccountId) {
    throw new Error(
      "Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID environment variable.",
    );
  }

  const accountId = normalizeAccountId(rawAccountId);

  const [yesterdayRows, last7dRows] = await Promise.all([
    fetchInsightRows(accountId, accessToken, "yesterday"),
    fetchInsightRows(accountId, accessToken, "last_7d"),
  ]);

  const campaigns = yesterdayRows.map(rowToCampaign);
  const yesterdayTotals = sumTotals(campaigns);

  const last7dTotals = sumTotals(last7dRows.map(rowToCampaign));
  const last7dDailyAverage: MetaTotals = {
    spend: last7dTotals.spend / 7,
    impressions: last7dTotals.impressions / 7,
    clicks: last7dTotals.clicks / 7,
    leads: last7dTotals.leads / 7,
    costPerLead:
      last7dTotals.leads > 0 ? last7dTotals.spend / last7dTotals.leads : null,
  };

  return {
    yesterday: { campaigns, totals: yesterdayTotals },
    last7dDailyAverage,
  };
}
