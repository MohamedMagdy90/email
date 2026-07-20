// Parse a business-directory PDF into structured rows: { company, category,
// phone, email?, website? }.
//
// Directory listings follow a repeating shape: a company NAME line, then
// address lines, then one or more phone/fax lines, then an activity/category.
// We walk the text line-by-line as a small state machine: a non-contact,
// non-address line starts a new company; contact lines (phone/email/site) and
// "Activity:" lines attach to the company currently being built. A company that
// never gathers a phone or email (e.g. the cover title / section headers) is
// dropped. Text extraction uses `unpdf`, a runtime-agnostic pdf.js build that
// runs cleanly under Bun.

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { regionFromCountryName } from "./phones";

export interface ParsedRow {
  company: string;
  category?: string;
  phone?: string; // E.164
  phoneMobile?: boolean;
  email?: string;
  website?: string;
}

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i;
// A bare domain or full URL (kept loose; validated/normalised before use).
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9\-]*(?:\.[a-z0-9\-]+){1,3})\b/i;
const CATEGORY_RE = /(?:activity|business activity|category|classification|line of business)\s*[:\-]\s*([^\n]{2,60})/i;
// A line that STARTS with one of these labels isn't a company name.
const LABEL_START_RE =
  /^(p\.?\s*o\.?\s*box|tel\b|tel\s*[:.]|telephone|tele\b|fax\b|fax\s*[:.]|mob(ile)?\b|cell\b|phone\b|e-?mail\b|email\s*[:.]|www\.|https?:|activity\b|category\b|classification\b|business\s+activity|line of business|contact\b)/i;
// A line that STARTS with one of these is an address fragment, not a name.
const ADDRESS_START_RE =
  /^(building|bldg|zone|street|st\.|road|rd\.|floor|flat|unit|office\s*(no|#)|shop\s*(no|#)|gate|area|district|block)\b/i;

// ------------------------------- text extract -------------------------------

// Flat text (space-joined) — kept as a fallback.
export async function extractPdfText(buf: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf)); // copy: pdf.js detaches the buffer
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : String(text || "");
  return { text: merged, pages: totalPages || 0 };
}

// Reconstruct real visual LINES from pdf.js text-item coordinates. Items sharing
// (roughly) the same Y are one line; we sort them left-to-right. This recovers
// the "one entry per line" structure that flat extraction loses — and, by
// splitting on wide horizontal gaps, keeps side-by-side columns apart.
export async function extractPdfLines(buf: Uint8Array): Promise<{ lines: string[]; pages: number }> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf: any = await getDocumentProxy(new Uint8Array(buf)); // copy: pdf.js detaches the buffer
  const lines: string[] = [];
  const pages = pdf.numPages || 0;

  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const buckets = new Map<number, { x: number; str: string }[]>();
    for (const it of content.items as any[]) {
      const str = it?.str;
      if (typeof str !== "string" || !str.length) continue;
      const tr = it.transform || [1, 0, 0, 1, 0, 0];
      const y = Math.round(tr[5] / 2) * 2; // 2pt tolerance so the same row groups
      const x = tr[4];
      if (!buckets.has(y)) buckets.set(y, []);
      buckets.get(y)!.push({ x, str });
    }
    // Top of page first (higher Y first).
    for (const y of [...buckets.keys()].sort((a, b) => b - a)) {
      const parts = buckets.get(y)!.sort((a, b) => a.x - b.x);
      // Break a visual line into segments where there's a big horizontal gap
      // (two columns on the same row shouldn't merge into one company).
      let seg = "";
      let lastX: number | null = null;
      const flushSeg = () => { const s = seg.replace(/\s+/g, " ").trim(); if (s) lines.push(s); seg = ""; };
      for (const part of parts) {
        if (lastX !== null && part.x - lastX > 90) flushSeg();
        seg += (seg ? " " : "") + part.str;
        lastX = part.x + part.str.length * 4; // rough end-x estimate
      }
      flushSeg();
    }
  }
  return { lines, pages };
}

// --------------------------------- helpers ----------------------------------

function cleanName(raw: string): string {
  return raw
    .replace(/^[\d).\-–—•*\s]+/, "") // leading numbering / bullets
    .replace(/[\s|·•,;:-]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 90);
}

function normDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!d.includes(".")) return null;
  if (EMAIL_RE.test(d)) return null;
  if (/\.(png|jpe?g|gif|svg|pdf|css|js)$/i.test(d)) return null;
  // TLD must be real letters (rejects "p.o" from "P.O. Box", "w.l.l", numerics).
  const tld = d.split(".").pop() || "";
  if (!/^[a-z]{2,}$/.test(tld)) return null;
  return d;
}

// Does this line read like a company name (vs. an address / contact / label)?
function looksLikeName(line: string): boolean {
  const l = line.trim();
  if (l.length < 2 || l.length > 90) return false;
  if (!/[a-z]/i.test(l)) return false;
  if (l.includes("@")) return false;
  if (LABEL_START_RE.test(l)) return false;
  if (ADDRESS_START_RE.test(l)) return false;
  if (/^(doha|qatar|state of qatar)$/i.test(l)) return false;
  const digits = (l.match(/\d/g) || []).length;
  if (digits > l.length * 0.4) return false; // too numeric to be a name
  return true;
}

interface LinePhone { e164: string; mobile: boolean; isFax: boolean }
function phonesInLine(line: string, region?: CountryCode): LinePhone[] {
  const out: LinePhone[] = [];
  const CAND = /(\+?\d[\d().\-\s/]{6,}\d)/g;
  let m: RegExpExecArray | null;
  while ((m = CAND.exec(line))) {
    const raw = m[1];
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;
    const p = parsePhoneNumberFromString(raw, region);
    if (!p || !p.isValid()) continue;
    const pre = line.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    // A number is "mobile" if its type says so OR it sits behind a mobile label.
    const mobile = p.getType() === "MOBILE" || /(mob|cell|gsm|whats)/.test(pre);
    out.push({ e164: p.number, mobile, isFax: /fax/.test(pre) });
  }
  return out;
}

// --------------------------------- parsing ----------------------------------

export function parseDirectoryText(text: string, country?: string): ParsedRow[] {
  if (!text || text.length < 20) return [];
  return parseDirectoryLines(text.split(/\r?\n/), country);
}

// The core parser, working on an array of text lines (from coordinates or \n).
export function parseDirectoryLines(rawLines: string[], country?: string): ParsedRow[] {
  const region = regionFromCountryName(country);
  const lines = rawLines.map((l) => l.replace(/\s{2,}/g, " ").trim());

  interface Rec { company: string; category?: string; phone?: string; phoneMobile?: boolean; email?: string; website?: string }
  const records: Rec[] = [];
  let cur: Rec | null = null;
  const hasContact = (r: Rec | null) => !!(r && (r.phone || r.email));
  const flush = () => { if (cur && cur.company && (cur.phone || cur.email)) records.push(cur); };

  for (const line of lines) {
    if (!line) continue;

    const phones = phonesInLine(line, region);
    const emailM = line.match(EMAIL_RE);
    const urlM = line.match(URL_RE);
    const catM = line.match(CATEGORY_RE);

    // A clean name line (no contact data on it) starts / renames a record.
    if (!phones.length && !emailM && !catM && looksLikeName(line)) {
      if (hasContact(cur)) { flush(); cur = { company: cleanName(line) }; }
      else if (cur) cur.company = cleanName(line); // replace a contact-less false start (title/header)
      else cur = { company: cleanName(line) };
      continue;
    }

    if (!cur) cur = { company: "" };

    // Phone: prefer the current one, but upgrade to a mobile if we find one.
    for (const p of phones) {
      if (p.isFax) continue;
      if (!cur.phone) { cur.phone = p.e164; cur.phoneMobile = p.mobile; }
      else if (p.mobile && !cur.phoneMobile) { cur.phone = p.e164; cur.phoneMobile = true; }
    }
    if (emailM && !cur.email) cur.email = emailM[0].toLowerCase();
    if (urlM && !cur.website) { const d = normDomain(urlM[1]); if (d) cur.website = d; }
    if (catM && !cur.category) cur.category = catM[1].trim();
  }
  flush();

  // Fallback: nothing had a phone/email — salvage any inline email/website lines.
  if (records.length === 0) {
    for (const line of lines) {
      const email = line.match(EMAIL_RE)?.[0]?.toLowerCase();
      const urlM = line.match(URL_RE)?.[1];
      const website = urlM ? normDomain(urlM) || undefined : undefined;
      if (!email && !website) continue;
      const company = looksLikeName(line) ? cleanName(line) : email ? email.split("@")[0] : website!;
      records.push({ company, email: email || undefined, website });
    }
  }

  // Dedupe.
  const seen = new Set<string>();
  const rows: ParsedRow[] = [];
  for (const r of records) {
    const key = `${r.company.toLowerCase()}|${r.phone || r.email || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  return rows;
}

export async function parsePdf(buf: Uint8Array, country?: string): Promise<{ rows: ParsedRow[]; pages: number }> {
  // Primary: reconstruct real lines from item coordinates.
  const { lines, pages } = await extractPdfLines(buf);
  let rows = parseDirectoryLines(lines, country);
  // Fallback: if coordinate lines produced nothing, try flat text.
  if (!rows.length) {
    const { text } = await extractPdfText(buf);
    rows = parseDirectoryText(text, country);
  }
  return { rows, pages };
}
