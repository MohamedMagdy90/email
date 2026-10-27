// The send queue. Every email we send is an `outbox` row; this worker sends
// the ones that are due, one at a time, under the rules in plan §7:
//   - inside the lead's sending hours and work days
//   - under each mailbox's daily limit, with a random 6–14 min gap per mailbox
//     and at least a minute between mailboxes of the same domain
//   - step 1 from the mailbox with the most room (a fresh domain for the
//     company if possible); every follow-up from that same mailbox, same thread
//   - right before sending: still not replied / unsubscribed / bounced, nobody
//     at the company replied, not suppressed, campaign running
//   - a row is marked "sending" before the API call; one stuck there is looked
//     up in the mailbox's Sent folder before it is ever retried
import { q } from "../../db";
import { logEvent, parseJson, todayUtc, uid } from "../events";
import { isFreeMailDomain } from "../verify";
import { suppressionReason } from "../campaigns/suppression";
import { DEFAULT_SETTINGS, sanitizeSettings, type ProspectEmails } from "../campaigns/types";
import { inWindow, nextWindowStart, randomBetween, windowFor, type SendWindow } from "../schedule";
import { buildMime, newMessageId, normalizeMessageId } from "./mime";
import { randomToken } from "./crypto";
import { withAccess } from "./access";
import { publicBase } from "./oauth";
import { testFailed, testSent } from "./placement";
import { EngineError, isEngineError, type SendResult } from "./types";

type Row = Record<string, any>;

let clock = () => new Date();
export function setQueueClock(fn: (() => Date) | null) {
  clock = fn || (() => new Date());
}
const now = () => clock();
const iso = () => clock().toISOString();
/** The engine's "now". Everything that writes a time the queue later compares against must use it. */
export const queueNowIso = () => clock().toISOString();
const errMsg = (e: unknown) => (isEngineError(e) ? e.message : String((e as any)?.message || e));

const GAP_MIN: [number, number] = [6, 14];
const DOMAIN_GAP_MS = 60_000;
const STUCK_MS = 10 * 60_000;
const RETRY_MIN = [5, 15, 45];
const PAUSED_CANCEL_DAYS = 7;
const MAX_SENDS_PER_TICK = 15;
const OWN = "('google','microsoft')";
const STOP_STAGES = new Set(["replied", "interested", "meeting", "won", "lost", "unsubscribed", "bounced", "skipped", "failed"]);

const plusMin = (m: number, from = now()) => new Date(from.getTime() + m * 60_000).toISOString();
const stripRe = (s: string) => String(s || "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim();

/* ------------------------------- mailboxes ------------------------------- */

export function fromName(mb: Row): string {
  return String(mb.sender_name || [mb.first_name, mb.last_name].filter(Boolean).join(" ") || "").trim();
}

async function mailbox(id: string | null): Promise<Row | null> {
  return id ? (await q(`SELECT * FROM mailboxes WHERE id = ?`, [id]))[0] || null : null;
}

const isSendable = (mb: Row | null) =>
  !!mb && ["google", "microsoft"].includes(mb.provider) && ["ramping", "active"].includes(mb.stage) && (mb.auth_status || "ok") === "ok" && !mb.missing_since && Number(mb.daily_limit) > 0;

async function sentToday(mailboxId: string): Promise<number> {
  const r = await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM outbox WHERE mailbox_id = ? AND kind = 'campaign' AND sent_at >= ? AND status IN ('sent','bounced','soft_bounced')`, [
    mailboxId,
    `${todayUtc(now())}T00:00:00.000Z`,
  ]);
  return Number(r[0]?.n) || 0;
}

async function domainBusy(domain: string, exceptId: string): Promise<boolean> {
  const r = await q(`SELECT MAX(last_send_at) AS at FROM mailboxes WHERE domain = ? AND id <> ?`, [domain, exceptId]);
  return !!r[0]?.at && now().getTime() - Date.parse(String(r[0].at)) < DOMAIN_GAP_MS;
}

/** Room left today, and whether its gap has passed. */
async function availability(mb: Row): Promise<{ room: number; ready: boolean; readyAt: string }> {
  const room = Number(mb.daily_limit) - (await sentToday(mb.id));
  const gapOk = !mb.next_send_at || String(mb.next_send_at) <= iso();
  const domainOk = !(await domainBusy(String(mb.domain || ""), mb.id));
  return { room, ready: room > 0 && gapOk && domainOk, readyAt: gapOk ? plusMin(1.5) : String(mb.next_send_at) };
}

export async function ownSendable(): Promise<Row[]> {
  return q(
    `SELECT * FROM mailboxes WHERE provider IN ${OWN} AND stage IN ('ramping','active') AND COALESCE(auth_status,'ok') = 'ok' AND missing_since IS NULL AND daily_limit > 0 ORDER BY email`
  );
}

async function pauseMailboxNow(mb: Row, reason: string) {
  if (mb.stage === "paused") return;
  const t = iso();
  await q(`UPDATE mailboxes SET stage = 'paused', stage_reason = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [reason.slice(0, 400), t, t, mb.id]);
  await logEvent("mailbox", `Paused ${mb.email}: ${reason}`, { level: "error", refType: "mailbox", refId: mb.id });
}

/* --------------------------------- rows ---------------------------------- */

async function defer(row: Row, at: string, reason: string) {
  await q(`UPDATE outbox SET scheduled_for = ?, status_reason = ?, updated_at = ? WHERE id = ?`, [at, reason.slice(0, 300), iso(), row.id]);
}

async function cancel(row: Row, reason: string) {
  await q(`UPDATE outbox SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE id = ? AND status IN ('scheduled','sending')`, [reason.slice(0, 300), iso(), row.id]);
}

export async function cancelForProspect(prospectId: string, reason: string): Promise<number> {
  const r = await q(`UPDATE outbox SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE prospect_id = ? AND status = 'scheduled' RETURNING id`, [reason.slice(0, 300), iso(), prospectId]);
  return r.length;
}

export async function cancelForCampaign(campaignId: string, reason: string): Promise<number> {
  const r = await q(`UPDATE outbox SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE campaign_id = ? AND status = 'scheduled' RETURNING id`, [reason.slice(0, 300), iso(), campaignId]);
  return r.length;
}

async function bumpHealth(mailboxId: string, col: "campaign_sent" | "bounced" | "replies", day = todayUtc(now())) {
  await q(
    `INSERT INTO mailbox_health (id, mailbox_id, day, ${col}, created_at) VALUES (?,?,?,1,?)
     ON CONFLICT (mailbox_id, day) DO UPDATE SET ${col} = mailbox_health.${col} + 1`,
    [uid(), mailboxId, day, iso()]
  );
}
export { bumpHealth };

/* ---------------------------- campaign context ---------------------------- */

interface Ctx {
  p: Row;
  c: Row;
  emails: ProspectEmails;
  window: SendWindow;
}

async function context(row: Row): Promise<Ctx | string> {
  const p = (
    await q(
      `SELECT p.*, co.domain AS co_domain, co.country AS co_country, co.name AS co_name FROM prospects p LEFT JOIN companies co ON co.id = p.company_id WHERE p.id = ?`,
      [row.prospect_id]
    )
  )[0];
  if (!p) return "The lead was removed";
  const c = (await q(`SELECT * FROM campaigns WHERE id = ?`, [p.campaign_id]))[0];
  if (!c) return "The campaign was removed";
  const emails = parseJson<ProspectEmails | null>(p.email_json, null);
  if (!emails?.steps?.length) return "The lead has no written emails";
  const settings = sanitizeSettings(parseJson(c.settings_json, {}), DEFAULT_SETTINGS);
  let country = p.co_country ? String(p.co_country) : null;
  if (!country) {
    try {
      const m = parseJson<any>(c.targeting_json, null);
      country = Array.isArray(m?.countries) && m.countries[0] ? String(m.countries[0]) : null;
    } catch {
      country = null;
    }
  }
  return { p, c, emails, window: windowFor(country, settings.sendWindow) };
}

/** Why this lead must not get the next step, "wait" (with a time), or null to go ahead. */
async function stopCheck(row: Row, x: Ctx): Promise<{ stop?: string; wait?: { at: string; reason: string } } | null> {
  const { p } = x;
  if (STOP_STAGES.has(String(p.stage))) return { stop: `Stopped: the lead is ${p.stage}` };
  const email = String(p.email || "").toLowerCase();
  const since = String(p.sent_at || row.created_at);
  const domain = p.co_domain && !isFreeMailDomain(String(p.co_domain)) ? String(p.co_domain).toLowerCase() : null;
  const ins = await q(
    `SELECT ai_status, classification, is_auto_reply FROM messages WHERE direction = 'in' AND sent_at >= ? AND (lower(from_email) = ?${domain ? " OR lower(from_email) LIKE ?" : ""}) ORDER BY sent_at DESC LIMIT 20`,
    domain ? [since, email, `%@${domain}`] : [since, email]
  );
  const real = ins.filter((m) => !(Number(m.is_auto_reply) || m.classification === "out_of_office" || m.classification === "bounce"));
  if (real.some((m) => m.ai_status === "pending")) return { wait: { at: plusMin(20), reason: "Waiting: a reply from them is being read" } };
  if (real.length) return { stop: "Stopped: they (or someone at their company) replied" };
  if (p.company_id) {
    const other = await q(`SELECT 1 AS x FROM prospects WHERE company_id = ? AND id <> ? AND replied_at IS NOT NULL AND replied_at >= ? LIMIT 1`, [p.company_id, p.id, since]);
    if (other.length) return { stop: "Stopped: someone else at their company replied" };
  }
  const why = await suppressionReason(email, String(p.campaign_id), String(p.id), p.company_id || null);
  if (why) return { stop: `Not sent: ${why}` };
  return null;
}

/* ------------------------------- sending -------------------------------- */

async function deliver(mb: Row, mime: string, threadId: string | null): Promise<SendResult> {
  return withAccess({ table: "mailboxes", id: mb.id }, (a, p) => p.send(a, mime, { threadId }));
}

async function lock(row: Row, fields: Record<string, any>): Promise<boolean> {
  const keys = Object.keys(fields);
  const r = await q(
    `UPDATE outbox SET status = 'sending', ${keys.map((k) => `${k} = ?`).join(", ")}${keys.length ? ", " : ""}updated_at = ? WHERE id = ? AND status = 'scheduled' RETURNING id`,
    [...keys.map((k) => fields[k]), iso(), row.id]
  );
  return r.length > 0;
}

async function reserveGap(mb: Row) {
  await q(`UPDATE mailboxes SET next_send_at = ? WHERE id = ?`, [plusMin(randomBetween(GAP_MIN[0], GAP_MIN[1])), mb.id]);
}

/** Bookkeeping after a campaign email is out: lead progress, health, the next step. */
async function afterCampaignSent(row: Row, mb: Row, res: SendResult) {
  const at = iso();
  const msgId = res.messageId || row.message_id;
  await q(`UPDATE outbox SET status = 'sent', sent_at = ?, provider_message_id = ?, provider_thread_id = ?, message_id = ?, status_reason = NULL, last_error = NULL, updated_at = ? WHERE id = ?`, [
    at,
    res.providerId,
    res.threadId,
    msgId,
    at,
    row.id,
  ]);
  await q(`UPDATE mailboxes SET last_send_at = ?, auth_status = 'ok', auth_error = NULL WHERE id = ?`, [at, mb.id]);
  await bumpHealth(mb.id, "campaign_sent");
  const x = await context(row);
  if (typeof x === "string") return;
  const { p, emails } = x;
  const step = Number(row.step) || 0;
  if (step === 0) {
    await q(`UPDATE prospects SET stage = 'sent', sent_at = ?, stage_reason = ?, mailbox_email = ?, stage_changed_at = ?, updated_at = ?, last_error = NULL WHERE id = ? AND stage = 'queued'`, [
      at,
      `First email sent from ${mb.email}`,
      mb.email,
      at,
      at,
      p.id,
    ]);
    if (p.segment_id) await q(`UPDATE segments SET sent = sent + 1 WHERE id = ?`, [p.segment_id]);
  }
  await q(`UPDATE prospects SET last_step = ?, last_step_at = ?, updated_at = ? WHERE id = ?`, [step + 1, at, at, p.id]);
  const next = emails.steps[step + 1];
  if (next?.body) {
    const delay = Number(next.delayDays) > 0 ? Number(next.delayDays) : 3;
    const base = new Date(Date.parse(at) + delay * 86_400_000);
    const when = new Date(nextWindowStart(base, x.window).getTime() + randomBetween(0, 90) * 60_000).toISOString();
    try {
      await q(
        `INSERT INTO outbox (id, kind, campaign_id, prospect_id, mailbox_id, step, to_email, to_name, unsub_token, scheduled_for, status, created_at, updated_at)
         VALUES (?,'campaign',?,?,?,?,?,?,?,?,'scheduled',?,?)`,
        [uid(), p.campaign_id, p.id, mb.id, step + 1, p.email, p.full_name || null, row.unsub_token, when, at, at]
      );
    } catch {
      /* the step already exists */
    }
  }
  await logEvent("send", `Sent email ${step + 1} to ${p.email} from ${mb.email}.`, { level: "success", campaignId: p.campaign_id, refType: "prospect", refId: p.id });
}

async function sendFailed(row: Row, mb: Row | null, e: unknown, opts: { isTest?: boolean } = {}) {
  const msg = errMsg(e).slice(0, 400);
  const code = isEngineError(e) ? e.code : "retry";
  const back = async (minutes: number, reason: string) =>
    q(`UPDATE outbox SET status = 'scheduled', scheduled_for = ?, status_reason = ?, last_error = ?, mailbox_id = ?, updated_at = ? WHERE id = ?`, [
      plusMin(minutes),
      reason,
      msg,
      Number(row.step) === 0 && row.kind === "campaign" ? null : row.mailbox_id,
      iso(),
      row.id,
    ]);
  if (mb && (code === "auth" || code === "blocked")) {
    await pauseMailboxNow(mb, code === "auth" ? "Sign-in expired or was revoked. Sign in again on the Mailboxes tab." : `${mb.provider === "microsoft" ? "Microsoft" : "Google"} stopped it from sending: ${msg}`);
    if (opts.isTest) {
      await q(`UPDATE outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`, [msg, iso(), row.id]);
      if (row.test_id) await testFailed(row.test_id, msg);
      return;
    }
    await back(10, `Waiting: ${mb.email} is paused`);
    return;
  }
  const attempts = Number(row.attempts || 0) + 1;
  if (code === "retry" && attempts < 3) {
    await q(`UPDATE outbox SET attempts = ? WHERE id = ?`, [attempts, row.id]);
    await back(RETRY_MIN[attempts - 1], `Trying again: ${msg}`);
    return;
  }
  await q(`UPDATE outbox SET status = 'failed', attempts = ?, last_error = ?, status_reason = ?, updated_at = ? WHERE id = ?`, [attempts, msg, `Couldn't send: ${msg}`, iso(), row.id]);
  if (opts.isTest) {
    if (row.test_id) await testFailed(row.test_id, msg);
    return;
  }
  if (row.prospect_id) {
    if (Number(row.step) === 0) {
      await q(`UPDATE prospects SET stage = 'failed', skipped_from = 'queued', stage_reason = ?, last_error = ?, stage_changed_at = ?, updated_at = ? WHERE id = ? AND stage = 'queued'`, [
        `Couldn't send: ${msg}`,
        msg,
        iso(),
        iso(),
        row.prospect_id,
      ]);
    } else await q(`UPDATE prospects SET last_error = ?, updated_at = ? WHERE id = ?`, [msg, iso(), row.prospect_id]);
    await logEvent("send", `Couldn't send email ${(Number(row.step) || 0) + 1} to ${row.to_email}: ${msg}`, { level: "error", campaignId: row.campaign_id || undefined, refType: "prospect", refId: row.prospect_id });
  }
}

async function unsubscribeLink(token: string): Promise<string | null> {
  const base = await publicBase();
  return base ? `${base}/api/u/${token}` : null;
}

async function processCampaign(row: Row): Promise<"sent" | "wait" | "stop"> {
  const x = await context(row);
  if (typeof x === "string") {
    await cancel(row, x);
    return "stop";
  }
  const { p, c, emails, window: w } = x;
  if (c.status === "archived") {
    await cancel(row, "The campaign was archived");
    return "stop";
  }
  if (c.status !== "active") {
    await defer(row, plusMin(60), "Waiting: the campaign isn't running");
    return "wait";
  }
  const verdict = await stopCheck(row, x);
  if (verdict?.stop) {
    await cancel(row, verdict.stop);
    await cancelForProspect(p.id, verdict.stop);
    if (Number(row.step) === 0 && /^Not sent/.test(verdict.stop) && p.stage === "queued") {
      await q(`UPDATE prospects SET stage = 'skipped', skipped_from = 'queued', stage_reason = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [verdict.stop, iso(), iso(), p.id]);
    }
    return "stop";
  }
  if (verdict?.wait) {
    await defer(row, verdict.wait.at, verdict.wait.reason);
    return "wait";
  }
  const step = Number(row.step) || 0;
  const copy = emails.steps[step];
  if (!copy?.body) {
    await cancel(row, "No copy for this step");
    return "stop";
  }
  if (!inWindow(now(), w)) {
    const at = new Date(nextWindowStart(now(), w).getTime() + randomBetween(0, 40) * 60_000).toISOString();
    await defer(row, at, `Waiting for the sending hours (${w.from}–${w.to}, ${w.tz})`);
    return "wait";
  }

  // The mailbox: chosen now for step 1, fixed for the rest of the thread.
  let mb: Row | null = null;
  if (step === 0 && !row.mailbox_id) {
    const pool = await ownSendable();
    if (!pool.length) {
      await defer(row, plusMin(30), "Waiting for a sending mailbox (still going through the readiness checks)");
      return "wait";
    }
    const used = new Set(
      (
        await q(
          `SELECT DISTINCT m.domain AS d FROM outbox o JOIN mailboxes m ON m.id = o.mailbox_id JOIN prospects x ON x.id = o.prospect_id
            WHERE x.company_id = ? AND o.status = 'sent'`,
          [p.company_id || "-"]
        )
      ).map((r) => String(r.d))
    );
    const scored: { mb: Row; room: number; ready: boolean; readyAt: string }[] = [];
    for (const m of pool) scored.push({ mb: m, ...(await availability(m)) });
    const ready = scored.filter((s) => s.ready).sort((a, b) => Number(used.has(String(a.mb.domain))) - Number(used.has(String(b.mb.domain))) || b.room - a.room);
    if (!ready.length) {
      if (scored.every((s) => s.room <= 0)) {
        const tomorrow = new Date(Date.parse(`${todayUtc(now())}T00:00:00Z`) + 86_400_000);
        await defer(row, new Date(nextWindowStart(tomorrow, w).getTime() + randomBetween(0, 60) * 60_000).toISOString(), "Waiting: today's sending limit is used up");
      } else {
        const soonest = scored.filter((s) => s.room > 0).map((s) => s.readyAt).sort()[0] || plusMin(5);
        await defer(row, soonest, "Waiting for the gap between emails");
      }
      return "wait";
    }
    mb = ready[0].mb;
  } else {
    mb = await mailbox(row.mailbox_id);
    if (!mb) {
      await cancel(row, "The mailbox that started this thread was removed");
      await cancelForProspect(p.id, "The mailbox that started this thread was removed");
      return "stop";
    }
    if (!isSendable(mb)) {
      if (mb.stage === "paused" && mb.stage_changed_at && now().getTime() - Date.parse(String(mb.stage_changed_at)) > PAUSED_CANCEL_DAYS * 86_400_000) {
        const why = `${mb.email} has been paused for over ${PAUSED_CANCEL_DAYS} days, so the rest of this sequence was cancelled`;
        await cancel(row, why);
        await cancelForProspect(p.id, why);
        return "stop";
      }
      await defer(row, plusMin(60), `Waiting: ${mb.email} isn't sending right now (${mb.stage})`);
      return "wait";
    }
    const a = await availability(mb);
    if (a.room <= 0) {
      const tomorrow = new Date(Date.parse(`${todayUtc(now())}T00:00:00Z`) + 86_400_000);
      await defer(row, new Date(nextWindowStart(tomorrow, w).getTime() + randomBetween(0, 60) * 60_000).toISOString(), `Waiting: ${mb.email} reached today's limit`);
      return "wait";
    }
    if (!a.ready) {
      await defer(row, a.readyAt, "Waiting for the gap between emails");
      return "wait";
    }
  }

  // The message: follow-ups reply in the same thread unless the step starts a new one.
  const newThread = step === 0 || !!String(copy.subject || "").trim();
  const prev = newThread
    ? []
    : await q(`SELECT message_id, provider_thread_id FROM outbox WHERE prospect_id = ? AND kind = 'campaign' AND status IN ('sent','bounced','soft_bounced') AND step < ? ORDER BY step`, [p.id, step]);
  const refs = prev.map((r) => normalizeMessageId(r.message_id)).filter(Boolean) as string[];
  const subject = newThread ? String(copy.subject) : `Re: ${stripRe(emails.steps[0].subject)}`;
  const messageId = newMessageId(String(mb.domain || mb.email.split("@")[1]));
  const token = row.unsub_token || randomToken(16);
  const mime = buildMime({
    from: { email: mb.email, name: fromName(mb) },
    to: { email: String(p.email), name: p.full_name || null },
    subject,
    text: copy.body,
    messageId,
    inReplyTo: refs[refs.length - 1] || null,
    references: refs,
    listUnsubscribe: { url: await unsubscribeLink(token), mailto: mb.email },
  });
  const ok = await lock(row, {
    mailbox_id: mb.id,
    subject,
    body_text: copy.body,
    message_id: messageId,
    in_reply_to: refs[refs.length - 1] || null,
    references_hdr: refs.join(" ") || null,
    unsub_token: token,
    to_email: p.email,
  });
  if (!ok) return "wait";
  await reserveGap(mb);
  const sendingRow = { ...row, mailbox_id: mb.id, message_id: messageId, unsub_token: token };
  try {
    const res = await deliver(mb, mime, newThread ? null : prev[prev.length - 1]?.provider_thread_id || null);
    await afterCampaignSent(sendingRow, mb, res);
    return "sent";
  } catch (e) {
    await sendFailed(sendingRow, mb, e);
    return "wait";
  }
}

async function processTest(row: Row): Promise<"sent" | "wait" | "stop"> {
  const mb = await mailbox(row.mailbox_id);
  const test = row.test_id ? (await q(`SELECT * FROM placement_tests WHERE id = ?`, [row.test_id]))[0] : null;
  if (!mb || !test || !["google", "microsoft"].includes(mb.provider)) {
    await cancel(row, "The mailbox or the test is gone");
    return "stop";
  }
  if (mb.stage === "paused" || (mb.auth_status || "ok") !== "ok") {
    await cancel(row, `${mb.email} is paused or signed out`);
    await testFailed(test.id, `${mb.email} was paused or signed out`);
    return "stop";
  }
  if (mb.next_send_at && String(mb.next_send_at) > iso()) {
    await defer(row, String(mb.next_send_at), "Waiting for the gap between emails");
    return "wait";
  }
  const messageId = newMessageId(String(mb.domain || mb.email.split("@")[1]));
  const mime = buildMime({
    from: { email: mb.email, name: fromName(mb) },
    to: { email: String(row.to_email) },
    subject: String(row.subject || ""),
    text: String(row.body_text || ""),
    messageId,
    listUnsubscribe: { url: await unsubscribeLink(String(row.unsub_token || randomToken(16))), mailto: mb.email },
  });
  if (!(await lock(row, { message_id: messageId }))) return "wait";
  await q(`UPDATE mailboxes SET next_send_at = ? WHERE id = ?`, [plusMin(randomBetween(1, 3)), mb.id]);
  try {
    const res = await deliver(mb, mime, null);
    const at = iso();
    const finalId = res.messageId || messageId;
    await q(`UPDATE outbox SET status = 'sent', sent_at = ?, provider_message_id = ?, provider_thread_id = ?, message_id = ?, updated_at = ? WHERE id = ?`, [at, res.providerId, res.threadId, finalId, at, row.id]);
    await q(`UPDATE mailboxes SET last_send_at = ?, auth_status = 'ok', auth_error = NULL WHERE id = ?`, [at, mb.id]);
    await testSent(test.id, finalId, at);
    return "sent";
  } catch (e) {
    await sendFailed({ ...row, message_id: messageId }, mb, e, { isTest: true });
    return "wait";
  }
}

/** Rows left in "sending" (a crash mid-send): sent if the mailbox has it, otherwise back in line. */
async function recoverStuck() {
  const stuck = await q(`SELECT * FROM outbox WHERE status = 'sending' AND updated_at < ? AND kind IN ('campaign','test') LIMIT 10`, [new Date(now().getTime() - STUCK_MS).toISOString()]);
  for (const row of stuck) {
    const mb = await mailbox(row.mailbox_id);
    let found: { found: boolean; ref: string | null } = { found: false, ref: null };
    if (mb && row.message_id) {
      try {
        found = await withAccess({ table: "mailboxes", id: mb.id }, (a, p) => p.findByMessageId(a, String(row.message_id)));
      } catch {
        continue; // can't tell yet: never risk a double send
      }
    }
    if (found.found && mb) {
      const res: SendResult = { providerId: found.ref || "", threadId: null, messageId: row.message_id };
      if (row.kind === "test") {
        await q(`UPDATE outbox SET status = 'sent', sent_at = ?, provider_message_id = ?, updated_at = ? WHERE id = ?`, [iso(), found.ref, iso(), row.id]);
        if (row.test_id) await testSent(row.test_id, String(row.message_id), iso());
      } else await afterCampaignSent(row, mb, res);
      await logEvent("send", `An email to ${row.to_email} was interrupted mid-send; it had gone out, so it was marked sent (not sent twice).`, { level: "info" });
    } else {
      await q(`UPDATE outbox SET status = 'scheduled', scheduled_for = ?, attempts = attempts + 1, status_reason = 'Interrupted mid-send; it had not gone out, so it is queued again', updated_at = ? WHERE id = ?`, [
        iso(),
        iso(),
        row.id,
      ]);
    }
  }
}

let ticking = false;

/** One pass of the queue. */
export async function queueTick(): Promise<{ sent: number; waited: number; stopped: number }> {
  const out = { sent: 0, waited: 0, stopped: 0 };
  if (ticking) return out;
  ticking = true;
  try {
    await recoverStuck();
    const due = await q(
      `SELECT * FROM outbox WHERE status = 'scheduled' AND kind IN ('campaign','test') AND scheduled_for <= ? ORDER BY CASE kind WHEN 'test' THEN 0 ELSE 1 END, scheduled_for LIMIT 60`,
      [iso()]
    );
    for (const row of due) {
      if (out.sent >= MAX_SENDS_PER_TICK) break;
      try {
        const r = row.kind === "test" ? await processTest(row) : await processCampaign(row);
        if (r === "sent") out.sent++;
        else if (r === "wait") out.waited++;
        else out.stopped++;
      } catch (e) {
        console.error(`[engine] queue row ${row.id}: ${errMsg(e)}`);
        await defer(row, plusMin(10), `Error: ${errMsg(e).slice(0, 200)}`).catch(() => {});
      }
    }
  } finally {
    ticking = false;
  }
  return out;
}

/* --------------------------- replies (Inbox) --------------------------- */

/** Send a reply in an existing thread from one of our mailboxes (used by the Inbox). */
export async function sendThreadReply(o: {
  mailboxEmail: string;
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string[];
  prospectId?: string | null;
  campaignId?: string | null;
  inboxThreadId?: string | null;
}): Promise<{ outboxId: string; messageId: string; at: string }> {
  const mb = (await q(`SELECT * FROM mailboxes WHERE lower(email) = ? AND provider IN ${OWN}`, [o.mailboxEmail.toLowerCase()]))[0];
  if (!mb) throw new EngineError(`${o.mailboxEmail} isn't connected to your own engine any more.`, "bad", 400);
  if ((mb.auth_status || "ok") !== "ok") throw new EngineError(`${mb.email} needs to sign in again (Mailboxes tab).`, "auth", 401);
  const refs = [...new Set([...(o.references || []), o.inReplyTo].map((x) => normalizeMessageId(x)).filter(Boolean) as string[])];
  const messageId = newMessageId(String(mb.domain || mb.email.split("@")[1]));
  const id = uid();
  const t = iso();
  await q(
    `INSERT INTO outbox (id, kind, campaign_id, prospect_id, thread_id, mailbox_id, to_email, to_name, subject, body_text, message_id, in_reply_to, references_hdr, scheduled_for, status, created_at, updated_at)
     VALUES (?,'reply',?,?,?,?,?,?,?,?,?,?,?,?,'sending',?,?)`,
    [id, o.campaignId || null, o.prospectId || null, o.inboxThreadId || null, mb.id, o.to, o.toName || null, o.subject, o.text, messageId, normalizeMessageId(o.inReplyTo), refs.join(" ") || null, t, t, t]
  );
  const threadId = o.prospectId
    ? (await q(`SELECT provider_thread_id FROM outbox WHERE prospect_id = ? AND mailbox_id = ? AND provider_thread_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1`, [o.prospectId, mb.id]))[0]?.provider_thread_id || null
    : null;
  const mime = buildMime({
    from: { email: mb.email, name: fromName(mb) },
    to: { email: o.to, name: o.toName || null },
    subject: o.subject,
    text: o.text,
    messageId,
    inReplyTo: normalizeMessageId(o.inReplyTo),
    references: refs,
  });
  try {
    const res = await deliver(mb, mime, threadId);
    const at = iso();
    const finalId = res.messageId || messageId;
    await q(`UPDATE outbox SET status = 'sent', sent_at = ?, provider_message_id = ?, provider_thread_id = ?, message_id = ?, updated_at = ? WHERE id = ?`, [at, res.providerId, res.threadId, finalId, at, id]);
    await q(`UPDATE mailboxes SET last_send_at = ? WHERE id = ?`, [at, mb.id]);
    return { outboxId: id, messageId: finalId, at };
  } catch (e) {
    await q(`UPDATE outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`, [errMsg(e).slice(0, 400), iso(), id]);
    throw e;
  }
}

/** The send plan for today (and what already went), for the "Sending today" view. */
export async function sendingToday(campaignId?: string) {
  const start = `${todayUtc(now())}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const rows = await q(
    `SELECT o.id, o.kind, o.step, o.to_email, o.to_name, o.status, o.status_reason, o.scheduled_for, o.sent_at, o.campaign_id, m.email AS mailbox
       FROM outbox o LEFT JOIN mailboxes m ON m.id = o.mailbox_id
      WHERE o.kind = 'campaign' AND ((o.status = 'scheduled' AND o.scheduled_for < ?) OR (o.sent_at >= ?))${campaignId ? " AND o.campaign_id = ?" : ""}
      ORDER BY COALESCE(o.sent_at, o.scheduled_for) LIMIT 300`,
    campaignId ? [end, start, campaignId] : [end, start]
  );
  return rows.map((r) => ({
    id: String(r.id),
    step: (Number(r.step) || 0) + 1,
    to: String(r.to_email),
    toName: r.to_name || null,
    status: String(r.status),
    reason: r.status_reason || null,
    at: String(r.sent_at || r.scheduled_for),
    mailbox: r.mailbox || null,
    campaignId: r.campaign_id || null,
  }));
}
