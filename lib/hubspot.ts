import { z } from "zod";
import { getYesterdayRangeET, getYesterdayDateRangeUTC } from "@/lib/dates";
import { fetchWithTimeout } from "@/lib/http";

/**
 * HubSpot CRM client.
 *
 * Pulls ONE thing: how many people became members yesterday, and how many of
 * them originally came from paid social — the reliable ad -> member ROI signal.
 *
 * It uses `member_since` (a real join event) rather than HubSpot's `createdate`.
 * Create Date proved unreliable in this account (a Salesforce sync re-creates
 * records, stamping today's date on months-old leads), so all Create Date–based
 * "new lead / new contact" metrics were removed rather than ship numbers we
 * can't trust.
 *
 * Only needs the `crm.objects.contacts.read` scope. Uses the CRM v3 search API
 * directly via fetch (no SDK).
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

const MemberResultSchema = z.object({
  id: z.string(),
  properties: z.object({
    hs_analytics_source: z.string().nullish(),
    hs_latest_source: z.string().nullish(),
    member_since: z.string().nullish(),
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

export interface NewMembers {
  total: number;
  fromPaidSocial: number;
}

export interface HubSpotData {
  dateLabel: string;
  /** People who became members yesterday (by `member_since`) + ad-sourced share. */
  newMembers: NewMembers;
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

export async function fetchHubSpotData(): Promise<HubSpotData> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing HUBSPOT_ACCESS_TOKEN environment variable.");
  }

  const { label } = getYesterdayRangeET();
  // member_since is a date property -> match against the UTC-midnight day range.
  const memberDay = getYesterdayDateRangeUTC();

  const rawMembers = await searchContacts(
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
  );

  const members = rawMembers.map((raw) => MemberResultSchema.parse(raw));
  const newMembers: NewMembers = {
    total: members.length,
    fromPaidSocial: members.filter((m) =>
      sourceIsPaidSocial(
        m.properties.hs_analytics_source,
        m.properties.hs_latest_source,
      ),
    ).length,
  };

  return {
    dateLabel: label,
    newMembers,
  };
}
