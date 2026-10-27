// Reads new mail in our own mailboxes (Inbox, Junk and Sent) every couple of
// minutes and hands it to the existing Inbox:
//   - bounces: the lead is marked bounced, its steps stop, the mailbox's
//     bounce count goes up (soft bounces get one more try the next day)
//   - replies: matched to the email we sent (headers, then thread, then
//     address) and stored in the Inbox thread, which classifies and answers
//   - replies you wrote yourself in Gmail / Outlook show up as "you"
//   - anything else (newsletters, warmup mail, spam) is ignored
import { q } from "../../db";
import { logEvent, todayUtc, uid } from "../events";
import { withAccess } from "./access";
import { bumpHealth, cancelForProspect } from "./queue";
import { testFailed } from "./placement";
import { emailsIn, looksLikeBounce, normalizeMessageId, parseBounce } from "./mime";
import { isEngineError, type InMessage } from "./types";

type Row = Record<string, any>;

let clock = () => new Date();
export function setReaderClock(fn: (() => Date) | null) {
  clock = fn || (() => new Date());
}
const iso = () => clock().toISOString();
const OWN = "('google','microsoft')";
const FIRST_READ_DAYS = 2;
const MATCH_DAYS = 45;

const keyOf = (mb: Row, m: InMessage) => `${mb.provider === "microsoft" ? "ms" : "gm"}:${m.providerId}`;
const threadKey = (mb: Row, prospectId: string | null, lead: string) => `own:${prospectId || lead}|${String(mb.email).toLowerCase()}`;

async function inbox() {
  return import("../inbox/service");
}

/** Our sent campaign emails for this lead, put into the thread first so the agent sees what it is answering. */
async function ensureThread(mb: Row, key: string, prospectId: string | null, lead: string): Promise<void> {
  const t = (await q(`SELECT id, backfilled_at FROM threads WHERE instantly_thread_id = ?`, [key]))[0];
  if (t?.backfilled_at) return;
  const { storeEmail } = await inbox();
  const sent = prospectId
    ? await q(`SELECT * FROM outbox WHERE prospect_id = ? AND mailbox_id = ? AND kind IN ('campaign','reply') AND status IN ('sent','bounced','soft_bounced') ORDER BY sent_at`, [prospectId, mb.id])
    : await q(`SELECT * FROM outbox WHERE lower(to_email) = ? AND mailbox_id = ? AND kind IN ('campaign','reply') AND status = 'sent' ORDER BY sent_at`, [lead, mb.id]);
  for (const o of sent) {
    await storeEmail(
      {
        id: `outbox:${o.id}`,
        thread_id: key,
        eaccount: mb.email,
        ue_type: o.kind === "reply" ? 3 : 1,
        from_address_email: mb.email,
        to_address_email_list: o.to_email,
        lead,
        subject: o.subject || "",
        body: { text: o.body_text || "" },
        timestamp_email: o.sent_at,
        timestamp_created: o.sent_at,
        step: o.step != null ? String(Number(o.step) + 1) : null,
        message_id_header: o.message_id,
        sent_by: o.kind === "reply" ? "agent" : "campaign",
      } as any,
      { pendingIfAfter: iso() }
    );
  }
  const now = iso();
  await q(`UPDATE threads SET backfilled_at = ?, mailbox_id = ? WHERE instantly_thread_id = ?`, [now, mb.id, key]);
}

interface Match {
  prospectId: string | null;
  lead: string;
}

async function matchReply(mb: Row, m: InMessage): Promise<Match | null> {
  const ids = [m.inReplyTo, ...m.references].map((x) => normalizeMessageId(x)).filter(Boolean) as string[];
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const o = (await q(`SELECT prospect_id, to_email FROM outbox WHERE message_id IN (${ph}) AND kind IN ('campaign','reply') ORDER BY sent_at DESC LIMIT 1`, ids))[0];
    if (o) return { prospectId: o.prospect_id || null, lead: String(o.to_email).toLowerCase() };
    const t = (await q(`SELECT t.prospect_id, t.lead_email FROM messages x JOIN threads t ON t.id = x.thread_id WHERE x.message_id_header IN (${ph}) AND t.instantly_thread_id LIKE 'own:%' LIMIT 1`, ids))[0];
    if (t) return { prospectId: t.prospect_id || null, lead: String(t.lead_email || m.from.email).toLowerCase() };
  }
  if (m.threadId) {
    const o = (await q(`SELECT prospect_id, to_email FROM outbox WHERE provider_thread_id = ? AND mailbox_id = ? AND kind IN ('campaign','reply') LIMIT 1`, [m.threadId, mb.id]))[0];
    if (o) return { prospectId: o.prospect_id || null, lead: String(o.to_email).toLowerCase() };
  }
  const since = new Date(clock().getTime() - MATCH_DAYS * 86_400_000).toISOString();
  const o = (
    await q(`SELECT prospect_id, to_email FROM outbox WHERE lower(to_email) = ? AND mailbox_id = ? AND kind IN ('campaign','reply') AND status = 'sent' AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1`, [
      m.from.email,
      mb.id,
      since,
    ])
  )[0];
  return o ? { prospectId: o.prospect_id || null, lead: String(o.to_email).toLowerCase() } : null;
}

async function handleBounce(mb: Row, m: InMessage): Promise<boolean> {
  const b = parseBounce(`${m.subject}\n${m.text}`);
  const ids = [...b.messageIds, m.inReplyTo, ...m.references].map((x) => normalizeMessageId(x)).filter(Boolean) as string[];
  let o: Row | null = null;
  if (ids.length) o = (await q(`SELECT * FROM outbox WHERE message_id IN (${ids.map(() => "?").join(",")}) AND mailbox_id = ? ORDER BY sent_at DESC LIMIT 1`, [...ids, mb.id]))[0] || null;
  const since = new Date(clock().getTime() - 30 * 86_400_000).toISOString();
  const candidates = b.recipients.length ? b.recipients : emailsIn(m.text).filter((e) => e !== String(mb.email).toLowerCase());
  if (!o && candidates.length) {
    o =
      (
        await q(`SELECT * FROM outbox WHERE lower(to_email) IN (${candidates.map(() => "?").join(",")}) AND mailbox_id = ? AND status = 'sent' AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1`, [
          ...candidates,
          mb.id,
          since,
        ])
      )[0] || null;
  }
  if (!o) return false;
  if (o.status === "bounced" || o.status === "soft_bounced") return true; // seen already
  if (o.kind === "test") {
    await q(`UPDATE outbox SET status = 'bounced', status_reason = ?, updated_at = ? WHERE id = ?`, [b.diagnostic || "Bounced", iso(), o.id]);
    if (o.test_id) await testFailed(o.test_id, `The test email bounced: ${b.diagnostic || b.status || "no reason given"}`);
    return true;
  }
  if (b.kind === "soft" && o.kind === "campaign" && o.prospect_id) {
    const earlier = await q(`SELECT 1 AS x FROM outbox WHERE prospect_id = ? AND step = ? AND status = 'soft_bounced' LIMIT 1`, [o.prospect_id, o.step]);
    if (!earlier.length) {
      await q(`UPDATE outbox SET status = 'soft_bounced', status_reason = ?, updated_at = ? WHERE id = ?`, [`Soft bounce: ${b.diagnostic || b.status || "temporary"}`, iso(), o.id]);
      try {
        await q(
          `INSERT INTO outbox (id, kind, campaign_id, prospect_id, mailbox_id, step, to_email, to_name, unsub_token, scheduled_for, status, status_reason, created_at, updated_at)
           VALUES (?,'campaign',?,?,?,?,?,?,?,?,'scheduled','Trying once more after a soft bounce',?,?)`,
          [uid(), o.campaign_id, o.prospect_id, o.mailbox_id, o.step, o.to_email, o.to_name, o.unsub_token, new Date(clock().getTime() + 86_400_000).toISOString(), iso(), iso()]
        );
      } catch {
        /* a retry already exists */
      }
      await logEvent("send", `Soft bounce from ${o.to_email} (${b.diagnostic || b.status || "temporary"}). Trying once more tomorrow.`, { campaignId: o.campaign_id || undefined, refType: "prospect", refId: o.prospect_id });
      return true;
    }
  }
  const reason = b.kind === "blocked" ? `Rejected by their mail server${b.diagnostic ? `: ${b.diagnostic}` : ""}` : `Bounced: ${b.diagnostic || b.status || "the address doesn't exist"}`;
  await q(`UPDATE outbox SET status = 'bounced', status_reason = ?, updated_at = ? WHERE id = ?`, [reason.slice(0, 300), iso(), o.id]);
  await bumpHealth(mb.id, "bounced", todayUtc(clock()));
  if (o.prospect_id) {
    await q(
      `UPDATE prospects SET stage = 'bounced', stage_reason = ?, email_status = CASE WHEN ? = 1 THEN 'invalid' ELSE email_status END, stage_changed_at = ?, updated_at = ?
        WHERE id = ? AND stage IN ('queued','sent','replied')`,
      [reason.slice(0, 500), b.kind === "invalid" ? 1 : 0, iso(), iso(), o.prospect_id]
    );
    await cancelForProspect(o.prospect_id, "Stopped: the address bounced");
  }
  await logEvent("send", `${o.to_email} bounced (${b.kind === "blocked" ? "rejected as spam / policy" : b.kind === "soft" ? "soft bounce, again" : "address doesn't exist"}) from ${mb.email}.`, {
    level: "warn",
    campaignId: o.campaign_id || undefined,
    refType: "prospect",
    refId: o.prospect_id || undefined,
  });
  return true;
}

async function ingest(mb: Row, m: InMessage): Promise<"stored" | "bounce" | "ignored"> {
  const key = keyOf(mb, m);
  if ((await q(`SELECT id FROM messages WHERE instantly_id = ?`, [key]))[0]) return "ignored";
  if (m.messageId && (await q(`SELECT id FROM outbox WHERE message_id = ? LIMIT 1`, [m.messageId]))[0]) return "ignored"; // our own sent copy
  if (m.messageId && (await q(`SELECT id FROM messages WHERE message_id_header = ? LIMIT 1`, [m.messageId]))[0]) return "ignored";
  const { storeEmail } = await inbox();

  if (m.folder === "sent") {
    // Written by hand in Gmail / Outlook, in a conversation we know.
    const ids = [m.inReplyTo, ...m.references].map((x) => normalizeMessageId(x)).filter(Boolean) as string[];
    if (!ids.length) return "ignored";
    const t = (await q(`SELECT t.instantly_thread_id AS k, t.lead_email FROM messages x JOIN threads t ON t.id = x.thread_id WHERE x.message_id_header IN (${ids.map(() => "?").join(",")}) AND t.instantly_thread_id LIKE 'own:%' LIMIT 1`, ids))[0];
    if (!t) return "ignored";
    await storeEmail(
      {
        id: key,
        thread_id: t.k,
        eaccount: mb.email,
        ue_type: 3,
        from_address_email: mb.email,
        to_address_email_list: m.to.join(","),
        lead: t.lead_email,
        subject: m.subject,
        body: { text: m.text, html: m.html },
        timestamp_email: m.date,
        timestamp_created: m.date,
        message_id_header: m.messageId,
        sent_by: "you",
      } as any,
      { pendingIfAfter: iso() }
    );
    return "stored";
  }

  if (looksLikeBounce({ from: m.from.email, subject: m.subject, contentType: m.contentType })) {
    return (await handleBounce(mb, m)) ? "bounce" : "ignored";
  }

  const match = await matchReply(mb, m);
  if (!match) return "ignored";
  const tkey = threadKey(mb, match.prospectId, match.lead);
  await ensureThread(mb, tkey, match.prospectId, match.lead);
  const windowStart = new Date(clock().getTime() - 14 * 86_400_000).toISOString();
  const r = await storeEmail(
    {
      id: key,
      thread_id: tkey,
      eaccount: mb.email,
      ue_type: 2,
      from_address_email: m.from.email,
      from_address_json: m.from.name ? [{ name: m.from.name }] : [],
      to_address_email_list: m.to.join(","),
      lead: match.lead,
      subject: m.subject,
      body: { text: m.text, html: m.html },
      timestamp_email: m.date,
      timestamp_created: m.date,
      is_auto_reply: m.autoSubmitted ? 1 : 0,
      message_id_header: m.messageId,
    } as any,
    { pendingIfAfter: windowStart }
  );
  if (r.threadId) await q(`UPDATE threads SET mailbox_id = ?, backfilled_at = COALESCE(backfilled_at, ?) WHERE id = ?`, [mb.id, iso(), r.threadId]);
  if (r.inserted && !m.autoSubmitted) {
    await bumpHealth(mb.id, "replies", todayUtc(clock()));
    if (match.prospectId) await q(`UPDATE prospects SET replied_step = COALESCE(replied_step, last_step), updated_at = ? WHERE id = ?`, [iso(), match.prospectId]);
  }
  return r.inserted ? "stored" : "ignored";
}

export interface ReadResult {
  mailboxes: number;
  stored: number;
  bounces: number;
  ignored: number;
  errors: string[];
}

export async function readMailbox(mb: Row): Promise<Omit<ReadResult, "mailboxes" | "errors">> {
  const out = { stored: 0, bounces: 0, ignored: 0 };
  const since = new Date(clock().getTime() - FIRST_READ_DAYS * 86_400_000).toISOString();
  const r = await withAccess({ table: "mailboxes", id: mb.id }, (a, p) => p.listNew(a, mb.read_cursor || null, since));
  const list = [...r.messages].sort((a, b) => a.date.localeCompare(b.date));
  for (const m of list) {
    try {
      const res = await ingest(mb, m);
      if (res === "stored") out.stored++;
      else if (res === "bounce") out.bounces++;
      else out.ignored++;
    } catch (e) {
      console.error(`[engine] read ${mb.email} ${m.providerId}: ${String((e as any)?.message || e)}`);
    }
  }
  await q(`UPDATE mailboxes SET read_cursor = ?, last_read_at = ?, auth_status = 'ok', auth_error = NULL WHERE id = ?`, [r.cursor, iso(), mb.id]);
  return out;
}

let reading = false;

export async function readAll(): Promise<ReadResult> {
  const res: ReadResult = { mailboxes: 0, stored: 0, bounces: 0, ignored: 0, errors: [] };
  if (reading) return res;
  reading = true;
  try {
    const rows = await q(`SELECT * FROM mailboxes WHERE provider IN ${OWN} AND COALESCE(auth_status,'ok') = 'ok' AND missing_since IS NULL`);
    for (const mb of rows) {
      res.mailboxes++;
      try {
        const r = await readMailbox(mb);
        res.stored += r.stored;
        res.bounces += r.bounces;
        res.ignored += r.ignored;
      } catch (e) {
        res.errors.push(`${mb.email}: ${isEngineError(e) ? e.message : String((e as any)?.message || e)}`);
      }
    }
    if (res.stored) await logEvent("reply", `${res.stored} new message(s) read from your own mailboxes.`, { level: "info" });
  } finally {
    reading = false;
  }
  return res;
}
