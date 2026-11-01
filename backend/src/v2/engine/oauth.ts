// "Sign in with Google / Microsoft" for sending mailboxes and test inboxes.
// The browser opens the provider's consent page; the provider redirects to
// our public callback with a one-time code; we swap it for tokens, read the
// address, and save it (tokens encrypted).
import { q, nowIso, getSetting, setSetting } from "../../db";
import { logEvent, uid } from "../events";
import { encryptJson, randomToken } from "./crypto";
import { loadConnection, providerFor } from "./access";
import { EngineError, isEngineError, type Connection, type TokenSet } from "./types";

const STATE_TTL_MS = 15 * 60_000;
export const CALLBACK_PATH = "/api/v2/oauth/callback";
const OWN = "('google','microsoft')";

export function normalizeBase(raw: string): string {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new EngineError("The app's address is missing or invalid.", "bad", 400);
  }
}

/* ---------------------------- public address ----------------------------
 * Unsubscribe links must reach THIS backend. The frontend can live on another
 * host (Railway: two services) where /api/* is just the app's index.html, so an
 * address is only trusted when a request provably reached us through it:
 *   APP_URL (explicit) · the address the last sign-in callback came in on ·
 *   RAILWAY_PUBLIC_DOMAIN (this service's own domain).
 * With more than one candidate, each is checked with GET /api/health (JSON
 * {ok:true} from us, HTML from a frontend host) and the first that answers is used.
 * The old `engine_public_base` key was written when a sign-in STARTED, from
 * whatever address the browser was on, so it is ignored. */
const SEEN_BASE_KEY = "engine_callback_base";
const isLocal = (base: string) => /localhost|127\.0\.0\.1|\[::1\]/.test(base);
let baseCache: { at: number; key: string; value: string | null } | null = null;
const BASE_TTL_MS = 6 * 3_600_000;
export const clearPublicBaseCache = () => (baseCache = null);

async function answersAsBackend(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000), redirect: "manual" });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return false;
    return (await r.json().catch(() => null))?.ok === true;
  } catch {
    return false;
  }
}

/** Where people reach the backend from outside (for unsubscribe links). */
export async function publicBase(): Promise<string | null> {
  const env = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  const seen = (await getSetting(SEEN_BASE_KEY)) || "";
  const rw = (process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  const candidates = [...new Set([env, seen, rw ? `https://${rw}` : ""].filter(Boolean))];
  if (candidates.length <= 1) return candidates[0] || null;
  const key = candidates.join("|");
  if (baseCache && baseCache.key === key && Date.now() - baseCache.at < BASE_TTL_MS) return baseCache.value;
  let value: string | null = null;
  for (const c of candidates) {
    if (await answersAsBackend(c)) {
      value = c;
      break;
    }
  }
  // Nothing answered (network trouble): prefer the addresses we've seen work.
  if (!value) value = seen || (rw ? `https://${rw}` : "") || env || null;
  if (env && value !== env) console.warn(`[engine] APP_URL ${env} doesn't reach this backend's /api/health; unsubscribe links use ${value}`);
  baseCache = { at: Date.now(), key, value };
  return value;
}

/** Where the app lives, for a full-page sign-in to come back to. http(s) only, no fragment. */
export function normalizeReturnTo(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    throw new EngineError("The app's return address is invalid.", "bad", 400);
  }
}

export interface OAuthStart {
  connectionId: string;
  purpose: "mailbox" | "seed";
  /** The backend's public address: the provider redirects to it + CALLBACK_PATH. */
  redirectBase: string;
  loginHint?: string | null;
  /** Re-sign-in for this mailbox: the address must match. */
  mailboxId?: string | null;
  /** Full-page sign-in (frontend on another host): where the callback sends the browser back to. */
  returnTo?: string | null;
}

export async function startOAuth(o: OAuthStart): Promise<{ url: string; redirectUri: string }> {
  const conn = await loadConnection(o.connectionId);
  const base = normalizeBase(o.redirectBase);
  const returnTo = normalizeReturnTo(o.returnTo);
  const redirectUri = `${base}${CALLBACK_PATH}`;
  const state = randomToken(24);
  await q(`DELETE FROM oauth_states WHERE created_at < ?`, [new Date(Date.now() - STATE_TTL_MS).toISOString()]);
  await q(`INSERT INTO oauth_states (state, data, created_at) VALUES (?,?,?)`, [
    state,
    JSON.stringify({ connectionId: conn.id, purpose: o.purpose, redirectUri, mailboxId: o.mailboxId || null, returnTo }),
    nowIso(),
  ]);
  return { url: providerFor(conn.provider).authUrl(conn, { redirectUri, state, loginHint: o.loginHint, purpose: o.purpose }), redirectUri };
}

export interface OAuthResult {
  ok: boolean;
  message: string;
  kind?: "mailbox" | "seed";
  email?: string;
  /** Set for a full-page sign-in: send the browser back here with the result. */
  returnTo?: string | null;
}

const FREE_GOOGLE = /@(gmail|googlemail)\.com$/i;
const FREE_MS = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i;

function splitName(name: string | null): { first: string | null; last: string | null } {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

async function saveMailbox(conn: Connection, prof: { email: string; name: string | null }, token: TokenSet, expectedId: string | null): Promise<OAuthResult> {
  const email = prof.email.toLowerCase();
  const domain = email.split("@")[1] || null;
  const now = nowIso();
  if ((await q(`SELECT id FROM seed_inboxes WHERE email = ?`, [email]))[0]) {
    throw new EngineError(`${email} is one of your test inboxes. A sending mailbox must be a different account.`, "bad", 400);
  }
  const existing = (await q(`SELECT * FROM mailboxes WHERE email = ?`, [email]))[0];
  if (expectedId && existing?.id !== expectedId) {
    const want = (await q(`SELECT email FROM mailboxes WHERE id = ?`, [expectedId]))[0]?.email;
    throw new EngineError(`You signed in as ${email}${want ? `, but this was the sign-in for ${want}` : ""}. Sign in with the right account.`, "bad", 400);
  }
  const tok = await encryptJson(token);
  const code = conn.provider === "microsoft" ? 3 : 2;
  const { first, last } = splitName(prof.name);
  if (existing) {
    const wasInstantly = (existing.provider || "instantly") === "instantly";
    const authPaused = existing.stage === "paused" && /^Sign-in/i.test(String(existing.stage_reason || ""));
    const stage = wasInstantly ? "warming" : authPaused ? (existing.ramp_started_at ? "ramping" : "warming") : existing.stage;
    const reason = wasInstantly
      ? "Moved to your own engine. Going through the readiness checks: DNS, domain age, inbox tests."
      : authPaused
        ? "Signed in again."
        : existing.stage_reason;
    await q(
      `UPDATE mailboxes SET provider = ?, connection_id = ?, token_enc = ?, auth_status = 'ok', auth_error = NULL, provider_code = ?, missing_since = NULL,
         sender_name = COALESCE(sender_name, ?), first_name = COALESCE(first_name, ?), last_name = COALESCE(last_name, ?),
         connected_at = COALESCE(connected_at, ?), stage = ?, stage_reason = ?, stage_changed_at = CASE WHEN stage <> ? THEN ? ELSE stage_changed_at END,
         ramp_started_at = CASE WHEN ? = 1 THEN NULL ELSE ramp_started_at END, daily_limit = CASE WHEN ? = 1 THEN 0 ELSE daily_limit END, updated_at = ?
       WHERE id = ?`,
      [conn.provider, conn.id, tok, code, prof.name, first, last, now, stage, reason, stage, now, wasInstantly ? 1 : 0, wasInstantly ? 1 : 0, now, existing.id]
    );
    await logEvent("mailbox", wasInstantly ? `${email} now sends through your own engine (${conn.provider === "microsoft" ? "Microsoft 365" : "Google Workspace"}).` : `${email} signed in again.`, {
      level: "success",
      refType: "mailbox",
      refId: existing.id,
    });
    return { ok: true, kind: "mailbox", email, message: wasInstantly ? `${email} moved to your own engine.` : `${email} is signed in again.` };
  }
  const id = uid();
  await q(
    `INSERT INTO mailboxes (id, email, domain, vendor, provider, connection_id, token_enc, auth_status, provider_code, first_name, last_name, sender_name,
       stage, stage_reason, stage_changed_at, daily_limit, connected_at, warmup_mode, created_at, updated_at)
     VALUES (?,?,?,'other',?,?,?,'ok',?,?,?,?,'warming',?,?,0,?,'off',?,?)`,
    [id, email, domain, conn.provider, conn.id, tok, code, first, last, prof.name, "Connected. Running the readiness checks: DNS, domain age, inbox tests.", now, now, now, now]
  );
  await logEvent("mailbox", `Connected ${email} (${conn.provider === "microsoft" ? "Microsoft 365" : "Google Workspace"}). It starts on the readiness checks.`, {
    level: "success",
    refType: "mailbox",
    refId: id,
  });
  return { ok: true, kind: "mailbox", email, message: `${email} is connected.` };
}

async function saveSeed(conn: Connection, prof: { email: string; name: string | null }, token: TokenSet): Promise<OAuthResult> {
  const email = prof.email.toLowerCase();
  const domain = email.split("@")[1] || "";
  if ((await q(`SELECT id FROM mailboxes WHERE email = ? AND provider IN ${OWN}`, [email]))[0]) {
    throw new EngineError(`${email} is one of your sending mailboxes. A test inbox must be a different account.`, "bad", 400);
  }
  if ((await q(`SELECT id FROM mailboxes WHERE domain = ? AND provider IN ${OWN} LIMIT 1`, [domain]))[0]) {
    throw new EngineError(`${email} is on ${domain}, the same domain as a sending mailbox. Mail inside one account isn't filtered like outside mail, so the test would say nothing. Use an inbox on another domain.`, "bad", 400);
  }
  const provider = conn.provider === "microsoft" ? (FREE_MS.test(email) ? "outlook" : "m365") : FREE_GOOGLE.test(email) ? "gmail" : "workspace";
  const now = nowIso();
  const tok = await encryptJson(token);
  const existing = (await q(`SELECT id FROM seed_inboxes WHERE email = ?`, [email]))[0];
  if (existing) {
    await q(`UPDATE seed_inboxes SET provider = ?, access = ?, connection_id = ?, token_enc = ?, status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?`, [
      provider,
      conn.provider,
      conn.id,
      tok,
      now,
      existing.id,
    ]);
  } else {
    await q(`INSERT INTO seed_inboxes (id, email, provider, access, connection_id, token_enc, enabled, status, created_at, updated_at) VALUES (?,?,?,?,?,?,1,'ok',?,?)`, [
      uid(),
      email,
      provider,
      conn.provider,
      conn.id,
      tok,
      now,
      now,
    ]);
  }
  await logEvent("mailbox", `Test inbox ${email} connected. Every mailbox sends it one test a day.`, { level: "success" });
  return { ok: true, kind: "seed", email, message: `Test inbox ${email} is connected.` };
}

export async function finishOAuth(p: { state?: string; code?: string; error?: string; error_description?: string }): Promise<OAuthResult> {
  const state = String(p.state || "");
  const row = state ? (await q(`SELECT * FROM oauth_states WHERE state = ?`, [state]))[0] : null;
  if (row) await q(`DELETE FROM oauth_states WHERE state = ?`, [state]);
  let data: any = null;
  try {
    data = row ? JSON.parse(String(row.data)) : null;
  } catch {
    data = null;
  }
  // Known even when the sign-in failed, so a full-page sign-in always gets back to the app.
  const returnTo: string | null = data?.returnTo || null;
  const done = (r: OAuthResult): OAuthResult => ({ ...r, returnTo });
  if (data?.redirectUri) {
    // The provider just sent the browser here through this address, so it
    // provably reaches this backend: unsubscribe links can use it.
    try {
      const seen = new URL(String(data.redirectUri)).origin;
      if (!isLocal(seen) && (await getSetting(SEEN_BASE_KEY)) !== seen) {
        await setSetting(SEEN_BASE_KEY, seen);
        clearPublicBaseCache();
      }
    } catch {
      /* not a URL: nothing to remember */
    }
  }
  if (p.error) return done({ ok: false, message: String(p.error_description || p.error).slice(0, 300) });
  if (!row || !data || Date.now() - Date.parse(String(row.created_at)) > STATE_TTL_MS) {
    return done({ ok: false, message: "This sign-in link has expired. Start again from the app." });
  }
  if (!p.code) return done({ ok: false, message: "The provider didn't send a sign-in code back." });
  try {
    const conn = await loadConnection(data.connectionId);
    const provider = providerFor(conn.provider);
    const token = await provider.exchangeCode(conn, String(p.code), String(data.redirectUri));
    const prof = await provider.profile(token.access_token);
    if (!prof.email) return done({ ok: false, message: "Signed in, but the provider didn't say which address it was." });
    return done(data.purpose === "seed" ? await saveSeed(conn, prof, token) : await saveMailbox(conn, prof, token, data.mailboxId || null));
  } catch (e) {
    return done({ ok: false, message: isEngineError(e) ? e.message : String((e as any)?.message || e) });
  }
}

/** Full-page sign-in: back to the app, the result in the fragment (never sent to a server or logged). */
export function returnUrl(r: OAuthResult): string | null {
  if (!r.returnTo) return null;
  const payload = JSON.stringify({ type: "dna-oauth", ok: r.ok, message: r.message, kind: r.kind || null, email: r.email || null });
  return `${r.returnTo}#dnaOauth=${encodeURIComponent(payload)}`;
}

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The page the provider redirects to. Tells the app (popup or same tab) and closes. */
export function callbackPage(r: OAuthResult): string {
  const payload = JSON.stringify({ type: "dna-oauth", ok: r.ok, message: r.message, kind: r.kind || null, email: r.email || null }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${r.ok ? "Connected" : "Sign-in didn't finish"}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07090c;color:#e8ecef;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
.card{max-width:420px;border:1px solid #1f262d;background:#0d1116;border-radius:14px;padding:28px 26px;text-align:center}h2{margin:0 0 6px;font-size:18px}
p{margin:0;color:#9aa5ae}a{color:#00d4aa}.dot{width:10px;height:10px;border-radius:99px;display:inline-block;margin-right:8px;background:${r.ok ? "#00d4aa" : "#ef6461"}}</style></head>
<body><div class="card"><h2><span class="dot"></span>${r.ok ? "Connected" : "Sign-in didn't finish"}</h2><p>${esc(r.message)}</p><p style="margin-top:14px"><a href="/">Back to the app</a></p></div>
<script>(function(){var d=${payload};try{localStorage.setItem("dnaOauthResult",JSON.stringify(d));}catch(e){}
try{if(window.opener&&!window.opener.closed){window.opener.postMessage(d,"*");setTimeout(function(){window.close()},500);return;}}catch(e){}
setTimeout(function(){location.href="/"},${r.ok ? 1500 : 4000});})();</script></body></html>`;
}
