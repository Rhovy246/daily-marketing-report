import { PDFDocument, StandardFonts, rgb, type PDFFont, type RGB } from "pdf-lib";
import {
  computeFlags,
  describeFlag,
  formatCostPerLead,
  formatCtr,
  formatInt,
  formatMoney,
  type ReportArtifactInput,
} from "@/lib/format";

/**
 * Builds the PDF attachment — a clean, printable one/two-page document.
 *
 * Rendered programmatically with pdf-lib (pure JS, no headless browser), so it
 * runs reliably inside a Vercel serverless function with no cold-start or
 * timeout risk. Layout is deterministic and built from the fetched numbers.
 */

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 48;
const RIGHT_EDGE = PAGE_W - MARGIN;

const INK: RGB = rgb(0.13, 0.13, 0.15);
const MUTED: RGB = rgb(0.42, 0.42, 0.46);
const LINE: RGB = rgb(0.8, 0.8, 0.82);
const WARN_BG: RGB = rgb(1, 0.95, 0.85);
const WARN_INK: RGB = rgb(0.55, 0.36, 0.02);

export async function buildReportPdf(
  input: ReportArtifactInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN) newPage();
  };

  const drawLeft = (
    text: string,
    x: number,
    size: number,
    f: PDFFont,
    color: RGB = INK,
  ) => {
    page.drawText(text, { x, y, size, font: f, color });
  };

  const drawRight = (
    text: string,
    rightX: number,
    size: number,
    f: PDFFont,
    color: RGB = INK,
  ) => {
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: rightX - w, y, size, font: f, color });
  };

  const hline = (color: RGB = LINE) => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: RIGHT_EDGE, y },
      thickness: 0.75,
      color,
    });
  };

  const truncateToWidth = (text: string, maxWidth: number, size: number): string => {
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
    let s = text;
    while (s.length > 1 && font.widthOfTextAtSize(s + "…", size) > maxWidth) {
      s = s.slice(0, -1);
    }
    return s + "…";
  };

  // Standard fonts use WinAnsi encoding and throw on characters they can't
  // represent. Campaign names come from Meta and can contain anything, so
  // replace any unencodable character with "?" rather than lose the whole PDF.
  const safeText = (text: string, f: PDFFont): string => {
    let out = "";
    for (const ch of text) {
      try {
        f.widthOfTextAtSize(ch, 9);
        out += ch;
      } catch {
        out += "?";
      }
    }
    return out;
  };

  const wrapText = (text: string, size: number, f: PDFFont, maxWidth: number): string[] => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const attempt = current ? `${current} ${word}` : word;
      if (f.widthOfTextAtSize(attempt, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = attempt;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  const sectionHeader = (label: string) => {
    ensure(30);
    drawLeft(label, MARGIN, 12, bold);
    y -= 6;
    hline();
    y -= 16;
  };

  const paragraph = (text: string, size = 10, f: PDFFont = font, color: RGB = INK) => {
    for (const ln of wrapText(text, size, f, RIGHT_EDGE - MARGIN)) {
      ensure(size + 4);
      drawLeft(ln, MARGIN, size, f, color);
      y -= size + 4;
    }
  };

  const kv = (label: string, value: string) => {
    ensure(16);
    drawLeft(label, MARGIN, 10, font, MUTED);
    drawLeft(value, MARGIN + 200, 10, bold);
    y -= 16;
  };

  const warning = (text: string) => {
    ensure(26);
    page.drawRectangle({
      x: MARGIN,
      y: y - 16,
      width: RIGHT_EDGE - MARGIN,
      height: 22,
      color: WARN_BG,
    });
    drawLeft(`!  ${text}`, MARGIN + 8, 10, bold, WARN_INK);
    y -= 34;
  };

  const { meta, hubspot, dateLabel } = input;

  // --- Header ---
  drawLeft("Powerhouse Gym", MARGIN, 18, bold);
  y -= 22;
  drawLeft("Daily Marketing Report", MARGIN, 13, font, MUTED);
  y -= 16;
  drawLeft(dateLabel, MARGIN, 11, font, MUTED);
  y -= 22;

  if (!meta) warning("Meta ad data unavailable for this report.");
  if (!hubspot) warning("HubSpot CRM data unavailable for this report.");

  // --- Topline ---
  sectionHeader("Topline");
  if (meta) {
    const t = meta.yesterday.totals;
    kv("Total ad spend", formatMoney(t.spend));
    kv("Total leads", formatInt(t.leads));
    kv("Cost per lead", formatCostPerLead(t.costPerLead));
  } else {
    kv("Meta ad data", "Unavailable");
  }
  if (hubspot) {
    kv("New contacts", formatInt(hubspot.newContactCount));
    kv("New deals", formatInt(hubspot.newDealCount));
    kv("Contacts from paid social", formatInt(hubspot.paidSocialContactCount));
    kv("Total deal value", formatMoney(hubspot.totalDealValue));
  } else {
    kv("HubSpot CRM data", "Unavailable");
  }
  y -= 8;

  // --- Campaign table ---
  sectionHeader("Campaigns (yesterday)");
  if (meta) {
    // Right edges for numeric columns; campaign name is left-aligned.
    const cols = {
      spend: 322,
      leads: 378,
      cpl: 448,
      clicks: 506,
      ctr: RIGHT_EDGE,
    };
    const nameMaxWidth = cols.spend - MARGIN - 55;

    const headerRow = () => {
      ensure(18);
      drawLeft("Campaign", MARGIN, 9, bold, MUTED);
      drawRight("Spend", cols.spend, 9, bold, MUTED);
      drawRight("Leads", cols.leads, 9, bold, MUTED);
      drawRight("Cost/Lead", cols.cpl, 9, bold, MUTED);
      drawRight("Clicks", cols.clicks, 9, bold, MUTED);
      drawRight("CTR", cols.ctr, 9, bold, MUTED);
      y -= 12;
      hline();
      y -= 12;
    };

    headerRow();

    if (meta.yesterday.campaigns.length === 0) {
      paragraph("No campaign activity yesterday.", 10, font, MUTED);
    } else {
      for (const c of meta.yesterday.campaigns) {
        ensure(16);
        if (y === PAGE_H - MARGIN) headerRow(); // repeat header after a page break
        drawLeft(
          truncateToWidth(safeText(c.campaignName, font), nameMaxWidth, 9),
          MARGIN,
          9,
          font,
        );
        drawRight(formatMoney(c.spend), cols.spend, 9, font);
        drawRight(formatInt(c.leads), cols.leads, 9, font);
        drawRight(formatCostPerLead(c.costPerLead), cols.cpl, 9, font);
        drawRight(formatInt(c.clicks), cols.clicks, 9, font);
        drawRight(formatCtr(c.ctr), cols.ctr, 9, font);
        y -= 15;
      }
      // Totals row
      ensure(20);
      y -= 2;
      hline();
      y -= 13;
      const t = meta.yesterday.totals;
      drawLeft("Total", MARGIN, 9, bold);
      drawRight(formatMoney(t.spend), cols.spend, 9, bold);
      drawRight(formatInt(t.leads), cols.leads, 9, bold);
      drawRight(formatCostPerLead(t.costPerLead), cols.cpl, 9, bold);
      drawRight(formatInt(t.clicks), cols.clicks, 9, bold);
      y -= 15;
    }
  } else {
    paragraph("Meta ad data unavailable for this report.", 10, font, MUTED);
  }
  y -= 10;

  // --- Funnel ---
  sectionHeader("Funnel");
  const spendStr = meta ? formatMoney(meta.yesterday.totals.spend) : "n/a";
  const leadsStr = meta ? formatInt(meta.yesterday.totals.leads) : "n/a";
  const paidStr = hubspot ? formatInt(hubspot.paidSocialContactCount) : "n/a";
  paragraph(
    `Meta ad spend ${spendStr}  ->  Meta leads ${leadsStr}  ->  HubSpot contacts from paid social ${paidStr}`,
  );
  y -= 10;

  // --- Flags ---
  sectionHeader("Flags vs 7-day average");
  if (meta) {
    const flags = computeFlags(meta);
    if (flags.length === 0) {
      paragraph("Nothing unusual today — all metrics are within 20% of the 7-day daily average.");
    } else {
      for (const flag of flags) {
        paragraph(`•  ${describeFlag(flag)}`);
      }
    }
  } else {
    paragraph("No baseline comparison available (Meta data unavailable).", 10, font, MUTED);
  }

  return doc.save();
}
