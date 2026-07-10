import { z } from "zod";
import { getYesterdayRangeET } from "@/lib/dates";

/**
 * HubSpot CRM client.
 *
 * Pulls contacts and deals created yesterday (America/New_York) via the CRM
 * search endpoints, and counts how many contacts came from paid social so the
 * report can connect Meta ad spend to CRM leads.
 *
 * Uses the CRM v3 search API directly via fetch (no SDK). Search endpoints are
 * paginated with an `after` cursor; page sizes cap at 100.
 */
const HUBSPOT_BASE = "https://api.hubapi.com";
const PAGE_LIMIT = 100;

// Source values (lower-cased) that indicate paid social / Facebook / Instagram.
// HubSpot's canonical paid-social source is "PAID_SOCIAL"; we also catch
// free-text Facebook/Instagram/Meta hints that show up in latest-source fields.
const PAID_SOCIAL_HINTS = [
  "paid_social",
  "paid social",
  "facebook",
  "instagram",
  "meta",
  "fb",
  "ig",
];

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

const DealResultSchema = z.object({
  id: z.string(),
  properties: z.object({
    dealname: z.string().nullish(),
    amount: z.string().nullish(),
    dealstage: z.string().nullish(),
    createdate: z.string().nullish(),
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

export interface HubSpotDeal {
  id: string;
  dealName: string | null;
  amount: number | null;
  dealStage: string | null;
  createdAt: string | null;
}

export interface HubSpotData {
  /** ET label for the day the data covers, e.g. "Wednesday, July 9, 2026". */
  dateLabel: string;
  contacts: HubSpotContact[];
  deals: HubSpotDeal[];
  newContactCount: number;
  newDealCount: number;
  /** Contacts whose source indicates paid social / Facebook / Instagram. */
  paidSocialContactCount: number;
  /** Total value of deals created yesterday (sum of `amount`). */
  totalDealValue: number;
}

function isPaidSocial(contact: HubSpotContact): boolean {
  const sources = [contact.analyticsSource, contact.latestSource]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.toLowerCase());
  return sources.some((source) =>
    PAID_SOCIAL_HINTS.some((hint) => source.includes(hint)),
  );
}

/**
 * Run a paginated CRM search. `objectType` is "contacts" or "deals".
 * Returns the raw result objects across all pages.
 */
async function searchCreatedYesterday(
  objectType: "contacts" | "deals",
  properties: string[],
  token: string,
  startMillis: number,
  endMillis: number,
): Promise<unknown[]> {
  const url = `${HUBSPOT_BASE}/crm/v3/objects/${objectType}/search`;
  const results: unknown[] = [];
  let after: string | undefined;
  let guard = 0;

  do {
    guard += 1;
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "createdate",
              operator: "GTE",
              value: String(startMillis),
            },
            {
              propertyName: "createdate",
              operator: "LTE",
              value: String(endMillis),
            },
          ],
        },
      ],
      properties,
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      limit: PAGE_LIMIT,
      ...(after ? { after } : {}),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `HubSpot ${objectType} search failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`,
      );
    }

    const json = await res.json();
    const page = SearchPageSchema.parse(json);
    results.push(...page.results);
    after = page.paging?.next?.after;
  } while (after && guard < 100);

  return results;
}

function parseAmount(amount: string | null | undefined): number | null {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = parseFloat(amount);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch yesterday's new contacts and deals from HubSpot. Throws on any hard
 * failure so the caller can catch it and mark HubSpot data unavailable while
 * still sending the rest of the report.
 */
export async function fetchHubSpotData(): Promise<HubSpotData> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing HUBSPOT_ACCESS_TOKEN environment variable.");
  }

  const { startMillis, endMillis, label } = getYesterdayRangeET();

  const [rawContacts, rawDeals] = await Promise.all([
    searchCreatedYesterday(
      "contacts",
      [
        "firstname",
        "lastname",
        "email",
        "hs_analytics_source",
        "hs_latest_source",
        "createdate",
      ],
      token,
      startMillis,
      endMillis,
    ),
    searchCreatedYesterday(
      "deals",
      ["dealname", "amount", "dealstage", "createdate"],
      token,
      startMillis,
      endMillis,
    ),
  ]);

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

  const deals: HubSpotDeal[] = rawDeals.map((raw) => {
    const parsed = DealResultSchema.parse(raw);
    return {
      id: parsed.id,
      dealName: parsed.properties.dealname ?? null,
      amount: parseAmount(parsed.properties.amount),
      dealStage: parsed.properties.dealstage ?? null,
      createdAt: parsed.properties.createdate ?? null,
    };
  });

  const paidSocialContactCount = contacts.filter(isPaidSocial).length;
  const totalDealValue = deals.reduce((sum, d) => sum + (d.amount ?? 0), 0);

  return {
    dateLabel: label,
    contacts,
    deals,
    newContactCount: contacts.length,
    newDealCount: deals.length,
    paidSocialContactCount,
    totalDealValue,
  };
}
