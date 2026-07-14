import { z } from "zod";
import {
  getYesterdayRangeET,
  getYesterdayDateRangeUTC,
  getMonthProgressET,
} from "@/lib/dates";
import { fetchWithTimeout } from "@/lib/http";

/**
 * HubSpot CRM client.
 *
 * Pulls three things:
 *  - contacts created yesterday (new leads + paid-social attribution + the
 *    follow-up list),
 *  - new members yesterday (contacts whose `member_since` date is yesterday) and
 *    how many came from paid social — the ad -> member ROI signal,
 *  - the paid-social lead -> member conversion funnel for the current month.
 *
 * Deals are intentionally NOT fetched (Powerhouse doesn't track them), so the
 * app only needs the `crm.objects.contacts.read` scope.
 *
 * Uses the CRM v3 search API directly via fetch (no SDK). Search endpoints are
 * paginated with an `after` cursor; page sizes cap at 100.
 */
const HUBSPOT_BASE = "https://api.hubapi.com";
const PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 20000;

// Source values (lower-cased) that indicate paid social / Facebook / Instagram.
const PAID_SOCIAL_HINTS = [
  "paid_social",
  "paid social",
  "facebook",
  "instagram",
  "meta",
  "fb",
  "ig",
];

// HubSpot values that mean "this contact became a member".
const MEMBER_LIFECYCLE_STAGE = "customer"; // "Member" maps to lifecyclestage "customer"
// Lead statuses that mean the person physically came in (front-desk check-in is
// auto-recorded as "Visited"; a member has visited too).
const VISITED_LEAD_STATUSES = new Set(["Visited", "Converted to Member"]);

// --- Response validation ---------------------------------------------------

const ContactResultSchema = z.object({
  id: z.string(),
  properties: z.object({
    firstname: z.string().nullish(),
    lastname: z.string().nullish(),
    email: z.string().nullish(),
    hs_analytics_source: z.string().nullish(),
    hs_latest_source: z.string().nullish(),
    createdate: z.string().nullish(),
  }),
});

const MemberResultSchema = z.object({
  id: z.string(),
  properties: z.object({
    hs_analytics_source: z.string().nullish(),
    hs_latest_source: z.string().nullish(),
    member_since: z.string().nullish(),
  }),
});

const FunnelResultSchema = z.object({
  id: z.string(),
  properties: z.object({
    lifecyclestage: z.string().nullish(),
    hs_lead_status: z.string().nullish(),
  }),
});

const SearchPageSchema = z.object({
  total: z.number().optional(),
  results: z.array(z.unknown()),
  paging: z
    .object({
      next: z.object({ after: z.string() }).optional(),
    })
    .optional(),
});

// --- Shapes we hand to the analyzer ---------------------------------------

export interface HubSpotContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  analyticsSource: string | null;
  latestSource: string | null;
  createdAt: string | null;
}

export interface NewMembers {
  total: number;
  fromPaidSocial: number;
}

export interface PaidSocialFunnel {
  monthLabel: string;
  /** Paid-social leads created this month. */
  leads: number;
  /** …of which, how many have visited (front-desk check-in) or beyond. */
  visited: number;
  /** …of which, how many became members. */
  members: number;
}

export interface HubSpotData {
  dateLabel: string;
  contacts: HubSpotContact[];
  newContactCount: number;
  paidSocialContactCount: number;
  /** People who became members yesterday (by `member_since`) + ad-sourced share. */
  newMembers: NewMembers;
  /** This-month paid-social lead -> visited -> member conversion. */
  paidSocialFunnel: PaidSocialFunnel;
}

function sourceIsPaidSocial(
  analyticsSource: string | null | undefined,
  latestSource: string | null | undefined,
): boolean {
  const sources = [analyticsSource, latestSource]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.toLowerCase());
  return sources.some((source) =>
    PAID_SOCIAL_HINTS.some((hint) => source.includes(hint)),
  );
}

/**
 * Run a paginated CRM contacts search with the given filter groups + properties.
 * Returns the raw result objects across all pages.
 */
async function searchContacts(
  filterGroups: unknown[],
  properties: string[],
  token: string,
): Promise<unknown[]> {
  const url = `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`;
  const results: unknown[] = [];
  let after: string | undefined;
  let guard = 0;

  do {
    guard += 1;
    const body: Record<string, unknown> = {
      filterGroups,
      properties,
      limit: PAGE_LIMIT,
      ...(after ? { after } : {}),
    };

    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS,
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `HubSpot contacts search failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`,
      );
    }

    const json = await res.json();
    const page = SearchPageSchema.parse(json);
    results.push(...page.results);
    after = page.paging?.next?.after;
  } while (after && guard < 200);

  return results;
}

function createdateBetween(startMillis: number, endMillis: number) {
  return [
    { propertyName: "createdate", operator: "GTE", value: String(startMillis) },
    { propertyName: "createdate", operator: "LTE", value: String(endMillis) },
  ];
}

export async function fetchHubSpotData(): Promise<HubSpotData> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing HUBSPOT_ACCESS_TOKEN environment variable.");
  }

  const { startMillis, endMillis, label } = getYesterdayRangeET();
  const memberDay = getYesterdayDateRangeUTC();
  const month = getMonthProgressET();

  const [rawContacts, rawMembers, rawFunnel] = await Promise.all([
    // 1. New leads created yesterday (for the count + follow-up list).
    searchContacts(
      [{ filters: createdateBetween(startMillis, endMillis) }],
      [
        "firstname",
        "lastname",
        "email",
        "hs_analytics_source",
        "hs_latest_source",
        "createdate",
      ],
      token,
    ),
    // 2. New members yesterday (member_since is a date property -> UTC-day range).
    searchContacts(
      [
        {
          filters: [
            {
              propertyName: "member_since",
              operator: "GTE",
              value: String(memberDay.startMillis),
            },
            {
              propertyName: "member_since",
              operator: "LTE",
              value: String(memberDay.endMillis),
            },
          ],
        },
      ],
      ["hs_analytics_source", "hs_latest_source", "member_since"],
      token,
    ),
    // 3. Paid-social leads created this month (for the conversion funnel).
    //    Two OR'd groups: paid social can be recorded on either source field.
    searchContacts(
      [
        {
          filters: [
            { propertyName: "createdate", operator: "GTE", value: String(month.monthStartMillis) },
            { propertyName: "hs_analytics_source", operator: "EQ", value: "PAID_SOCIAL" },
          ],
        },
        {
          filters: [
            { propertyName: "createdate", operator: "GTE", value: String(month.monthStartMillis) },
            { propertyName: "hs_latest_source", operator: "EQ", value: "PAID_SOCIAL" },
          ],
        },
      ],
      ["lifecyclestage", "hs_lead_status"],
      token,
    ),
  ]);

  // --- Leads created yesterday ---
  const contacts: HubSpotContact[] = rawContacts.map((raw) => {
    const parsed = ContactResultSchema.parse(raw);
    return {
      id: parsed.id,
      firstName: parsed.properties.firstname ?? null,
      lastName: parsed.properties.lastname ?? null,
      email: parsed.properties.email ?? null,
      analyticsSource: parsed.properties.hs_analytics_source ?? null,
      latestSource: parsed.properties.hs_latest_source ?? null,
      createdAt: parsed.properties.createdate ?? null,
    };
  });
  const paidSocialContactCount = contacts.filter((c) =>
    sourceIsPaidSocial(c.analyticsSource, c.latestSource),
  ).length;

  // --- New members yesterday ---
  const members = rawMembers.map((raw) => MemberResultSchema.parse(raw));
  const newMembers: NewMembers = {
    total: members.length,
    fromPaidSocial: members.filter((m) =>
      sourceIsPaidSocial(m.properties.hs_analytics_source, m.properties.hs_latest_source),
    ).length,
  };

  // --- Paid-social conversion funnel (this month) ---
  const funnelRows = rawFunnel.map((raw) => FunnelResultSchema.parse(raw));
  let visited = 0;
  let membersInFunnel = 0;
  for (const row of funnelRows) {
    const isMember = row.properties.lifecyclestage === MEMBER_LIFECYCLE_STAGE;
    const isVisited =
      isMember ||
      (row.properties.hs_lead_status
        ? VISITED_LEAD_STATUSES.has(row.properties.hs_lead_status)
        : false);
    if (isVisited) visited += 1;
    if (isMember) membersInFunnel += 1;
  }
  const paidSocialFunnel: PaidSocialFunnel = {
    monthLabel: month.monthLabel,
    leads: funnelRows.length,
    visited,
    members: membersInFunnel,
  };

  return {
    dateLabel: label,
    contacts,
    newContactCount: contacts.length,
    paidSocialContactCount,
    newMembers,
    paidSocialFunnel,
  };
}
