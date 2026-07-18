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
  const db = new Database("data.sqlite");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  query = async (text, params = []) => {
    const isRead = /^\s*(select|with)\b/i.test(text) || /\breturning\b/i.test(text);
    const stmt = db.query(text);
    if (isRead) return stmt.all(...(params as any[])) as Row[];
    stmt.run(...(params as any[]));
    return [];
  };
  console.log("[db] using SQLite (data.sqlite)");
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
    sent_at TEXT,
    created_at TEXT NOT NULL
  )`);

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
