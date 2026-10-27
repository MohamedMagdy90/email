// Campaigns on the own engine: approved leads go into the send queue (instead
// of an Instantly campaign), and the campaign's numbers come from our own
// records (instead of Instantly's analytics).
import { q } from "../../db";
import { logEvent, parseJson, todayUtc, uid } from "../events";
import { getAgentSettings } from "../agent-settings";
import { suppressionReason } from "../campaigns/suppression";
import { applyLearning } from "../targeting/learning";
import { ensureDailyTable } from "../dashboard/daily";
import { sequenceFor } from "../sequences/store";
import type { CampaignSettings, ProspectEmails, Row } from "../campaigns/types";
import { randomToken } from "./crypto";
import { ownSendable, queueNowIso as nowIso } from "./queue";

export async function ownCapacity(): Promise<{ mailboxes: number; sending: number; dailyCapacity: number }> {
  const pool = await ownSendable();
  const total = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM mailboxes WHERE provider IN ('google','microsoft') AND missing_since IS NULL`))[0]?.n) || 0;
  return { mailboxes: total, sending: pool.length, dailyCapacity: pool.reduce((n, m) => n + (Number(m.daily_limit) || 0), 0) };
}

async function queuedToday(campaignId: string): Promise<number> {
  const r = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND queued_at >= ?`, [campaignId, `${todayUtc(new Date(nowIso()))}T00:00:00.000Z`]))[0];
  return Number(r?.n) || 0;
}

/** Approved leads -> step 1 in the send queue. Same rules as the Instantly push: daily cap, suppression, catch-all share. */
export async function queueApprovedOwn(c: Row, settings: CampaignSettings): Promise<{ queued: number; notes: string[] }> {
  const notes: string[] = [];
  const waiting = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'approved'`, [c.id]))[0]?.n) || 0;
  if (!waiting) return { queued: 0, notes };
  const cap = await ownCapacity();
  if (!cap.sending) {
    return {
      queued: 0,
      notes: [
        cap.mailboxes
          ? "Approved emails are waiting for a sending mailbox: your mailboxes are still going through the readiness checks (Mailboxes tab)."
          : "Approved emails are waiting: connect a sending mailbox on the Mailboxes tab.",
      ],
    };
  }
  const dayCap = Math.min(settings.dailyNewLeads, cap.dailyCapacity);
  const already = await queuedToday(String(c.id));
  const limit = dayCap - already;
  if (limit <= 0) return { queued: 0, notes: [`Today's limit of ${dayCap} new leads is reached; the rest go out tomorrow.`] };

  const policy = (await getAgentSettings()).sending;
  const seq = (await sequenceFor(String(c.id))).steps;
  let catchAll = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND queued_at >= ? AND catch_all = 1`, [c.id, `${todayUtc(new Date(nowIso()))}T00:00:00.000Z`]))[0]?.n) || 0;
  const rows = await q(
    `SELECT p.* FROM prospects p LEFT JOIN segments sg ON sg.id = p.segment_id
      WHERE p.campaign_id = ? AND p.stage = 'approved'
      ORDER BY CASE sg.status WHEN 'scaling' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, p.approved_at, p.created_at LIMIT ?`,
    [c.id, limit * 2]
  );
  const now = nowIso();
  let queued = 0;
  for (const p of rows) {
    if (queued >= limit) break;
    const reason = await suppressionReason(String(p.email), String(c.id), String(p.id), p.company_id || null);
    if (reason) {
      await q(`UPDATE prospects SET stage = 'skipped', skipped_from = 'approved', stage_reason = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [`Not sent: ${reason}`, now, now, p.id]);
      continue;
    }
    if (Number(p.catch_all) === 1) {
      const total = already + queued + 1;
      if ((catchAll + 1) / total > policy.maxCatchAllShare && total > 1) continue;
      catchAll++;
    }
    const emails = parseJson<ProspectEmails | null>(p.email_json, null);
    if (!emails?.steps?.length) continue;
    if (emails.steps.length < seq.length) {
      await q(`UPDATE prospects SET stage = 'verified', email_json = NULL, written_at = NULL, approved_at = NULL, stage_reason = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [
        `Written for an older version of the sequence (${emails.steps.length} of ${seq.length} steps); rewriting it`,
        now,
        now,
        p.id,
      ]);
      continue;
    }
    try {
      await q(
        `INSERT INTO outbox (id, kind, campaign_id, prospect_id, step, to_email, to_name, unsub_token, scheduled_for, status, created_at, updated_at)
         VALUES (?,'campaign',?,?,0,?,?,?,?,'scheduled',?,?)`,
        [uid(), c.id, p.id, p.email, p.full_name || null, randomToken(16), now, now, now]
      );
    } catch {
      continue; // step 1 is already queued for this lead
    }
    await q(`UPDATE prospects SET stage = 'queued', stage_reason = ?, queued_at = ?, stage_changed_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`, [
      "In your send queue: goes out from one of your mailboxes in the sending hours",
      now,
      now,
      now,
      p.id,
    ]);
    queued++;
  }
  if (queued) await logEvent("send", `Queued ${queued} lead(s) in your own send queue.`, { level: "success", campaignId: String(c.id) });
  else if (rows.length) notes.push("Approved leads are waiting so catch-all addresses stay under the daily share set in the Agent settings.");
  return { queued, notes };
}

const lastSync = new Map<string, number>();

/** Campaign numbers, daily trend, segment counters and the learning loop — from our own records. */
export async function syncOwnCampaign(c: Row, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && Date.now() - (lastSync.get(String(c.id)) || 0) < 5 * 60_000) return;
  lastSync.set(String(c.id), Date.now());
  const n = async (sql: string, params: any[]) => Number((await q(sql, params))[0]?.n) || 0;
  const sent = await n(`SELECT CAST(count(*) AS INTEGER) AS n FROM outbox WHERE campaign_id = ? AND kind = 'campaign' AND status IN ('sent','bounced','soft_bounced')`, [c.id]);
  const replies = await n(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND replied_at IS NOT NULL`, [c.id]);
  const positive = await n(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage IN ('interested','meeting','won')`, [c.id]);
  const bounced = await n(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'bounced'`, [c.id]);
  const row = (await q(`SELECT stats_json, instantly_campaign_id FROM campaigns WHERE id = ?`, [c.id]))[0];
  const prev = parseJson<any>(row?.stats_json, {}) || {};
  // A campaign that moved from Instantly keeps Instantly's numbers for the leads sent there.
  const fromInstantly = row?.instantly_campaign_id ? { sent: Number(prev.instantlySent) || 0, bounced: Number(prev.instantlyBounced) || 0 } : { sent: 0, bounced: 0 };
  const stats = { ...prev, sent: sent + fromInstantly.sent, opened: null, replies, positive, bounced, ownSent: sent, updatedAt: nowIso() };
  await q(`UPDATE campaigns SET stats_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(stats), nowIso(), c.id]);
  await syncOwnDaily(c).catch((e) => console.error(`[engine] daily ${c.id}: ${String(e?.message || e)}`));
  await q(
    `UPDATE segments SET
       replies = (SELECT CAST(count(*) AS INTEGER) FROM prospects p WHERE p.segment_id = segments.id AND p.stage IN ('replied','interested','meeting','won','lost','unsubscribed')),
       positive = (SELECT CAST(count(*) AS INTEGER) FROM prospects p WHERE p.segment_id = segments.id AND p.stage IN ('interested','meeting','won'))
     WHERE campaign_id = ?`,
    [c.id]
  );
  await applyLearning(String(c.id)).catch((e) => console.error(`[learning] ${String(e?.message || e)}`));
}

/** campaign_daily rows (the Dashboard's trend) from the outbox and the leads. */
export async function syncOwnDaily(c: Row): Promise<number> {
  await ensureDailyTable();
  const have = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM campaign_daily WHERE campaign_id = ?`, [c.id]))[0]?.n) || 0;
  const days = have ? 3 : 31;
  const from = new Date(Date.parse(nowIso()) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const byDay = new Map<string, Record<string, number>>();
  const add = (day: string, k: string, v: number) => {
    const d = byDay.get(day) || {};
    d[k] = (d[k] || 0) + v;
    byDay.set(day, d);
  };
  for (const r of await q(
    `SELECT substr(sent_at, 1, 10) AS day, CAST(count(*) AS INTEGER) AS sent, CAST(count(DISTINCT prospect_id) AS INTEGER) AS contacted,
            CAST(SUM(CASE WHEN step = 0 THEN 1 ELSE 0 END) AS INTEGER) AS fresh
       FROM outbox WHERE campaign_id = ? AND kind = 'campaign' AND status IN ('sent','bounced','soft_bounced') AND sent_at >= ? GROUP BY substr(sent_at, 1, 10)`,
    [c.id, `${from}T00:00:00.000Z`]
  )) {
    add(String(r.day), "sent", Number(r.sent) || 0);
    add(String(r.day), "contacted", Number(r.contacted) || 0);
    add(String(r.day), "fresh", Number(r.fresh) || 0);
  }
  for (const r of await q(`SELECT substr(replied_at, 1, 10) AS day, CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND replied_at >= ? GROUP BY substr(replied_at, 1, 10)`, [c.id, `${from}T00:00:00.000Z`])) {
    add(String(r.day), "replies", Number(r.n) || 0);
  }
  for (const [stage, key] of [
    ["bounced", "bounced"],
    ["unsubscribed", "unsub"],
  ] as const) {
    for (const r of await q(`SELECT substr(stage_changed_at, 1, 10) AS day, CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = ? AND stage_changed_at >= ? GROUP BY substr(stage_changed_at, 1, 10)`, [
      c.id,
      stage,
      `${from}T00:00:00.000Z`,
    ])) {
      add(String(r.day), key, Number(r.n) || 0);
    }
  }
  for (const r of await q(
    `SELECT substr(replied_at, 1, 10) AS day, CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage IN ('interested','meeting','won') AND replied_at >= ? GROUP BY substr(replied_at, 1, 10)`,
    [c.id, `${from}T00:00:00.000Z`]
  )) {
    add(String(r.day), "opps", Number(r.n) || 0);
  }
  const now = nowIso();
  for (const [day, v] of byDay) {
    await q(
      `INSERT INTO campaign_daily (day, campaign_id, sent, contacted, new_leads_contacted, replies, replies_auto, bounced, unsubscribed, opportunities, updated_at)
       VALUES (?,?,?,?,?,?,0,?,?,?,?)
       ON CONFLICT (day, campaign_id) DO UPDATE SET sent = excluded.sent, contacted = excluded.contacted, new_leads_contacted = excluded.new_leads_contacted,
         replies = excluded.replies, bounced = excluded.bounced, unsubscribed = excluded.unsubscribed, opportunities = excluded.opportunities, updated_at = excluded.updated_at`,
      [day, c.id, v.sent || 0, v.contacted || 0, v.fresh || 0, v.replies || 0, v.bounced || 0, v.unsub || 0, v.opps || 0, now]
    );
  }
  return byDay.size;
}

/** Unsubscribe from a link in one of our emails (GET page and RFC 8058 one-click POST). */
export async function unsubscribeToken(token: string): Promise<boolean> {
  const o = token ? (await q(`SELECT * FROM outbox WHERE unsub_token = ? ORDER BY created_at LIMIT 1`, [token]))[0] : null;
  if (!o) return false;
  if (o.kind === "test" || !o.prospect_id) return true;
  const p = (await q(`SELECT id, email, campaign_id, stage FROM prospects WHERE id = ?`, [o.prospect_id]))[0];
  if (!p) return true;
  const now = nowIso();
  if (p.stage !== "unsubscribed") {
    await q(`UPDATE prospects SET stage = 'unsubscribed', interest = 'unsubscribe', stage_reason = 'Unsubscribed with the link in the email', stage_changed_at = ?, updated_at = ? WHERE id = ?`, [now, now, p.id]);
    await q(`UPDATE outbox SET status = 'cancelled', status_reason = 'They unsubscribed', updated_at = ? WHERE prospect_id = ? AND status = 'scheduled'`, [now, p.id]);
    await logEvent("send", `${p.email} unsubscribed with the link in the email. Nothing more goes to them from any campaign.`, { level: "warn", campaignId: p.campaign_id, refType: "prospect", refId: p.id });
    try {
      const inst = await import("../instantly");
      if (await inst.instantlyConfigured()) await inst.blockEntry(String(p.email).toLowerCase());
    } catch {
      /* best effort */
    }
  }
  return true;
}
