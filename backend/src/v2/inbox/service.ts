// Inbox (v2 workstream B): every reply from every campaign, threaded, read by
// the agent and answered according to the rules on the Agent tab.
//
//   sync      Instantly Unibox -> threads / messages (received + manual sends)
//   process   classify -> decideReply() -> housekeeping | hand off | draft | schedule
//   send      scheduled replies go out from the SAME mailbox, in the SAME thread
//   actions   reply yourself, approve / edit / discard / rewrite, pause the agent
//
// Prospect outcomes (contract): prospects.stage / interest / replied_at, matched
// by lower-cased email. Never writes campaigns.
import { getSetting, q, setSetting } from "../../db";
import { decideReply, getAgentSettings, REPLY_CATEGORIES, type AgentSettings, type ReplyDecision } from "../agent-settings";
import { logEvent, parseJson, textToHtml, htmlToText, uid } from "../events";
import * as inst from "../instantly";
import { classifyMessage, latestReply, stripRe, type Classification } from "./classify";
import { checkReply, writeReply, type ReplyContext } from "./writer";

/* -------------------------------- config -------------------------------- */

const POLL_EVERY_MS = 3 * 60_000;
const TICK_MS = 20_000;
/** Older than this, a reply is never auto-sent (first sync, outages). */
const STALE_HOURS = 72;
const MAX_PAGES = 5;
const MAX_BACKFILL_PER_SYNC = 12;
const MAX_SEND_ATTEMPTS = 3;
const CURSOR_KEY = (t: string) => `inbox_cursor_${t}`;
const LAST_SYNC_KEY = "inbox_last_sync";

let clock = () => new Date();
/** Tests only: move time forward. */
export function setClockForTests(fn: (() => Date) | null) {
  clock = fn || (() => new Date());
}
const nowIso = () => clock().toISOString();
const errMsg = (e: unknown) => String((e as any)?.message || e);
const oneLine = (s: string, n = 200) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

export class InboxError extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.name = "InboxError";
    this.status = status;
  }
}

/** Columns this module adds. Idempotent. */
export async function ensureInboxColumns() {
  const tryQ = async (sql: string) => {
    try {
      await q(sql);
    } catch {
      /* already there */
    }
  };
  await tryQ(`ALTER TABLE messages ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0`);
  await tryQ(`ALTER TABLE messages ADD COLUMN ai_source TEXT`);
  await tryQ(`ALTER TABLE messages ADD COLUMN ai_meta TEXT`);
  await tryQ(`ALTER TABLE threads ADD COLUMN instantly_campaign_id TEXT`);
  await tryQ(`ALTER TABLE threads ADD COLUMN backfilled_at TEXT`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status)`);
}

/* ------------------------------- helpers -------------------------------- */

type Row = Record<string, any>;

const one = async (sql: string, params: any[] = []) => (await q(sql, params))[0] || null;
const getThread = (id: string) => one(`SELECT * FROM threads WHERE id = ?`, [id]);
const getMessage = (id: string) => one(`SELECT * FROM messages WHERE id = ?`, [id]);
const threadMessages = (threadId: string) => q(`SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at ASC, created_at ASC`, [threadId]);
const ts = (m: Row) => String(m.sent_at || m.created_at || "");
export const threadIdOf = async (messageId: string): Promise<string | null> => (await getMessage(messageId))?.thread_id || null;
const catOf = (id: string | null | undefined) => REPLY_CATEGORIES.find((c) => c.id === id) || null;

function randMinutes([lo, hi]: [number, number]) {
  const a = Math.max(0, Math.min(lo, hi));
  const b = Math.max(lo, hi);
  return a + Math.random() * (b - a);
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

/* ---------------------------- lead context ------------------------------ */

async function leadContext(t: Row) {
  let prospect: Row | null = null;
  let company: Row | null = null;
  let campaign: Row | null = null;
  let contact: Row | null = null;
  const email = String(t.lead_email || "").toLowerCase();
  try {
    prospect = t.prospect_id
      ? await one(`SELECT * FROM prospects WHERE id = ?`, [t.prospect_id])
      : email
        ? await one(`SELECT * FROM prospects WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1`, [email])
        : null;
    if (prospect?.company_id) company = await one(`SELECT * FROM companies WHERE id = ?`, [prospect.company_id]);
    const cid = t.campaign_id || prospect?.campaign_id;
    if (cid) campaign = await one(`SELECT id, name, kind, status FROM campaigns WHERE id = ?`, [cid]);
  } catch {
    /* lead engine not migrated */
  }
  try {
    if (email) contact = await one(`SELECT company, country, industry, category, phone, source, status FROM contacts WHERE LOWER(email) = ?`, [email]);
  } catch {
    /* classic tables missing */
  }
  return { prospect, company, campaign, contact };
}

function researchFacts(company: Row | null, prospect: Row | null): string[] {
  const out: string[] = [];
  if (company?.description) out.push(String(company.description));
  if (company?.industry) out.push(`Industry: ${company.industry}`);
  if (company?.size_hint) out.push(`Size: ${company.size_hint}`);
  const r = parseJson<any>(company?.research_json, null);
  if (r && typeof r === "object") {
    if (typeof r.summary === "string") out.push(r.summary);
    for (const k of ["hooks", "facts", "signals", "highlights", "recent", "notes"]) {
      if (Array.isArray(r[k])) out.push(...r[k].filter((x: unknown) => typeof x === "string"));
    }
  }
  if (prospect?.fit_reason) out.push(`Why they fit: ${prospect.fit_reason}`);
  return [...new Set(out.map((s) => oneLine(s, 300)).filter(Boolean))].slice(0, 8);
}

async function replyContext(t: Row, msgs: Row[], m: Row, cls?: Partial<Classification>): Promise<ReplyContext> {
  const { prospect, company, contact } = await leadContext(t);
  const meta = parseJson<any>(m.ai_meta, {});
  const before = msgs.filter((x) => x.id !== m.id && ts(x) <= ts(m));
  return {
    lead: {
      name: prospect?.full_name || t.lead_name || null,
      email: t.lead_email,
      title: prospect?.title || null,
      company: company?.name || t.company || contact?.company || null,
      city: company?.city || null,
      country: company?.country || contact?.country || null,
    },
    research: researchFacts(company, prospect),
    history: before.slice(-6).map((x) => ({
      direction: x.direction === "out" ? "out" : "in",
      at: x.sent_at || null,
      text: latestReply(x.body_text || ""),
    })),
    latest: { subject: m.subject || t.subject || "", text: latestReply(m.body_text || "") },
    category: (cls?.category || m.classification || "needs_human") as string,
    language: cls?.language || meta.language || null,
    referral: cls?.referral ?? meta.referral ?? null,
    returnDate: cls?.returnDate ?? meta.returnDate ?? null,
  };
}

/* ---------------------------- thread status ----------------------------- */

const CLOSING = new Set(["unsubscribe", "bounce", "not_interested"]);

/** Derive status + list fields from the messages, so they never drift. */
async function recompute(threadId: string, opts: { keepClosed?: boolean } = {}) {
  const t = await getThread(threadId);
  if (!t) return;
  const msgs = await threadMessages(threadId);
  const last = msgs[msgs.length - 1];
  const inbound = msgs.filter((m) => m.direction === "in");
  const lastIn = inbound[inbound.length - 1];
  const has = (...s: string[]) => msgs.some((m) => s.includes(m.ai_status));
  let status: string;
  if (opts.keepClosed && t.status === "closed" && !has("pending", "scheduled")) status = "closed";
  else if (has("needs_human", "drafted", "failed")) status = "needs_human";
  else if (has("pending", "scheduled")) status = "open";
  else if (lastIn && CLOSING.has(lastIn.classification) && last?.direction === "in") status = "closed";
  else status = "handled";
  const preview = last ? oneLine(last.direction === "in" ? latestReply(last.body_text || "") : last.body_text || "") : t.last_preview;
  await q(
    `UPDATE threads SET status = ?, last_message_at = ?, last_direction = ?, last_preview = ?, classification = ?, updated_at = ? WHERE id = ?`,
    [status, last ? ts(last) : t.last_message_at, last?.direction || t.last_direction, preview, lastIn?.classification || t.classification, nowIso(), threadId]
  );
}

/* -------------------------------- ingest -------------------------------- */

type RawEmail = inst.InstantlyEmail & { from_address_json?: any; i_status?: number | null };

function directionOf(e: RawEmail, eaccount: string): "in" | "out" {
  if (e.ue_type === 2) return "in";
  if (e.ue_type === 1 || e.ue_type === 3 || e.ue_type === 4) return "out";
  return String(e.from_address_email || "").toLowerCase() === eaccount ? "out" : "in";
}

function senderName(e: RawEmail): string | null {
  const j = Array.isArray(e.from_address_json) ? e.from_address_json[0] : null;
  const n = j && (j.name || j.display_name || j.Name);
  const clean = n ? String(n).replace(/["']/g, "").trim() : "";
  return clean && !clean.includes("@") ? clean.slice(0, 120) : null;
}

const bodyOf = (e: RawEmail) => {
  const t = String(e.body?.text || "").trim();
  return t || htmlToText(String(e.body?.html || ""));
};

export interface StoreResult {
  inserted: boolean;
  threadId: string | null;
  newThread: boolean;
}

/**
 * Store one Unibox email (idempotent on instantly id).
 * `pendingIfAfter`: inbound mail at/after this ISO time is queued for the agent;
 * older inbound is kept as history only.
 */
export async function storeEmail(e: RawEmail, opts: { pendingIfAfter: string; onlyKnownThreads?: boolean }): Promise<StoreResult> {
  if (!e?.id) return { inserted: false, threadId: null, newThread: false };
  if (await one(`SELECT id FROM messages WHERE instantly_id = ?`, [e.id])) return { inserted: false, threadId: null, newThread: false };

  const eaccount = String(e.eaccount || "").toLowerCase();
  const dir = directionOf(e, eaccount);
  const lead = String(e.lead || (dir === "in" ? e.from_address_email : String(e.to_address_email_list || "").split(",")[0]) || "")
    .trim()
    .toLowerCase();
  const key = e.thread_id || `lead:${lead}|${eaccount}`;
  const at = e.timestamp_email || e.timestamp_created || nowIso();
  const now = nowIso();

  let t = await one(`SELECT * FROM threads WHERE instantly_thread_id = ?`, [key]);
  let newThread = false;
  if (!t) {
    if (opts.onlyKnownThreads) return { inserted: false, threadId: null, newThread: false };
    const ctx = await leadContext({ lead_email: lead });
    let campaignId: string | null = ctx.prospect?.campaign_id || null;
    if (!campaignId && e.campaign_id) {
      try {
        campaignId = (await one(`SELECT id FROM campaigns WHERE instantly_campaign_id = ?`, [e.campaign_id]))?.id || null;
      } catch {
        /* no campaigns yet */
      }
    }
    const id = uid();
    await q(
      `INSERT INTO threads (id, instantly_thread_id, prospect_id, campaign_id, instantly_campaign_id, lead_email, lead_name, company, eaccount, subject,
         last_message_at, last_direction, last_preview, unread, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        key,
        ctx.prospect?.id || null,
        campaignId,
        e.campaign_id || null,
        lead,
        ctx.prospect?.full_name || (dir === "in" ? senderName(e) : null),
        ctx.company?.name || ctx.contact?.company || null,
        eaccount,
        stripRe(e.subject || "").slice(0, 300),
        at,
        dir,
        "",
        0,
        "open",
        now,
        now,
      ]
    );
    t = await getThread(id);
    newThread = true;
  } else if (dir === "in" && !t.lead_name) {
    const n = senderName(e);
    if (n) await q(`UPDATE threads SET lead_name = ? WHERE id = ?`, [n, t.id]);
  }

  const text = bodyOf(e).slice(0, 60_000);
  const queued = dir === "in" && at >= opts.pendingIfAfter;
  await q(
    `INSERT INTO messages (id, instantly_id, thread_id, direction, eaccount, from_email, to_email, subject, body_text, body_html, preview,
       sent_at, is_auto_reply, step, ai_status, ai_reason, sent_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      uid(),
      e.id,
      t!.id,
      dir,
      eaccount,
      String(e.from_address_email || (dir === "out" ? eaccount : lead)).toLowerCase(),
      String(e.to_address_email_list || "").toLowerCase().slice(0, 500),
      String(e.subject || "").slice(0, 300),
      text,
      String(e.body?.html || "").slice(0, 120_000),
      oneLine(dir === "in" ? latestReply(text) : text, 240),
      at,
      e.is_auto_reply ? 1 : 0,
      e.step || null,
      dir === "in" ? (queued ? "pending" : "skipped") : null,
      dir === "in" && !queued ? "Earlier message, kept for context." : null,
      dir === "out" ? (e.ue_type === 1 ? "campaign" : "instantly") : null,
      now,
    ]
  );

  if (dir === "in" && queued) {
    await q(`UPDATE threads SET unread = 1, updated_at = ? WHERE id = ?`, [now, t!.id]);
    if (t!.status === "closed") await q(`UPDATE threads SET status = 'open' WHERE id = ?`, [t!.id]);
  }
  if (dir === "out" && e.ue_type === 3) {
    // Someone answered in Instantly itself: nothing before it still needs us.
    await q(
      `UPDATE messages SET ai_status = 'replied', ai_reason = 'Answered from Instantly.', reply_due_at = NULL
       WHERE thread_id = ? AND direction = 'in' AND ai_status IN ('needs_human','drafted','failed','scheduled') AND sent_at <= ?`,
      [t!.id, at]
    );
  }
  await recompute(t!.id, { keepClosed: dir === "out" });
  return { inserted: true, threadId: t!.id, newThread };
}

export interface LastSync {
  at: string;
  ok: boolean;
  fetched: number;
  stored: number;
  newThreads: number;
  errors: string[];
}

let syncing: Promise<LastSync> | null = null;
export const isSyncing = () => !!syncing;

/** Pull new replies (and manual sends) from Instantly. One at a time. */
export function syncInbox(): Promise<LastSync> {
  if (syncing) return syncing;
  syncing = doSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function doSync(): Promise<LastSync> {
  const res: LastSync = { at: nowIso(), ok: true, fetched: 0, stored: 0, newThreads: 0, errors: [] };
  const backfillDays = Math.min(60, Math.max(1, Number(await getSetting("inbox_backfill_days")) || 14));
  const windowStart = new Date(clock().getTime() - backfillDays * 86_400_000).toISOString();
  let newReplies = 0;

  for (const type of ["received", "manual"] as const) {
    const cursor = (await getSetting(CURSOR_KEY(type))) || windowStart;
    let newest = cursor;
    let after: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await inst.listEmails({
          email_type: type,
          min_timestamp_created: cursor,
          sort_order: "asc",
          limit: 100,
          starting_after: after,
          mode: "emode_all",
        });
        const items = (r?.items || []) as RawEmail[];
        for (const e of items) {
          res.fetched++;
          const s = await storeEmail(e, { pendingIfAfter: windowStart, onlyKnownThreads: type === "manual" });
          if (s.inserted) {
            res.stored++;
            if (type === "received") newReplies++;
          }
          if (s.newThread) res.newThreads++;
          if (e.timestamp_created && e.timestamp_created > newest) newest = e.timestamp_created;
        }
        if (!r?.next_starting_after || items.length < 100) break;
        after = r.next_starting_after;
      }
    } catch (e) {
      res.ok = false;
      res.errors.push(errMsg(e));
    }
    if (newest !== cursor) await setSetting(CURSOR_KEY(type), newest);
  }

  // Give new threads their history (our first email, follow-ups) so the agent
  // knows what it is answering. Capped per sync; the rest go next time.
  const todo = await q(`SELECT id FROM threads WHERE backfilled_at IS NULL ORDER BY created_at ASC LIMIT ${MAX_BACKFILL_PER_SYNC}`);
  for (const r of todo) {
    try {
      await backfillThread(r.id, windowStart);
      await q(`UPDATE threads SET backfilled_at = ? WHERE id = ?`, [nowIso(), r.id]);
    } catch (e) {
      res.errors.push(errMsg(e));
      break; // Instantly is struggling; try again next sync
    }
  }

  await setSetting(LAST_SYNC_KEY, JSON.stringify(res));
  if (newReplies) await logEvent("reply", `${plural(newReplies, "new reply")} pulled from Instantly.`, { level: "info" });
  if (!res.ok) await logEvent("reply", `Inbox sync had a problem: ${res.errors[0]}`, { level: "warn" });
  return res;
}

async function backfillThread(threadId: string, windowStart: string) {
  const t = await getThread(threadId);
  if (!t) return;
  const key = String(t.instantly_thread_id || "");
  const query: inst.ListEmailsQuery = key.startsWith("lead:")
    ? { lead: t.lead_email, eaccount: t.eaccount, limit: 50, sort_order: "asc" }
    : { search: `thread:${key}`, limit: 50, sort_order: "asc" };
  const r = await inst.listEmails(query);
  for (const e of (r?.items || []) as RawEmail[]) await storeEmail(e, { pendingIfAfter: windowStart });
}

export async function lastSync(): Promise<LastSync | null> {
  return parseJson<LastSync | null>(await getSetting(LAST_SYNC_KEY), null);
}

/* ------------------------------- outcomes ------------------------------- */

const OUTCOME: Record<string, { stage?: string; interest?: string; instantly?: number; block?: boolean; replied?: boolean }> = {
  interested: { stage: "interested", interest: "interested", instantly: 1, replied: true },
  question: { stage: "replied", interest: "question", replied: true },
  not_now: { stage: "replied", interest: "not_now", replied: true },
  referral: { stage: "replied", interest: "referral", instantly: -2, replied: true },
  not_interested: { stage: "lost", interest: "not_interested", instantly: -1, replied: true },
  negotiation: { stage: "interested", interest: "negotiation", instantly: 1, replied: true },
  complaint: { stage: "lost", interest: "complaint", instantly: -1, block: true, replied: true },
  legal: { stage: "lost", interest: "legal", instantly: -1, block: true, replied: true },
  needs_human: { stage: "replied", replied: true },
  unsubscribe: { stage: "unsubscribed", interest: "unsubscribe", instantly: -1, block: true, replied: true },
  out_of_office: { interest: "out_of_office", instantly: 0 },
  bounce: { stage: "bounced", interest: "bounce" },
};

/** Prospect stage + Instantly lead status + block list. Best effort, logged. */
async function applyOutcome(t: Row, m: Row, cls: Classification) {
  const o = OUTCOME[cls.category];
  if (!o) return;
  const email = String(t.lead_email || "").toLowerCase();
  const now = nowIso();
  try {
    const rows = email ? await q(`SELECT id, stage FROM prospects WHERE LOWER(email) = ?`, [email]) : [];
    for (const p of rows) {
      const protectedStage = ["meeting", "won"].includes(p.stage) && ["replied", "interested"].includes(o.stage || "");
      const stage = o.stage && !protectedStage ? o.stage : p.stage;
      await q(
        `UPDATE prospects SET stage = ?, interest = COALESCE(?, interest), replied_at = CASE WHEN ? = 1 THEN COALESCE(replied_at, ?) ELSE replied_at END,
           email_status = CASE WHEN ? = 1 THEN 'invalid' ELSE email_status END,
           next_action_at = COALESCE(?, next_action_at), updated_at = ? WHERE id = ?`,
        [stage, o.interest || null, o.replied ? 1 : 0, m.sent_at || now, cls.category === "bounce" ? 1 : 0, cls.returnDate || null, now, p.id]
      );
    }
  } catch {
    /* lead engine not migrated */
  }
  if (!email || !(await inst.instantlyConfigured())) return;
  if (typeof o.instantly === "number") {
    try {
      await inst.updateInterest(email, o.instantly, t.instantly_campaign_id || undefined);
    } catch (e) {
      await logEvent("reply", `Couldn't update ${email} in Instantly: ${errMsg(e)}`, { level: "warn", refType: "thread", refId: t.id });
    }
  }
  if (o.block) {
    try {
      await inst.blockEntry(email);
      await logEvent("reply", `Blocked ${email} in Instantly, so no campaign will email them again.`, { level: "info", refType: "thread", refId: t.id });
    } catch (e) {
      await logEvent("reply", `Couldn't block ${email} in Instantly: ${errMsg(e)}`, { level: "warn", refType: "thread", refId: t.id });
    }
  }
}

/* ------------------------------- process -------------------------------- */

const busy = new Set<string>();

async function setMsg(id: string, fields: Record<string, any>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await q(`UPDATE messages SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
}

function who(t: Row) {
  return t.lead_name || t.lead_email || "the prospect";
}

/**
 * Read one inbound message and act on it.
 * `forceCategory` = a person corrected the category (confidence 1).
 */
export async function processMessage(id: string, opts: { forceCategory?: string } = {}): Promise<void> {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    const m = await getMessage(id);
    if (!m || m.direction !== "in") throw new InboxError("Message not found.", 404);
    const t = await getThread(m.thread_id);
    if (!t) throw new InboxError("Thread not found.", 404);
    const msgs = await threadMessages(t.id);
    const ev = { refType: "thread", refId: t.id, campaignId: t.campaign_id || undefined };

    if (msgs.some((x) => x.direction === "in" && x.id !== m.id && ts(x) > ts(m))) {
      await setMsg(id, { ai_status: "skipped", ai_reason: "A newer message from them arrived; the agent answers that one.", reply_due_at: null });
      await recompute(t.id);
      return;
    }
    const answered = msgs.some((x) => x.direction === "out" && ts(x) > ts(m));
    const settings = await getAgentSettings();
    const text = latestReply(m.body_text || "");
    const ourLast = [...msgs].reverse().find((x) => x.direction === "out" && ts(x) <= ts(m));

    let cls: Classification;
    if (opts.forceCategory) {
      if (!catOf(opts.forceCategory)) throw new InboxError("Unknown category.");
      const prev = parseJson<any>(m.ai_meta, {});
      cls = {
        category: opts.forceCategory as Classification["category"],
        confidence: 1,
        summary: m.ai_summary || "",
        language: prev.language || "en",
        source: "human",
        returnDate: prev.returnDate || null,
        referral: prev.referral || null,
      };
    } else {
      cls = await classifyMessage(
        {
          from: m.from_email,
          subject: m.subject,
          text,
          isAutoReply: !!Number(m.is_auto_reply),
          ourLast: ourLast ? { subject: ourLast.subject || "", text: latestReply(ourLast.body_text || "") } : null,
        },
        clock()
      );
    }
    await setMsg(id, {
      classification: cls.category,
      confidence: cls.confidence,
      ai_summary: cls.summary || null,
      ai_source: cls.source,
      ai_meta: JSON.stringify({ language: cls.language, returnDate: cls.returnDate || null, referral: cls.referral || null, error: cls.error || null, provider: cls.provider || null }),
    });
    await q(`UPDATE threads SET classification = ?, updated_at = ? WHERE id = ?`, [cls.category, nowIso(), t.id]);
    await applyOutcome(t, m, cls);

    const label = catOf(cls.category)?.label || cls.category;
    let d: ReplyDecision = Number(t.ai_paused)
      ? { action: "handoff", reason: "You paused the agent on this thread." }
      : decideReply(settings, { category: cls.category, confidence: cls.confidence, autoRepliesInThread: Number(t.auto_replies || 0) });
    if (cls.source === "none" && d.action !== "silent") d = { action: "handoff", reason: cls.error || "No AI is connected, so replies wait for you." };

    if (answered && d.action !== "silent") {
      await setMsg(id, { ai_status: "classified", ai_reason: "Already answered in this thread.", reply_due_at: null });
      await recompute(t.id);
      return;
    }
    const ageH = (clock().getTime() - new Date(ts(m)).getTime()) / 3_600_000;
    if (d.action === "send" && ageH > STALE_HOURS) {
      d = { action: "draft", reason: `This reply is ${Math.round(ageH / 24)} days old, so the agent drafted an answer for you instead of sending it on its own.` };
    }

    if (d.action === "silent") {
      await setMsg(id, { ai_status: "skipped", ai_reason: d.reason, reply_due_at: null, ai_draft: null });
      await recompute(t.id);
      await logEvent("reply", `${label} from ${who(t)}: ${d.reason}`, { ...ev, level: cls.category === "bounce" ? "warn" : "info" });
      return;
    }

    if (d.action === "handoff") {
      await setMsg(id, { ai_status: "needs_human", ai_reason: d.reason, reply_due_at: null });
      await recompute(t.id);
      await logEvent("reply", `${label} from ${who(t)} needs you: ${d.reason}`, { ...ev, level: "warn" });
      // A head start for the person, when it's safe to have one.
      const c = catOf(cls.category);
      if (c && c.kind === "reply" && cls.source !== "none") {
        try {
          const w = await writeReply(settings, await replyContext(t, msgs, m, cls));
          await setMsg(id, { ai_draft: w.body });
        } catch {
          /* no draft, the person writes it */
        }
      }
      return;
    }

    // draft | send — both need the writer.
    let body: string;
    try {
      body = (await writeReply(settings, await replyContext(t, msgs, m, cls))).body;
    } catch (e) {
      await setMsg(id, { ai_status: "needs_human", ai_reason: `The agent couldn't write a reply: ${errMsg(e)}`, reply_due_at: null });
      await recompute(t.id);
      await logEvent("write", `Couldn't write a reply to ${who(t)}: ${errMsg(e)}`, { ...ev, level: "error" });
      return;
    }
    const held = d.action === "send" ? checkReply(body, settings) : null;
    if (d.action === "draft" || held) {
      const reason = held ? `Held for you: ${held}` : d.reason;
      await setMsg(id, { ai_status: "drafted", ai_reason: reason, ai_draft: body, reply_due_at: null });
      await recompute(t.id);
      await logEvent("write", `Drafted a reply to ${who(t)} (${label.toLowerCase()}). ${reason}`, ev);
      return;
    }
    const due = new Date(clock().getTime() + randMinutes(d.delayMinutes || [0, 0]) * 60_000).toISOString();
    await setMsg(id, { ai_status: "scheduled", ai_reason: d.reason, ai_draft: body, reply_due_at: due, send_attempts: 0 });
    await recompute(t.id);
    await logEvent("write", `Wrote a reply to ${who(t)} (${label.toLowerCase()}); it goes out ${due.slice(11, 16)} UTC.`, ev);
  } finally {
    busy.delete(id);
  }
}

let processing = false;
export async function processPending(limit = 4): Promise<number> {
  if (processing) return 0;
  processing = true;
  let n = 0;
  try {
    const rows = await q(`SELECT id FROM messages WHERE direction = 'in' AND ai_status = 'pending' ORDER BY sent_at ASC LIMIT ${Math.max(1, Math.floor(limit))}`);
    for (const r of rows) {
      try {
        await processMessage(r.id);
        n++;
      } catch (e) {
        await setMsg(r.id, { ai_status: "failed", ai_reason: `The agent hit an error reading this: ${errMsg(e)}` }).catch(() => {});
        const m = await getMessage(r.id).catch(() => null);
        if (m) await recompute(m.thread_id).catch(() => {});
        console.error(`[inbox] process ${r.id}: ${errMsg(e)}`);
      }
    }
  } finally {
    processing = false;
  }
  return n;
}

/* --------------------------------- send --------------------------------- */

/** Send `body` as a reply to message `replyTo`, from the thread's mailbox. */
async function deliver(t: Row, replyTo: Row, body: string, by: "agent" | "approved" | "you"): Promise<void> {
  const text = String(body || "").trim();
  if (!text) throw new InboxError("The reply is empty.");
  if (!(await inst.instantlyConfigured())) throw new InboxError("Connect Instantly first — replies go out through your mailboxes there.");
  if (!t.eaccount) throw new InboxError("This thread has no sending mailbox.");
  if (!replyTo?.instantly_id) throw new InboxError("Can't reply to this message: it has no Instantly id.");
  const subject = `Re: ${stripRe(replyTo.subject || t.subject || "")}`.trim();
  const sent = await inst.replyToEmail({ eaccount: t.eaccount, reply_to_uuid: replyTo.instantly_id, subject, body: { text, html: textToHtml(text) } });
  const at = sent?.timestamp_email || sent?.timestamp_created || nowIso();
  await q(
    `INSERT INTO messages (id, instantly_id, thread_id, direction, eaccount, from_email, to_email, subject, body_text, body_html, preview, sent_at, is_auto_reply, sent_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uid(), sent?.id || null, t.id, "out", t.eaccount, t.eaccount, t.lead_email, subject, text, textToHtml(text), oneLine(text, 240), at, 0, by, nowIso()]
  );
  await q(
    `UPDATE messages SET ai_status = 'replied', reply_due_at = NULL,
       ai_reason = CASE WHEN id = ? THEN ? ELSE 'Answered in the same reply.' END
     WHERE thread_id = ? AND direction = 'in' AND ai_status IN ('needs_human','drafted','failed','scheduled','classified','pending') AND sent_at <= ?`,
    [replyTo.id, by === "agent" ? "The agent replied." : by === "approved" ? "You approved the agent's reply." : "You replied.", t.id, ts(replyTo)]
  );
  await q(`UPDATE threads SET auto_replies = auto_replies + ?, unread = 0, updated_at = ? WHERE id = ?`, [by === "agent" ? 1 : 0, nowIso(), t.id]);
  await recompute(t.id);
  const ev = { refType: "thread", refId: t.id, campaignId: t.campaign_id || undefined, level: "success" as const };
  if (by === "agent") await logEvent("send", `Replied to ${who(t)} from ${t.eaccount}.`, ev);
  else if (by === "approved") await logEvent("send", `Sent the reply you approved to ${who(t)}.`, ev);
  else await logEvent("send", `You replied to ${who(t)}.`, ev);
}

function retryable(e: unknown) {
  return e instanceof inst.InstantlyError && (e.status === 0 || e.status === 429 || e.status >= 500);
}

async function sendScheduled(id: string) {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    const m = await getMessage(id);
    if (!m || m.ai_status !== "scheduled") return;
    const t = await getThread(m.thread_id);
    if (!t) return;
    const msgs = await threadMessages(t.id);
    const ev = { refType: "thread", refId: t.id, campaignId: t.campaign_id || undefined };
    if (msgs.some((x) => x.direction === "in" && ts(x) > ts(m))) {
      await setMsg(id, { ai_status: "skipped", ai_reason: "They wrote again before it went out; the agent answers the newer message.", reply_due_at: null });
      return recompute(t.id);
    }
    if (msgs.some((x) => x.direction === "out" && ts(x) > ts(m))) {
      await setMsg(id, { ai_status: "replied", ai_reason: "Someone already answered in this thread.", reply_due_at: null });
      return recompute(t.id);
    }
    const settings = await getAgentSettings();
    const hold = async (reason: string) => {
      await setMsg(id, { ai_status: "drafted", ai_reason: reason, reply_due_at: null });
      await recompute(t.id);
      await logEvent("write", `Held the reply to ${who(t)}: ${reason}`, { ...ev, level: "warn" });
    };
    if (Number(t.ai_paused)) return hold("You paused the agent on this thread, so its reply waits for you.");
    const d = decideReply(settings, { category: m.classification, confidence: Number(m.confidence ?? 0), autoRepliesInThread: Number(t.auto_replies || 0) });
    if (d.action === "silent") {
      await setMsg(id, { ai_status: "skipped", ai_reason: d.reason, reply_due_at: null });
      return recompute(t.id);
    }
    if (d.action !== "send") return hold(`Your settings changed before it went out. ${d.reason}`);
    const problem = checkReply(m.ai_draft || "", settings);
    if (problem) return hold(problem);
    try {
      await deliver(t, m, m.ai_draft || "", "agent");
    } catch (e) {
      const attempts = Number(m.send_attempts || 0) + 1;
      if (retryable(e) && attempts < MAX_SEND_ATTEMPTS) {
        const due = new Date(clock().getTime() + 5 * 60_000 * attempts).toISOString();
        await setMsg(id, { send_attempts: attempts, reply_due_at: due, ai_reason: `Instantly didn't take it (${errMsg(e)}). Trying again at ${due.slice(11, 16)} UTC.` });
      } else {
        await setMsg(id, { ai_status: "failed", send_attempts: attempts, reply_due_at: null, ai_reason: `Couldn't send: ${errMsg(e)}` });
        await recompute(t.id);
        await logEvent("send", `Couldn't send the reply to ${who(t)}: ${errMsg(e)}`, { ...ev, level: "error" });
      }
    }
  } finally {
    busy.delete(id);
  }
}

let sending = false;
export async function sendDue(limit = 5): Promise<number> {
  if (sending) return 0;
  sending = true;
  try {
    const rows = await q(`SELECT id FROM messages WHERE ai_status = 'scheduled' AND reply_due_at <= ? ORDER BY reply_due_at ASC LIMIT ${Math.max(1, Math.floor(limit))}`, [nowIso()]);
    for (const r of rows) {
      try {
        await sendScheduled(r.id);
      } catch (e) {
        console.error(`[inbox] send ${r.id}: ${errMsg(e)}`);
      }
    }
    return rows.length;
  } finally {
    sending = false;
  }
}

/* ---------------------------- manual actions ---------------------------- */

async function mustThread(id: string) {
  const t = await getThread(id);
  if (!t) throw new InboxError("Thread not found.", 404);
  return t;
}
async function mustInbound(id: string) {
  const m = await getMessage(id);
  if (!m || m.direction !== "in") throw new InboxError("Message not found.", 404);
  const t = await mustThread(m.thread_id);
  return { m, t };
}

/** You write the reply. Goes to their latest message, from the thread's mailbox. */
export async function replyAsYou(threadId: string, body: string) {
  const t = await mustThread(threadId);
  const msgs = await threadMessages(t.id);
  const target = [...msgs].reverse().find((x) => x.direction === "in" && x.instantly_id) || [...msgs].reverse().find((x) => x.instantly_id);
  if (!target) throw new InboxError("There's no message in this thread to reply to yet.");
  await deliver(t, target, body, "you");
}

export async function approveDraft(messageId: string, body?: string) {
  const { m, t } = await mustInbound(messageId);
  const text = typeof body === "string" && body.trim() ? body : m.ai_draft;
  if (!text) throw new InboxError("There's no draft to send. Write one first.");
  await deliver(t, m, text, "approved");
}

export async function saveDraft(messageId: string, body: string) {
  const { m, t } = await mustInbound(messageId);
  const text = String(body || "").trim();
  if (!text) throw new InboxError("The draft is empty.");
  if (m.ai_status === "scheduled") {
    const problem = checkReply(text, await getAgentSettings());
    if (problem) {
      await setMsg(m.id, { ai_draft: text, ai_status: "drafted", reply_due_at: null, ai_reason: `Held for you after your edit: ${problem}` });
      return recompute(t.id);
    }
    await setMsg(m.id, { ai_draft: text });
    return;
  }
  await setMsg(m.id, { ai_draft: text, ai_status: m.ai_status === "needs_human" || m.ai_status === "failed" || m.ai_status === "classified" ? "drafted" : m.ai_status });
  await recompute(t.id);
}

export async function discardDraft(messageId: string) {
  const { m, t } = await mustInbound(messageId);
  await setMsg(m.id, { ai_status: "classified", ai_draft: null, reply_due_at: null, ai_reason: "You chose not to send the agent's reply." });
  await recompute(t.id);
  await logEvent("reply", `Discarded the agent's reply to ${who(t)}.`, { refType: "thread", refId: t.id });
}

/** Write (or rewrite) the draft for an inbound message, with an optional nudge. */
export async function redraft(messageId: string, instruction?: string) {
  const { m, t } = await mustInbound(messageId);
  const msgs = await threadMessages(t.id);
  const settings = await getAgentSettings();
  const w = await writeReply(settings, await replyContext(t, msgs, m), instruction ? String(instruction).slice(0, 500) : null);
  if (m.ai_status === "scheduled") {
    const problem = checkReply(w.body, settings);
    if (problem) await setMsg(m.id, { ai_draft: w.body, ai_status: "drafted", reply_due_at: null, ai_reason: `Held for you: ${problem}` });
    else await setMsg(m.id, { ai_draft: w.body });
  } else {
    await setMsg(m.id, {
      ai_draft: w.body,
      ai_status: ["replied", "pending"].includes(m.ai_status) ? m.ai_status : "drafted",
      ai_reason: ["replied", "pending"].includes(m.ai_status) ? m.ai_reason : instruction ? `Rewritten: "${oneLine(instruction, 80)}"` : "Drafted on request.",
    });
  }
  await recompute(t.id);
}

/** Send a scheduled reply right away (you pressed "Send now"). */
export async function sendNow(messageId: string) {
  const { m, t } = await mustInbound(messageId);
  if (!m.ai_draft) throw new InboxError("There's no reply to send.");
  await deliver(t, m, m.ai_draft, "approved");
}

export async function setThreadRead(threadId: string, read: boolean) {
  const t = await mustThread(threadId);
  await q(`UPDATE threads SET unread = ?, updated_at = ? WHERE id = ?`, [read ? 0 : 1, nowIso(), t.id]);
  const key = String(t.instantly_thread_id || "");
  if (read && key && !key.startsWith("lead:") && (await inst.instantlyConfigured())) {
    inst.markThreadRead(key).catch(() => {});
  }
}

export async function setThreadAi(threadId: string, paused: boolean) {
  const t = await mustThread(threadId);
  await q(`UPDATE threads SET ai_paused = ?, updated_at = ? WHERE id = ?`, [paused ? 1 : 0, nowIso(), t.id]);
  if (paused) {
    await q(
      `UPDATE messages SET ai_status = 'drafted', reply_due_at = NULL, ai_reason = 'You paused the agent on this thread, so its reply waits for you.'
       WHERE thread_id = ? AND ai_status = 'scheduled'`,
      [t.id]
    );
  }
  await recompute(t.id);
  await logEvent("reply", `${paused ? "Paused" : "Resumed"} the agent on the thread with ${who(t)}.`, { refType: "thread", refId: t.id });
}

export async function setThreadStatus(threadId: string, status: "closed" | "handled" | "open") {
  const t = await mustThread(threadId);
  if (status === "closed" || status === "handled") {
    await q(
      `UPDATE messages SET ai_status = 'classified', reply_due_at = NULL, ai_reason = ? WHERE thread_id = ? AND ai_status IN ('needs_human','drafted','failed','scheduled')`,
      [status === "closed" ? "Thread closed by you." : "Marked handled by you.", t.id]
    );
  }
  if (status === "closed") {
    await q(`UPDATE threads SET status = 'closed', unread = 0, updated_at = ? WHERE id = ?`, [nowIso(), t.id]);
    await recompute(t.id, { keepClosed: true });
  } else {
    if (t.status === "closed") await q(`UPDATE threads SET status = 'open' WHERE id = ?`, [t.id]);
    await recompute(t.id);
  }
}

/* -------------------------------- views --------------------------------- */

export type InboxFilter = "active" | "needs_human" | "scheduled" | "unread" | "closed" | "all";
const FILTERS: InboxFilter[] = ["active", "needs_human", "scheduled", "unread", "closed", "all"];

export async function counts(): Promise<{ unread: number; needsHuman: number }> {
  const r = await one(
    `SELECT SUM(CASE WHEN status = 'needs_human' THEN 1 ELSE 0 END) AS needs,
            SUM(CASE WHEN unread = 1 AND status NOT IN ('needs_human','closed') THEN 1 ELSE 0 END) AS unread
     FROM threads`
  );
  // `unread` leaves out threads already counted in needsHuman, so the tab
  // badge (unread + needsHuman) counts each thread once.
  return { unread: Number(r?.unread || 0), needsHuman: Number(r?.needs || 0) };
}

function pendingOf(rows: Row[]) {
  const pick = (s: string) => rows.find((r) => r.ai_status === s);
  const p = pick("failed") || pick("needs_human") || pick("drafted") || pick("scheduled") || pick("pending");
  if (!p) return null;
  return { kind: p.ai_status as string, dueAt: p.reply_due_at || null, reason: p.ai_reason || null, messageId: p.id as string };
}

function threadView(t: Row, pend: Row[] = []) {
  return {
    id: t.id as string,
    leadEmail: (t.lead_email || "") as string,
    leadName: (t.lead_name || null) as string | null,
    company: (t.company || null) as string | null,
    subject: (t.subject || "") as string,
    eaccount: (t.eaccount || "") as string,
    lastMessageAt: (t.last_message_at || null) as string | null,
    lastDirection: (t.last_direction || null) as string | null,
    lastPreview: (t.last_preview || "") as string,
    unread: !!Number(t.unread),
    status: t.status as string,
    classification: (t.classification || null) as string | null,
    aiPaused: !!Number(t.ai_paused),
    autoReplies: Number(t.auto_replies || 0),
    campaignId: (t.campaign_id || null) as string | null,
    pending: pendingOf(pend),
  };
}

export async function listThreads(opts: { filter?: string; search?: string; category?: string; limit?: number; offset?: number } = {}) {
  const filter: InboxFilter = FILTERS.includes(opts.filter as InboxFilter) ? (opts.filter as InboxFilter) : "active";
  const where: string[] = [];
  const params: any[] = [];
  if (filter === "active") where.push(`status <> 'closed'`);
  if (filter === "needs_human") where.push(`status = 'needs_human'`);
  if (filter === "unread") where.push(`unread = 1`);
  if (filter === "closed") where.push(`status = 'closed'`);
  if (filter === "scheduled") where.push(`id IN (SELECT thread_id FROM messages WHERE ai_status = 'scheduled')`);
  if (opts.category && catOf(opts.category)) {
    where.push(`classification = ?`);
    params.push(opts.category);
  }
  const s = String(opts.search || "").trim().toLowerCase().slice(0, 100);
  if (s) {
    where.push(`(LOWER(COALESCE(lead_email,'')) LIKE ? OR LOWER(COALESCE(lead_name,'')) LIKE ? OR LOWER(COALESCE(company,'')) LIKE ? OR LOWER(COALESCE(subject,'')) LIKE ?)`);
    params.push(`%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`);
  }
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit || 60)));
  const offset = Math.max(0, Math.floor(opts.offset || 0));
  const rows = await q(
    `SELECT * FROM threads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_message_at DESC LIMIT ${limit + 1} OFFSET ${offset}`,
    params
  );
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.id);
  const pend = ids.length
    ? await q(
        `SELECT id, thread_id, ai_status, reply_due_at, ai_reason FROM messages
         WHERE thread_id IN (${ids.map(() => "?").join(",")}) AND ai_status IN ('scheduled','drafted','needs_human','failed','pending')`,
        ids
      )
    : [];
  const c = await one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status <> 'closed' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'needs_human' THEN 1 ELSE 0 END) AS needs,
            SUM(CASE WHEN unread = 1 THEN 1 ELSE 0 END) AS unread,
            SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
     FROM threads`
  );
  const sched = await one(`SELECT COUNT(DISTINCT thread_id) AS n FROM messages WHERE ai_status = 'scheduled'`);
  return {
    filter,
    threads: page.map((t) => threadView(t, pend.filter((p) => p.thread_id === t.id))),
    hasMore: rows.length > limit,
    counts: {
      active: Number(c?.active || 0),
      needs_human: Number(c?.needs || 0),
      scheduled: Number(sched?.n || 0),
      unread: Number(c?.unread || 0),
      closed: Number(c?.closed || 0),
      all: Number(c?.total || 0),
    } as Record<InboxFilter, number>,
  };
}

function messageView(m: Row) {
  const text = String(m.body_text || "");
  const reply = latestReply(text);
  return {
    id: m.id as string,
    direction: m.direction as "in" | "out",
    from: (m.from_email || "") as string,
    to: (m.to_email || "") as string,
    subject: (m.subject || "") as string,
    text,
    replyText: reply,
    hasQuote: reply.length < text.trim().length - 20,
    sentAt: (m.sent_at || m.created_at) as string,
    isAutoReply: !!Number(m.is_auto_reply),
    step: (m.step || null) as string | null,
    classification: (m.classification || null) as string | null,
    confidence: m.confidence == null ? null : Number(m.confidence),
    summary: (m.ai_summary || null) as string | null,
    aiStatus: (m.ai_status || null) as string | null,
    aiReason: (m.ai_reason || null) as string | null,
    aiDraft: (m.ai_draft || null) as string | null,
    aiSource: (m.ai_source || null) as string | null,
    replyDueAt: (m.reply_due_at || null) as string | null,
    sentBy: (m.sent_by || null) as string | null,
    meta: parseJson<Record<string, any>>(m.ai_meta, {}),
  };
}

export async function threadDetail(id: string) {
  const t = await getThread(id);
  if (!t) return null;
  const msgs = await threadMessages(id);
  const { prospect, company, campaign, contact } = await leadContext(t);
  let mailbox: Row | null = null;
  try {
    mailbox = t.eaccount ? await one(`SELECT email, stage, daily_limit, vendor FROM mailboxes WHERE email = ?`, [t.eaccount]) : null;
  } catch {
    /* mailboxes module absent */
  }
  const events = await q(`SELECT id, kind, level, message, created_at FROM agent_events WHERE ref_type = 'thread' AND ref_id = ? ORDER BY created_at DESC LIMIT 25`, [id]);
  return {
    thread: threadView(t, msgs.filter((m) => ["scheduled", "drafted", "needs_human", "failed", "pending"].includes(m.ai_status))),
    messages: msgs.map(messageView),
    lead: {
      name: prospect?.full_name || t.lead_name || null,
      email: t.lead_email,
      title: prospect?.title || null,
      linkedin: prospect?.linkedin_url || null,
      company: company?.name || t.company || contact?.company || null,
      website: company?.website || (company?.domain ? `https://${company.domain}` : null),
      country: company?.country || contact?.country || null,
      city: company?.city || null,
      industry: company?.industry || contact?.industry || null,
      phone: company?.phone || contact?.phone || null,
      stage: prospect?.stage || null,
      fitScore: prospect?.fit_score == null ? null : Number(prospect.fit_score),
      research: researchFacts(company, prospect),
      source: prospect ? "campaign" : contact ? "contacts" : null,
    },
    campaign: campaign ? { id: campaign.id, name: campaign.name, kind: campaign.kind, status: campaign.status } : null,
    mailbox: mailbox ? { email: mailbox.email, stage: mailbox.stage, dailyLimit: Number(mailbox.daily_limit || 0), vendor: mailbox.vendor } : t.eaccount ? { email: t.eaccount, stage: null, dailyLimit: null, vendor: null } : null,
    events,
  };
}

/* --------------------------- playground (no I/O) ------------------------ */

export async function playground(input: { subject?: string; message: string; category?: string; settings: AgentSettings; write?: boolean }) {
  const text = latestReply(String(input.message || "")).slice(0, 4000);
  if (!text.trim()) throw new InboxError("Paste a reply to test.");
  const subject = String(input.subject || "Re: quick question").slice(0, 200);
  const cls: Classification =
    input.category && catOf(input.category)
      ? { category: input.category as Classification["category"], confidence: 1, summary: "Category set by you.", language: "en", source: "human" }
      : await classifyMessage({ subject, text, from: "prospect@example.com" }, clock());
  let decision = decideReply(input.settings, { category: cls.category, confidence: cls.confidence, autoRepliesInThread: 0 });
  if (cls.source === "none" && decision.action !== "silent") decision = { action: "handoff", reason: cls.error || "No AI is connected, so replies wait for you." };
  let reply: { body: string; provider: string; model: string } | null = null;
  let held: string | null = null;
  let writeError: string | null = null;
  if (input.write !== false && (decision.action === "send" || decision.action === "draft" || (decision.action === "handoff" && catOf(cls.category)?.kind === "reply" && cls.source !== "none"))) {
    try {
      reply = await writeReply(input.settings, {
        lead: { name: "Khalid Al-Mansouri", email: "prospect@example.com", title: "Operations Manager", company: "Gulf Fasteners Trading W.L.L.", city: "Doha", country: "Qatar" },
        research: [],
        history: [],
        latest: { subject, text },
        category: cls.category,
        language: cls.language,
        referral: cls.referral || null,
        returnDate: cls.returnDate || null,
      });
      if (decision.action === "send") held = checkReply(reply.body, input.settings);
    } catch (e) {
      writeError = errMsg(e);
    }
  }
  return { classification: cls, decision, reply, held, writeError };
}

/* -------------------------------- worker -------------------------------- */

let started = false;
let ticking = false;
let lastPoll = 0;

export function startInboxWorker() {
  if (started) return;
  started = true;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const connected = await inst.instantlyConfigured();
      if (connected && Date.now() - lastPoll >= POLL_EVERY_MS) {
        lastPoll = Date.now();
        await syncInbox().catch((e) => console.error(`[inbox] sync failed: ${errMsg(e)}`));
      }
      await processPending(4);
      if (connected) await sendDue(5);
    } catch (e) {
      console.error(`[inbox] tick failed: ${errMsg(e)}`);
    } finally {
      ticking = false;
    }
  };
  setTimeout(tick, 25_000);
  setInterval(tick, TICK_MS);
}
