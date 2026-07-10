/**
 * Optional performance targets, read from environment variables so they can be
 * changed in the Vercel dashboard without touching code. Any that are unset (or
 * not a positive number) are treated as null, and the report simply skips the
 * advice that depends on them.
 */
export interface Targets {
  /** Target cost per lead in USD, e.g. 10. */
  targetCpl: number | null;
  /** Monthly lead goal, e.g. 1000. */
  monthlyLeadGoal: number | null;
  /** Total monthly ad budget in USD, e.g. 6500. */
  monthlyBudget: number | null;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getTargets(): Targets {
  return {
    targetCpl: parsePositiveNumber(process.env.TARGET_CPL),
    monthlyLeadGoal: parsePositiveNumber(process.env.MONTHLY_LEAD_GOAL),
    monthlyBudget: parsePositiveNumber(process.env.MONTHLY_AD_BUDGET),
  };
}
