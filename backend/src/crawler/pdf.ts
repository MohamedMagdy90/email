// Parse a business-directory PDF into structured rows: { company, category,
// phone, email?, website? }.
//
// Real directories (e.g. the Qatar Commercial & Industrial Directory) are
// multi-COLUMN, and each listing looks like:
//     Abdul Aziz Al-Baker Trading &        <- name (may wrap 1-2 lines)
//     Contracting Est.
//     (P.O.Box 00001334) ........ 44416243 <- phone at end of the P.O.Box line
//     (Fax 44423546)
// So we (1) reconstruct COLUMNS from pdf.js text-item coordinates (detecting the
// vertical gutters between columns), then (2) parse each column top-to-bottom:
// name lines accumulate until a line carries a phone/email, which closes the
// record. Page headers, page numbers, index letters and ads are dropped;
// ALL-CAPS section titles (MEDICAL, METAL, …) become the running category.

import { parsePhoneNumberFromString, getCountryCallingCode, type CountryCode } from "libphonenumber-js";
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
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9\-]*(?:\.[a-z0-9\-]+){1,3})\b/i;
const CATEGORY_RE = /(?:activity|business activity|category|classification|line of business)\s*[:\-]\s*([^\n]{2,60})/i;
const LABEL_START_RE =
  /^\(?\s*(p\.?\s*o\.?\s*box|tel\b|tel\s*[:.]|telephone|fax\b|fax\s*[:.]|mob(ile)?\b|cell\b|phone\b|e-?mail\b|email\s*[:.]|www\.|https?:|activity\b|category\b)/i;
const ADDRESS_START_RE =
  /^(building|bldg|zone|street|st\.|road|rd\.|floor|flat|unit|office\s*(no|#)|shop\s*(no|#)|gate|area|district|block)\b/i;

// Running page headers / footers / ads to ignore (directory-specific + generic).
const NOISE_RE =
  /(commercial and industrial directory|alphabetical list of commercial|industrial companies and institutions|list of commercial and industrial|ahlibank|alikhtyar|www\.[a-z]|\.com\.qa\b)/i;

// ------------------------------- text extract -------------------------------

// Flat text (space-joined) — kept as a fallback.
export async function extractPdfText(buf: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf)); // copy: pdf.js detaches the buffer
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : String(text || "");
  return { text: merged, pages: totalPages || 0 };
}

// Reconstruct real LINES from pdf.js text-item coordinates, column by column.
export async function extractPdfLines(buf: Uint8Array): Promise<{ lines: string[]; pages: number }> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf: any = await getDocumentProxy(new Uint8Array(buf)); // copy: pdf.js detaches the buffer
  const lines: string[] = [];
  const pages = pdf.numPages || 0;

  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    const W = page.getViewport({ scale: 1 }).width || 612;
    const content = await page.getTextContent();

    const items: { x: number; y: number; w: number; str: string }[] = [];
    for (const it of content.items as any[]) {
      const str = it?.str;
      if (typeof str !== "string" || !str.trim()) continue;
      const tr = it.transform || [1, 0, 0, 1, 0, 0];
      items.push({ x: tr[4], y: tr[5], w: it.width || str.length * 4, str });
    }
    if (!items.length) continue;

    // --- detect column bands via vertical gutters (uncovered x-ranges) ---
    const BIN = 4;
    const nbins = Math.ceil(W / BIN) + 1;
    const covered = new Array(nbins).fill(false);
    for (const it of items) {
      const a = Math.max(0, Math.floor(it.x / BIN));
      const b = Math.min(nbins - 1, Math.floor((it.x + it.w) / BIN));
      for (let i = a; i <= b; i++) covered[i] = true;
    }
    const first = Math.max(0, covered.indexOf(true));
    const last = covered.lastIndexOf(true);
    const edges: number[] = [first * BIN];
    for (let i = first; i <= last; ) {
      if (!covered[i]) {
        let j = i;
        while (j <= last && !covered[j]) j++;
        if (j - i >= 3) edges.push(((i + j) / 2) * BIN); // gutter ≥ ~12pt → column break
        i = j;
      } else i++;
    }
    edges.push((last + 1) * BIN);

    // --- within each column, group items into lines by Y (top→bottom) ---
    for (let k = 0; k + 1 < edges.length; k++) {
      const lo = edges[k], hi = edges[k + 1];
      const colItems = items.filter((it) => { const cx = it.x + it.w / 2; return cx >= lo && cx < hi; });
      if (!colItems.length) continue;
      const rows = new Map<number, { x: number; str: string }[]>();
      for (const it of colItems) {
        const y = Math.round(it.y / 2) * 2; // 2pt tolerance groups a visual row
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y)!.push({ x: it.x, str: it.str });
      }
      for (const y of [...rows.keys()].sort((a, b) => b - a)) {
        const line = rows.get(y)!.sort((a, b) => a.x - b.x).map((r) => r.str).join(" ").replace(/\s+/g, " ").trim();
        if (line) lines.push(line);
      }
    }
  }
  return { lines, pages };
}

// --------------------------------- helpers ----------------------------------

function cleanName(raw: string): string {
  return raw
    // strip leading bullets and "1." / "2)" list markers — but NOT bare leading
    // numbers, which are part of names like "21 Century" or "360 Solutions".
    .replace(/^\s*(?:[•*·\-–—]+\s*)?(?:\d{1,3}[.)]\s+)?/, "")
    .replace(/[\s|·•,;:-]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 120);
}

function normDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!d.includes(".")) return null;
  if (EMAIL_RE.test(d)) return null;
  if (/\.(png|jpe?g|gif|svg|pdf|css|js)$/i.test(d)) return null;
  const tld = d.split(".").pop() || "";
  if (!/^[a-z]{2,}$/.test(tld)) return null;
  return d;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}

function isNoise(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  if (/^\d{1,4}$/.test(l)) return true; // page number
  if (/^[A-Za-z]$/.test(l)) return true; // index letter (A, B, …)
  if (/^\(?\s*fax\b/i.test(l)) return true; // fax-only line
  if (NOISE_RE.test(l)) return true;
  return false;
}

// ALL-CAPS short standalone line ⇒ an activity/section title (MEDICAL, METAL…).
function sectionHeader(line: string): string | null {
  const s = line.trim();
  if (s.length < 3 || s.length > 26) return null;
  if (!/^[A-Z][A-Z0-9 &/\-]+$/.test(s)) return null;
  if (/\b(WLL|W\.?L\.?L|LLC)\b/.test(s)) return null; // legal-suffix fragments
  if (/\d/.test(s)) return null;
  return s.replace(/\s+/g, " ").trim();
}

function looksLikeName(line: string): boolean {
  const l = line.trim();
  if (l.length < 2 || l.length > 120) return false;
  if (!/[a-z]/i.test(l)) return false;
  if (l.includes("@")) return false;
  if (LABEL_START_RE.test(l)) return false;
  if (ADDRESS_START_RE.test(l)) return false;
  if (/^(doha|qatar|state of qatar)$/i.test(l)) return false;
  const digits = (l.match(/\d/g) || []).length;
  if (digits > l.length * 0.4) return false;
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
    const pre = line.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    if (/box|p\.?\s*o\b/.test(pre)) continue; // P.O. Box number, not a phone
    const p = parsePhoneNumberFromString(raw, region);
    if (!p || !p.isValid()) continue;
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
  const lines = rawLines.map((l) => l.replace(/\s{2,}/g, " ").trim()).filter(Boolean);

  const records: ParsedRow[] = [];
  let nameBuf: string[] = [];
  let currentCategory: string | undefined;

  const flush = (phone?: string, phoneMobile?: boolean, email?: string, website?: string) => {
    const company = cleanName(nameBuf.join(" "));
    nameBuf = [];
    if (!company || company.length < 2 || !/[a-z]/i.test(company)) return;
    if (!phone && !email) return; // need at least one contact anchor
    records.push({ company, category: currentCategory, phone, phoneMobile, email, website });
  };

  for (const line of lines) {
    if (isNoise(line)) { nameBuf = []; continue; }

    const sec = sectionHeader(line);
    if (sec) { currentCategory = titleCase(sec); nameBuf = []; continue; }

    const phones = phonesInLine(line, region).filter((p) => !p.isFax);
    const emailM = line.match(EMAIL_RE);
    const catM = line.match(CATEGORY_RE);

    // A line carrying a phone or email closes the current listing.
    if (phones.length || emailM) {
      let phone: string | undefined;
      let phoneMobile = false;
      for (const p of phones) {
        if (!phone) { phone = p.e164; phoneMobile = p.mobile; }
        else if (p.mobile && !phoneMobile) { phone = p.e164; phoneMobile = true; }
      }
      const email = emailM ? emailM[0].toLowerCase() : undefined;
      let website: string | undefined;
      const urlM = line.match(URL_RE);
      if (urlM) { const d = normDomain(urlM[1]); if (d) website = d; }
      flush(phone, phoneMobile, email, website);
      continue;
    }

    if (catM) { currentCategory = catM[1].trim(); continue; }

    // Otherwise it's (part of) a company name — accumulate wrapped lines.
    if (looksLikeName(line)) {
      nameBuf.push(line);
      if (nameBuf.length > 4) nameBuf.shift();
    }
    // address-only / unknown lines are ignored (buffer preserved).
  }

  // Fallback: nothing anchored — salvage any inline email/website lines.
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

  // Dedupe by company + anchor.
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

// ------------------------- flat-stream directory parser ---------------------
// The reliable path for multi-column directories: pdf.js flattens each page to
// text in correct READING order (column 1 fully, then 2, then 3), just
// space-joined. Every listing ends with "(P.O.Box <n>) …… <phone>", so we anchor
// on that pattern and take the text BEFORE each block as the company name. This
// sidesteps fragile column-geometry detection entirely.

const HEADER_NOISE_RE =
  /(Qatar Commercial and Industrial Directory\s*\d{4}\s*[-–]\s*\d{4}|(?:Commercial|Industrial) companies and institutions by activity|Alphabetical List of Commercial and Industrial|Al Ikhtyaar German Group|www\.[a-z0-9.\-]+|UPVC[^]*?Coating)/gi;

const POBOX_ANCHOR_RE = /\(?\s*p\.?\s*o\.?\s*box\s*([0-9]+)\s*\)?[.\s]*([0-9]{6,9})/gi;
const FAX_TAIL_RE = /^\s*\(\s*fax[^)]*\)/i;

function safeCallingCode(region?: CountryCode): string {
  if (!region) return "";
  try { return getCountryCallingCode(region); } catch { return ""; }
}

function formatPhone(digits: string, region?: CountryCode, cc?: string): string {
  if (region) {
    const p = parsePhoneNumberFromString(digits, region);
    if (p && p.isValid()) return p.formatInternational();
  }
  return cc ? `+${cc} ${digits}` : digits;
}

function isMobile(digits: string, region?: CountryCode): boolean {
  if (region) {
    const p = parsePhoneNumberFromString(digits, region);
    if (p && p.isValid()) {
      if (p.getType() === "MOBILE") return true;
      if (region === "QA") return /^[3567]/.test(digits) && digits.length === 8;
      return false;
    }
  }
  if (region === "QA") return /^[3567]/.test(digits) && digits.length === 8;
  return false;
}

// Turn the text sitting before a P.O.Box block into a clean company name (and,
// when present, a leading ALL-CAPS activity section → category).
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+/g;
const ENG_HEADER_RE = /(commercial and industrial directory|companies and institutions by activity|alphabetical list of commercial|list of commercial and industrial)/i;

function nameFromBetween(raw: string): { name: string; category?: string } {
  // A page-boundary chunk carries the bilingual page header + page no. + index letter.
  const hadHeader = ARABIC_RE.test(raw) || ENG_HEADER_RE.test(raw);
  ARABIC_RE.lastIndex = 0; // reset (global regex used with .test above)

  let s = raw
    .replace(ARABIC_RE, " ")                                   // drop Arabic header text
    .replace(HEADER_NOISE_RE, " ")                             // drop English header / ads
    .replace(FAX_TAIL_RE, " ")                                 // stray leading "(Fax …)"
    .replace(/\b(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\b/g, " ");  // year range e.g. 2025 - 2026

  if (hadHeader) {
    // Only for page-boundary chunks: strip a leading page number + index letter
    // (mid-page names never carry these, so real names like "21 Century" are safe).
    s = s.replace(/^\s*\d{1,4}\s+/, " ").replace(/^\s*[A-Z]\s+/, " ");
  }
  s = s.replace(/\s+/g, " ").trim();

  let category: string | undefined;
  // Leading ALL-CAPS run followed by a Title-Case name ⇒ activity header.
  const sec = s.match(/^([A-Z][A-Z &/\-]{2,})\s+([A-Z].*)$/);
  if (sec && !/\b(WLL|LLC|W\.?L\.?L)\b/.test(sec[1]) && sec[1] === sec[1].toUpperCase()) {
    category = titleCase(sec[1]);
    s = sec[2];
  }
  return { name: cleanName(s), category };
}

// A leftover fragment (e.g. a lone lowercase word like "point") — not a company.
function isFragmentName(name: string): boolean {
  if (/^[a-z]/.test(name) && !name.includes(" ")) return true; // single lowercase word
  if (name.replace(/[^a-z]/gi, "").length < 2) return true;    // barely any letters
  return false;
}

export function parseDirectoryFlat(text: string, country?: string): ParsedRow[] {
  const region = regionFromCountryName(country);
  const cc = safeCallingCode(region);
  if (!text) return [];
  const s = text.replace(/\s+/g, " ");

  const rows: ParsedRow[] = [];
  const seen = new Set<string>();
  let lastEnd = 0;
  let currentCategory: string | undefined;
  POBOX_ANCHOR_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = POBOX_ANCHOR_RE.exec(s))) {
    const between = s.slice(lastEnd, m.index);
    const phoneDigits = m[2];

    // Consume a trailing "(Fax …)" so it doesn't bleed into the next name.
    let end = POBOX_ANCHOR_RE.lastIndex;
    const fax = FAX_TAIL_RE.exec(s.slice(end));
    if (fax) end += fax[0].length;
    lastEnd = end;
    POBOX_ANCHOR_RE.lastIndex = end;

    const { name, category } = nameFromBetween(between);
    if (category) currentCategory = category;
    if (!name || name.length < 2 || !/[a-z]/i.test(name)) continue;
    if (isFragmentName(name)) continue;

    const phone = formatPhone(phoneDigits, region, cc);
    const key = `${name.toLowerCase()}|${phoneDigits}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ company: name, category: currentCategory, phone, phoneMobile: isMobile(phoneDigits, region) });
  }
  return rows;
}

export interface ParseResult {
  rows: ParsedRow[];
  pages: number;
  textChars: number;
  lineCount: number;
  sampleLines: string[];
}

export async function parsePdf(buf: Uint8Array, country?: string): Promise<ParseResult> {
  // Primary: flat text in reading order, parsed by P.O.Box anchor.
  const { text, pages } = await extractPdfText(buf);
  let rows = parseDirectoryFlat(text, country);

  // Fallback: line-based parser (for non-P.O.Box layouts / true multi-line PDFs).
  if (rows.length < 3) {
    const alt = parseDirectoryText(text, country);
    if (alt.length > rows.length) rows = alt;
  }

  // A readable sample for diagnostics (split the stream before each P.O.Box).
  const sampleLines = text
    .replace(/\s+/g, " ")
    .split(/(?=\(?\s*p\.?\s*o\.?\s*box)/i)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 60);

  return { rows, pages, textChars: text.length, lineCount: sampleLines.length, sampleLines };
}
