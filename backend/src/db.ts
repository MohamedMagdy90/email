// Unified data layer with portable SQL (uses `?` placeholders everywhere).
//  - Local / preview: bun:sqlite (built-in, instant, reliable)
//  - Production (Railway): postgres.js via DATABASE_URL
// SQL is kept to a portable subset: no now()/interval/date_trunc, booleans as 0/1,
// timestamps as ISO text, CAST(... AS INTEGER) for counts, ON CONFLICT upserts.

type Row = Record<string, any>;
type QueryFn = (text: string, params?: any[]) => Promise<Row[]>;

let query: QueryFn;
const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
  query = async (text, params = []) => {
    let i = 0;
    const pgText = text.replace(/\?/g, () => `$${++i}`); // ?  ->  $1, $2, ...
    const res = await sql.unsafe(pgText, params as any[]);
    return res as unknown as Row[];
  };
  console.log("[db] using Postgres (DATABASE_URL)");
} else {
  const { Database } = await import("bun:sqlite");
  // SQLITE_PATH lets a second process (a script, a test) use its own file —
  // two processes sharing one WAL database corrupts it.
  const file = process.env.SQLITE_PATH || "data.sqlite";

  // ⚠️ THE HANDLE IS PINNED TO globalThis ON PURPOSE — do not "simplify" this
  // back to a bare `new Database(file)`.
  //
  // `bun --watch` re-evaluates this module in the SAME PROCESS on every save.
  // A module-scope `new Database(file)` therefore opens ANOTHER handle on the
  // same WAL each time, and the previous one is never closed — so a dev session
  // that edits a few backend files ends up with several live writers inside one
  // process. That is the same hazard as running two dev servers, and it is the
  // most likely explanation for this database being found corrupt at boot in
  // session after session (seven parked copies in `.same/` and counting).
  // Reusing one handle across reloads costs nothing and removes the cause.
  const g = globalThis as unknown as { __dnaSqlite?: any };

  // WAL IS OFF BY DEFAULT HERE, AND THAT IS DELIBERATE.
  //
  // This project has parked EIGHT corrupt copies of this file in `.same/`, one
  // per session, always discovered as "malformed" at boot. WAL mode needs a
  // shared-memory `-shm` file plus working POSIX locking; inside this container
  // the workspace sits on an overlay filesystem where neither is dependable, so
  // an ordinary interruption — the dev server being SIGKILLed by a supervisor,
  // say — leaves the `-wal`/`-shm` pair inconsistent with the main file and the
  // next open fails outright. A rollback journal needs no shared memory and no
  // second reader, and simply replays or discards on open.
  //
  // Production is Postgres, so nothing here is on the hot path that matters.
  // Set SQLITE_WAL=1 to opt back in on a filesystem that can take it.
  const openDb = (path: string) => {
    const d = new Database(path);
    d.exec(process.env.SQLITE_WAL === "1" ? "PRAGMA journal_mode = WAL;" : "PRAGMA journal_mode = TRUNCATE;");
    d.exec("PRAGMA busy_timeout = 5000;");
    d.exec("PRAGMA synchronous = FULL;");
    d.query("SELECT count(*) FROM sqlite_master").all(); // prove it really opens
    return d;
  };

  let db = g.__dnaSqlite;
  if (!db) {
    try {
      db = openDb(file);
    } catch (e: any) {
      // A corrupt LOCAL dev database must not turn into a boot loop. Park it
      // (never delete — it is the only copy of whatever was in it) and carry on
      // with an empty one, saying loudly where it went.
      if (!/malformed|corrupt|not a database/i.test(String(e?.message || e))) throw e;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const parked = `${file}.corrupt-${stamp}`;
      try {
        const { renameSync, existsSync } = await import("node:fs");
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(file + suffix)) renameSync(file + suffix, parked + suffix);
        }
      } catch { /* if it cannot be moved, the retry below will fail loudly */ }
      console.error(`[db] ${file} was corrupt — parked it as ${parked} and started a fresh one. Production (Postgres) is unaffected.`);
      db = openDb(file);
    }
    g.__dnaSqlite = db;
  }
  query = async (text, params = []) => {
    const isRead = /^\s*(select|with)\b/i.test(text) || /\breturning\b/i.test(text);
    const stmt = db.query(text);
    if (isRead) return stmt.all(...(params as any[])) as Row[];
    stmt.run(...(params as any[]));
    return [];
  };
  console.log(`[db] using SQLite (${file})`);
}

export const q = query;

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureSchema() {
  await q(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    company TEXT,
    country TEXT,
    industry TEXT,
    category TEXT,
    phone TEXT,
    role_based INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
  )`);

  // Migrations for existing databases. Safe to run every boot: a duplicate-column
  // error is swallowed, so this is idempotent.
  try { await q(`ALTER TABLE contacts ADD COLUMN category TEXT`); } catch { /* already exists */ }
  try { await q(`ALTER TABLE contacts ADD COLUMN phone TEXT`); } catch { /* already exists */ }
  // WHO this contact is: a prospective 'customer' (we sell them DNA ERP) or a
  // prospective 'partner' (we sell them the Makers program). It rides in from
  // the discovery source that found them, and it decides which automation lane
  // — and which email — they get. NULL on every pre-existing row, and every
  // read treats NULL as 'customer', which is what the app was before this.
  try { await q(`ALTER TABLE contacts ADD COLUMN audience TEXT`); } catch { /* already exists */ }

  await q(`CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'customer',
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  await q(`CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL,
    daily_cap INTEGER NOT NULL DEFAULT 40,
    sent_today INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`);

  await q(`CREATE TABLE IF NOT EXISTS sends (
    id TEXT PRIMARY KEY,
    contact_id TEXT,
    contact_email TEXT,
    template_id TEXT,
    domain_id TEXT,
    subject TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    opened INTEGER NOT NULL DEFAULT 0,
    open_count INTEGER NOT NULL DEFAULT 0,
    first_opened_at TEXT,
    last_opened_at TEXT,
    click_count INTEGER NOT NULL DEFAULT 0,
    first_clicked_at TEXT,
    last_clicked_at TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL
  )`);

  // Engagement tracking migrations (idempotent — duplicate-column errors swallowed).
  try { await q(`ALTER TABLE sends ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE sends ADD COLUMN first_opened_at TEXT`); } catch { /* exists */ }
  try { await q(`ALTER TABLE sends ADD COLUMN last_opened_at TEXT`); } catch { /* exists */ }
  try { await q(`ALTER TABLE sends ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE sends ADD COLUMN first_clicked_at TEXT`); } catch { /* exists */ }
  try { await q(`ALTER TABLE sends ADD COLUMN last_clicked_at TEXT`); } catch { /* exists */ }
  // Backfill: legacy opened rows had no counter — treat as one open.
  try { await q(`UPDATE sends SET open_count = 1 WHERE opened = 1 AND open_count = 0`); } catch { /* ignore */ }

  // Follow-up ladder: which rung of a sequence a send belongs to.
  //   followup_step   0 = the original email · 1 = first retry · 2 = second retry
  //   followup_branch why the retry went out — 'no_open' | 'no_click'
  // Step 0 is what makes a send the START of a sequence, so the engine can count
  // "emails in THIS sequence" instead of every email the contact has ever had
  // (a contact mailed in an old campaign must still be followable-up today).
  try { await q(`ALTER TABLE sends ADD COLUMN followup_step INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE sends ADD COLUMN followup_branch TEXT`); } catch { /* exists */ }
  // The follow-up scan groups the whole sends table by contact, so both of these
  // are on its hot path.
  try { await q(`CREATE INDEX IF NOT EXISTS idx_sends_contact ON sends(contact_id)`); } catch { /* ignore */ }
  try { await q(`CREATE INDEX IF NOT EXISTS idx_sends_sent_at ON sends(sent_at)`); } catch { /* ignore */ }

  await q(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Persistent crawl ledger: remembers every domain we've ever scanned so we
  // never waste time (or rate-limit budget) re-crawling the same site.
  await q(`CREATE TABLE IF NOT EXISTS crawled_domains (
    domain TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'ok',
    emails_found INTEGER NOT NULL DEFAULT 0,
    pages_crawled INTEGER NOT NULL DEFAULT 0,
    first_crawled_at TEXT NOT NULL,
    last_crawled_at TEXT NOT NULL
  )`);

  /* ------------------------- 24/7 Discovery bot ------------------------ */

  // "Watchers" the background bot cycles through. Each is a (location,
  // industry) pair the bot re-runs on its own interval, forever, server-side.
  await q(`CREATE TABLE IF NOT EXISTS discovery_sources (
    id TEXT PRIMARY KEY,
    location TEXT NOT NULL,
    place_json TEXT,
    category TEXT NOT NULL,
    limit_n INTEGER NOT NULL DEFAULT 40,
    interval_minutes INTEGER NOT NULL DEFAULT 360,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    runs INTEGER NOT NULL DEFAULT 0,
    total_found INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);

  // Directory-source support (idempotent migrations). A 'directory' source walks
  // a business-directory URL page-by-page, continuously, until exhausted —
  // `cursor` is the next page to fetch, `exhausted` marks the end of the list.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN type TEXT NOT NULL DEFAULT 'osm'`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN base_url TEXT`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN cursor INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN exhausted INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN empty_streak INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  // STALENESS — "this source ran again and still fetched nobody".
  //
  // Deliberately NOT `empty_streak`, which is walk bookkeeping: it means "these
  // pages held no more listings" (it drives `exhausted`), it is reset by a
  // manual Run now, and it never applies to map areas at all. What a human
  // wants to know is simpler and blunter: how many completed runs in a row have
  // added zero NEW leads to the pool, because two of those in a row means the
  // source is spent and should be replaced.
  //   barren_runs   consecutive completed runs that added nothing new
  //   last_found    new leads the most recent completed run added
  //   last_found_at when this source last actually produced a lead
  // A run that ERRORED, was rate-limited or was stopped mid-flight is not
  // counted — that is a blocked source, not a stale one, and the two need
  // different fixes.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN barren_runs INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN last_found INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN last_found_at TEXT`); } catch { /* exists */ }
  // Consecutive rate-limit blocks, so the pause escalates (3 → 6 → 12 → 24 → 30
  // min) instead of jumping straight to the source's full interval. A search
  // that hit a per-minute ceiling recovers in minutes, not an hour.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN block_streak INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  // A 'search' source runs free-text web searches (keywords × cities), walking a
  // generated query plan by `cursor`. Optional custom keywords live here; when
  // blank the bot derives them from the category.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN keywords TEXT`); } catch { /* exists */ }
  // The EXACT URL a directory walk must resume from. A page NUMBER can't describe
  // every pager (Drupal's multi-pager "?page=0,7", rel=next-only pagers, opaque
  // tokens), so the crawler hands back the next unread page and we store it.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN next_url TEXT`); } catch { /* exists */ }
  // Archiving: retire a source without losing it (or the leads it found). An
  // archived source is invisible to the worker and to every count, and can be
  // restored later exactly where it left off.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN archived_at TEXT`); } catch { /* exists */ }
  // A Map-area ('osm') source sweeps its country tile-by-tile, reusing `cursor`
  // as "next tile". `osm_tiles` is how many tiles the grid has, and
  // `osm_available` is how many contactable businesses OpenStreetMap holds in
  // that area in total — the hard ceiling, so the UI can show real coverage
  // instead of leaving a finished source looking stuck.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN osm_tiles INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN osm_available INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  // WHO this source is hunting: 'customer' (companies we sell DNA ERP to) or
  // 'partner' (accounting firms, VARs, consultancies we sell the Makers program
  // to). Every lead it files inherits the tag, so the two audiences can never be
  // emailed the same pitch by accident. Existing sources default to 'customer'.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN audience TEXT NOT NULL DEFAULT 'customer'`); } catch { /* exists */ }
  // Web-search sources: also walk Common Crawl's index of the country's own
  // ccTLD, not just the keyword queries. The index answers "which hosts exist
  // under .qa", which is a far bigger set than "the firms that rank for the
  // phrases we thought of".
  //
  // Defaults OFF, and this is a deliberate reversal. A ccTLD is a list of every
  // host in a country, not a list of its businesses: switched on by default it
  // filed `alabama.qa`, `agdoha2030.qa` and `akhlaquna.qa` as company leads,
  // each named after its own hostname, and buried the real results. It is now
  // opt-in, per source, with the host filter it always needed.
  try { await q(`ALTER TABLE discovery_sources ADD COLUMN sweep_country INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  // Sources created while the default was ON are still carrying it. Turn them
  // off ONCE — guarded by a settings flag, so a user who deliberately switches
  // it back on doesn't have it taken away again on the next boot.
  try {
    const done = await getSetting("sweep_country_default_off_v1");
    if (!done) {
      const rows = await q(`UPDATE discovery_sources SET sweep_country=0 WHERE sweep_country=1 RETURNING id`);
      if (rows.length) {
        console.log(`[db] country sweep switched off on ${rows.length} existing source(s) — it was filing non-companies; re-enable per source if you want it`);
      }
      await setSetting("sweep_country_default_off_v1", new Date().toISOString());
    }
  } catch { /* non-fatal */ }

  // The growing pool of companies the bot has found, awaiting your review.
  // dedup_key (domain / email / name+city) keeps the same company from being
  // added twice across ticks or sources.
  await q(`CREATE TABLE IF NOT EXISTS discovered_leads (
    id TEXT PRIMARY KEY,
    dedup_key TEXT UNIQUE,
    name TEXT,
    website TEXT,
    domain TEXT,
    email TEXT,
    phone TEXT,
    city TEXT,
    country TEXT,
    category TEXT,
    source_id TEXT,
    source_label TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    enriched INTEGER NOT NULL DEFAULT 0,
    confidence TEXT,
    via TEXT,
    created_at TEXT NOT NULL
  )`);

  // Fast lookups for email de-duplication in the pool (never unique — many leads
  // legitimately have no email/NULL — the app guarantees email-uniqueness itself).
  try { await q(`CREATE INDEX IF NOT EXISTS idx_discovered_leads_email ON discovered_leads(email)`); } catch { /* ignore */ }

  // Enrichment retry state (idempotent migrations). A BLOCKED / rate-limited /
  // errored crawl must NOT be treated like a genuine "no email" — otherwise a
  // transient Cloudflare wall permanently discards a recoverable lead. Track the
  // retry count + a backoff (`next_enrich_at`) so we come back to it, and record
  // WHY the last attempt failed (`enrich_status`: found | empty | blocked | error)
  // so the historical blocked ones can be re-run in bulk later.
  try { await q(`ALTER TABLE discovered_leads ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovered_leads ADD COLUMN next_enrich_at TEXT`); } catch { /* exists */ }
  try { await q(`ALTER TABLE discovered_leads ADD COLUMN enrich_status TEXT`); } catch { /* exists */ }
  // Due-lead scan hits (enriched=0, next_enrich_at) on every enrich tick.
  try { await q(`CREATE INDEX IF NOT EXISTS idx_discovered_leads_enrich ON discovered_leads(enriched, next_enrich_at)`); } catch { /* ignore */ }
  // Domain lookups (the pool-domain backfill + junk sweeps scan by domain).
  try { await q(`CREATE INDEX IF NOT EXISTS idx_discovered_leads_domain ON discovered_leads(domain)`); } catch { /* ignore */ }
  // Customer or partner — copied from the source that found this lead, and
  // carried onto the contact when it's approved. NULL = discovered before the
  // tag existed, and is read everywhere as 'customer'.
  try { await q(`ALTER TABLE discovered_leads ADD COLUMN audience TEXT`); } catch { /* exists */ }
  // The automation counts and drains the pool one audience at a time.
  try { await q(`CREATE INDEX IF NOT EXISTS idx_discovered_leads_audience ON discovered_leads(audience)`); } catch { /* ignore */ }

  /* ------------------------- Pool domain ledger ------------------------ */

  // ONE permanent row per domain the discovery pool has ever considered.
  //
  // discovered_leads.dedup_key cannot do this job on its own: when enrichment
  // finds an address we promote the key from "d:<domain>" to "e:<email>" (so a
  // future lead carrying that address collides). That promotion FREES the
  // domain key — so the next search query re-inserts the very same site and we
  // crawl all six of its pages again. In production roughly one crawl in five
  // was a re-crawl of a domain we had already resolved.
  //
  // This ledger is the durable claim. It outlives the lead row, so approving,
  // deleting or retiring a lead can never make its domain crawlable again.
  //   outcome: seen | found | empty | blocked | junk
  await q(`CREATE TABLE IF NOT EXISTS pool_domains (
    domain TEXT PRIMARY KEY,
    outcome TEXT NOT NULL DEFAULT 'seen',
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  /* ---------------------- Search query saturation ---------------------- */

  // Per (source, query, page): how many consecutive passes it produced nothing
  // new, and the earliest time it is worth asking again.
  //
  // A country/city/keyword pair saturates — after a few passes "civil
  // contractor Fujairah UAE" has surfaced everything the engine will show us,
  // and in the production log whole batches came back "+0 new" while still
  // costing a request each and counting against the engine's rate limit.
  //
  // Deliberately a COOL-OFF, not a permanent skip: sites get published, so a
  // saturated query becomes useful again later. The wait doubles (6h → 72h max)
  // and resets to zero the moment the query yields anything.
  await q(`CREATE TABLE IF NOT EXISTS search_query_stats (
    source_id TEXT NOT NULL,
    q TEXT NOT NULL,
    offset_n INTEGER NOT NULL DEFAULT 0,
    zero_streak INTEGER NOT NULL DEFAULT 0,
    retry_after TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_id, q, offset_n)
  )`);

  /* --------------------------- Automation ledger ------------------------ */
  // Every automation run (auto-approve a batch of emailable leads → email them)
  // is written here, so "when did it last run, and what did it do?" is always
  // answerable — including the runs that were skipped, and why.
  await q(`CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    trigger TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL DEFAULT 'running',
    threshold INTEGER NOT NULL DEFAULT 0,
    pool_count INTEGER NOT NULL DEFAULT 0,
    approved INTEGER NOT NULL DEFAULT 0,
    contacts_added INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    template_names TEXT,
    job_id TEXT,
    note TEXT,
    error TEXT
  )`);
  try { await q(`CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at)`); } catch { /* ignore */ }
  // Which lane the run belongs to — 'customer' or 'partner'. The two lanes have
  // their own trigger, templates and cooldown, so every run has to say which one
  // it was, or the ledger (and the cooldown that reads it) mixes them up.
  try { await q(`ALTER TABLE automation_runs ADD COLUMN audience TEXT NOT NULL DEFAULT 'customer'`); } catch { /* exists */ }

  /* -------------------------- Follow-up ledger ------------------------- */
  // One row per follow-up pass (the sweep that emails everyone whose retry is
  // due). Mirrors automation_runs on purpose: same shape, same reasoning —
  // "what did it do, and why did it refuse?" must always be answerable.
  await q(`CREATE TABLE IF NOT EXISTS followup_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    trigger TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL DEFAULT 'running',
    due_count INTEGER NOT NULL DEFAULT 0,
    queued INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    no_open INTEGER NOT NULL DEFAULT 0,
    no_click INTEGER NOT NULL DEFAULT 0,
    retry1 INTEGER NOT NULL DEFAULT 0,
    retry2 INTEGER NOT NULL DEFAULT 0,
    template_names TEXT,
    job_id TEXT,
    note TEXT,
    error TEXT
  )`);
  try { await q(`CREATE INDEX IF NOT EXISTS idx_followup_runs_started ON followup_runs(started_at)`); } catch { /* ignore */ }
}

/* ---------------------- Search query saturation ------------------------ */

const ZERO_STREAK_BEFORE_COOLOFF = 2;
const COOLOFF_BASE_H = 6;
const COOLOFF_MAX_H = 72;

/** Queries for this source that are still cooling off right now. */
export async function loadSaturatedQueries(sourceId: string): Promise<Set<string>> {
  const rows = await q(
    `SELECT q, offset_n FROM search_query_stats
      WHERE source_id=? AND retry_after IS NOT NULL AND retry_after > ?`,
    [sourceId, nowIso()]
  );
  return new Set(rows.map((r) => `${r.q}|${r.offset_n}`));
}

/**
 * Record what a query produced. Anything above zero clears the streak
 * immediately, so a query only cools off while it is genuinely exhausted.
 */
export async function recordQueryYield(
  sourceId: string,
  queryText: string,
  offset: number,
  foundNew: number
): Promise<void> {
  const now = nowIso();
  if (foundNew > 0) {
    await q(
      `INSERT INTO search_query_stats (source_id,q,offset_n,zero_streak,retry_after,updated_at)
       VALUES (?,?,?,0,NULL,?)
       ON CONFLICT (source_id,q,offset_n) DO UPDATE SET zero_streak=0, retry_after=NULL, updated_at=?`,
      [sourceId, queryText, offset, now, now]
    );
    return;
  }
  const prev = (await q(
    `SELECT zero_streak FROM search_query_stats WHERE source_id=? AND q=? AND offset_n=?`,
    [sourceId, queryText, offset]
  ))[0];
  const streak = (Number(prev?.zero_streak) || 0) + 1;
  let retryAfter: string | null = null;
  if (streak >= ZERO_STREAK_BEFORE_COOLOFF) {
    const hours = Math.min(COOLOFF_MAX_H, COOLOFF_BASE_H * 2 ** (streak - ZERO_STREAK_BEFORE_COOLOFF));
    retryAfter = new Date(Date.now() + hours * 3_600_000).toISOString();
  }
  await q(
    `INSERT INTO search_query_stats (source_id,q,offset_n,zero_streak,retry_after,updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (source_id,q,offset_n) DO UPDATE SET zero_streak=?, retry_after=?, updated_at=?`,
    [sourceId, queryText, offset, streak, retryAfter, now, streak, retryAfter, now]
  );
}

/* -------------------------- Pool domain ledger ------------------------- */

/**
 * Atomically CLAIM a domain for the discovery pool.
 *
 * Returns true only for the caller that inserted the row. Two search sources
 * running concurrently can hand us the same domain in the same millisecond, so
 * a SELECT-then-INSERT would let both through; the unique PK makes the insert
 * itself the arbiter.
 */
export async function claimPoolDomain(domain: string, outcome = "seen"): Promise<boolean> {
  const d = (domain || "").trim().toLowerCase();
  if (!d) return false;
  const now = nowIso();
  const rows = await q(
    `INSERT INTO pool_domains (domain,outcome,first_seen_at,updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT (domain) DO NOTHING RETURNING domain`,
    [d, outcome, now, now]
  );
  return rows.length > 0;
}

/** Record how a domain ended up (found / empty / blocked / junk). Never unclaims. */
export async function closePoolDomain(domain: string, outcome: string): Promise<void> {
  const d = (domain || "").trim().toLowerCase();
  if (!d) return;
  const now = nowIso();
  await q(
    `INSERT INTO pool_domains (domain,outcome,first_seen_at,updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT (domain) DO UPDATE SET outcome = ?, updated_at = ?`,
    [d, outcome, now, now, outcome, now]
  );
}

/**
 * Seed the ledger from what the pool already holds. Runs on every boot and is
 * idempotent — without it, the ~9k domains discovered before this table existed
 * would all be treated as brand new and re-crawled once each.
 */
export async function backfillPoolDomains(): Promise<number> {
  const now = nowIso();
  const rows = await q(
    `INSERT INTO pool_domains (domain,outcome,first_seen_at,updated_at)
     SELECT DISTINCT lower(domain), 'seen', ?, ?
       FROM discovered_leads
      WHERE domain IS NOT NULL AND domain <> ''
     ON CONFLICT (domain) DO NOTHING RETURNING domain`,
    [now, now]
  );
  return rows.length;
}

/* ---------------------------- Crawl ledger ---------------------------- */

// Upsert a domain into the ledger. Keeps the original first_crawled_at,
// always refreshes last_crawled_at / status / counts.
export async function recordCrawledDomain(
  domain: string,
  status: string,
  emailsFound: number,
  pagesCrawled: number
): Promise<void> {
  const d = (domain || "").toLowerCase();
  if (!d) return;
  const now = nowIso();
  await q(
    `INSERT INTO crawled_domains (domain,status,emails_found,pages_crawled,first_crawled_at,last_crawled_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (domain) DO UPDATE SET
       status = ?, emails_found = ?, pages_crawled = ?, last_crawled_at = ?`,
    [d, status, emailsFound, pagesCrawled, now, now, status, emailsFound, pagesCrawled, now]
  );
}

// Domains crawled at or after `sinceIso` (used to skip recently-scanned sites).
export async function getKnownDomains(sinceIso: string): Promise<Map<string, string>> {
  const rows = await q(
    `SELECT domain, last_crawled_at FROM crawled_domains WHERE last_crawled_at >= ?`,
    [sinceIso]
  );
  const m = new Map<string, string>();
  for (const r of rows) m.set(String(r.domain).toLowerCase(), String(r.last_crawled_at));
  return m;
}

// All email addresses we already have (to derive domains we've captured).
export async function getContactEmails(): Promise<string[]> {
  const rows = await q(`SELECT email FROM contacts`);
  return rows.map((r) => String(r.email || "").toLowerCase()).filter(Boolean);
}

export async function getSetting(key: string): Promise<string | null> {
  const r = await q(`SELECT value FROM settings WHERE key = ?`, [key]);
  return r[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await q(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = ?`,
    [key, value, value]
  );
}

/* ---------------------------- Categories ----------------------------- */
// User-defined contact categories, stored as a JSON array in settings.

export async function getCategories(): Promise<string[]> {
  const raw = await getSetting("categories");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x.trim()) : [];
  } catch {
    return [];
  }
}

export async function setCategories(list: string[]): Promise<void> {
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const v = String(s || "").trim();
    const key = v.toLowerCase();
    if (v && !seen.has(key)) { seen.add(key); clean.push(v); }
  }
  await setSetting("categories", JSON.stringify(clean.slice(0, 100)));
}
