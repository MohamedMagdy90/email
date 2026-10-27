// Sign-in apps (mail_connections) and per-address tokens (mailboxes, seeds):
// load, refresh when close to expiry, save the rotated token, and mark the
// owner "sign in again" when the provider says the sign-in is gone.
import { q, nowIso } from "../../db";
import { decryptJson, decryptSecret, encryptJson } from "./crypto";
import { google } from "./google";
import { microsoft } from "./microsoft";
import { EngineError, isEngineError, type Connection, type MailProvider, type TokenSet } from "./types";

export const providerFor = (k: string): MailProvider => (k === "microsoft" ? microsoft : google);

export async function loadConnection(id: string | null | undefined): Promise<Connection> {
  const r = id ? (await q(`SELECT * FROM mail_connections WHERE id = ?`, [id]))[0] : null;
  if (!r) throw new EngineError("The sign-in app this address used was removed. Add it again under Agent → Connections, then sign in again.", "auth", 404);
  return { id: String(r.id), provider: r.provider === "microsoft" ? "microsoft" : "google", label: r.label || null, client_id: String(r.client_id), client_secret: await decryptSecret(r.client_secret_enc) };
}

export type Owner = { table: "mailboxes" | "seed_inboxes"; id: string };

export async function markAuth(owner: Owner, ok: boolean, error?: string) {
  const now = nowIso();
  if (owner.table === "mailboxes") {
    await q(`UPDATE mailboxes SET auth_status = ?, auth_error = ?, updated_at = ? WHERE id = ?`, [ok ? "ok" : "failed", ok ? null : String(error || "").slice(0, 400), now, owner.id]);
  } else {
    await q(`UPDATE seed_inboxes SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`, [ok ? "ok" : "failed", ok ? null : String(error || "").slice(0, 400), now, owner.id]);
  }
}

const refreshing = new Map<string, Promise<string>>();

/** A usable access token for a mailbox or a seed; refreshed (and saved) when it is about to expire. */
export async function accessFor(owner: Owner): Promise<{ access: string; provider: MailProvider; email: string }> {
  const kindCol = owner.table === "mailboxes" ? "provider" : "access";
  const row = (await q(`SELECT id, email, connection_id, token_enc, ${kindCol} AS kind FROM ${owner.table} WHERE id = ?`, [owner.id]))[0];
  if (!row) throw new EngineError("Address not found", "bad", 404);
  if (row.kind !== "google" && row.kind !== "microsoft") throw new EngineError("This address doesn't use a Google or Microsoft sign-in", "bad", 400);
  const provider = providerFor(String(row.kind));
  const token = await decryptJson<TokenSet>(row.token_enc);
  if (!token?.refresh_token) throw new EngineError("Not signed in. Sign in again.", "auth", 401);
  if (token.expires_at - Date.now() > 120_000) return { access: token.access_token, provider, email: String(row.email) };
  const key = `${owner.table}:${owner.id}`;
  let p = refreshing.get(key);
  if (!p) {
    p = (async () => {
      const conn = await loadConnection(row.connection_id);
      try {
        const fresh = await provider.refresh(conn, token);
        await q(`UPDATE ${owner.table} SET token_enc = ? WHERE id = ?`, [await encryptJson(fresh), owner.id]);
        return fresh.access_token;
      } catch (e) {
        if (isEngineError(e) && e.code === "auth") await markAuth(owner, false, e.message);
        throw e;
      }
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, p);
  }
  return { access: await p, provider, email: String(row.email) };
}

/** Run one provider call; a sign-in error marks the owner so the screen says "sign in again". */
export async function withAccess<T>(owner: Owner, fn: (access: string, provider: MailProvider, email: string) => Promise<T>): Promise<T> {
  const a = await accessFor(owner);
  try {
    return await fn(a.access, a.provider, a.email);
  } catch (e) {
    if (isEngineError(e) && e.code === "auth") await markAuth(owner, false, e.message);
    throw e;
  }
}
