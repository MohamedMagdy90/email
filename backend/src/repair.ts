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

import { q, getSetting, setSetting, nowIso } from "./db";
import { crawlDirectory, looksLikeName, type DirectoryOptions } from "./crawler/directory";
import { registrableDomain, hostOf } from "./crawler/urls";
import { isFreeMailDomain } from "./crawler/validate";
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

/**
 * Bumped whenever `looksLikeName` or `nameFromDomain` gets smarter.
 *
 * A row this pass could not name is stamped with the fingerprint below and then
 * left alone — but "we can't name it" is only true of the rules we had at the
 * time. Bumping this re-offers every stamped row on the next deploy, which is
 * the honest way to let an improvement reach the rows it was written for.
 */
const NAME_RULES_VERSION = 1;

const onlyDigits = (s?: string | null) => String(s || "").replace(/\D/g, "");

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * What a repair pass actually has to work with: the directory sources it can
 * re-read, plus the version of the naming rules.
 *
 * Nothing else can change the answer. Re-walking the same directories with the
 * same rules rebuilds a byte-identical index, so a row that could not be named
 * last time cannot be named this time — and finding that out costs a full
 * crawl of every directory (up to 80 pages and 5,000 listing pages each). That
 * is what made the badge stick at a number no amount of pressing could move.
 */
async function namingFingerprint(): Promise<string> {
  const rows = await q(
    `SELECT base_url FROM discovery_sources WHERE type='directory' AND base_url IS NOT NULL AND base_url <> ''`
  );
  const urls = (rows as any[])
    .map((r) => String(r.base_url || "").trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
  return fnv1a(`v${NAME_RULES_VERSION}|${urls}`);
}

// A stored name we should replace. Deliberately the SAME rule the crawler now
// uses to accept a name, so the two can never disagree.
export function isBadName(name?: string | null): boolean {
  const t = String(name || "").trim();
  if (!t) return true;
  return !looksLikeName(t);
}

// Last-resort name from a domain: "www.al-mashreq-qatar.com" → "Al Mashreq Qatar".
// Only ever used when the directory couldn't tell us the real one.
//
// A FREE-MAIL host is never a company's identity: deriving from one turned a
// contact on a gmail address into a company called "Gmail", which is worse than
// no name at all because it reads as valid, never comes back for review, and
// renders straight into the `{{company}}` merge tag of a real outreach email.
export function nameFromDomain(website?: string | null, domain?: string | null): string {
  const host = String(domain || "").trim() || hostOf(String(website || ""));
  const reg = registrableDomain(host);
  if (!reg) return "";
  if (isFreeMailDomain(reg)) return "";
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
  const fp = await namingFingerprint();
  const leads = await q(`SELECT id, name, email, phone, website, domain, name_fix_key FROM discovered_leads`);
  const contacts = await q(`SELECT id, company, email, phone, name_fix_key FROM contacts`);

  // Bad, AND not already proven unnameable under this exact set of directory
  // sources and naming rules. Without the second half this list never shrank.
  const fixable = (r: any) => String(r.name_fix_key || "") !== fp;
  const badLeads = (leads as any[]).filter((r) => isBadName(r.name) && fixable(r));
  const badContacts = (contacts as any[]).filter((r) => isBadName(r.company) && fixable(r));
  const parkedLeads = (leads as any[]).filter((r) => isBadName(r.name) && !fixable(r)).length;
  const parkedContacts = (contacts as any[]).filter((r) => isBadName(r.company) && !fixable(r)).length;

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
  // THE EARLY RETURN THAT MATTERS. Everything below re-crawls every directory
  // source in full; doing that to re-derive an index we already know cannot
  // name these rows was the expensive half of the loop.
  if (!badLeads.length && !badContacts.length) {
    const parked = parkedLeads + parkedContacts;
    onLog(
      parked
        ? `Nothing more can be repaired. ${parked} name(s) have already been tried against these directory sources and could not be recovered — add or change a directory source and they become repairable again.`
        : "Nothing to repair — every company name looks right."
    );
    if (parked) result.notes.push(`${parked} name(s) could not be recovered from the sources available.`);
    return result;
  }

  const { index, pages, notes } = await buildNameIndex(onLog);
  result.pagesWalked = pages;
  result.notes = notes;
  onLog(`Recovered ${index.byEmail.size} name(s) by email and ${index.byPhone.size} by phone.`);

  // Rows this pass could not name: stamped so the next press skips them (and so
  // the badge stops counting work the button cannot actually do).
  const unfixedLeads: string[] = [];
  const unfixedContacts: string[] = [];

  for (const row of badLeads) {
    let name = lookup(index, row.email, row.phone);
    let via: "dir" | "domain" = "dir";
    if (!name) { name = nameFromDomain(row.website, row.domain); via = "domain"; }
    if (!name) { result.stillBad++; unfixedLeads.push(row.id); continue; }
    await q(`UPDATE discovered_leads SET name=?, name_fix_key=NULL WHERE id=?`, [name, row.id]);
    result.fixedLeads++;
    if (via === "dir") result.fromDirectory++; else result.fromDomain++;
    onLog(`  ✓ ${String(row.name).trim()} → ${name}${via === "domain" ? " (from its domain)" : ""}`);
  }

  for (const row of badContacts) {
    let name = lookup(index, row.email, row.phone);
    let via: "dir" | "domain" = "dir";
    if (!name) { name = nameFromDomain(null, (String(row.email || "").split("@")[1] || "")); via = "domain"; }
    if (!name) { result.stillBad++; unfixedContacts.push(row.id); continue; }
    await q(`UPDATE contacts SET company=?, name_fix_key=NULL WHERE id=?`, [name, row.id]);
    result.fixedContacts++;
    if (via === "dir") result.fromDirectory++; else result.fromDomain++;
    onLog(`  ✓ contact ${String(row.company).trim()} → ${name}${via === "domain" ? " (from its domain)" : ""}`);
  }

  await stampUnfixable("discovered_leads", unfixedLeads, fp);
  await stampUnfixable("contacts", unfixedContacts, fp);

  onLog(`Done: fixed ${result.fixedLeads} lead(s) and ${result.fixedContacts} contact(s) — ${result.fromDirectory} from the directory, ${result.fromDomain} from their domain, ${result.stillBad} left unchanged.`);
  if (result.stillBad) {
    onLog(`Those ${result.stillBad} have no directory entry and no usable domain to build a name from. They won't be retried until a directory source is added or changed.`);
  }
  return result;
}

// Chunked so a big pool never builds an oversized statement.
async function stampUnfixable(table: "discovered_leads" | "contacts", ids: string[], fp: string): Promise<void> {
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await q(
      `UPDATE ${table} SET name_fix_key=? WHERE id IN (${chunk.map(() => "?").join(",")})`,
      [fp, ...chunk]
    );
  }
}

// How many rows would the repair ACTUALLY touch? Cheap enough to call on page
// load so the UI can offer the fix only when it's genuinely needed — and,
// crucially, so the badge promises a number the button can deliver. It used to
// count every unusable name, including the ones no available source could ever
// name, so it never reached zero however many times you pressed.
export async function countBadNames(): Promise<{
  leads: number;
  contacts: number;
  /** Bad names already proven unrecoverable from the sources currently configured. */
  stuckLeads: number;
  stuckContacts: number;
}> {
  const fp = await namingFingerprint();
  const leads = await q(`SELECT name, name_fix_key FROM discovered_leads`);
  const contacts = await q(`SELECT company, name_fix_key FROM contacts`);
  const bad = (rows: any[], field: string) => rows.filter((r) => isBadName(r[field]));
  const badL = bad(leads as any[], "name");
  const badC = bad(contacts as any[], "company");
  const parked = (r: any) => String(r.name_fix_key || "") === fp;
  return {
    leads: badL.filter((r) => !parked(r)).length,
    contacts: badC.filter((r) => !parked(r)).length,
    stuckLeads: badL.filter(parked).length,
    stuckContacts: badC.filter(parked).length,
  };
}

/**
 * Undo the "Gmail" bug, once.
 *
 * Before `nameFromDomain` refused free-mail hosts, a contact with a junk company
 * name on a shared mailbox was "repaired" to the provider's brand — "Gmail",
 * "Hotmail", "Yahoo". That is worse than an empty field: it reads as a valid
 * name so it never comes back for review, and `{{company}}` renders it into the
 * body of a real cold email.
 *
 * Narrow on purpose. A row is only cleared when the company name is exactly the
 * brand label of that contact's OWN free-mail domain — i.e. demonstrably this
 * bug's output, not a real firm that happens to share the word. Guarded by a
 * settings flag so it runs exactly once.
 */
export async function clearFreemailCompanyNames(): Promise<number> {
  if (await getSetting("freemail_company_name_fix_v1")) return 0;
  const rows = await q(
    `SELECT id, company, email FROM contacts WHERE company IS NOT NULL AND company <> '' AND email LIKE '%@%'`
  );
  const ids: string[] = [];
  for (const r of rows as any[]) {
    const domain = registrableDomain(String(r.email || "").split("@")[1] || "");
    if (!isFreeMailDomain(domain)) continue;
    const label = domain.split(".")[0];
    const brand = label.length <= 3 ? label.toUpperCase() : label[0].toUpperCase() + label.slice(1);
    if (String(r.company).trim() === brand) ids.push(r.id);
  }
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      await q(
        `UPDATE contacts SET company=NULL, name_fix_key=NULL WHERE id IN (${chunk.map(() => "?").join(",")})`,
        chunk
      );
    }
    console.log(
      `[repair] cleared ${ids.length} contact(s) whose company name was their email provider ("Gmail", "Hotmail", …) — an empty field is honest, that name was not`
    );
  }
  await setSetting("freemail_company_name_fix_v1", nowIso());
  return ids.length;
}
