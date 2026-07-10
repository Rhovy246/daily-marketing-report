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
  const bestAd = adsWithLeads.length
    ? adsWithLeads.reduce((best, a) =>
        (a.costPerLead as number) < (best.costPerLead as number) ? a : best,
      )
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
  const out: string[] = [];

  if (insights.budget) {
    const { mtdSpend, monthlyBudget, overUnderPct } = insights.budget;
    const pct = Math.round(Math.abs(overUnderPct) * 100);
    const pace =
      overUnderPct > 0.05
        ? `about ${pct}% ahead of an even pace`
        : overUnderPct < -0.05
          ? `about ${pct}% behind an even pace`
          : "on an even pace";
    out.push(
      `Budget: ${formatMoney(mtdSpend)} of ${formatMoney(monthlyBudget)} spent this month (${insights.monthLabel}) — ${pace}.`,
    );
  }

  if (insights.leads) {
    const { mtdLeads, goal, expectedToDate, impliedCplForGoal } = insights.leads;
    out.push(
      `Leads: ${formatInt(mtdLeads)} so far this month toward a goal of ${formatInt(goal)} (about ${formatInt(expectedToDate)} expected by now).`,
    );
    if (impliedCplForGoal !== null) {
      out.push(
        `Reaching ${formatInt(goal)} leads on the monthly budget would need about ${formatMoney(impliedCplForGoal)} per lead — focus on efficiency and lead quality rather than simply spending more.`,
      );
    }
  }

  if (insights.targetCpl !== null && insights.overTargetAds.length > 0) {
    const a = insights.overTargetAds[0];
    out.push(
      `"${a.name}" is over your ${formatMoney(insights.targetCpl)} target at ${formatMoney(a.cpl)} per lead — refresh the creative or trim its budget.`,
    );
  }

  for (const a of insights.zeroLeadAds.slice(0, 2)) {
    out.push(
      `"${a.name}" spent ${formatMoney(a.spend)} yesterday with no leads — consider pausing or refreshing it.`,
    );
  }

  if (insights.bestAd && insights.bestAd.costPerLead !== null) {
    out.push(
      `"${insights.bestAd.adName}" is your best performer at ${formatMoney(insights.bestAd.costPerLead)} per lead — consider shifting budget toward it.`,
    );
  }

  if (insights.highFrequencyAds.length > 0) {
    const a = insights.highFrequencyAds[0];
    out.push(
      `"${a.name}" is being shown about ${formatDecimal(a.frequency, 1)}x per person (ad-fatigue risk) — refresh the creative before costs climb.`,
    );
  }

  if (out.length === 0) {
    out.push(
      "Nothing to change today — performance is within your targets and on an even pace.",
    );
  }

  return out;
}
