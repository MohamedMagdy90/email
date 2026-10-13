// Repair company names that were stored wrong.
//
// An earlier version of the directory harvester picked "the nearest heading or
// link before the email" as the company name. On directories whose cards put a
// `tel:` link immediately before the email (cra.gov.qa, most government
// registers) that IS the phone number — so rows were saved with a phone number,
// an email, or a bare URL where the company name should be.
//
// The crawler no longer does that. This module repairs the rows already saved:
//   1. find every lead/contact whose name is not a plausible company name
//   2. re-walk the directory sources they came from and build
//      email → real name  and  phone → real name  lookups
//   3. write the real name back
//   4. anything still unmatched falls back to a name derived from its domain,
//      which is imperfect but never a phone number
//
// Idempotent: rows with a good name are never touched, so it's safe to re-run.

import { q } from "./db";
import { crawlDirectory, looksLikeName, type DirectoryOptions } from "./crawler/directory";
import { registrableDomain, hostOf } from "./crawler/urls";
import { getProxyConfig, getReaderKey } from "./config";

export interface RepairProgress {
  (msg: string): void;
}

export interface RepairResult {
  scannedLeads: number;
  scannedContacts: number;
  badLeads: number;
  badContacts: number;
  fixedLeads: number;
  fixedContacts: number;
  fromDirectory: number; // names recovered by re-reading the source
  fromDomain: number;    // names derived from the company's own domain
  stillBad: number;
  pagesWalked: number;
  notes: string[];
}

const onlyDigits = (s?: string | null) => String(s || "").replace(/\D/g, "");

// A stored name we should replace. Deliberately the SAME rule the crawler now
// uses to accept a name, so the two can never disagree.
export function isBadName(name?: string | null): boolean {
  const t = String(name || "").trim();
  if (!t) return true;
  return !looksLikeName(t);
}

// Last-resort name from a domain: "www.al-mashreq-qatar.com" → "Al Mashreq Qatar".
// Only ever used when the directory couldn't tell us the real one.
export function nameFromDomain(website?: string | null, domain?: string | null): string {
  const host = String(domain || "").trim() || hostOf(String(website || ""));
  const reg = registrableDomain(host);
  if (!reg) return "";
  const label = reg.split(".")[0];
  if (!label || label.length < 2) return "";
  const words = label
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  const out = words.join(" ");
  return looksLikeName(out) ? out : "";
}

interface NameIndex {
  byEmail: Map<string, string>;
  byPhone: Map<string, string>; // keyed on the last 9 digits
}

function indexContacts(index: NameIndex, contacts: { name: string; email: string | null; phone: string | null }[]) {
  for (const c of contacts) {
    const name = String(c.name || "").trim();
    if (!looksLikeName(name)) continue;
    const email = String(c.email || "").trim().toLowerCase();
    if (email && !index.byEmail.has(email)) index.byEmail.set(email, name);
    const phone = onlyDigits(c.phone);
    if (phone.length >= 7) {
      const k = phone.slice(-9);
      if (!index.byPhone.has(k)) index.byPhone.set(k, name);
    }
  }
}

// Walk every directory source that still exists and learn the real names.
async function buildNameIndex(onLog: RepairProgress): Promise<{ index: NameIndex; pages: number; notes: string[] }> {
  const index: NameIndex = { byEmail: new Map(), byPhone: new Map() };
  const notes: string[] = [];
  let pages = 0;

  const sources = await q(`SELECT id, base_url, location FROM discovery_sources WHERE type='directory' AND base_url IS NOT NULL`);
  if (!sources.length) {
    notes.push("No directory sources are configured, so names could only be rebuilt from each company's domain.");
    return { index, pages, notes };
  }

  const proxy = await getProxyConfig();
  const readerKey = await getReaderKey();

  for (const src of sources as any[]) {
    const base = String(src.base_url || "").trim();
    if (!base) continue;
    onLog(`Re-reading ${base} to recover the real company names…`);
    const opts: DirectoryOptions = {
      // Walk the whole directory: this is a one-off repair, not a paced harvest.
      maxPages: 80,
      maxDetails: 5000,
      concurrency: proxy ? 3 : 4,
      respectRobots: true,
      checkMx: false, // we only want names — skip the DNS round-trips
      defaultCountry: String(src.location || "").trim() || undefined,
      proxy,
      readerKey,
    };
    try {
      const res = await crawlDirectory(base, opts, (p) => {
        if (p.type === "page" && p.msg) onLog(`  · ${p.msg}`);
      });
      pages += res.listingPages || 0;
      indexContacts(index, res.contacts.map((c) => ({ name: c.name, email: c.email, phone: c.phone })));
      onLog(`  ↳ learned ${res.contacts.length} company name(s) from ${res.listingPages} page(s)`);
      if (res.note) notes.push(`${base}: ${res.note}`);
    } catch (e: any) {
      const msg = `Could not re-read ${base}: ${String(e?.message || e)}`;
      onLog(`  ↳ ${msg}`);
      notes.push(msg);
    }
  }
  return { index, pages, notes };
}

function lookup(index: NameIndex, email?: string | null, phone?: string | null): string {
  const e = String(email || "").trim().toLowerCase();
  if (e) { const hit = index.byEmail.get(e); if (hit) return hit; }
  const p = onlyDigits(phone);
  if (p.length >= 7) { const hit = index.byPhone.get(p.slice(-9)); if (hit) return hit; }
  return "";
}

export async function repairLeadNames(onLog: RepairProgress = () => {}): Promise<RepairResult> {
  const leads = await q(`SELECT id, name, email, phone, website, domain FROM discovered_leads`);
  const contacts = await q(`SELECT id, company, email, phone FROM contacts`);

  const badLeads = (leads as any[]).filter((r) => isBadName(r.name));
  const badContacts = (contacts as any[]).filter((r) => isBadName(r.company));

  const result: RepairResult = {
    scannedLeads: leads.length,
    scannedContacts: contacts.length,
    badLeads: badLeads.length,
    badContacts: badContacts.length,
    fixedLeads: 0, fixedContacts: 0, fromDirectory: 0, fromDomain: 0, stillBad: 0,
    pagesWalked: 0, notes: [],
  };

  onLog(`Scanned ${leads.length} lead(s) and ${contacts.length} contact(s).`);
  onLog(`${badLeads.length} lead(s) and ${badContacts.length} contact(s) have a phone number (or other junk) where the company name should be.`);
  if (!badLeads.length && !badContacts.length) {
    onLog("Nothing to repair — every company name looks right.");
    return result;
  }

  const { index, pages, notes } = await buildNameIndex(onLog);
  result.pagesWalked = pages;
  result.notes = notes;
  onLog(`Recovered ${index.byEmail.size} name(s) by email and ${index.byPhone.size} by phone.`);

  for (const row of badLeads) {
    let name = lookup(index, row.email, row.phone);
    let via: "dir" | "domain" = "dir";
    if (!name) { name = nameFromDomain(row.website, row.domain); via = "domain"; }
    if (!name) { result.stillBad++; continue; }
    await q(`UPDATE discovered_leads SET name=? WHERE id=?`, [name, row.id]);
    result.fixedLeads++;
    if (via === "dir") result.fromDirectory++; else result.fromDomain++;
    onLog(`  ✓ ${String(row.name).trim()} → ${name}${via === "domain" ? " (from its domain)" : ""}`);
  }

  for (const row of badContacts) {
    let name = lookup(index, row.email, row.phone);
    let via: "dir" | "domain" = "dir";
    if (!name) { name = nameFromDomain(null, (String(row.email || "").split("@")[1] || "")); via = "domain"; }
    if (!name) { result.stillBad++; continue; }
    await q(`UPDATE contacts SET company=? WHERE id=?`, [name, row.id]);
    result.fixedContacts++;
    if (via === "dir") result.fromDirectory++; else result.fromDomain++;
    onLog(`  ✓ contact ${String(row.company).trim()} → ${name}${via === "domain" ? " (from its domain)" : ""}`);
  }

  onLog(`Done: fixed ${result.fixedLeads} lead(s) and ${result.fixedContacts} contact(s) — ${result.fromDirectory} from the directory, ${result.fromDomain} from their domain, ${result.stillBad} left unchanged.`);
  return result;
}

// How many rows would the repair touch? Cheap enough to call on page load so the
// UI can offer the fix only when it's actually needed.
export async function countBadNames(): Promise<{ leads: number; contacts: number }> {
  const leads = await q(`SELECT name FROM discovered_leads`);
  const contacts = await q(`SELECT company FROM contacts`);
  return {
    leads: (leads as any[]).filter((r) => isBadName(r.name)).length,
    contacts: (contacts as any[]).filter((r) => isBadName(r.company)).length,
  };
}
