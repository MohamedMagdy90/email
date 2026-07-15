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
    role_based INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
  )`);

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
