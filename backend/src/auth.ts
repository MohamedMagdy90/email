// Simple, self-contained auth for the outreach app.
//  - Credentials live in the DB (settings table): auth_username + auth_password_hash
//  - They are seeded/updated from env vars (AUTH_USERNAME / AUTH_PASSWORD) on boot,
//    so the plaintext password never lives in the (public) repo.
//  - Login returns a stateless HMAC-signed token (signed with a persistent secret
//    stored in the DB, so it survives redeploys). No session table needed.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSetting, setSetting, q, nowIso } from "./db";

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Sessions minted by exchanging an access key. Deliberately short: the key can
 *  always mint another, so there is no reason to leave a long-lived bearer
 *  token lying around in an agent's browser profile. */
const AGENT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Get (or lazily create) the persistent token-signing secret. */
export async function getAuthSecret(): Promise<string> {
  let secret = await getSetting("auth_secret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    await setSetting("auth_secret", secret);
  }
  return secret;
}

/** On boot: if AUTH_USERNAME/AUTH_PASSWORD are set, upsert them into the DB (hashed). */
export async function seedAuthFromEnv(): Promise<void> {
  const user = process.env.AUTH_USERNAME?.trim();
  const pass = process.env.AUTH_PASSWORD;
  if (user && pass) {
    const hash = await Bun.password.hash(pass);
    await setSetting("auth_username", user);
    await setSetting("auth_password_hash", hash);
    console.log(`[auth] credentials seeded from env for user "${user}"`);
  }
  await getAuthSecret(); // ensure a signing secret exists
  const configured = await isAuthConfigured();
  if (!configured) {
    console.warn(
      "[auth] No credentials configured. Set AUTH_USERNAME and AUTH_PASSWORD env vars, then redeploy."
    );
  }
}

export async function isAuthConfigured(): Promise<boolean> {
  const [u, h] = await Promise.all([getSetting("auth_username"), getSetting("auth_password_hash")]);
  return !!u && !!h;
}

export async function getUsername(): Promise<string | null> {
  return getSetting("auth_username");
}

/** Set (or replace) the login credentials. Password is stored hashed. */
export async function setCredentials(username: string, password: string): Promise<void> {
  const hash = await Bun.password.hash(password);
  await setSetting("auth_username", username.trim());
  await setSetting("auth_password_hash", hash);
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const [storedUser, storedHash] = await Promise.all([
    getSetting("auth_username"),
    getSetting("auth_password_hash"),
  ]);
  if (!storedUser || !storedHash) return false;
  if (username !== storedUser) return false;
  try {
    return await Bun.password.verify(password, storedHash);
  } catch {
    return false;
  }
}

export async function createToken(username: string, ttlMs = TOKEN_TTL_MS): Promise<string> {
  const secret = await getAuthSecret();
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + ttlMs })
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/* ---------------------------- Access keys ---------------------------- */
// A session token is something you GET by proving who you are. An access key is
// something you HAVE. It exists for callers that cannot type a password: an
// agent driving the UI in a throwaway browser profile, a cron job, a connector.
//
// The whole design goal is that the key is *disposable*. It is stored hashed, it
// can be revoked individually, it can expire on its own, and it records when it
// was last used — so handing one out is a reversible decision rather than a
// permanent one.

export const ACCESS_KEY_PREFIX = "dna_";

export interface AccessKeyRow {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked: number;
}

/** SHA-256, not bcrypt, and on purpose.
 *
 *  bcrypt is slow BY DESIGN, which is right for passwords (low entropy, worth
 *  brute-forcing) and wrong here: this hash is checked on EVERY authenticated
 *  request, and a 256-bit random key has nothing to brute-force. Slow hashing
 *  would buy no security and cost ~100ms per API call. */
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A key looks like `dna_<43 base64url chars>` — 32 bytes of entropy.
 *  No dots, which is what lets the middleware tell it apart from a session
 *  token (`payload.signature`) without a database round-trip. */
function generateKey(): string {
  return ACCESS_KEY_PREFIX + randomBytes(32).toString("base64url");
}

export const looksLikeAccessKey = (v: string) =>
  typeof v === "string" && v.startsWith(ACCESS_KEY_PREFIX) && !v.includes(".");

/**
 * Mint a key. Returns the plaintext ONCE — it is not stored and cannot be
 * shown again. `expiresInDays = 0` means it never expires.
 */
export async function createAccessKey(
  label: string,
  expiresInDays = 0
): Promise<{ id: string; key: string; row: AccessKeyRow }> {
  const key = generateKey();
  const id = randomBytes(8).toString("hex");
  const created = nowIso();
  const expires =
    expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
  const prefix = key.slice(0, ACCESS_KEY_PREFIX.length + 6);
  const clean = label.trim().slice(0, 60) || "Unnamed key";

  await q(
    `INSERT INTO access_keys (id, label, key_hash, prefix, created_at, expires_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [id, clean, hashKey(key), prefix, created, expires]
  );

  return {
    id,
    key,
    row: {
      id,
      label: clean,
      prefix,
      created_at: created,
      expires_at: expires,
      last_used_at: null,
      last_used_ip: null,
      revoked: 0,
    },
  };
}

/**
 * Verify a presented key. Returns the label on success, null otherwise.
 * Touches last_used_at/ip as a side effect so misuse leaves a trace.
 */
export async function verifyAccessKey(key: string, ip?: string): Promise<string | null> {
  if (!looksLikeAccessKey(key)) return null;
  const rows = await q(
    `SELECT id, label, expires_at, revoked FROM access_keys WHERE key_hash = ?`,
    [hashKey(key)]
  );
  const row = rows[0];
  if (!row) return null;
  // 0/1 in sqlite, boolean in postgres — both are falsy-checked the same way.
  if (row.revoked) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  // Best-effort: a failed bookkeeping write must never fail the request.
  q(`UPDATE access_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?`, [
    nowIso(),
    (ip || "").slice(0, 64) || null,
    row.id,
  ]).catch(() => { /* non-fatal */ });

  return String(row.label);
}

export async function listAccessKeys(): Promise<AccessKeyRow[]> {
  const rows = await q(
    `SELECT id, label, prefix, created_at, expires_at, last_used_at, last_used_ip, revoked
       FROM access_keys ORDER BY created_at DESC`
  );
  return rows as AccessKeyRow[];
}

/** Hard delete. Revocation should leave nothing behind to re-enable by accident. */
export async function revokeAccessKey(id: string): Promise<boolean> {
  const rows = await q(`DELETE FROM access_keys WHERE id = ? RETURNING id`, [id]);
  return rows.length > 0;
}

/** Exchange a valid key for a short-lived ordinary session token. */
export async function sessionFromAccessKey(key: string, ip?: string): Promise<string | null> {
  const label = await verifyAccessKey(key, ip);
  if (!label) return null;
  const username = (await getUsername()) || "agent";
  return createToken(username, AGENT_SESSION_TTL_MS);
}

export async function verifyToken(token: string): Promise<boolean> {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const secret = await getAuthSecret();
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof data.exp === "number" && Date.now() < data.exp;
  } catch {
    return false;
  }
}
