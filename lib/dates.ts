/**
 * Timezone helpers for "yesterday in America/New_York".
 *
 * We avoid a date library (keeping dependencies minimal) and instead use the
 * built-in Intl timezone database to resolve the correct UTC instants for the
 * gym's local day — which handles EST/EDT automatically.
 */

const TIME_ZONE = "America/New_York";

/**
 * The offset (in milliseconds) of `timeZone` from UTC at a given instant.
 * For America/New_York this is -4h (EDT) or -5h (EST) depending on the date.
 */
function timeZoneOffsetMillis(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  // `hour` can come back as "24" at midnight in some environments; normalize.
  const hour = map.hour === "24" ? "00" : map.hour;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - date.getTime();
}

/** Convert a wall-clock time in America/New_York to a UTC epoch (ms). */
function etWallTimeToUtcMillis(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const offset = timeZoneOffsetMillis(TIME_ZONE, new Date(guess));
  return guess - offset;
}

export interface YesterdayRange {
  /** Start of yesterday, 00:00:00.000 ET, as a UTC epoch in milliseconds. */
  startMillis: number;
  /** End of yesterday, 23:59:59.999 ET, as a UTC epoch in milliseconds. */
  endMillis: number;
  /** Human-friendly label like "Wednesday, July 9, 2026" (ET). */
  label: string;
  /** ISO date (yesterday, ET) like "2026-07-09" — used for attachment filenames. */
  isoDate: string;
}

/**
 * Compute yesterday's date range in America/New_York, returned as UTC epoch
 * millisecond bounds (the format HubSpot's createdate filters expect).
 */
export function getYesterdayRangeET(now: Date = new Date()): YesterdayRange {
  // Today's ET calendar date.
  const todayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of todayParts) map[p.type] = p.value;

  // Step back one calendar day using a UTC anchor (safe across month/year ends).
  const anchor = new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)),
  );
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + 1;
  const d = anchor.getUTCDate();

  const startMillis = etWallTimeToUtcMillis(y, m, d, 0, 0, 0, 0);
  const endMillis = etWallTimeToUtcMillis(y, m, d, 23, 59, 59, 999);

  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(startMillis));

  const isoDate = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  return { startMillis, endMillis, label, isoDate };
}

export interface MonthProgress {
  /** Day of the month today (ET), 1-31. */
  dayOfMonth: number;
  /** Total days in the current month. */
  daysInMonth: number;
  /** dayOfMonth / daysInMonth — how far through the month we are. */
  fraction: number;
  /** e.g. "July 2026". */
  monthLabel: string;
  /** Start of the current month (00:00 ET) as a UTC epoch — for createdate filters. */
  monthStartMillis: number;
}

/**
 * How far through the current month we are, in America/New_York — used to
 * pro-rate monthly budget and lead goals ("are we on pace?").
 */
export function getMonthProgressET(now: Date = new Date()): MonthProgress {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const year = Number(map.year);
  const monthIndex = Number(map.month) - 1; // 0-based
  const dayOfMonth = Number(map.day);
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  const monthLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "long",
    year: "numeric",
  }).format(now);

  return {
    dayOfMonth,
    daysInMonth,
    fraction: dayOfMonth / daysInMonth,
    monthLabel,
    monthStartMillis: etWallTimeToUtcMillis(year, monthIndex + 1, 1, 0, 0, 0, 0),
  };
}

/**
 * UTC-midnight range for yesterday's ET calendar date. HubSpot `date`-type
 * properties (like `member_since`) store values as **midnight UTC**, so filtering
 * them by the ET epoch range would be off by the timezone offset. This returns
 * the correct range for matching a date property to "yesterday".
 */
export function getYesterdayDateRangeUTC(now: Date = new Date()): {
  startMillis: number;
  endMillis: number;
} {
  const { isoDate } = getYesterdayRangeET(now);
  const [y, m, d] = isoDate.split("-").map(Number);
  return {
    startMillis: Date.UTC(y, m - 1, d, 0, 0, 0, 0),
    endMillis: Date.UTC(y, m - 1, d, 23, 59, 59, 999),
  };
}
