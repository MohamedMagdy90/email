// Mailbox pool service. Pulls accounts, warmup analytics, daily sends and DNS
// checks from Instantly into `mailboxes` / `mailbox_health`, runs the policy
// (policy.ts) and pushes the result back: daily limits for the ramp, a pause
// when a mailbox goes bad, warmup back on when it was switched off.
//
// Contract exports (used by v2/campaigns):
//   getSendableMailboxes()  — mailboxes allowed to send campaign mail today
//   syncMailboxes()         — one full sync
import { q, getSetting, setSetting } from "../../db";
import { uid, todayUtc, logEvent, parseJson } from "../events";
import * as inst from "../instantly";
import { normalizePolicy, decide, rampParams, addDays, type MailboxPolicy, type MailboxRow, type HealthRow, type Dns } from "./policy";
import { buildView, viewMailbox, type PoolView } from "./view";

const POLICY_KEY = "mailbox_policy";
const LAST_SYNC_KEY = "mailbox_last_sync";
const DNS_TTL_MS = 12 * 3_600_000;
const MISSING_REASON = "Not found in Instantly any more (removed or renamed there).";
export const VENDORS = ["zapmail", "mailforge", "other"] as const;

// Overridable clock, so tests can walk the pool through several days.
let clock = () => new Date();
export function setClockForTests(fn: (() => Date) | null) {
  clock = fn || (() => new Date());
}
const nowIso = () => clock().toISOString();
const today = () => todayUtc(clock());

const errMsg = (e: unknown) => String((e as any)?.message || e);

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/* ------------------------------- schema ------------------------------- */

/** Columns this module adds to `mailboxes`. Idempotent. */
export async function ensureMailboxColumns() {
  for (const sql of [
    "ALTER TABLE mailboxes ADD COLUMN target_custom INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE mailboxes ADD COLUMN missing_since TEXT",
  ]) {
    try {
      await q(sql);
    } catch {
      /* column already exists */
    }
  }
}

/* ------------------------------- policy ------------------------------- */

export async function getPolicy(): Promise<MailboxPolicy> {
  return normalizePolicy(parseJson(await getSetting(POLICY_KEY), {}));
}

export async function savePolicy(raw: unknown): Promise<MailboxPolicy> {
  const before = await getPolicy();
  const policy = normalizePolicy({ ...before, ...(raw && typeof raw === "object" ? raw : {}) });
  await setSetting(POLICY_KEY, JSON.stringify(policy));
  const changed = (Object.keys(policy) as (keyof MailboxPolicy)[]).filter((k) => policy[k] !== before[k]);
  if (changed.length) await logEvent("mailbox", `Mailbox rules changed: ${changed.join(", ")}.`, { refType: "mailbox_policy" });
  return policy;
}

/* -------------------------------- reads -------------------------------- */

const toRow = (r: any): MailboxRow => ({
  ...r,
  provider_code: r.provider_code == null ? null : Number(r.provider_code),
  instantly_status: r.instantly_status == null ? null : Number(r.instantly_status),
  warmup_status: r.warmup_status == null ? null : Number(r.warmup_status),
  warmup_score: r.warmup_score == null ? null : Number(r.warmup_score),
  pre_warmed: Number(r.pre_warmed) || 0,
  daily_limit: Number(r.daily_limit) || 0,
  target_limit: Number(r.target_limit) || 0,
  ramp_start: Number(r.ramp_start) || 0,
  ramp_step: Number(r.ramp_step) || 0,
  manual_hold: Number(r.manual_hold) || 0,
  target_custom: Number(r.target_custom) || 0,
});

const toHealth = (h: any): HealthRow => ({
  day: String(h.day),
  warmup_sent: Number(h.warmup_sent) || 0,
  warmup_inbox: Number(h.warmup_inbox) || 0,
  warmup_spam: Number(h.warmup_spam) || 0,
  warmup_received: Number(h.warmup_received) || 0,
  inbox_rate: h.inbox_rate == null ? null : Number(h.inbox_rate),
  health_score: h.health_score == null ? null : Number(h.health_score),
  campaign_sent: Number(h.campaign_sent) || 0,
  bounced: Number(h.bounced) || 0,
  replies: Number(h.replies) || 0,
});

async function loadRows(): Promise<MailboxRow[]> {
  return (await q("SELECT * FROM mailboxes ORDER BY domain, email")).map(toRow);
}

async function loadRow(id: string): Promise<MailboxRow | null> {
  const r = (await q("SELECT * FROM mailboxes WHERE id = ?", [id]))[0];
  return r ? toRow(r) : null;
}

async function loadHealth(sinceDay: string, mailboxId?: string): Promise<Map<string, HealthRow[]>> {
  const rows = mailboxId
    ? await q("SELECT * FROM mailbox_health WHERE day >= ? AND mailbox_id = ? ORDER BY day", [sinceDay, mailboxId])
    : await q("SELECT * FROM mailbox_health WHERE day >= ? ORDER BY day", [sinceDay]);
  const out = new Map<string, HealthRow[]>();
  for (const r of rows) {
    const list = out.get(String(r.mailbox_id)) || [];
    list.push(toHealth(r));
    out.set(String(r.mailbox_id), list);
  }
  return out;
}

/** Mailboxes allowed to send campaign mail right now, with today's limit. */
export async function getSendableMailboxes(): Promise<{ email: string; dailyLimit: number }[]> {
  const rows = await q(
    `SELECT email, daily_limit FROM mailboxes
     WHERE stage IN ('ramping', 'active') AND missing_since IS NULL AND instantly_status = 1 AND daily_limit > 0
     ORDER BY email`
  );
  return rows.map((r) => ({ email: String(r.email), dailyLimit: Number(r.daily_limit) || 0 }));
}

export interface LastSync {
  at: string;
  ok: boolean;
  synced: number;
  errors: string[];
  ms: number;
}

export async function listView(): Promise<PoolView & { example: false; connected: boolean; syncing: boolean; lastSync: LastSync | null; policy: MailboxPolicy }> {
  const policy = await getPolicy();
  const t = today();
  const view = buildView(await loadRows(), await loadHealth(addDays(t, -29)), policy, t);
  return {
    example: false,
    connected: await inst.instantlyConfigured(),
    syncing: isSyncing(),
    lastSync: parseJson<LastSync | null>(await getSetting(LAST_SYNC_KEY), null),
    policy,
    ...view,
  };
}

export async function mailboxDetail(id: string) {
  const row = await loadRow(id);
  if (!row) return null;
  const policy = await getPolicy();
  const t = today();
  const health = (await loadHealth(addDays(t, -29), id)).get(id) || [];
  const events = await q(
    "SELECT * FROM agent_events WHERE ref_type = 'mailbox' AND ref_id = ? ORDER BY created_at DESC LIMIT 40",
    [id]
  );
  return { mailbox: viewMailbox(row, health, policy, t), health, events };
}

/* ------------------------------ evaluate ------------------------------ */

/**
 * Run the policy over stored data and apply the result. With `push`, also
 * tell Instantly: today's daily limit for sending mailboxes, pause for newly
 * paused ones, warmup back on where it was switched off.
 * `live` = the account list from this sync (lets us see Instantly's own limit).
 */
export async function evaluateAll(opts: { push: boolean; onlyId?: string; live?: Map<string, inst.InstantlyAccount> }): Promise<{ errors: string[] }> {
  const policy = await getPolicy();
  const t = today();
  const now = nowIso();
  const rows = (await loadRows()).filter((r) => !opts.onlyId || r.id === opts.onlyId);
  const health = await loadHealth(addDays(t, -29), opts.onlyId);
  const errors: string[] = [];
  const connected = opts.push && (await inst.instantlyConfigured());
  const warmupOff: MailboxRow[] = [];

  for (const row of rows) {
    if (row.missing_since) continue;
    const d = decide(row, health.get(row.id) || [], policy, t);
    const { target } = rampParams(row, policy);
    const stageChanged = d.stage !== row.stage;
    await q(
      `UPDATE mailboxes SET stage = ?, stage_reason = ?, stage_changed_at = ?, daily_limit = ?, ramp_started_at = ?,
         target_limit = ?, ramp_start = ?, ramp_step = ?, checks_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        d.stage,
        d.reason,
        stageChanged ? now : row.stage_changed_at || row.created_at,
        d.dailyLimit,
        d.rampStartedAt,
        target,
        policy.rampStart,
        policy.rampStep,
        JSON.stringify({ checks: d.checks, metrics: d.metrics, at: now }),
        now,
        row.id,
      ]
    );
    if (d.event) await logEvent("mailbox", d.event.message, { level: d.event.level, refType: "mailbox", refId: row.id });
    if (!connected) continue;

    const live = opts.live?.get(row.email.toLowerCase());
    try {
      if (d.stage === "ramping" || d.stage === "active") {
        const instantlyLimit = live ? Number(live.daily_limit ?? -1) : row.daily_limit;
        if (instantlyLimit !== d.dailyLimit) await inst.patchAccount(row.email, { daily_limit: d.dailyLimit });
      }
      if (d.stage === "paused" && stageChanged && row.instantly_status !== 2) {
        await inst.pauseAccount(row.email);
        await logEvent("mailbox", `Stopped campaign sending for ${row.email} in Instantly.`, { refType: "mailbox", refId: row.id });
      }
    } catch (e) {
      errors.push(`${row.email}: ${errMsg(e)}`);
    }
    if (policy.keepWarmupOn && row.warmup_status === 0 && (live || !opts.live)) warmupOff.push(row);
  }

  if (connected && warmupOff.length) {
    try {
      await inst.enableWarmup(warmupOff.map((r) => r.email));
      for (const r of warmupOff) {
        await q("UPDATE mailboxes SET warmup_status = 1 WHERE id = ?", [r.id]);
        await logEvent("mailbox", `Warmup was off for ${r.email}. Turned it back on.`, { refType: "mailbox", refId: r.id });
      }
    } catch (e) {
      errors.push(`Turning warmup back on: ${errMsg(e)}`);
    }
  }
  return { errors };
}

/* -------------------------------- sync -------------------------------- */

let running: Promise<{ synced: number; errors: string[] }> | null = null;
export const isSyncing = () => !!running;

/** One full sync. Concurrent callers share the run in progress. */
export function syncMailboxes(opts: { forceDns?: boolean } = {}): Promise<{ synced: number; errors: string[] }> {
  if (!running) running = runSync(opts).finally(() => (running = null));
  return running;
}

async function recordSync(started: number, synced: number, errors: string[]) {
  const rec: LastSync = { at: nowIso(), ok: errors.length === 0, synced, errors: errors.slice(0, 10), ms: Date.now() - started };
  await setSetting(LAST_SYNC_KEY, JSON.stringify(rec));
}

function dnsFromVitals(v: inst.VitalsResult, at: string): Dns {
  return {
    mx: !!v.mx,
    spf: !!v.spf,
    dkim: !!v.dkim,
    dmarc: !!v.dmarc,
    allPass: !!v.allPass,
    indeterminate: Array.isArray(v.indeterminate) ? v.indeterminate.map(String) : [],
    checkedAt: at,
  };
}

async function runSync(opts: { forceDns?: boolean }): Promise<{ synced: number; errors: string[] }> {
  const started = Date.now();
  const errors: string[] = [];
  if (!(await inst.instantlyConfigured())) return { synced: 0, errors: ["Instantly is not connected."] };

  let accounts: inst.InstantlyAccount[];
  try {
    accounts = await inst.listAccounts();
  } catch (e) {
    errors.push(errMsg(e));
    await recordSync(started, 0, errors);
    return { synced: 0, errors };
  }

  const now = nowIso();
  const t = today();
  const existing = await loadRows();
  const byEmail = new Map(existing.map((r) => [r.email.toLowerCase(), r]));
  const live = new Map<string, inst.InstantlyAccount>();
  const idByEmail = new Map<string, string>();

  /* 1. accounts -> mailboxes */
  for (const a of accounts) {
    const email = String(a.email || "").trim().toLowerCase();
    if (!email || live.has(email)) continue;
    live.set(email, a);
    const domain = email.split("@")[1] || null;
    const vals = [
      domain,
      a.first_name || null,
      a.last_name || null,
      a.provider_code ?? null,
      a.status ?? null,
      a.warmup_status ?? null,
      a.stat_warmup_score ?? null,
      a.timestamp_warmup_start || null,
    ];
    const row = byEmail.get(email);
    if (!row) {
      const id = uid();
      idByEmail.set(email, id);
      await q(
        `INSERT INTO mailboxes (id, email, domain, first_name, last_name, provider_code, instantly_status, warmup_status,
           warmup_score, warmup_started_at, stage, stage_reason, stage_changed_at, last_synced_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, email, ...vals, "warming", "Just found in Instantly.", now, now, now, now]
      );
      await logEvent("mailbox", `Found ${email} in Instantly and started tracking it.`, { refType: "mailbox", refId: id });
    } else {
      idByEmail.set(email, row.id);
      await q(
        `UPDATE mailboxes SET domain = ?, first_name = ?, last_name = ?, provider_code = ?, instantly_status = ?, warmup_status = ?,
           warmup_score = ?, warmup_started_at = ?, last_synced_at = ?, missing_since = NULL, updated_at = ?
         WHERE id = ?`,
        [...vals, now, now, row.id]
      );
      if (row.missing_since && row.stage === "paused" && row.stage_reason === MISSING_REASON) {
        await q("UPDATE mailboxes SET stage = 'warming', stage_reason = ?, stage_changed_at = ?, ramp_started_at = NULL, daily_limit = 0 WHERE id = ?", [
          "Back in Instantly. Going through the checks again.",
          now,
          row.id,
        ]);
        await logEvent("mailbox", `${email} is back in Instantly. It goes through the readiness checks again.`, { refType: "mailbox", refId: row.id });
      }
    }
  }

  /* 2. mailboxes that left Instantly */
  for (const r of existing) {
    if (live.has(r.email.toLowerCase()) || r.missing_since) continue;
    await q("UPDATE mailboxes SET missing_since = ?, stage = 'paused', stage_reason = ?, stage_changed_at = ?, daily_limit = 0, updated_at = ? WHERE id = ?", [
      now,
      MISSING_REASON,
      now,
      now,
      r.id,
    ]);
    await logEvent("mailbox", `${r.email} is no longer in Instantly. Marked it paused.`, { level: "warn", refType: "mailbox", refId: r.id });
  }

  const emails = [...live.keys()];
  const oldest = addDays(t, -59);

  /* 3. warmup analytics -> mailbox_health (warmup columns) */
  for (const part of chunks(emails, 100)) {
    try {
      const { aggregate, byDate } = await inst.warmupAnalytics(part);
      const dates = new Map(Object.entries(byDate || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const agg = new Map(Object.entries(aggregate || {}).map(([k, v]) => [k.toLowerCase(), v]));
      for (const email of part) {
        const id = idByEmail.get(email) as string;
        for (const [day, d] of Object.entries(dates.get(email) || {})) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < oldest || day > t) continue;
          const inbox = Number(d?.landed_inbox) || 0;
          const spam = Number(d?.landed_spam) || 0;
          await q(
            `INSERT INTO mailbox_health (id, mailbox_id, day, warmup_sent, warmup_inbox, warmup_spam, warmup_received, inbox_rate, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT (mailbox_id, day) DO UPDATE SET warmup_sent = excluded.warmup_sent, warmup_inbox = excluded.warmup_inbox,
               warmup_spam = excluded.warmup_spam, warmup_received = excluded.warmup_received, inbox_rate = excluded.inbox_rate`,
            [uid(), id, day, Number(d?.sent) || 0, inbox, spam, Number(d?.received) || 0, inbox + spam > 0 ? Math.round((inbox / (inbox + spam)) * 1000) / 10 : null, now]
          );
        }
        const score = agg.get(email)?.health_score;
        if (live.get(email)?.stat_warmup_score == null && score != null && Number.isFinite(Number(score))) {
          await q("UPDATE mailboxes SET warmup_score = ? WHERE id = ?", [Number(score), id]);
        }
      }
    } catch (e) {
      errors.push(`Warmup analytics: ${errMsg(e)}`);
    }
  }

  /* 4. daily campaign numbers -> mailbox_health (campaign columns) */
  for (const part of chunks(emails, 200)) {
    try {
      const stats = await inst.dailyAccountAnalytics(part, addDays(t, -29), t);
      for (const s of stats) {
        const id = idByEmail.get(String(s.email_account || "").toLowerCase());
        const day = String(s.date || "").slice(0, 10);
        if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        await q(
          `INSERT INTO mailbox_health (id, mailbox_id, day, campaign_sent, bounced, replies, created_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (mailbox_id, day) DO UPDATE SET campaign_sent = excluded.campaign_sent, bounced = excluded.bounced, replies = excluded.replies`,
          [uid(), id, day, Number(s.sent) || 0, Number(s.bounced) || 0, Number(s.unique_replies ?? s.replies) || 0, now]
        );
      }
    } catch (e) {
      errors.push(`Daily sending numbers: ${errMsg(e)}`);
    }
  }

  /* 5. DNS vitals, once per domain, at most every 12 hours */
  const fresh = await loadRows();
  const byDomain = new Map<string, MailboxRow[]>();
  for (const r of fresh) {
    if (r.missing_since || !r.domain) continue;
    byDomain.set(r.domain, [...(byDomain.get(r.domain) || []), r]);
  }
  const due: { domain: string; email: string; prev: Dns | null }[] = [];
  for (const [domain, list] of byDomain) {
    const last = list.map((r) => r.last_vitals_at || "").sort().pop() || "";
    if (opts.forceDns || !last || Date.parse(now) - Date.parse(last) > DNS_TTL_MS) {
      due.push({ domain, email: list[0].email, prev: parseJson<Dns | null>(list[0].dns_json, null) });
    }
  }
  for (const part of chunks(due, 50)) {
    try {
      const results = await inst.testVitals(part.map((d) => d.email));
      const byName = new Map(results.map((v) => [String(v.domain || "").toLowerCase(), v]));
      for (const d of part) {
        const v = byName.get(d.domain.toLowerCase());
        if (!v) continue;
        const dns = dnsFromVitals(v, now);
        await q("UPDATE mailboxes SET dns_json = ?, last_vitals_at = ? WHERE domain = ?", [JSON.stringify(dns), now, d.domain]);
        if (!d.prev || d.prev.allPass !== dns.allPass) {
          const missing = (["mx", "spf", "dkim", "dmarc"] as const).filter((k) => !dns[k]).map((k) => k.toUpperCase());
          await logEvent(
            "mailbox",
            dns.allPass ? `DNS check passed for ${d.domain}: MX, SPF, DKIM and DMARC found.` : `DNS check for ${d.domain}: missing ${missing.join(", ")}.`,
            { level: dns.allPass ? "success" : "warn", refType: "domain", refId: d.domain }
          );
        }
      }
    } catch (e) {
      errors.push(`DNS check: ${errMsg(e)}`);
    }
  }

  /* 6. policy + push */
  const ev = await evaluateAll({ push: true, live });
  errors.push(...ev.errors);
  await recordSync(started, live.size, errors);
  return { synced: live.size, errors };
}

/* --------------------------- manual actions --------------------------- */

export class MailboxError extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.status = status;
  }
}

async function mustRow(id: string): Promise<MailboxRow> {
  const row = await loadRow(id);
  if (!row) throw new MailboxError("Mailbox not found.", 404);
  return row;
}

/** Notes for the caller when Instantly could not be told. */
async function tellInstantly(fn: () => Promise<unknown>): Promise<string | null> {
  if (!(await inst.instantlyConfigured())) return null;
  try {
    await fn();
    return null;
  } catch (e) {
    return errMsg(e);
  }
}

export async function pauseMailbox(id: string, reason?: string) {
  const row = await mustRow(id);
  if (row.stage === "paused") throw new MailboxError("Already paused.");
  const now = nowIso();
  const why = (reason || "").trim().slice(0, 300) || "Paused by you.";
  await q("UPDATE mailboxes SET stage = 'paused', stage_reason = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?", [why, now, now, id]);
  const warning = row.stage === "ramping" || row.stage === "active" ? await tellInstantly(() => inst.pauseAccount(row.email)) : null;
  await logEvent("mailbox", `Paused ${row.email} by hand.${reason ? ` Reason: ${why}` : ""}`, { refType: "mailbox", refId: id });
  return { warning };
}

export async function resumeMailbox(id: string) {
  const row = await mustRow(id);
  if (row.stage !== "paused") throw new MailboxError("Only a paused mailbox can be resumed.");
  if (row.missing_since) throw new MailboxError("This mailbox is no longer in Instantly. Add it back there first.");
  const now = nowIso();
  await q(
    "UPDATE mailboxes SET stage = 'warming', stage_reason = ?, stage_changed_at = ?, ramp_started_at = NULL, daily_limit = 0, updated_at = ? WHERE id = ?",
    ["Back through the checks after a pause.", now, now, id]
  );
  const warning = row.instantly_status === 2 ? await tellInstantly(() => inst.resumeAccount(row.email)) : null;
  if (!warning && row.instantly_status === 2 && (await inst.instantlyConfigured())) await q("UPDATE mailboxes SET instantly_status = 1 WHERE id = ?", [id]);
  await logEvent("mailbox", `Resumed ${row.email}. It goes through the readiness checks again, and the ramp restarts from day 1.`, {
    refType: "mailbox",
    refId: id,
  });
  const ev = await evaluateAll({ push: true, onlyId: id });
  return { warning: warning || ev.errors[0] || null };
}

/** Start the ramp now for a mailbox that passes every check (overrides a hold). */
export async function startMailbox(id: string) {
  const row = await mustRow(id);
  if (row.stage !== "ready" && row.stage !== "warming") throw new MailboxError(`Already ${row.stage}.`);
  const policy = await getPolicy();
  const t = today();
  const health = (await loadHealth(addDays(t, -29), id)).get(id) || [];
  const d = decide({ ...row, manual_hold: 0, stage: "warming" }, health, { ...policy, autoStart: true }, t);
  if (d.stage !== "ramping" && d.stage !== "active") throw new MailboxError(`Not ready yet: ${d.reason}`);
  // daily_limit stays 0 here: the evaluation below sets it and, because it
  // changed, pushes it to Instantly.
  await q("UPDATE mailboxes SET manual_hold = 0, stage = 'ramping', ramp_started_at = ?, daily_limit = 0, updated_at = ? WHERE id = ?", [
    d.rampStartedAt,
    nowIso(),
    id,
  ]);
  await logEvent("mailbox", `Started sending from ${row.email} at ${d.dailyLimit} emails a day.`, { level: "success", refType: "mailbox", refId: id });
  const ev = await evaluateAll({ push: true, onlyId: id });
  return { warning: ev.errors[0] || null };
}

export interface MailboxPatch {
  vendor?: string;
  preWarmed?: boolean;
  manualHold?: boolean;
  targetLimit?: number | null;
  notes?: string;
}

export async function updateMailbox(id: string, p: MailboxPatch) {
  const row = await mustRow(id);
  const sets: string[] = [];
  const vals: any[] = [];
  const said: string[] = [];
  if (p.vendor !== undefined) {
    const v = String(p.vendor).toLowerCase();
    if (!(VENDORS as readonly string[]).includes(v)) throw new MailboxError("Vendor must be zapmail, mailforge or other.");
    sets.push("vendor = ?");
    vals.push(v);
    if (v !== row.vendor) said.push(`vendor ${v}`);
  }
  if (p.preWarmed !== undefined) {
    sets.push("pre_warmed = ?");
    vals.push(p.preWarmed ? 1 : 0);
    if ((p.preWarmed ? 1 : 0) !== row.pre_warmed) said.push(p.preWarmed ? "marked pre-warmed" : "not pre-warmed");
  }
  if (p.manualHold !== undefined) {
    sets.push("manual_hold = ?");
    vals.push(p.manualHold ? 1 : 0);
    if ((p.manualHold ? 1 : 0) !== row.manual_hold) said.push(p.manualHold ? "held before sending" : "hold removed");
  }
  if (p.targetLimit !== undefined) {
    if (p.targetLimit === null) {
      sets.push("target_custom = 0");
      if (row.target_custom === 1) said.push("daily limit follows the pool rule");
    } else {
      const n = Math.round(Number(p.targetLimit));
      if (!(n >= 1 && n <= 200)) throw new MailboxError("Daily limit must be between 1 and 200.");
      sets.push("target_custom = 1", "target_limit = ?");
      vals.push(n);
      if (row.target_custom !== 1 || row.target_limit !== n) said.push(`full daily limit ${n}`);
    }
  }
  if (p.notes !== undefined) {
    sets.push("notes = ?");
    vals.push(String(p.notes).slice(0, 1000));
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  vals.push(nowIso(), id);
  await q(`UPDATE mailboxes SET ${sets.join(", ")} WHERE id = ?`, vals);
  if (said.length) await logEvent("mailbox", `Updated ${row.email}: ${said.join(", ")}.`, { refType: "mailbox", refId: id });
  const ev = await evaluateAll({ push: true, onlyId: id });
  return { warning: ev.errors[0] || null };
}

export async function setWarmup(id: string, on: boolean) {
  const row = await mustRow(id);
  if (!(await inst.instantlyConfigured())) throw new MailboxError("Connect Instantly first.");
  try {
    await (on ? inst.enableWarmup([row.email]) : inst.disableWarmup([row.email]));
  } catch (e) {
    throw new MailboxError(errMsg(e), 502);
  }
  await q("UPDATE mailboxes SET warmup_status = ?, updated_at = ? WHERE id = ?", [on ? 1 : 0, nowIso(), id]);
  await logEvent("mailbox", on ? `Turned warmup on for ${row.email}.` : `Turned warmup off for ${row.email} by hand.`, {
    level: on ? "info" : "warn",
    refType: "mailbox",
    refId: id,
  });
  await evaluateAll({ push: false, onlyId: id });
}

/** Drop a mailbox that is no longer in Instantly, with its history. */
export async function forgetMailbox(id: string) {
  const row = await mustRow(id);
  if (!row.missing_since) throw new MailboxError("Only mailboxes that were removed from Instantly can be dropped here.");
  await q("DELETE FROM mailbox_health WHERE mailbox_id = ?", [id]);
  await q("DELETE FROM mailboxes WHERE id = ?", [id]);
  await logEvent("mailbox", `Stopped tracking ${row.email} (removed from Instantly).`, { refType: "mailbox", refId: id });
}
