import type { MetaData } from "@/lib/meta";
import type { HubSpotData } from "@/lib/hubspot";

/**
 * Shared formatting helpers and the ±20%-vs-baseline flag computation, used by
 * both the CSV and PDF report builders so the two attachments stay consistent
 * with each other (and with the email).
 */

/** The data both attachment builders need. Either source may be unavailable. */
export interface ReportArtifactInput {
  dateLabel: string;
  meta: MetaData | null;
  hubspot: HubSpotData | null;
}

export function formatMoney(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function formatDecimal(n: number, places = 1): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

export function formatCostPerLead(n: number | null): string {
  return n === null ? "—" : formatMoney(n);
}

/** Meta's `ctr` is already a percentage value (e.g. 1.23 means 1.23%). */
export function formatCtr(n: number): string {
  return `${n.toFixed(2)}%`;
}

/** Round a number to 2 decimals as a *number* (for spreadsheet cells). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface Flag {
  metric: string;
  direction: "up" | "down";
  /** Absolute fractional change, e.g. 0.34 for a 34% move. */
  pct: number;
  yesterday: number;
  average: number;
}

/**
 * Compare yesterday's spend, leads, and cost-per-lead to the 7-day daily
 * average and return anything that moved by 20% or more. Metrics with a zero
 * baseline are skipped (no meaningful percentage).
 */
export function computeFlags(meta: MetaData): Flag[] {
  const y = meta.yesterday.totals;
  const a = meta.last7dDailyAverage;
  const flags: Flag[] = [];

  const check = (metric: string, yv: number, av: number) => {
    if (av <= 0) return;
    const pct = (yv - av) / av;
    if (Math.abs(pct) >= 0.2) {
      flags.push({
        metric,
        direction: pct >= 0 ? "up" : "down",
        pct: Math.abs(pct),
        yesterday: yv,
        average: av,
      });
    }
  };

  check("Spend", y.spend, a.spend);
  check("Leads", y.leads, a.leads);
  if (y.costPerLead !== null && a.costPerLead !== null) {
    check("Cost per lead", y.costPerLead, a.costPerLead);
  }

  return flags;
}

export function describeFlag(flag: Flag): string {
  return `${flag.metric} is ${flag.direction} ${Math.round(
    flag.pct * 100,
  )}% versus the 7-day daily average.`;
}
