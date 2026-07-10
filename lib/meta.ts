import { z } from "zod";
import { fetchWithTimeout } from "@/lib/http";

// Per-request ceiling for each Meta call (they run in parallel).
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Meta (Facebook) Marketing API client.
 *
 * Fetches:
 *  - yesterday's performance at BOTH campaign level (for the overview table)
 *    and ad level (so we can rank individual creatives),
 *  - a 7-day daily-average baseline (for the ±20% flags), and
 *  - month-to-date spend + leads (for budget / lead-goal pacing).
 *
 * Lead counts come from the `actions` array; cost-per-lead is derived.
 *
 * Uses the Graph API directly via fetch (no SDK). v25.0 is the latest stable
 * version as of this writing — bump GRAPH_API_VERSION when Meta ships a newer
 * stable release (roughly twice a year; each version supported ~2 years).
 */
const GRAPH_API_VERSION = "v25.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Meta reports lead conversions under one (or both) of these action types.
const LEAD_ACTION_TYPES = new Set([
  "lead",
  "offsite_conversion.fb_pixel_lead",
]);

const CAMPAIGN_FIELDS = [
  "campaign_name",
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "actions",
];

const AD_FIELDS = [
  "ad_name",
  "campaign_name",
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "reach",
  "frequency",
  "actions",
];

const ACCOUNT_FIELDS = ["spend", "actions"];

// --- Response validation ---------------------------------------------------

const ActionSchema = z.object({
  action_type: z.string(),
  value: z.union([z.string(), z.number()]).optional(),
});

const InsightRowSchema = z.object({
  campaign_name: z.string().optional(),
  ad_name: z.string().optional(),
  spend: z.union([z.string(), z.number()]).optional(),
  impressions: z.union([z.string(), z.number()]).optional(),
  clicks: z.union([z.string(), z.number()]).optional(),
  ctr: z.union([z.string(), z.number()]).optional(),
  cpc: z.union([z.string(), z.number()]).optional(),
  reach: z.union([z.string(), z.number()]).optional(),
  frequency: z.union([z.string(), z.number()]).optional(),
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

export interface MetaAd {
  adName: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  reach: number;
  /** Average times each person saw the ad (impressions / reach). */
  frequency: number;
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

export interface MetaMonthToDate {
  spend: number;
  leads: number;
}

export interface MetaData {
  yesterday: {
    campaigns: MetaCampaign[];
    ads: MetaAd[];
    totals: MetaTotals;
  };
  /** 7-day baseline as a per-day average, for flagging yesterday vs a normal day. */
  last7dDailyAverage: MetaTotals;
  /** Spend + leads so far this calendar month, for pacing against targets. */
  monthToDate: MetaMonthToDate;
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
 * Fetch every page of insights for a given query and return the raw rows.
 * There are usually only a handful of rows, but we page defensively.
 */
async function fetchInsightRows(
  accountId: string,
  accessToken: string,
  opts: { datePreset: string; level: string; fields: string[] },
): Promise<InsightRow[]> {
  const params = new URLSearchParams({
    level: opts.level,
    date_preset: opts.datePreset,
    fields: opts.fields.join(","),
    limit: "200",
    access_token: accessToken,
  });

  let url: string | undefined = `${GRAPH_BASE}/${accountId}/insights?${params.toString()}`;
  const rows: InsightRow[] = [];
  // Bound the loop so a broken `next` cursor can never hang the request.
  let guard = 0;

  while (url && guard < 25) {
    guard += 1;
    const res = await fetchWithTimeout(url, {}, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Meta insights request failed (${res.status} ${res.statusText}) for level=${opts.level} date_preset=${opts.datePreset}: ${body.slice(0, 500)}`,
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

function rowToAd(row: InsightRow): MetaAd {
  const spend = toNumber(row.spend);
  const leads = extractLeads(row.actions);
  return {
    adName: row.ad_name ?? "(unnamed ad)",
    campaignName: row.campaign_name ?? "",
    spend,
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
    ctr: toNumber(row.ctr),
    cpc: toNumber(row.cpc),
    reach: toNumber(row.reach),
    frequency: toNumber(row.frequency),
    leads,
    costPerLead: leads > 0 ? spend / leads : null,
  };
}

function sumTotals(rows: { spend: number; impressions: number; clicks: number; leads: number }[]): MetaTotals {
  const totals = rows.reduce(
    (acc, r) => {
      acc.spend += r.spend;
      acc.impressions += r.impressions;
      acc.clicks += r.clicks;
      acc.leads += r.leads;
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
 * Fetch yesterday's campaign + ad performance, a 7-day daily-average baseline,
 * and month-to-date spend/leads. Throws on any hard failure so the caller can
 * mark Meta data unavailable while still sending the rest of the report.
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

  const [yesterdayCampaignRows, last7dRows, yesterdayAdRows, monthToDateRows] =
    await Promise.all([
      fetchInsightRows(accountId, accessToken, {
        datePreset: "yesterday",
        level: "campaign",
        fields: CAMPAIGN_FIELDS,
      }),
      fetchInsightRows(accountId, accessToken, {
        datePreset: "last_7d",
        level: "campaign",
        fields: CAMPAIGN_FIELDS,
      }),
      fetchInsightRows(accountId, accessToken, {
        datePreset: "yesterday",
        level: "ad",
        fields: AD_FIELDS,
      }),
      fetchInsightRows(accountId, accessToken, {
        datePreset: "this_month",
        level: "account",
        fields: ACCOUNT_FIELDS,
      }),
    ]);

  const campaigns = yesterdayCampaignRows.map(rowToCampaign);
  const ads = yesterdayAdRows.map(rowToAd);
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

  const monthToDate: MetaMonthToDate = {
    spend: monthToDateRows.reduce((s, r) => s + toNumber(r.spend), 0),
    leads: monthToDateRows.reduce((s, r) => s + extractLeads(r.actions), 0),
  };

  return {
    yesterday: { campaigns, ads, totals: yesterdayTotals },
    last7dDailyAverage,
    monthToDate,
  };
}
