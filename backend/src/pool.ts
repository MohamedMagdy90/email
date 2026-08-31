// The discovered-leads review pool.
//
// One approval path, shared by the manual "Approve" buttons in the UI and by
// the automation — so a lead becomes a Contact in exactly the same way however
// it was triggered. Keeping this in one place is what lets the automation reuse
// the (well-tested) filter, dedupe, address-validation and country-normalising
// rules instead of re-implementing them and drifting.

import { q, nowIso } from "./db";
import { cleanEmail, isValidEmail, isFreeMailDomain } from "./crawler/validate";
import { normalizeCountry } from "./country";

const uid = () => crypto.randomUUID();

// Mailbox names that belong to a company, not a person — flagged so sending can
// treat them differently (and so exports stay honest).
export const ROLE_RE =
  /^(info|sales|contact|support|admin|office|enquir|inquir|hello|mail|team|marketing|hr|jobs|career|reception)/i;

// The explicit "no country on file" bucket, so those leads stay reviewable
// instead of being invisible to every country filter.
export const NO_COUNTRY = "__none__";

/**
 * `source_id` on a pool row that came from a CSV/contact import rather than
 * from a discovery source.
 *
 * It exists so the fill-rate metric can tell the two apart. That card answers
 * "is DISCOVERY feeding the automation?" — a 30,000-row import is not
 * discovery, and counting it would spike the rate to something absurd for ten
 * minutes and then read as a total collapse for the rest of the day.
 */
export const IMPORT_SOURCE_ID = "__import__";

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
  /**
   * Restrict to a SET of countries (the send-window gate: only the countries
   * whose local window is open right now). `__none__` in the list means "leads
   * with no country on file". An empty array matches nothing, which is the
   * honest answer when every window is shut.
   */
  countries?: string[] | null;
}) {
  const where: string[] = [];
  const params: any[] = [];
  const status = opts.status;
  const search = opts.q;
  const country = String(opts.country || "").trim();
  const audience = String(opts.audience || "").trim();

  if (status && status !== "all") {
    where.push(`status = ?`);
    params.push(status);
  }

  if (opts.hasEmail) where.push(`(email IS NOT NULL AND email <> '')`);

  if (audience && audience !== "all") {
    where.push(audienceClause(normalizeAudience(audience)));
  }

  if (country) {
    if (country === NO_COUNTRY) {
      where.push(`(country IS NULL OR country = '')`);
    } else {
      where.push(`lower(country) = ?`);
      params.push(country.toLowerCase());
    }
  }

  if (Array.isArray(opts.countries)) {
    const list = opts.countries
      .map((c) => String(c || "").trim())
      .filter(Boolean);
    const wantsNone = list.includes(NO_COUNTRY);
    const named = list.filter((c) => c !== NO_COUNTRY);
    const parts: string[] = [];

    if (named.length) {
      parts.push(`lower(country) IN (${named.map(() => "?").join(",")})`);
      params.push(...named.map((c) => c.toLowerCase()));
    }

    if (wantsNone) parts.push(`(country IS NULL OR country = '')`);

    // No open country at all — match nothing rather than everything.
    where.push(parts.length ? `(${parts.join(" OR ")})` : `1 = 0`);
  }

  if (search) {
    const like = `%${String(search).toLowerCase()}%`;
    where.push(
      `(lower(name) LIKE ? OR lower(email) LIKE ? OR lower(domain) LIKE ? OR lower(category) LIKE ?)`
    );
    params.push(like, like, like, like);
  }

  return {
    where,
    params,
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
  };
}

// How many pending leads currently hold a usable email — the number the
// automation watches, and the one the UI counts down to the trigger. Each
// automation lane counts only its own audience.
export async function countApprovableLeads(
  search?: string | null,
  country?: string | null,
  audience?: string | null,
  countries?: string[] | null
): Promise<number> {
  const { clause, params } = discoveredWhere({
    status: "pending",
    q: search,
    hasEmail: true,
    country,
    audience,
    countries,
  });

  const r = await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads ${clause}`,
    params
  );

  return Number(r[0]?.n ?? 0);
}

/** Emailable pending leads grouped by country — what the schedule panel reads. */
export async function approvableByCountry(
  audience?: string | null
): Promise<{ country: string; n: number }[]> {
  const { clause, params } = discoveredWhere({
    status: "pending",
    hasEmail: true,
    audience,
  });

  const rows = await q(
    `SELECT COALESCE(NULLIF(country,''), '${NO_COUNTRY}') AS country,
            CAST(count(*) AS INTEGER) AS n
       FROM discovered_leads ${clause}
      GROUP BY COALESCE(NULLIF(country,''), '${NO_COUNTRY}')
      ORDER BY count(*) DESC`,
    params
  );

  return rows.map((r) => ({
    country: String(r.country),
    n: Number(r.n) || 0,
  }));
}

/* ----------------------------- approving ------------------------------ */

export interface ApproveResult {
  added: number; // contacts actually created

  /**
   * Existing contacts that had never been emailed and were taken into this
   * batch. Counted apart from `added` because no row was created — but they
   * ARE in `contactIds`, so they get the email.
   */
  adopted: number;

  skipped: number; // duplicates already emailed / no (or unmailable) email
  contactIds: string[]; // the new contact rows (what the automation emails)
  approvedIds: string[]; // pool rows marked 'approved'

  /**
   * contact id → the pool row it came from.
   *
   * Approving is destructive: the lead leaves the pool the moment this returns,
   * before a single email has been attempted. When the sender then can't
   * deliver to some of them, this map is how the caller knows WHICH pool rows
   * to put back — see `requeueLeads`.
   */
  leadByContact: Record<string, string>;
}

export interface ApproveOptions {
  ids?: string[];
  all?: boolean;
  q?: string | null;
  filterCountry?: string | null; // which rows to act on (matches the table's filter)
  filterCountries?: string[] | null; // only these countries (the open send windows)
  filterAudience?: string | null; // customer | partner (blank = both)
  category?: string | null; // contact category to save them under
  country?: string | null; // country override (blank = keep the lead's own)
  limit?: number; // cap the batch (the automation approves N at a time)
  oldestFirst?: boolean; // FIFO — the automation drains the pool in order
}

// Approve leads → create Contacts (only the ones with a mailable email) and mark
// the pool rows 'approved'. Returns the ids of the contacts it created so a
// caller can act on exactly this batch — that's how the automation knows who to
// email without re-querying and catching unrelated contacts.
export async function approveLeads(
  opts: ApproveOptions
): Promise<ApproveResult> {
  const category = String(opts.category ?? "").trim() || null;

  // Normalised so an override always matches the spelling the filter and the
  // Contacts list use.
  const rawCountry = String(opts.country ?? "").trim();
  const country = normalizeCountry(rawCountry) || rawCountry || null;

  let leads: any[];

  if (opts.all === true) {
    const { clause, params } = discoveredWhere({
      status: "pending",
      q: opts.q,
      hasEmail: true,
      country: opts.filterCountry,
      audience: opts.filterAudience,
      countries: opts.filterCountries,
    });

    const limit = Math.max(
      1,
      Math.min(Number(opts.limit) || 5000, 20000)
    );
    const order = opts.oldestFirst
      ? `ORDER BY created_at ASC, id ASC`
      : "";

    leads = await q(
      `SELECT * FROM discovered_leads ${clause} ${order} LIMIT ?`,
      [...params, limit]
    );
  } else {
    const ids: string[] = Array.isArray(opts.ids) ? opts.ids : [];

    if (!ids.length) {
      return {
        added: 0,
        adopted: 0,
        skipped: 0,
        contactIds: [],
        approvedIds: [],
        leadByContact: {},
      };
    }

    const ph = ids.map(() => "?").join(",");
    leads = await q(
      `SELECT * FROM discovered_leads WHERE id IN (${ph})`,
      ids
    );
  }

  let added = 0;
  let adopted = 0;
  let skipped = 0;

  const contactIds: string[] = [];
  const approvedIds: string[] = [];
  const leadByContact: Record<string, string> = {};
  const seenEmails = new Set<string>(); // guards against the same email twice in one batch

  for (const l of leads) {
    const email = cleanEmail(String(l.email || "")) || "";

    approvedIds.push(l.id); // approving marks it handled even if it has no email

    // A malformed address ("//info@x.com", "%20info@x.com") is unmailable —
    // approve the lead but never promote the junk into Contacts.
    if (!email || !isValidEmail(email)) {
      skipped++;
      continue;
    }

    // Never attempt the same email twice in one request. The contacts.email
    // UNIQUE constraint (ON CONFLICT DO NOTHING) is the hard guarantee; this
    // just keeps the counts honest and avoids redundant inserts.
    if (seenEmails.has(email)) {
      skipped++;
      continue;
    }

    seenEmails.add(email);

    const id = uid();
    const leadAudience = normalizeAudience(l.audience);

    const ins = await q(
      `INSERT INTO contacts
        (id,email,company,country,industry,category,phone,role_based,source,audience,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'new',?)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [
        id,
        email,
        l.name || l.domain || null,
        country || l.country || null,
        l.category || null,
        category || l.category || null,
        l.phone || null,
        ROLE_RE.test(email) ? 1 : 0,
        "discovery",
        // The pitch this company gets is decided by the source that found
        // them — never by whoever happens to click Approve.
        leadAudience,
        nowIso(),
      ]
    );

    if (ins.length) {
      const contactId = String(ins[0].id ?? id);
      added++;
      contactIds.push(contactId);
      leadByContact[contactId] = String(l.id);
      continue;
    }

    // ---- Already a Contact. That is NOT the same as "already handled". -----
    //
    // The row losing the insert race used to be counted as a duplicate and
    // dropped, which is right for someone we have emailed before and wrong for
    // everybody else. A contact that arrived by CSV import (or was typed in by
    // hand) and has never actually been sent anything is a perfectly good
    // recipient — and under the old behaviour was unreachable by the
    // automation for ever, because the automation only emails the ids that its
    // own approve step created.
    //
    // Ground truth for "have we emailed them" is the sends ledger, not
    // `contacts.status`: the status column is also moved by bounce and
    // unsubscribe handling, whereas a row in `sends` means an email was
    // genuinely built and handed to the sender for that contact.
    const existing = (
      await q(
        `SELECT id, status, audience, category
           FROM contacts
          WHERE email = ?`,
        [email]
      )
    )[0] as any;

    if (!existing) {
      skipped++;
      continue;
    }

    if (
      existing.status === "unsubscribed" ||
      existing.status === "bounced"
    ) {
      skipped++;
      continue;
    }

    const alreadySent = await q(
      `SELECT 1 AS x
         FROM sends
        WHERE contact_id = ?
        LIMIT 1`,
      [String(existing.id)]
    );

    if (alreadySent.length) {
      skipped++;
      continue;
    }

    // Take it into the batch, and let the lead fill in what the contact is
    // missing. An imported contact has no audience at all (the bulk endpoint
    // never wrote one), so without this it could never be routed to a lane.
    const patch: string[] = [];
    const vals: any[] = [];

    if (!String(existing.audience || "").trim()) {
      patch.push(`audience = ?`);
      vals.push(leadAudience);
    }

    if (category && !String(existing.category || "").trim()) {
      patch.push(`category = ?`);
      vals.push(category);
    }

    if (patch.length) {
      await q(
        `UPDATE contacts SET ${patch.join(", ")} WHERE id = ?`,
        [...vals, String(existing.id)]
      ).catch(() => {});
    }

    adopted++;
    contactIds.push(String(existing.id));
    leadByContact[String(existing.id)] = String(l.id);
  }

  if (approvedIds.length) {
    // Chunked so a big batch never blows past SQLite's variable limit (999).
    for (let i = 0; i < approvedIds.length; i += 400) {
      const slice = approvedIds.slice(i, i + 400);
      const ph = slice.map(() => "?").join(",");

      await q(
        `UPDATE discovered_leads
            SET status='approved'
          WHERE id IN (${ph})`,
        slice
      );
    }
  }

  return {
    added,
    adopted,
    skipped,
    contactIds,
    approvedIds,
    leadByContact,
  };
}

/* ------------------------ putting leads back ---------------------------- */

/**
 * Return pool rows to `pending` after a batch could not be delivered.
 *
 * Approval and sending are two steps, and everything between them is a chance
 * for the second one not to happen — every domain capped out, the template
 * deleted mid-batch, the process restarted. The lead has already left the pool
 * by then, and because the lanes only ever count `status='pending'` it would
 * never be looked at again: approved, turned into a contact, never emailed,
 * invisible for ever.
 *
 * Guarded by `status='approved'` so this can only ever undo the automation's
 * own claim. A lead a human has since rejected, or one that genuinely was
 * emailed, is left exactly where it is.
 */
export async function requeueLeads(leadIds: string[]): Promise<number> {
  const ids = [
    ...new Set(
      leadIds.map((x) => String(x || "")).filter(Boolean)
    ),
  ];

  if (!ids.length) return 0;

  let n = 0;

  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400);
    const ph = slice.map(() => "?").join(",");

    const r = await q(
      `UPDATE discovered_leads
          SET status='pending'
        WHERE id IN (${ph})
          AND status='approved'
       RETURNING id`,
      slice
    );

    n += r.length;
  }

  return n;
}

/* --------------------- recovering stranded leads ------------------------ */

/**
 * A lead that was approved, became a contact, and was then never emailed.
 *
 * This is the wreckage left by any run that approved a batch it could not
 * send — most of all the "done · sent 0" runs that happened once the sending
 * domains had quietly used up their daily caps.
 *
 * The sends ledger is the ground truth for "did we email them", exactly as it
 * is in `approveLeads`: no row means no email was ever built for that contact,
 * whatever the status column happens to say. Opt-outs are excluded — those
 * leads are correctly finished with.
 *
 * Note this deliberately does NOT reuse `ADOPTABLE_SQL` below. That one
 * excludes any contact that already has a pool row, which is right for its own
 * job (queueing contacts that never came from the pool) and precisely wrong
 * here: a stranded lead is defined by still having one.
 */
const STRANDED_SQL = `
  FROM discovered_leads dl
  JOIN contacts c ON c.email = dl.email
 WHERE dl.status = 'approved'
   AND c.status NOT IN ('unsubscribed','bounced')
   AND NOT EXISTS (
     SELECT 1
       FROM sends s
      WHERE s.contact_id = c.id
   )`;

export async function countStrandedLeads(): Promise<number> {
  const r = await q(
    `SELECT CAST(count(*) AS INTEGER) AS n ${STRANDED_SQL}`
  );

  return Number(r[0]?.n ?? 0);
}

/**
 * Put every stranded lead back into the pool.
 *
 * Idempotent and safe to run repeatedly: once a lead is `pending` again it no
 * longer matches, and when a lane later re-approves it `approveLeads` finds the
 * contact already on file with an empty ledger and ADOPTS it into the batch —
 * so nobody is duplicated and nobody is emailed twice.
 */
export async function requeueStrandedLeads(
  limit = 50000
): Promise<number> {
  const cap = Math.max(
    1,
    Math.min(Number(limit) || 50000, 200000)
  );

  const rows = await q(
    `UPDATE discovered_leads
        SET status='pending'
      WHERE id IN (
        SELECT dl.id ${STRANDED_SQL}
        LIMIT ?
      )
     RETURNING id`,
    [cap]
  );

  return rows.length;
}

/* ------------------------- importing into the pool --------------------- */

export interface ImportLeadRow {
  email: string;
  company?: string | null;
  country?: string | null;
  industry?: string | null;
  category?: string | null;
  phone?: string | null;
}

export interface ImportToPoolResult {
  added: number; // new pending pool rows
  duplicate: number; // already in the pool (same address)
  invalid: number; // no address, or one that could never be mailed
}

/**
 * Put rows into the REVIEW POOL rather than straight into Contacts.
 *
 * This is what makes an import reachable by the automation at all: the lanes
 * count `discovered_leads`, never `contacts`, so anything written directly to
 * Contacts is invisible to them for ever.
 *
 * Deliberately NOT reusing discovery's `insertDiscovered`: that one drops any
 * lead whose address already belongs to a Contact (correct when the crawler
 * re-finds a company you already have, exactly wrong when the operator is
 * explicitly asking for these people to be queued), and it claims the domain
 * for crawling, which an imported row never needs.
 */
export async function importLeadsToPool(
  rows: ImportLeadRow[],
  opts: {
    audience?: string | null;
    label?: string | null;
    category?: string | null;
    country?: string | null;
  } = {}
): Promise<ImportToPoolResult> {
  const audience = normalizeAudience(opts.audience);
  const label = String(opts.label || "CSV import").slice(0, 120);
  const forcedCategory = String(opts.category ?? "").trim() || null;
  const rawCountry = String(opts.country ?? "").trim();
  const forcedCountry = normalizeCountry(rawCountry) || rawCountry || null;

  let added = 0;
  let duplicate = 0;
  let invalid = 0;

  const seen = new Set<string>();

  for (const r of rows) {
    const email = cleanEmail(String(r?.email || "")) || "";

    if (!email || !isValidEmail(email)) {
      invalid++;
      continue;
    }

    if (seen.has(email)) {
      duplicate++;
      continue;
    }

    seen.add(email);

    // The domain is only recorded when it identifies a company. A free-mail
    // host does not, and writing "gmail.com" into `domain` would let one
    // gmail lead block every other one through domain-level de-duplication.
    const host = (email.split("@")[1] || "").trim().toLowerCase();
    const domain = host && !isFreeMailDomain(host) ? host : null;
    const country =
      forcedCountry ||
      normalizeCountry(String(r?.country || "")) ||
      String(r?.country || "").trim() ||
      null;
    const now = nowIso();

    const ins = await q(
      `INSERT INTO discovered_leads
        (id,dedup_key,name,website,domain,email,phone,city,country,category,audience,
         source_id,source_label,status,enriched,enrich_status,confidence,via,created_at,email_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,'pending',1,'import',?,'import',?,?)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [
        uid(),
        // Same key shape discovery uses for an address-bearing lead, so an
        // import and a crawl can never file the same person twice.
        "e:" + email,
        String(r?.company || "").trim() || domain || email,
        domain ? `https://${domain}` : null,
        domain,
        email,
        String(r?.phone || "").trim() || null,
        country,
        forcedCategory ||
          String(r?.category || r?.industry || "").trim() ||
          null,
        audience,
        IMPORT_SOURCE_ID,
        label,
        // We were handed the address; there is nothing to be confident about
        // and nothing to crawl. `enriched=1` keeps it out of the enrich queue.
        "listed",
        now,
        // It is emailable the instant it lands. The fill-rate query filters
        // imports out by source, so this cannot distort discovery's health.
        now,
      ]
    );

    if (ins.length) added++;
    else duplicate++;
  }

  return { added, duplicate, invalid };
}

/* --------------------- backfilling contacts already held --------------- */

/**
 * A contact is adoptable when it can still be emailed and never has been:
 * a real address, not opted out, and no row in the sends ledger. Written once
 * and shared by the count and the backfill so the button can never offer a
 * number it will not deliver — the same rule the pool tools learned the hard
 * way.
 */
const ADOPTABLE_SQL = `
  FROM contacts c
 WHERE c.email IS NOT NULL AND c.email <> ''
   AND c.status NOT IN ('unsubscribed','bounced')
   AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.contact_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM discovered_leads d WHERE d.email = c.email)`;

export interface AdoptableSummary {
  /** Contacts that could be queued right now. */
  adoptable: number;
  /** Of those, the ones that arrived by import rather than by hand. */
  imported: number;
  /** Contacts already emailed at least once — shown so the number has context. */
  alreadyEmailed: number;
}

export async function countAdoptableContacts(): Promise<AdoptableSummary> {
  const [all, imported, sent] = await Promise.all([
    q(
      `SELECT CAST(count(*) AS INTEGER) AS n ${ADOPTABLE_SQL}`
    ),
    q(
      `SELECT CAST(count(*) AS INTEGER) AS n
         ${ADOPTABLE_SQL}
          AND lower(COALESCE(c.source,'')) IN ('import','csv')`
    ),
    q(
      `SELECT CAST(count(DISTINCT contact_id) AS INTEGER) AS n
         FROM sends
        WHERE contact_id IS NOT NULL`
    ),
  ]);

  return {
    adoptable: Number(all[0]?.n ?? 0),
    imported: Number(imported[0]?.n ?? 0),
    alreadyEmailed: Number(sent[0]?.n ?? 0),
  };
}

export interface AdoptOptions {
  /** Restrict to contacts that arrived by import (default) or take every one. */
  importedOnly?: boolean;
  /** Lane to queue them under. Blank keeps each contact's own tag. */
  audience?: string | null;
  category?: string | null;
  country?: string | null;
  /** Safety valve — process at most this many in one pass. */
  limit?: number;
  /** Called after each chunk, so a 30k backfill can report progress. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * ONE-TIME BACKFILL for contacts that were imported before the pool route
 * existed. Creates a pending pool row per never-emailed contact so the
 * automation can see, batch, schedule and send to them under all its normal
 * rails.
 *
 * The contact row is left exactly as it is. When the lane later approves the
 * pool row, `approveLeads` finds the address already taken, sees the ledger is
 * empty for it, and adopts that existing contact into the batch — which is why
 * this backfill and the adoption change have to ship together.
 *
 * Idempotent: `ADOPTABLE_SQL` excludes any contact that already has a pool row,
 * so running it twice queues nobody twice, and a pass that dies half way can
 * simply be run again.
 */
export async function adoptContactsToPool(
  opts: AdoptOptions = {}
): Promise<ImportToPoolResult & { scanned: number }> {
  const limit = Math.max(
    1,
    Math.min(Number(opts.limit) || 50000, 200000)
  );
  const importedOnly = opts.importedOnly !== false;
  const filter = importedOnly
    ? ` AND lower(COALESCE(c.source,'')) IN ('import','csv')`
    : "";

  const rows = await q(
    `SELECT c.email, c.company, c.country, c.industry, c.category, c.phone, c.audience
       ${ADOPTABLE_SQL}${filter}
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT ?`,
    [limit]
  );

  const override = String(opts.audience || "").trim();

  let added = 0;
  let duplicate = 0;
  let invalid = 0;

  // Chunked, and grouped by lane inside each chunk: a contact that already
  // carries a tag keeps it, and only the untagged ones take the override. One
  // call per contact would be 30,000 round trips — minutes of latency for work
  // that batches perfectly well.
  const CHUNK = 500;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const byLane = new Map<string, ImportLeadRow[]>();

    for (const c of slice) {
      const lane =
        override ||
        String((c as any).audience || "").trim() ||
        "customer";
      const list = byLane.get(lane) || [];

      list.push({
        email: String((c as any).email || ""),
        company: (c as any).company,
        country: (c as any).country,
        industry: (c as any).industry,
        category: (c as any).category,
        phone: (c as any).phone,
      });

      byLane.set(lane, list);
    }

    for (const [lane, list] of byLane) {
      const r = await importLeadsToPool(list, {
        audience: lane,
        label: "Imported contacts",
        category: opts.category ?? null,
        country: opts.country ?? null,
      });

      added += r.added;
      duplicate += r.duplicate;
      invalid += r.invalid;
    }

    opts.onProgress?.(
      Math.min(i + CHUNK, rows.length),
      rows.length
    );
  }

  return {
    scanned: rows.length,
    added,
    duplicate,
    invalid,
  };
}
