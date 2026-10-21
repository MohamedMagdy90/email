// Step 9-10 — push approved leads into one Instantly campaign per campaign and
// keep it in sync. The copy travels in lead custom variables; the campaign is
// plain text with no open/link tracking, stops on reply and sends only from
// mailboxes the Mailboxes module says are ready (ramping / active).
import { q, nowIso } from "../../db";
import { logEvent, parseJson, todayUtc } from "../events";
import * as inst from "../instantly";
import { getAgentSettings } from "../agent-settings";
import { suppressionReason } from "./suppression";
import type { CampaignSettings, CampaignStatsT, ProspectEmails, Row } from "./types";

export async function sendableMailboxes(): Promise<{ email: string; dailyLimit: number }[]> {
  const mod = await import("../mailboxes/service").catch(() => null);
  if (!mod?.getSendableMailboxes) return [];
  try {
    return await mod.getSendableMailboxes();
  } catch {
    return [];
  }
}

const html = (s: string) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");

function scheduleFor(settings: CampaignSettings, country: string | null): inst.CampaignSchedule {
  return {
    name: "Work hours",
    timing: { from: settings.sendWindow.from, to: settings.sendWindow.to },
    days: inst.workDaysForCountry(country),
    timezone: inst.timezoneForCountry(country),
  };
}

export function instantlyPayload(c: Row, settings: CampaignSettings, country: string | null, mailboxes: { email: string; dailyLimit: number }[]): inst.CreateCampaignInput {
  const steps: inst.CreateCampaignInput["sequences"][0]["steps"] = [{ type: "email", delay: 0, variants: [{ subject: "{{subject_1}}", body: "{{body_1}}" }] }];
  for (let i = 0; i < settings.followUps; i++) {
    steps.push({ type: "email", delay: settings.followUpDelays[i] || 3, delay_unit: "days", variants: [{ subject: "", body: `{{body_${i + 2}}}` }] });
  }
  return {
    name: `${c.name} · DNA`,
    campaign_schedule: { schedules: [scheduleFor(settings, country)] },
    sequences: [{ steps }],
    email_list: mailboxes.map((m) => m.email),
    daily_limit: Math.max(1, mailboxes.reduce((n, m) => n + m.dailyLimit, 0)),
    text_only: true,
    first_email_text_only: true,
    link_tracking: false,
    open_tracking: false,
    stop_on_reply: true,
    stop_on_auto_reply: false,
    stop_for_company: true,
    insert_unsubscribe_header: true,
    prioritize_new_leads: false,
    allow_risky_contacts: false,
    match_lead_esp: false,
  };
}

async function campaignCountry(campaignId: string): Promise<string | null> {
  const seg = (await q(`SELECT countries_json FROM segments WHERE campaign_id = ? AND enabled = 1 ORDER BY created_at LIMIT 1`, [campaignId]))[0];
  return parseJson<string[]>(seg?.countries_json, [])[0] || null;
}

/** Create the Instantly campaign on first use; keep its mailbox list current. */
export async function ensureInstantlyCampaign(c: Row, settings: CampaignSettings, mailboxes: { email: string; dailyLimit: number }[]): Promise<string> {
  const emails = mailboxes.map((m) => m.email).sort();
  if (c.instantly_campaign_id) {
    const prev = parseJson<string[]>(parseJson<any>(c.stats_json, {})?.mailboxes, []).sort();
    if (prev.join(",") !== emails.join(",")) {
      await inst.patchCampaign(c.instantly_campaign_id, { email_list: emails, daily_limit: Math.max(1, mailboxes.reduce((n, m) => n + m.dailyLimit, 0)) });
      await saveMailboxSet(c.id, emails);
    }
    return String(c.instantly_campaign_id);
  }
  const created = await inst.createCampaign(instantlyPayload(c, settings, await campaignCountry(c.id), mailboxes));
  await q(`UPDATE campaigns SET instantly_campaign_id = ?, instantly_status = ?, updated_at = ? WHERE id = ?`, [created.id, created.status ?? 0, nowIso(), c.id]);
  await saveMailboxSet(c.id, emails);
  await logEvent("send", `Created the Instantly campaign "${c.name} · DNA" with ${emails.length} sending mailbox(es).`, { campaignId: c.id });
  c.instantly_campaign_id = created.id;
  // Instantly creates campaigns as drafts; ours is already running.
  if (c.status === "active") await setInstantlyRunning(c, true);
  return created.id;
}

async function saveMailboxSet(campaignId: string, emails: string[]) {
  const row = (await q(`SELECT stats_json FROM campaigns WHERE id = ?`, [campaignId]))[0];
  const stats = parseJson<any>(row?.stats_json, {}) || {};
  stats.mailboxes = JSON.stringify(emails);
  await q(`UPDATE campaigns SET stats_json = ? WHERE id = ?`, [JSON.stringify(stats), campaignId]);
}

export async function queuedToday(campaignId: string): Promise<number> {
  const r = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND queued_at >= ?`, [campaignId, `${todayUtc()}T00:00:00.000Z`]))[0];
  return Number(r?.n) || 0;
}

/** Push approved prospects. Returns how many were queued and why anything waited. */
export async function pushApproved(c: Row, settings: CampaignSettings): Promise<{ queued: number; notes: string[] }> {
  const notes: string[] = [];
  const waiting = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'approved'`, [c.id]))[0];
  if (!Number(waiting?.n)) return { queued: 0, notes };
  if (!(await inst.instantlyConfigured())) return { queued: 0, notes: ["Approved emails are waiting: connect Instantly in the Agent tab to start sending."] };
  const mailboxes = await sendableMailboxes();
  if (!mailboxes.length) return { queued: 0, notes: ["Approved emails are waiting for a sending mailbox: mailboxes are still warming up (see the Mailboxes tab)."] };
  const capacity = mailboxes.reduce((n, m) => n + m.dailyLimit, 0);
  const limit = Math.min(settings.dailyNewLeads, capacity) - (await queuedToday(c.id));
  if (limit <= 0) return { queued: 0, notes: [`Today's limit of ${Math.min(settings.dailyNewLeads, capacity)} new leads is reached; the rest go out tomorrow.`] };

  let campaignId: string;
  try {
    campaignId = await ensureInstantlyCampaign(c, settings, mailboxes);
  } catch (e: any) {
    const msg = `Instantly refused the campaign: ${String(e?.message || e).slice(0, 200)}`;
    await q(`UPDATE campaigns SET last_error = ?, updated_at = ? WHERE id = ?`, [msg, nowIso(), c.id]);
    await logEvent("send", msg, { level: "warn", campaignId: c.id });
    return { queued: 0, notes: [msg] };
  }

  const policy = (await getAgentSettings()).sending;
  const todayCatchAll = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND queued_at >= ? AND catch_all = 1`, [c.id, `${todayUtc()}T00:00:00.000Z`]))[0]?.n) || 0;
  const todayAll = await queuedToday(c.id);
  const rows = await q(
    `SELECT p.*, co.name AS co_name, co.domain AS co_domain FROM prospects p LEFT JOIN companies co ON co.id = p.company_id
      WHERE p.campaign_id = ? AND p.stage = 'approved' ORDER BY p.approved_at, p.created_at LIMIT ?`,
    [c.id, limit * 2]
  );
  const batch: { p: Row; lead: inst.NewLead }[] = [];
  let catchAll = todayCatchAll;
  const now = nowIso();
  for (const p of rows) {
    if (batch.length >= limit) break;
    const reason = await suppressionReason(String(p.email), c.id, String(p.id));
    if (reason) {
      await q(`UPDATE prospects SET stage = 'skipped', skipped_from = 'approved', stage_reason = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [`Not sent: ${reason}`, now, now, p.id]);
      continue;
    }
    if (Number(p.catch_all) === 1) {
      const total = todayAll + batch.length + 1;
      if ((catchAll + 1) / total > policy.maxCatchAllShare && total > 1) continue; // waits for a later batch
      catchAll++;
    }
    const emails = parseJson<ProspectEmails | null>(p.email_json, null);
    if (!emails?.steps?.length) continue;
    const vars: Record<string, string> = { subject_1: emails.steps[0].subject, body_1: html(emails.steps[0].body) };
    for (let i = 1; i < emails.steps.length && i <= settings.followUps; i++) vars[`body_${i + 1}`] = html(emails.steps[i].body);
    batch.push({
      p,
      lead: {
        email: String(p.email),
        first_name: p.first_name || undefined,
        last_name: p.last_name || undefined,
        company_name: p.co_name || p.co_domain || undefined,
        job_title: p.title || undefined,
        website: p.co_domain ? `https://${p.co_domain}` : undefined,
        custom_variables: vars,
      },
    });
  }
  if (!batch.length) {
    if (rows.length) notes.push("Approved leads are waiting so catch-all addresses stay under the daily share set in the Agent settings.");
    return { queued: 0, notes };
  }

  let res: inst.AddLeadsResult;
  try {
    res = await inst.addLeads(campaignId, batch.map((b) => b.lead));
  } catch (e: any) {
    const msg = `Instantly didn't accept the leads: ${String(e?.message || e).slice(0, 200)}`;
    await q(`UPDATE campaigns SET last_error = ?, updated_at = ? WHERE id = ?`, [msg, nowIso(), c.id]);
    await logEvent("send", msg, { level: "warn", campaignId: c.id });
    return { queued: 0, notes: [msg] };
  }
  const created = new Map<string, string>();
  for (const cl of res.created_leads || []) {
    const b = batch[cl.index];
    const email = String(cl.email || b?.lead.email || "").toLowerCase();
    if (email) created.set(email, cl.id);
  }
  let queued = 0;
  for (const b of batch) {
    const id = created.get(String(b.lead.email).toLowerCase());
    if (id) {
      queued++;
      await q(`UPDATE prospects SET stage = 'queued', stage_reason = ?, instantly_lead_id = ?, queued_at = ?, stage_changed_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`, ["In the Instantly campaign, waiting for its send slot", id, now, now, now, b.p.id]);
    } else {
      const why = res.in_blocklist ? "Instantly's block list or an existing lead in the workspace" : "Instantly skipped it (duplicate or invalid)";
      await q(`UPDATE prospects SET stage = 'skipped', skipped_from = 'approved', stage_reason = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [`Not sent: ${why}`, now, now, b.p.id]);
    }
  }
  await q(`UPDATE campaigns SET last_error = NULL, updated_at = ? WHERE id = ?`, [now, c.id]);
  await logEvent("send", `Queued ${queued} lead(s) in Instantly${batch.length - queued ? `; ${batch.length - queued} skipped by Instantly` : ""}.`, { level: "success", campaignId: c.id });
  return { queued, notes };
}

/** Match our campaign state in Instantly (active <-> activate, paused/archived <-> pause). */
export async function setInstantlyRunning(c: Row, running: boolean): Promise<void> {
  if (!c.instantly_campaign_id || !(await inst.instantlyConfigured())) return;
  try {
    if (running) await inst.activateCampaign(c.instantly_campaign_id);
    else await inst.pauseCampaign(c.instantly_campaign_id);
    await q(`UPDATE campaigns SET instantly_status = ?, updated_at = ? WHERE id = ?`, [running ? 1 : 2, nowIso(), c.id]);
  } catch (e: any) {
    const msg = `Couldn't ${running ? "activate" : "pause"} the Instantly campaign: ${String(e?.message || e).slice(0, 200)}`;
    await q(`UPDATE campaigns SET last_error = ?, updated_at = ? WHERE id = ?`, [msg, nowIso(), c.id]);
    await logEvent("send", msg, { level: "warn", campaignId: c.id });
  }
}

/** Lead status -> sent / bounced / unsubscribed, campaign analytics -> stats. */
export async function syncCampaign(c: Row): Promise<void> {
  if (!c.instantly_campaign_id || !(await inst.instantlyConfigured())) return;
  const now = nowIso();
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await inst.listCampaignLeads(c.instantly_campaign_id, after, 100);
    for (const l of r.items || []) {
      const email = String(l.email || "").toLowerCase();
      if (!email) continue;
      const p = (await q(`SELECT id, stage, segment_id FROM prospects WHERE campaign_id = ? AND lower(email) = ?`, [c.id, email]))[0];
      if (!p) continue;
      if (Number(l.status) === -1 && ["queued", "sent"].includes(p.stage)) {
        await q(`UPDATE prospects SET stage = 'bounced', stage_reason = 'Bounced in Instantly', stage_changed_at = ?, updated_at = ? WHERE id = ?`, [now, now, p.id]);
      } else if (Number(l.status) === -2 && ["queued", "sent"].includes(p.stage)) {
        await q(`UPDATE prospects SET stage = 'unsubscribed', stage_reason = 'Unsubscribed in Instantly', stage_changed_at = ?, updated_at = ? WHERE id = ?`, [now, now, p.id]);
      } else if (p.stage === "queued" && l.timestamp_last_contact) {
        await q(`UPDATE prospects SET stage = 'sent', stage_reason = 'First email sent', sent_at = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [String(l.timestamp_last_contact), now, now, p.id]);
        if (p.segment_id) await q(`UPDATE segments SET sent = sent + 1 WHERE id = ?`, [p.segment_id]);
      }
    }
    after = r.next_starting_after;
    if (!after || !(r.items || []).length) break;
  }
  const a = await inst.campaignAnalytics(c.instantly_campaign_id).catch(() => null);
  const positive = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage IN ('interested','meeting','won')`, [c.id]))[0]?.n) || 0;
  const row = (await q(`SELECT stats_json FROM campaigns WHERE id = ?`, [c.id]))[0];
  const prev = parseJson<any>(row?.stats_json, {}) || {};
  const num = (...vals: any[]) => {
    for (const v of vals) if (v !== undefined && v !== null && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  const stats: CampaignStatsT & { mailboxes?: string } = {
    ...prev,
    sent: num(a?.emails_sent_count, a?.contacted_count, prev.sent) ?? 0,
    opened: null, // open tracking is off on purpose
    replies: num(a?.reply_count_unique, a?.reply_count, prev.replies) ?? 0,
    positive,
    bounced: num(a?.bounced_count, prev.bounced) ?? 0,
    updatedAt: now,
  };
  if (a?.campaign_status !== undefined) await q(`UPDATE campaigns SET instantly_status = ? WHERE id = ?`, [Number(a.campaign_status), c.id]);
  await q(`UPDATE campaigns SET stats_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(stats), now, c.id]);
  // Segment replies / positives from our own prospect stages (the Inbox writes them).
  await q(
    `UPDATE segments SET
       replies = (SELECT CAST(count(*) AS INTEGER) FROM prospects p WHERE p.segment_id = segments.id AND p.stage IN ('replied','interested','meeting','won','lost','unsubscribed')),
       positive = (SELECT CAST(count(*) AS INTEGER) FROM prospects p WHERE p.segment_id = segments.id AND p.stage IN ('interested','meeting','won'))
     WHERE campaign_id = ?`,
    [c.id]
  );
}
