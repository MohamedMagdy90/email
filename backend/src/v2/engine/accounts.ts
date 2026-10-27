// Sign-in apps, our own mailboxes, their domains and the test inboxes.
import { q, nowIso } from "../../db";
import { logEvent, parseJson, uid } from "../events";
import { getAgentSettings } from "../agent-settings";
import { decryptSecret, encryptSecret, hasAppSecret } from "./crypto";
import { markAuth, withAccess } from "./access";
import { checkDomain, domainRegisteredAt, expectedRecords, toDnsJson, type DnsProvider, type DomainCheck } from "./dns";
import { imapTest } from "./imap";
import { EngineError, isEngineError } from "./types";

const OWN = "('google','microsoft')";
const DOMAIN_RECHECK_MS = 12 * 3_600_000;
const RDAP_RECHECK_MS = 7 * 86_400_000;

/* ------------------------------ connections ------------------------------ */

export interface ConnectionView {
  id: string;
  provider: "google" | "microsoft";
  label: string;
  clientId: string;
  status: string;
  lastError: string | null;
  mailboxes: number;
  seeds: number;
  createdAt: string;
}

export async function listConnections(): Promise<ConnectionView[]> {
  const rows = await q(`SELECT * FROM mail_connections ORDER BY created_at`);
  const out: ConnectionView[] = [];
  for (const r of rows) {
    const mb = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM mailboxes WHERE connection_id = ?`, [r.id]))[0]?.n) || 0;
    const sd = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM seed_inboxes WHERE connection_id = ?`, [r.id]))[0]?.n) || 0;
    out.push({
      id: String(r.id),
      provider: r.provider === "microsoft" ? "microsoft" : "google",
      label: String(r.label || (r.provider === "microsoft" ? "Microsoft 365" : "Google Workspace")),
      clientId: String(r.client_id),
      status: String(r.status || "ok"),
      lastError: r.last_error || null,
      mailboxes: mb,
      seeds: sd,
      createdAt: String(r.created_at),
    });
  }
  return out;
}

export async function saveConnection(b: any): Promise<ConnectionView[]> {
  const provider = b?.provider === "microsoft" ? "microsoft" : b?.provider === "google" ? "google" : null;
  const id = b?.id ? String(b.id) : null;
  const clientId = String(b?.clientId || "").trim().slice(0, 300);
  const secret = String(b?.clientSecret || "").trim().slice(0, 500);
  const label = String(b?.label || "").trim().slice(0, 80);
  const now = nowIso();
  if (id) {
    const cur = (await q(`SELECT * FROM mail_connections WHERE id = ?`, [id]))[0];
    if (!cur) throw new EngineError("Sign-in app not found.", "bad", 404);
    await q(`UPDATE mail_connections SET label = ?, client_id = ?, client_secret_enc = ?, status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?`, [
      label || cur.label,
      clientId || cur.client_id,
      secret ? await encryptSecret(secret) : cur.client_secret_enc,
      now,
      id,
    ]);
  } else {
    if (!provider) throw new EngineError("Pick Google or Microsoft.", "bad", 400);
    if (!clientId || !secret) throw new EngineError("Paste both the client ID and the client secret.", "bad", 400);
    if (provider === "google" && !/\.apps\.googleusercontent\.com$/.test(clientId)) throw new EngineError("That doesn't look like a Google client ID (it ends in .apps.googleusercontent.com).", "bad", 400);
    if (provider === "microsoft" && !/^[0-9a-f-]{36}$/i.test(clientId)) throw new EngineError("That doesn't look like a Microsoft application (client) ID: it's a 36-character GUID.", "bad", 400);
    await q(`INSERT INTO mail_connections (id, provider, label, client_id, client_secret_enc, status, created_at, updated_at) VALUES (?,?,?,?,?,'ok',?,?)`, [
      uid(),
      provider,
      label || (provider === "microsoft" ? "Microsoft 365" : "Google Workspace"),
      clientId,
      await encryptSecret(secret),
      now,
      now,
    ]);
    await logEvent("system", `Added a ${provider === "microsoft" ? "Microsoft" : "Google"} sign-in app for your own mailboxes.`, { level: "success" });
  }
  return listConnections();
}

export async function deleteConnection(id: string): Promise<ConnectionView[]> {
  const used = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM mailboxes WHERE connection_id = ?`, [id]))[0]?.n) || 0;
  const usedSeeds = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM seed_inboxes WHERE connection_id = ?`, [id]))[0]?.n) || 0;
  if (used || usedSeeds) throw new EngineError(`${used} mailbox(es) and ${usedSeeds} test inbox(es) sign in through this app. Remove them first.`, "bad", 400);
  await q(`DELETE FROM mail_connections WHERE id = ?`, [id]);
  return listConnections();
}

/* -------------------------------- mailboxes -------------------------------- */

async function ownRow(id: string) {
  const r = (await q(`SELECT * FROM mailboxes WHERE id = ? AND provider IN ${OWN}`, [id]))[0];
  if (!r) throw new EngineError("That isn't one of your own mailboxes.", "bad", 404);
  return r;
}

export async function testMailbox(id: string): Promise<{ ok: boolean; error?: string; email?: string }> {
  await ownRow(id);
  try {
    const p = await withAccess({ table: "mailboxes", id }, (a, prov) => prov.profile(a));
    await markAuth({ table: "mailboxes", id }, true);
    return { ok: true, email: p.email };
  } catch (e) {
    return { ok: false, error: isEngineError(e) ? e.message : String((e as any)?.message || e) };
  }
}

/** Remove one of our own mailboxes. Its scheduled emails are cancelled (follow-ups never switch sender). */
export async function removeOwnMailbox(id: string): Promise<{ cancelled: number }> {
  const r = await ownRow(id);
  const rows = await q(`UPDATE outbox SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE mailbox_id = ? AND status = 'scheduled' RETURNING id`, [
    `${r.email} was removed`,
    nowIso(),
    id,
  ]);
  await q(`DELETE FROM placement_tests WHERE mailbox_id = ? AND result = 'pending'`, [id]);
  await q(`DELETE FROM mailbox_health WHERE mailbox_id = ?`, [id]);
  await q(`DELETE FROM mailboxes WHERE id = ?`, [id]);
  await logEvent("mailbox", `Removed ${r.email}.${rows.length ? ` ${rows.length} scheduled email(s) from it were cancelled.` : ""}`, { level: "warn" });
  return { cancelled: rows.length };
}

/* --------------------------------- domains --------------------------------- */

async function websiteHost(): Promise<string> {
  try {
    const w = (await getAgentSettings()).website || "";
    return new URL(/^https?:\/\//.test(w) ? w : `https://${w}`).hostname.replace(/^www\./, "") || "dna.systems";
  } catch {
    return "dna.systems";
  }
}

async function domainProvider(domain: string): Promise<DnsProvider> {
  const r = (await q(`SELECT provider FROM mailboxes WHERE domain = ? AND provider IN ${OWN} LIMIT 1`, [domain]))[0];
  return r?.provider === "microsoft" ? "microsoft" : r?.provider === "google" ? "google" : "unknown";
}

/** Re-check one domain's DNS (and its age, weekly). Saved on every own mailbox of the domain. */
export async function refreshDomain(domain: string, opts: { force?: boolean } = {}): Promise<DomainCheck> {
  const d = domain.toLowerCase();
  const prev = parseJson<any>((await q(`SELECT dns_json FROM mailboxes WHERE domain = ? AND provider IN ${OWN} LIMIT 1`, [d]))[0]?.dns_json, null);
  const check = await checkDomain(d, await domainProvider(d), await websiteHost());
  const now = nowIso();
  await q(`UPDATE mailboxes SET dns_json = ?, last_vitals_at = ? WHERE domain = ? AND provider IN ${OWN}`, [JSON.stringify(toDnsJson(check)), now, d]);
  const ageRow = (await q(`SELECT domain_checked_at FROM mailboxes WHERE domain = ? AND provider IN ${OWN} LIMIT 1`, [d]))[0];
  if (opts.force || !ageRow?.domain_checked_at || Date.now() - Date.parse(String(ageRow.domain_checked_at)) > RDAP_RECHECK_MS) {
    const reg = await domainRegisteredAt(d);
    await q(`UPDATE mailboxes SET domain_registered_at = COALESCE(?, domain_registered_at), domain_checked_at = ? WHERE domain = ? AND provider IN ${OWN}`, [reg, now, d]);
  }
  if (!prev || prev.allPass !== check.allPass) {
    const miss = (["mx", "spf", "dkim", "dmarc"] as const).filter((k) => !check[k].ok).map((k) => k.toUpperCase());
    await logEvent("mailbox", check.allPass ? `DNS for ${d} is complete: MX, SPF, DKIM and DMARC found.` : `DNS for ${d}: missing ${miss.join(", ")}.`, {
      level: check.allPass ? "success" : "warn",
      refType: "domain",
      refId: d,
    });
  }
  return check;
}

/** Domains whose DNS is older than 12 hours (or never checked). */
export async function refreshStaleDomains(): Promise<number> {
  const rows = await q(`SELECT domain, MAX(COALESCE(last_vitals_at, '')) AS at FROM mailboxes WHERE provider IN ${OWN} AND domain IS NOT NULL GROUP BY domain`);
  let n = 0;
  for (const r of rows) {
    if (r.at && Date.now() - Date.parse(String(r.at)) < DOMAIN_RECHECK_MS) continue;
    try {
      await refreshDomain(String(r.domain));
      n++;
    } catch (e) {
      console.error(`[engine] DNS check ${r.domain}: ${String((e as any)?.message || e)}`);
    }
  }
  return n;
}

export async function domainSetup(domain: string) {
  const d = domain.toLowerCase();
  const rows = await q(`SELECT email, dns_json, domain_registered_at, created_at FROM mailboxes WHERE domain = ? AND provider IN ${OWN} ORDER BY created_at`, [d]);
  if (!rows.length) throw new EngineError("No mailbox of yours is on that domain.", "bad", 404);
  const provider = await domainProvider(d);
  const dns = parseJson<any>(rows[0].dns_json, null);
  return {
    domain: d,
    provider,
    records: expectedRecords(d, provider, rows[0].email, await websiteHost()),
    check: (dns?.details as DomainCheck) || null,
    registeredAt: rows[0].domain_registered_at || null,
    firstAddedAt: rows[0].created_at,
  };
}

/* ---------------------------------- seeds ---------------------------------- */

export interface SeedView {
  id: string;
  email: string;
  provider: string;
  access: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  last7: { tests: number; inbox: number; spam: number; missing: number };
}

export async function listSeeds(): Promise<SeedView[]> {
  const rows = await q(`SELECT * FROM seed_inboxes ORDER BY created_at`);
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const stats = await q(`SELECT seed_id, result, CAST(count(*) AS INTEGER) AS n FROM placement_tests WHERE day >= ? GROUP BY seed_id, result`, [since]);
  return rows.map((r) => {
    const mine = stats.filter((s) => s.seed_id === r.id);
    const n = (res: string[]) => mine.filter((s) => res.includes(s.result)).reduce((a, s) => a + Number(s.n), 0);
    return {
      id: String(r.id),
      email: String(r.email),
      provider: String(r.provider),
      access: String(r.access),
      enabled: Number(r.enabled) === 1,
      status: String(r.status),
      lastError: r.last_error || null,
      lastCheckedAt: r.last_checked_at || null,
      last7: { tests: n(["inbox", "other_tab", "other", "spam", "missing"]), inbox: n(["inbox", "other_tab", "other"]), spam: n(["spam"]), missing: n(["missing"]) },
    };
  });
}

export async function addImapSeed(b: any): Promise<SeedView[]> {
  const email = String(b?.email || "").trim().toLowerCase();
  const host = String(b?.host || "").trim().toLowerCase();
  const port = Number(b?.port) || 993;
  const user = String(b?.user || email).trim();
  const pass = String(b?.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw new EngineError("Enter the test inbox's email address.", "bad", 400);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new EngineError("Enter the IMAP server, e.g. imap.gmail.com or mail.example.com.", "bad", 400);
  if (!pass) throw new EngineError("Enter the password (for Gmail: an app password).", "bad", 400);
  const domain = email.split("@")[1];
  if ((await q(`SELECT id FROM mailboxes WHERE domain = ? AND provider IN ${OWN} LIMIT 1`, [domain]))[0]) {
    throw new EngineError(`${domain} is one of your sending domains. Use a test inbox on another domain.`, "bad", 400);
  }
  try {
    await imapTest({ host, port, user, pass });
  } catch (e: any) {
    throw new EngineError(`Couldn't sign in over IMAP: ${String(e?.message || e)}`, "bad", 400);
  }
  const provider = /@(gmail|googlemail)\.com$/.test(email) ? "gmail" : /@(outlook|hotmail|live|msn)\./.test(email) ? "outlook" : "imap";
  const now = nowIso();
  const existing = (await q(`SELECT id FROM seed_inboxes WHERE email = ?`, [email]))[0];
  const enc = await encryptSecret(pass);
  if (existing) {
    await q(`UPDATE seed_inboxes SET provider = ?, access = 'imap', imap_host = ?, imap_port = ?, imap_user = ?, imap_pass_enc = ?, status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?`, [
      provider,
      host,
      port,
      user,
      enc,
      now,
      existing.id,
    ]);
  } else {
    await q(
      `INSERT INTO seed_inboxes (id, email, provider, access, imap_host, imap_port, imap_user, imap_pass_enc, enabled, status, created_at, updated_at) VALUES (?,?,?,'imap',?,?,?,?,1,'ok',?,?)`,
      [uid(), email, provider, host, port, user, enc, now, now]
    );
  }
  await logEvent("mailbox", `Test inbox ${email} connected over IMAP.`, { level: "success" });
  return listSeeds();
}

export async function updateSeed(id: string, b: any): Promise<SeedView[]> {
  if (typeof b?.enabled === "boolean") await q(`UPDATE seed_inboxes SET enabled = ?, updated_at = ? WHERE id = ?`, [b.enabled ? 1 : 0, nowIso(), id]);
  return listSeeds();
}

export async function deleteSeed(id: string): Promise<SeedView[]> {
  await q(`DELETE FROM placement_tests WHERE seed_id = ? AND result = 'pending'`, [id]);
  await q(`UPDATE outbox SET status = 'cancelled', status_reason = 'Test inbox removed', updated_at = ? WHERE kind = 'test' AND status = 'scheduled' AND test_id NOT IN (SELECT id FROM placement_tests)`, [nowIso()]);
  await q(`DELETE FROM seed_inboxes WHERE id = ?`, [id]);
  return listSeeds();
}

export async function testSeed(id: string): Promise<{ ok: boolean; error?: string }> {
  const s = (await q(`SELECT * FROM seed_inboxes WHERE id = ?`, [id]))[0];
  if (!s) throw new EngineError("Test inbox not found.", "bad", 404);
  try {
    if (s.access === "imap") await imapTest({ host: s.imap_host, port: Number(s.imap_port) || 993, user: s.imap_user || s.email, pass: await decryptSecret(s.imap_pass_enc) });
    else await withAccess({ table: "seed_inboxes", id }, (a, p) => p.profile(a));
    await markAuth({ table: "seed_inboxes", id }, true);
    return { ok: true };
  } catch (e: any) {
    await markAuth({ table: "seed_inboxes", id }, false, String(e?.message || e));
    return { ok: false, error: String(e?.message || e) };
  }
}

export const engineSecretWarning = () => (hasAppSecret() ? null : "APP_SECRET isn't set on the server, so tokens are encrypted with a key kept in the database. Set APP_SECRET on Railway to keep them safe even if the database leaks.");
