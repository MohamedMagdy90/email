// The discovered-leads review pool.
//
// One approval path, shared by the manual "Approve" buttons in the UI and by
// the automation — so a lead becomes a Contact in exactly the same way however
// it was triggered. Keeping this in one place is what lets the automation reuse
// the (well-tested) filter, dedupe, address-validation and country-normalising
// rules instead of re-implementing them and drifting.

import { q, nowIso } from "./db";
import { cleanEmail, isValidEmail } from "./crawler/validate";
import { normalizeCountry } from "./country";

const uid = () => crypto.randomUUID();

// Mailbox names that belong to a company, not a person — flagged so sending can
// treat them differently (and so exports stay honest).
export const ROLE_RE =
  /^(info|sales|contact|support|admin|office|enquir|inquir|hello|mail|team|marketing|hr|jobs|career|reception)/i;

// The explicit "no country on file" bucket, so those leads stay reviewable
// instead of being invisible to every country filter.
export const NO_COUNTRY = "__none__";

/* ------------------------------ audience ------------------------------ */

// Who a lead / contact is: someone we sell DNA ERP to, or someone we sell the
// Makers program to. The tag comes from the discovery source that found them.
export type Audience = "customer" | "partner";

/** Anything that isn't literally 'partner' is a customer — including NULL. */
export function normalizeAudience(v: unknown): Audience {
  return String(v || "").trim().toLowerCase() === "partner" ? "partner" : "customer";
}

// SQL for "this row belongs to <audience>". Rows discovered before the tag
// existed have audience NULL, and the app has always been customer-first, so
// they count as customers rather than falling out of both lanes.
function audienceClause(a: Audience): string {
  return a === "partner"
    ? `lower(COALESCE(audience,'customer')) = 'partner'`
    : `lower(COALESCE(audience,'customer')) <> 'partner'`;
}

/* ----------------------------- filtering ------------------------------ */

// Portable WHERE builder for the pool (status + country + free-text search).
// Every bulk action reuses this, so "Approve all" acts on EXACTLY the rows the
// table is showing — including the country filter.
export function discoveredWhere(opts: {
  status?: string | null;
  q?: string | null;
  hasEmail?: boolean;
  country?: string | null;
  /** Blank / omitted = both audiences. */
  audience?: string | null;
}) {
  const where: string[] = [];
  const params: any[] = [];
  const status = opts.status;
  const search = opts.q;
  const country = String(opts.country || "").trim();
  const audience = String(opts.audience || "").trim();
  if (status && status !== "all") { where.push(`status = ?`); params.push(status); }
  if (opts.hasEmail) where.push(`(email IS NOT NULL AND email <> '')`);
  if (audience && audience !== "all") where.push(audienceClause(normalizeAudience(audience)));
  if (country) {
    if (country === NO_COUNTRY) where.push(`(country IS NULL OR country = '')`);
    else { where.push(`lower(country) = ?`); params.push(country.toLowerCase()); }
  }
  if (search) {
    const like = `%${String(search).toLowerCase()}%`;
    where.push(`(lower(name) LIKE ? OR lower(email) LIKE ? OR lower(domain) LIKE ? OR lower(category) LIKE ?)`);
    params.push(like, like, like, like);
  }
  return { where, params, clause: where.length ? `WHERE ${where.join(" AND ")}` : "" };
}

// How many pending leads currently hold a usable email — the number the
// automation watches, and the one the UI counts down to the trigger. Each
// automation lane counts only its own audience.
export async function countApprovableLeads(
  search?: string | null,
  country?: string | null,
  audience?: string | null
): Promise<number> {
  const { clause, params } = discoveredWhere({ status: "pending", q: search, hasEmail: true, country, audience });
  const r = await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads ${clause}`, params);
  return Number(r[0]?.n ?? 0);
}

/* ----------------------------- approving ------------------------------ */

export interface ApproveResult {
  added: number;          // contacts actually created
  skipped: number;        // duplicates / no (or unmailable) email
  contactIds: string[];   // the new contact rows (what the automation emails)
  approvedIds: string[];  // pool rows marked 'approved'
}

export interface ApproveOptions {
  ids?: string[];
  all?: boolean;
  q?: string | null;
  filterCountry?: string | null; // which rows to act on (matches the table's filter)
  filterAudience?: string | null; // customer | partner (blank = both)
  category?: string | null;      // contact category to save them under
  country?: string | null;       // country override (blank = keep the lead's own)
  limit?: number;                // cap the batch (the automation approves N at a time)
  oldestFirst?: boolean;         // FIFO — the automation drains the pool in order
}

// Approve leads → create Contacts (only the ones with a mailable email) and mark
// the pool rows 'approved'. Returns the ids of the contacts it created so a
// caller can act on exactly this batch — that's how the automation knows who to
// email without re-querying and catching unrelated contacts.
export async function approveLeads(opts: ApproveOptions): Promise<ApproveResult> {
  const category = String(opts.category ?? "").trim() || null;
  // Normalised so an override always matches the spelling the filter and the
  // Contacts list use.
  const rawCountry = String(opts.country ?? "").trim();
  const country = normalizeCountry(rawCountry) || rawCountry || null;

  let leads: any[];
  if (opts.all === true) {
    const { clause, params } = discoveredWhere({
      status: "pending", q: opts.q, hasEmail: true, country: opts.filterCountry, audience: opts.filterAudience,
    });
    const limit = Math.max(1, Math.min(Number(opts.limit) || 5000, 20000));
    const order = opts.oldestFirst ? `ORDER BY created_at ASC, id ASC` : "";
    leads = await q(`SELECT * FROM discovered_leads ${clause} ${order} LIMIT ?`, [...params, limit]);
  } else {
    const ids: string[] = Array.isArray(opts.ids) ? opts.ids : [];
    if (!ids.length) return { added: 0, skipped: 0, contactIds: [], approvedIds: [] };
    const ph = ids.map(() => "?").join(",");
    leads = await q(`SELECT * FROM discovered_leads WHERE id IN (${ph})`, ids);
  }

  let added = 0, skipped = 0;
  const contactIds: string[] = [];
  const approvedIds: string[] = [];
  const seenEmails = new Set<string>(); // guards against the same email twice in one batch

  for (const l of leads) {
    const email = cleanEmail(String(l.email || "")) || "";
    approvedIds.push(l.id); // approving marks it handled even if it has no email
    // A malformed address ("//info@x.com", "%20info@x.com") is unmailable —
    // approve the lead but never promote the junk into Contacts.
    if (!email || !isValidEmail(email)) { skipped++; continue; }
    // Never attempt the same email twice in one request. The contacts.email
    // UNIQUE constraint (ON CONFLICT DO NOTHING) is the hard guarantee; this just
    // keeps the counts honest and avoids redundant inserts.
    if (seenEmails.has(email)) { skipped++; continue; }
    seenEmails.add(email);
    const id = uid();
    const ins = await q(
      `INSERT INTO contacts (id,email,company,country,industry,category,phone,role_based,source,audience,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'new',?) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [
        id, email, l.name || l.domain || null, country || l.country || null, l.category || null,
        category || l.category || null, l.phone || null, ROLE_RE.test(email) ? 1 : 0, "discovery",
        // The pitch this company gets is decided by the source that found them —
        // never by whoever happens to click Approve.
        normalizeAudience(l.audience), nowIso(),
      ]
    );
    if (ins.length) { added++; contactIds.push(String(ins[0].id ?? id)); }
    else skipped++; // already an existing Contact
  }

  if (approvedIds.length) {
    // Chunked so a big batch never blows past SQLite's variable limit (999).
    for (let i = 0; i < approvedIds.length; i += 400) {
      const slice = approvedIds.slice(i, i + 400);
      const ph = slice.map(() => "?").join(",");
      await q(`UPDATE discovered_leads SET status='approved' WHERE id IN (${ph})`, slice);
    }
  }

  return { added, skipped, contactIds, approvedIds };
}
