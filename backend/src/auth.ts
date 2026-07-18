// Simple, self-contained auth for the outreach app.
//  - Credentials live in the DB (settings table): auth_username + auth_password_hash
//  - They are seeded/updated from env vars (AUTH_USERNAME / AUTH_PASSWORD) on boot,
//    so the plaintext password never lives in the (public) repo.
//  - Login returns a stateless HMAC-signed token (signed with a persistent secret
//    stored in the DB, so it survives redeploys). No session table needed.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSetting, setSetting } from "./db";

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

export async function createToken(username: string): Promise<string> {
  const secret = await getAuthSecret();
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL_MS })
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
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
