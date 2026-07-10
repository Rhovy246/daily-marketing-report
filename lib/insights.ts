import type { MetaData, MetaAd } from "@/lib/meta";
import type { HubSpotData } from "@/lib/hubspot";
import type { Targets } from "@/lib/config";
import type { MonthProgress } from "@/lib/dates";
import { formatDecimal, formatInt, formatMoney } from "@/lib/format";

/**
 * Computes deterministic, data-grounded insights: which ads/campaigns are over
 * the cost-per-lead target, best/worst performers, wasted spend, ad-fatigue
 * risk, and budget/lead pacing. These feed the PDF and CSV directly, and are
 * also handed to Claude so the email's written recommendations stay consistent
 * with the numbers.
 */

// An ad shown to the same person this many times a day risks ad fatigue.
const FREQUENCY_FATIGUE_THRESHOLD = 3;
// Ignore trivial spend when flagging "spent money, got no leads".
const ZERO_LEAD_MIN_SPEND = 5;

/** The full input every report artifact (PDF, CSV) is built from. */
export interface ReportArtifactInput {
  dateLabel: string;
  meta: MetaData | null;
  hubspot: HubSpotData | null;
  insights: ReportInsights | null;
  targets: Targets;
}

export interface BudgetPacing {
  monthlyBudget: number;
  mtdSpend: number;
  expectedToDate: number;
  /** (mtdSpend - expectedToDate) / expectedToDate. Positive = spending ahead. */
  overUnderPct: number;
}

export interface LeadPacing {
  goal: number;
  mtdLeads: number;
  expectedToDate: number;
  /** monthlyBudget / goal — the CPL you'd need to hit the goal on budget. */
  impliedCplForGoal: number | null;
}

/** Spend/leads for one location (Miami / Fort Lauderdale / Other). */
export interface MarketSplitRow {
  market: string;
  spend: number;
  leads: number;
  costPerLead: number | null;
}

export interface ReportInsights {
  monthLabel: string;
  targetCpl: number | null;
  overallCpl: number | null;
  overTargetCampaigns: { name: string; cpl: number }[];
  overTargetAds: { name: string; campaignName: string; cpl: number }[];
  bestAd: MetaAd | null;
  worstAd: MetaAd | null;
  /** Top lead-driving ads yesterday (most leads first), for an at-a-glance list. */
  topAds: MetaAd[];
  zeroLeadAds: { name: string; spend: number }[];
  highFrequencyAds: { name: string; frequency: number }[];
  /** Spend/leads split by location, derived from MIA/FTL in ad & campaign names. */
  marketSplit: MarketSplitRow[];
  budget: BudgetPacing | null;
  leads: LeadPacing | null;
  /** Month-to-date cost per lead (spend / leads so far this month). */
  mtdCpl: number | null;
  mtdSpend: number;
  mtdLeads: number;
}

type Market = "Miami" | "Fort Lauderdale" | "Other";

/**
 * Classify a campaign/ad name to a location. "MIA & FTL" (both present) is
 * treated as Other rather than guessed — ad-level names disambiguate it.
 */
function marketFromString(s: string): Market {
  const n = s.toUpperCase();
  const isFtl = n.includes("FTL") || n.includes("FORT LAUDERDALE");
  const isMia = n.includes("MIA") || n.includes("MIAMI");
  if (isFtl && !isMia) return "Fort Lauderdale";
  if (isMia && !isFtl) return "Miami";
  return "Other";
}

function classifyAdMarket(ad: MetaAd): Market {
  const fromAd = marketFromString(ad.adName);
  return fromAd !== "Other" ? fromAd : marketFromString(ad.campaignName);
}

function computeMarketSplit(ads: MetaAd[]): MarketSplitRow[] {
  const buckets = new Map<Market, { spend: number; leads: number }>();
  for (const ad of ads) {
    const market = classifyAdMarket(ad);
    const b = buckets.get(market) ?? { spend: 0, leads: 0 };
    b.spend += ad.spend;
    b.leads += ad.leads;
    buckets.set(market, b);
  }
  const order: Market[] = ["Miami", "Fort Lauderdale", "Other"];
  return order
    .filter((m) => buckets.has(m))
    .map((m) => {
      const b = buckets.get(m) as { spend: number; leads: number };
      return {
        market: m,
        spend: b.spend,
        leads: b.leads,
        costPerLead: b.leads > 0 ? b.spend / b.leads : null,
      };
    });
}

export function computeInsights(
  meta: MetaData,
  targets: Targets,
  month: MonthProgress,
): ReportInsights {
  const { campaigns, ads, totals } = meta.yesterday;
  const target = targets.targetCpl;

  const overTargetCampaigns =
    target !== null
      ? campaigns
          .filter((c) => c.costPerLead !== null && c.costPerLead > target)
          .map((c) => ({ name: c.campaignName, cpl: c.costPerLead as number }))
          .sort((a, b) => b.cpl - a.cpl)
      : [];

  const overTargetAds =
    target !== null
      ? ads
          .filter((a) => a.costPerLead !== null && a.costPerLead > target)
          .map((a) => ({
            name: a.adName,
            campaignName: a.campaignName,
            cpl: a.costPerLead as number,
          }))
          .sort((a, b) => b.cpl - a.cpl)
      : [];

  const adsWithLeads = ads.filter((a) => a.leads > 0 && a.costPerLead !== null);
  // "Best" = the proven workhorse: the ad that drove the most leads, with a tie
  // broken by lower cost per lead. This avoids crowning a low-volume ad that
  // happens to have the cheapest cost per lead on one or two leads.
  const bestAd = adsWithLeads.length
    ? adsWithLeads.reduce((best, a) => {
        if (a.leads !== best.leads) return a.leads > best.leads ? a : best;
        return (a.costPerLead as number) < (best.costPerLead as number) ? a : best;
      })
    : null;
  const worstAd = adsWithLeads.length
    ? adsWithLeads.reduce((worst, a) =>
        (a.costPerLead as number) > (worst.costPerLead as number) ? a : worst,
      )
    : null;

  const topAds = [...adsWithLeads]
    .sort(
      (a, b) =>
        b.leads - a.leads ||
        (a.costPerLead as number) - (b.costPerLead as number),
    )
    .slice(0, 5);

  const zeroLeadAds = ads
    .filter((a) => a.leads === 0 && a.spend >= ZERO_LEAD_MIN_SPEND)
    .map((a) => ({ name: a.adName, spend: a.spend }))
    .sort((a, b) => b.spend - a.spend);

  const highFrequencyAds = ads
    .filter((a) => a.frequency >= FREQUENCY_FATIGUE_THRESHOLD)
    .map((a) => ({ name: a.adName, frequency: a.frequency }))
    .sort((a, b) => b.frequency - a.frequency);

  const budget: BudgetPacing | null = targets.monthlyBudget
    ? {
        monthlyBudget: targets.monthlyBudget,
        mtdSpend: meta.monthToDate.spend,
        expectedToDate: targets.monthlyBudget * month.fraction,
        overUnderPct:
          targets.monthlyBudget * month.fraction > 0
            ? (meta.monthToDate.spend - targets.monthlyBudget * month.fraction) /
              (targets.monthlyBudget * month.fraction)
            : 0,
      }
    : null;

  const leads: LeadPacing | null = targets.monthlyLeadGoal
    ? {
        goal: targets.monthlyLeadGoal,
        mtdLeads: meta.monthToDate.leads,
        expectedToDate: targets.monthlyLeadGoal * month.fraction,
        impliedCplForGoal:
          targets.monthlyBudget !== null
            ? targets.monthlyBudget / targets.monthlyLeadGoal
            : null,
      }
    : null;

  return {
    monthLabel: month.monthLabel,
    targetCpl: target,
    overallCpl: totals.costPerLead,
    overTargetCampaigns,
    overTargetAds,
    bestAd,
    worstAd,
    topAds,
    zeroLeadAds,
    highFrequencyAds,
    marketSplit: computeMarketSplit(ads),
    budget,
    leads,
    mtdCpl:
      meta.monthToDate.leads > 0
        ? meta.monthToDate.spend / meta.monthToDate.leads
        : null,
    mtdSpend: meta.monthToDate.spend,
    mtdLeads: meta.monthToDate.leads,
  };
}

/**
 * Turn insights into a prioritized list of plain-English recommendation lines
 * (used verbatim in the PDF and CSV). The email's version is written by Claude
 * from the same underlying insights.
 */
export function describeRecommendations(insights: ReportInsights): string[] {
  // Concrete actions only. Budget / lead pacing lives in the "Targets & pacing"
  // section, so it is deliberately NOT restated here.
  const out: string[] = [];

  // Scale the proven workhorse first — it's the most useful action.
  if (insights.bestAd && insights.bestAd.costPerLead !== null) {
    const a = insights.bestAd;
    out.push(
      `Scale "${a.adName}" — your top lead driver yesterday (${formatInt(a.leads)} ${a.leads === 1 ? "lead" : "leads"} at ${formatMoney(a.costPerLead as number)} each). Consider shifting budget toward it.`,
    );
  }

  if (insights.targetCpl !== null && insights.overTargetAds.length > 0) {
    const a = insights.overTargetAds[0];
    out.push(
      `Refresh or trim "${a.name}" — at ${formatMoney(a.cpl)} per lead it's over your ${formatMoney(insights.targetCpl)} target.`,
    );
  }

  for (const a of insights.zeroLeadAds.slice(0, 2)) {
    out.push(
      `Pause or refresh "${a.name}" — it spent ${formatMoney(a.spend)} yesterday with no leads.`,
    );
  }

  if (insights.highFrequencyAds.length > 0) {
    const a = insights.highFrequencyAds[0];
    out.push(
      `Refresh the creative on "${a.name}" — it's being shown about ${formatDecimal(a.frequency, 1)}x per person (ad-fatigue risk) and costs tend to climb from here.`,
    );
  }

  if (out.length === 0) {
    out.push(
      "Nothing to change today — every ad is within your targets and pacing looks healthy.",
    );
  }

  return out;
}
