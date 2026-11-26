// Alerts on your phone and computer (Web Push) when a reply needs you:
//
//   handoff      the agent handed the reply to you (kinds you keep, unclear,
//                legal, low confidence, auto-reply off, it couldn't write/send)
//   interested   they want a call, a demo or the next step, even when the
//                agent answers it on its own
//   draft        the agent wrote a reply and holds it for your approval
//
// Out-of-office, bounces, unsubscribes and replies the agent sends by itself
// never alert. One alert per reply and kind; replies older than 24 hours
// (first sync, outages) never alert; more than 5 in 10 minutes are grouped
// into one alert so a backlog can't buzz the phone all afternoon.
import { getSetting, q, setSetting } from "../../db";
import { logEvent, parseJson, uid } from "../events";
import { REPLY_CATEGORIES } from "../agent-settings";
import { decryptJson, encryptJson } from "../engine/crypto";
import { generateVapidKeys, sendPush, unb64u, validEndpoint, type PushOutcome, type VapidKeys } from "./webpush";

export type AlertKind = "interested" | "handoff" | "draft";
export interface PushPrefs {
  handoff: boolean;
  interested: boolean;
  drafts: boolean;
}
export const DEFAULT_PREFS: PushPrefs = { handoff: true, interested: true, drafts: true };

const VAPID_SETTING = "push_vapid";
const PREFS_SETTING = "push_prefs";
const MAX_AGE_MS = 24 * 3600_000;
const BURST_WINDOW_MS = 10 * 60_000;
const BURST_MAX = 5;
/** A device the push service keeps refusing (403: keys changed, permission revoked) is dropped after this many tries in a row. */
const REFUSED_FORGET = 3;
const SUBJECT = () => (process.env.PUSH_SUBJECT || "").trim() || "mailto:outreach@dna.systems";

type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const oneLine = (s: unknown, n: number) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

export class PushError extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.name = "PushError";
    this.status = status;
  }
}

/* -------------------------------- schema -------------------------------- */

export async function ensurePushTables() {
  await q(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_ok_at TEXT,
    last_error TEXT,
    last_error_at TEXT,
    fails INTEGER NOT NULL DEFAULT 0
  )`);
  // One row per alert. status: sent | held (grouped later) | grouped | no_device | failed | dropped
  await q(`CREATE TABLE IF NOT EXISTS push_log (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    thread_id TEXT,
    kind TEXT NOT NULL,
    title TEXT,
    body TEXT,
    status TEXT NOT NULL,
    devices INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  for (const sql of [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_log_msg_kind ON push_log(message_id, kind)`,
    `CREATE INDEX IF NOT EXISTS idx_push_log_created ON push_log(created_at)`,
  ]) {
    try {
      await q(sql);
    } catch {
      /* exists */
    }
  }
}

/* --------------------------------- keys ---------------------------------- */

let keysPromise: Promise<VapidKeys> | null = null;

/** This server's VAPID keys: made once, kept encrypted in settings. */
export function vapidKeys(): Promise<VapidKeys> {
  if (!keysPromise) keysPromise = loadKeys().catch((e) => {
    keysPromise = null;
    throw e;
  });
  return keysPromise;
}

async function loadKeys(): Promise<VapidKeys> {
  const raw = await getSetting(VAPID_SETTING);
  if (raw) {
    const k = await decryptJson<VapidKeys>(raw);
    if (k?.publicKey && k.privateJwk?.d) return k;
    // Unreadable (APP_SECRET changed): new keys. Devices signed up with the old
    // public key can't receive anything, so they are dropped; each one signs up
    // again by itself the next time the app is opened on it.
    const n = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM push_subscriptions`))[0]?.n) || 0;
    await q(`DELETE FROM push_subscriptions`);
    await logEvent("system", `The alert keys couldn't be read (the server secret changed), so new ones were made.${n ? ` ${n} device${n === 1 ? "" : "s"} sign up again the next time the app is opened on them.` : ""}`, { level: "warn" });
  }
  const k = await generateVapidKeys();
  await setSetting(VAPID_SETTING, await encryptJson(k));
  return k;
}

/** Tests only: forget the cached keys. */
export function resetKeysForTests() {
  keysPromise = null;
}

/* -------------------------------- prefs ---------------------------------- */

export async function getPrefs(): Promise<PushPrefs> {
  const p = parseJson<Partial<PushPrefs>>(await getSetting(PREFS_SETTING), {}) || {};
  return {
    handoff: typeof p.handoff === "boolean" ? p.handoff : DEFAULT_PREFS.handoff,
    interested: typeof p.interested === "boolean" ? p.interested : DEFAULT_PREFS.interested,
    drafts: typeof p.drafts === "boolean" ? p.drafts : DEFAULT_PREFS.drafts,
  };
}

export async function savePrefs(body: any): Promise<PushPrefs> {
  const cur = await getPrefs();
  const next: PushPrefs = {
    handoff: typeof body?.handoff === "boolean" ? body.handoff : cur.handoff,
    interested: typeof body?.interested === "boolean" ? body.interested : cur.interested,
    drafts: typeof body?.drafts === "boolean" ? body.drafts : cur.drafts,
  };
  await setSetting(PREFS_SETTING, JSON.stringify(next));
  return next;
}

/* ------------------------------- devices --------------------------------- */

function deviceView(r: Row) {
  let service = "";
  try {
    const h = new URL(String(r.endpoint)).hostname;
    service = /apple\.com$/.test(h) ? "Apple" : /googleapis\.com$/.test(h) ? "Google" : /mozilla\.(com|org|net)$/.test(h) ? "Mozilla" : /windows\.com$|notify\.windows/.test(h) ? "Microsoft" : h;
  } catch {
    /* keep empty */
  }
  return {
    id: String(r.id),
    endpoint: String(r.endpoint),
    label: String(r.label || "A device"),
    service,
    createdAt: String(r.created_at),
    lastOkAt: r.last_ok_at || null,
    lastError: r.last_error || null,
    lastErrorAt: r.last_error_at || null,
  };
}

export async function subscribe(body: any, userAgent = "") {
  const s = body?.subscription && typeof body.subscription === "object" ? body.subscription : body;
  const endpoint = String(s?.endpoint || "").trim();
  const p256dh = String(s?.keys?.p256dh || "").trim();
  const auth = String(s?.keys?.auth || "").trim();
  if (!validEndpoint(endpoint)) throw new PushError("That isn't a push subscription from a browser.");
  let keyOk = false;
  try {
    keyOk = unb64u(p256dh).length === 65 && unb64u(auth).length >= 16;
  } catch {
    keyOk = false;
  }
  if (!keyOk) throw new PushError("The subscription's keys are missing or malformed.");
  const label = oneLine(body?.label, 80) || "A device";
  const now = nowIso();
  const cur = (await q(`SELECT id FROM push_subscriptions WHERE endpoint = ?`, [endpoint]))[0];
  let id: string;
  if (cur) {
    id = String(cur.id);
    await q(`UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ?, user_agent = ?, updated_at = ?, fails = 0, last_error = NULL, last_error_at = NULL WHERE id = ?`, [
      p256dh,
      auth,
      label,
      oneLine(userAgent, 300) || null,
      now,
      id,
    ]);
  } else {
    id = uid();
    await q(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, user_agent, created_at, updated_at, fails) VALUES (?,?,?,?,?,?,?,?,0)`, [
      id,
      endpoint,
      p256dh,
      auth,
      label,
      oneLine(userAgent, 300) || null,
      now,
      now,
    ]);
    await logEvent("system", `Alerts turned on for ${label}.`, { level: "success" });
  }
  return deviceView((await q(`SELECT * FROM push_subscriptions WHERE id = ?`, [id]))[0]);
}

export async function unsubscribe(endpoint: string): Promise<boolean> {
  const rows = await q(`DELETE FROM push_subscriptions WHERE endpoint = ? RETURNING label`, [String(endpoint || "")]);
  if (rows.length) await logEvent("system", `Alerts turned off for ${rows[0].label || "a device"}.`);
  return rows.length > 0;
}

export async function removeDevice(id: string): Promise<void> {
  const rows = await q(`DELETE FROM push_subscriptions WHERE id = ? RETURNING label`, [id]);
  if (!rows.length) throw new PushError("Device not found.", 404);
  await logEvent("system", `Removed ${rows[0].label || "a device"} from alerts.`);
}

export async function pushView() {
  const devices = await q(`SELECT * FROM push_subscriptions ORDER BY created_at`);
  const recent = await q(`SELECT kind, title, body, status, delivered, devices, thread_id, created_at FROM push_log WHERE kind <> 'test' ORDER BY created_at DESC LIMIT 8`);
  return {
    publicKey: (await vapidKeys()).publicKey,
    prefs: await getPrefs(),
    devices: devices.map(deviceView),
    recent: recent.map((r) => ({
      kind: String(r.kind),
      title: String(r.title || ""),
      body: String(r.body || ""),
      status: String(r.status),
      delivered: Number(r.delivered) || 0,
      devices: Number(r.devices) || 0,
      threadId: r.thread_id || null,
      at: String(r.created_at),
    })),
  };
}

/* --------------------------------- send ---------------------------------- */

interface Payload {
  title: string;
  body: string;
  tag: string;
  url: string;
  threadId: string | null;
  kind: string;
  at: string;
  /** Unread + needs-you threads, for the app icon's badge. */
  count?: number;
}

async function inboxCount(): Promise<number | undefined> {
  try {
    const { counts } = await import("../inbox/service");
    const c = await counts();
    return c.unread + c.needsHuman;
  } catch {
    return undefined;
  }
}

/** Send one payload to every device (or one). Updates each device's health. */
async function deliver(payload: Payload, urgency: "normal" | "high", onlyEndpoint?: string): Promise<{ devices: number; delivered: number; errors: string[] }> {
  const devices = onlyEndpoint ? await q(`SELECT * FROM push_subscriptions WHERE endpoint = ?`, [onlyEndpoint]) : await q(`SELECT * FROM push_subscriptions`);
  if (!devices.length) return { devices: 0, delivered: 0, errors: [] };
  const keys = await vapidKeys();
  const results: { d: Row; r: PushOutcome }[] = await Promise.all(
    devices.map(async (d) => ({ d, r: await sendPush({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, payload, { keys, subject: SUBJECT(), urgency, ttl: 86400 }) }))
  );
  const now = nowIso();
  let delivered = 0;
  const errors: string[] = [];
  for (const { d, r } of results) {
    if (r.ok) {
      delivered++;
      await q(`UPDATE push_subscriptions SET last_ok_at = ?, fails = 0, last_error = NULL, last_error_at = NULL WHERE id = ?`, [now, d.id]);
      continue;
    }
    const fails = (Number(d.fails) || 0) + 1;
    if (r.gone || (r.status === 403 && fails >= REFUSED_FORGET)) {
      // (Already gone when it was turned off while this was in flight: nothing to say.)
      const removed = await q(`DELETE FROM push_subscriptions WHERE id = ? RETURNING id`, [d.id]);
      if (removed.length) {
        await logEvent("system", `${d.label || "A device"} no longer takes alerts (${r.gone ? "the browser cancelled its sign-up" : "the push service keeps refusing it"}), so it was removed. Turn alerts on again there to get them back.`, { level: "warn" });
      }
      errors.push(`${d.label || "A device"} no longer takes alerts (${r.error || r.status}); it was removed. Turn alerts on again there.`);
      continue;
    }
    await q(`UPDATE push_subscriptions SET fails = ?, last_error = ?, last_error_at = ? WHERE id = ?`, [fails, oneLine(r.error, 240), now, d.id]);
    errors.push(`${d.label || "A device"}: ${r.error}`);
  }
  return { devices: devices.length, delivered, errors };
}

async function sentRecently(): Promise<number> {
  const since = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
  return Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM push_log WHERE status IN ('sent','sending') AND kind <> 'test' AND created_at >= ?`, [since]))[0]?.n) || 0;
}

// Alerts start in the background, several at once. Deciding and claiming runs
// one at a time, so a burst is counted right; sending runs in parallel.
let claimChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = claimChain.then(fn);
  claimChain = run.catch(() => {});
  return run;
}

const catLabel = (id: string) => REPLY_CATEGORIES.find((c) => c.id === id)?.label || "Reply";

function inMinutes(iso: string | null | undefined): string {
  const ms = Date.parse(String(iso || "")) - Date.now();
  if (!Number.isFinite(ms) || ms < 90_000) return "in a minute or two";
  const min = Math.round(ms / 60_000);
  if (min < 90) return `in about ${min} minutes`;
  return `in about ${Math.round(min / 60)} hours`;
}

/** The alerts this reply deserves right now, most important first, given the switches. */
export function alertKindsFor(m: Row, prefs: PushPrefs): AlertKind[] {
  const out: AlertKind[] = [];
  if (m.classification === "interested" && prefs.interested) out.push("interested");
  if ((m.ai_status === "needs_human" || m.ai_status === "failed") && prefs.handoff) out.push("handoff");
  if (m.ai_status === "drafted" && prefs.drafts) out.push("draft");
  return out;
}

function buildAlert(kind: AlertKind, m: Row, t: Row): { title: string; body: string } {
  const name = oneLine(t.lead_name || t.lead_email || "A lead", 60);
  const company = oneLine(t.company, 60);
  const what = oneLine(m.ai_summary || m.preview || m.body_text || "", 150);
  if (kind === "interested") {
    const tail =
      m.ai_status === "scheduled"
        ? ` The agent replies ${inMinutes(m.reply_due_at)}.`
        : m.ai_status === "drafted"
          ? " A reply is drafted for you to approve."
          : m.ai_status === "needs_human" || m.ai_status === "failed"
            ? " It's waiting for you."
            : "";
    return { title: `Interested · ${name}`, body: oneLine(`${company ? `${company}: ` : ""}${what || "Wants the next step."}${tail}`, 230) };
  }
  const from = `${catLabel(String(m.classification || "needs_human"))}${company ? ` from ${company}` : ""}`;
  if (kind === "handoff") {
    const tail = m.ai_status === "failed" ? " The agent couldn't handle it." : m.ai_draft ? " A draft is ready." : "";
    return { title: `Needs you · ${name}`, body: oneLine(`${from}: ${what || "Open it to read it."}${tail}`, 230) };
  }
  return { title: `Reply to approve · ${name}`, body: oneLine(`${from}: ${what || "The agent drafted an answer."} The agent's reply waits for you.`, 230) };
}

type Claim = { kind: AlertKind | null; status: string; send?: { id: string; kind: AlertKind; m: Row; title: string; body: string; now: string } };

/** Decide which alert (if any) this reply gets, and record it before anything is sent. */
async function claimAlert(messageId: string): Promise<Claim> {
  const m = (await q(`SELECT * FROM messages WHERE id = ?`, [messageId]))[0];
  if (!m || m.direction !== "in") return { kind: null, status: "none" };
  const at = Date.parse(String(m.sent_at || m.created_at || ""));
  if (!Number.isFinite(at) || Date.now() - at > MAX_AGE_MS) return { kind: null, status: "too_old" };
  const kinds = alertKindsFor(m, await getPrefs());
  if (!kinds.length) return { kind: null, status: "none" };
  // The first kind not told yet. (A draft adds nothing to "needs you"; an
  // interested reply later held for approval is news, so it alerts again.)
  const done = (await q(`SELECT kind FROM push_log WHERE message_id = ?`, [messageId])).map((r) => String(r.kind));
  const kind = kinds.find((k) => !done.includes(k) && !(k === "draft" && done.includes("handoff")));
  if (!kind) return { kind: kinds[0], status: "already" };
  const t = (await q(`SELECT * FROM threads WHERE id = ?`, [m.thread_id]))[0] || {};
  const { title, body } = buildAlert(kind, m, t);
  const id = uid();
  const now = nowIso();
  const burst = (await sentRecently()) >= BURST_MAX;
  const claimed = await q(
    `INSERT INTO push_log (id, message_id, thread_id, kind, title, body, status, devices, delivered, created_at) VALUES (?,?,?,?,?,?,?,0,0,?)
     ON CONFLICT (message_id, kind) DO NOTHING RETURNING id`,
    [id, messageId, m.thread_id || null, kind, title, body, burst ? "held" : "sending", now]
  );
  if (!claimed.length) return { kind, status: "already" };
  if (burst) return { kind, status: "held" };
  return { kind, status: "sending", send: { id, kind, m, title, body, now } };
}

/**
 * The Inbox calls this after the agent has read a reply (or held a scheduled
 * one). Sends at most one alert per reply and kind. Never throws for push
 * problems: they are recorded on the device.
 */
export async function alertForMessage(messageId: string): Promise<{ kind: AlertKind | null; status: string; delivered: number }> {
  const c = await oneAtATime(() => claimAlert(messageId));
  if (!c.send) return { kind: c.kind, status: c.status, delivered: 0 };
  const { id, kind, m, title, body, now } = c.send;
  const r = await deliver(
    { title, body, tag: `thread-${m.thread_id}`, url: `/?thread=${encodeURIComponent(String(m.thread_id))}`, threadId: String(m.thread_id), kind, at: now, count: await inboxCount() },
    kind === "draft" ? "normal" : "high"
  );
  const status = !r.devices ? "no_device" : r.delivered ? "sent" : "failed";
  await q(`UPDATE push_log SET status = ?, devices = ?, delivered = ? WHERE id = ?`, [status, r.devices, r.delivered, id]);
  return { kind, status, delivered: r.delivered };
}

/** Held alerts (a burst) go out as one, once the burst has passed. The push worker calls this every minute. */
export async function flushHeld(): Promise<number> {
  const held = await q(`SELECT l.*, m.ai_status AS m_status, m.classification AS m_class FROM push_log l LEFT JOIN messages m ON m.id = l.message_id WHERE l.status = 'held' ORDER BY l.created_at`);
  if (!held.length) return 0;
  if ((await sentRecently()) >= BURST_MAX) return 0;
  // Dealt with in the meantime (answered, closed): nothing to tell.
  const live = held.filter((h) => h.kind === "interested" || ["needs_human", "failed", "drafted"].includes(h.m_status));
  const dropped = held.filter((h) => !live.includes(h));
  for (const h of dropped) await q(`UPDATE push_log SET status = 'dropped' WHERE id = ?`, [h.id]);
  if (!live.length) return 0;
  const now = nowIso();
  if (live.length === 1) {
    const h = live[0];
    const r = await deliver({ title: h.title, body: h.body, tag: `thread-${h.thread_id}`, url: `/?thread=${encodeURIComponent(String(h.thread_id))}`, threadId: h.thread_id, kind: h.kind, at: now, count: await inboxCount() }, "high");
    await q(`UPDATE push_log SET status = ?, devices = ?, delivered = ?, created_at = ? WHERE id = ?`, [!r.devices ? "no_device" : r.delivered ? "sent" : "failed", r.devices, r.delivered, now, h.id]);
    return 1;
  }
  const by = (k: string) => live.filter((h) => h.kind === k).length;
  const parts = [
    by("interested") && `${by("interested")} interested`,
    by("handoff") && `${by("handoff")} need${by("handoff") === 1 ? "s" : ""} you`,
    by("draft") && `${by("draft")} repl${by("draft") === 1 ? "y" : "ies"} to approve`,
  ].filter(Boolean);
  const names = [...new Set(live.map((h) => String(h.title || "").split(" · ")[1]).filter(Boolean))].slice(0, 3);
  const title = `${live.length} more replies need a look`;
  const body = oneLine(`${parts.join(", ")}${names.length ? `: ${names.join(", ")}${live.length > names.length ? " and others" : ""}` : ""}.`, 230);
  const r = await deliver({ title, body, tag: "inbox-summary", url: "/?tab=inbox", threadId: null, kind: "summary", at: now, count: await inboxCount() }, "high");
  await q(`INSERT INTO push_log (id, message_id, thread_id, kind, title, body, status, devices, delivered, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    uid(),
    null,
    null,
    "summary",
    title,
    body,
    !r.devices ? "no_device" : r.delivered ? "sent" : "failed",
    r.devices,
    r.delivered,
    now,
  ]);
  for (const h of live) await q(`UPDATE push_log SET status = 'grouped' WHERE id = ?`, [h.id]);
  return live.length;
}

/** "Send a test" from the alerts dialog: to this device, or to every device. */
export async function sendTest(endpoint?: string) {
  const one = typeof endpoint === "string" && endpoint ? endpoint : undefined;
  if (one && !(await q(`SELECT id FROM push_subscriptions WHERE endpoint = ?`, [one]))[0]) throw new PushError("This device isn't signed up for alerts. Turn them on first.", 404);
  const now = nowIso();
  const r = await deliver(
    {
      title: "Alerts work on this device",
      body: "Replies handed to you, interested leads and replies waiting for your approval arrive like this.",
      tag: "test",
      url: "/?tab=inbox",
      threadId: null,
      kind: "test",
      at: now,
      count: await inboxCount(),
    },
    "high",
    one
  );
  await q(`INSERT INTO push_log (id, message_id, thread_id, kind, title, body, status, devices, delivered, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    uid(),
    null,
    null,
    "test",
    "Test",
    null,
    !r.devices ? "no_device" : r.delivered ? "sent" : "failed",
    r.devices,
    r.delivered,
    now,
  ]);
  return { devices: r.devices, delivered: r.delivered, errors: r.errors };
}
