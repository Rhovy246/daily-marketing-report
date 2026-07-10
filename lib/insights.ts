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

export interface ReportInsights {
  monthLabel: string;
  targetCpl: number | null;
  overallCpl: number | null;
  overTargetCampaigns: { name: string; cpl: number }[];
  overTargetAds: { name: string; campaignName: string; cpl: number }[];
  bestAd: MetaAd | null;
  worstAd: MetaAd | null;
  zeroLeadAds: { name: string; spend: number }[];
  highFrequencyAds: { name: string; frequency: number }[];
  budget: BudgetPacing | null;
  leads: LeadPacing | null;
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
    zeroLeadAds,
    highFrequencyAds,
    budget,
    leads,
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
