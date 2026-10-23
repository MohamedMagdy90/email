// campaign_daily — one row per campaign per day, from Instantly's daily
// campaign analytics (sent, contacted, replies, opportunities), plus the
// bounces and unsubscribes our own records saw that day. Synced by the
// campaign sync every 30 minutes: 31 days back on the first sync, then the
// last 3 days (late replies land on earlier days).
import { nowIso, q } from "../../db";
import * as inst from "../instantly";
import type { Row } from "../campaigns/types";

let ready: Promise<void> | null = null;

export function ensureDailyTable(): Promise<void> {
  if (!ready)
    ready = q(`CREATE TABLE IF NOT EXISTS campaign_daily (
      day TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      contacted INTEGER NOT NULL DEFAULT 0,
      new_leads_contacted INTEGER NOT NULL DEFAULT 0,
      replies INTEGER NOT NULL DEFAULT 0,
      replies_auto INTEGER NOT NULL DEFAULT 0,
      bounced INTEGER NOT NULL DEFAULT 0,
      unsubscribed INTEGER NOT NULL DEFAULT 0,
      opportunities INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (day, campaign_id)
    )`)
      .then(() => undefined)
      .catch((e) => {
        ready = null;
        throw e;
      });
  return ready;
}

const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

export async function syncCampaignDaily(c: Row): Promise<number> {
  if (!c.instantly_campaign_id || !(await inst.instantlyConfigured())) return 0;
  await ensureDailyTable();
  const have = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM campaign_daily WHERE campaign_id = ?`, [c.id]))[0]?.n) || 0;
  const end = new Date();
  const start = new Date(end.getTime() - (have ? 2 : 30) * 86400000);
  const rows = await inst.campaignDailyAnalytics(String(c.instantly_campaign_id), dayStr(start), dayStr(end));
  const now = nowIso();
  let saved = 0;
  for (const r of rows) {
    const day = String(r?.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const bounced = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'bounced' AND stage_changed_at >= ? AND stage_changed_at < ?`, [c.id, `${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`]))[0]?.n) || 0;
    const unsub = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'unsubscribed' AND stage_changed_at >= ? AND stage_changed_at < ?`, [c.id, `${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`]))[0]?.n) || 0;
    const vals = [n(r.sent), n(r.contacted), n(r.new_leads_contacted), n(r.unique_replies ?? r.replies), n(r.unique_replies_automatic ?? r.replies_automatic), bounced, unsub, n(r.unique_opportunities ?? r.opportunities), now];
    await q(
      `INSERT INTO campaign_daily (day, campaign_id, sent, contacted, new_leads_contacted, replies, replies_auto, bounced, unsubscribed, opportunities, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (day, campaign_id) DO UPDATE SET sent = excluded.sent, contacted = excluded.contacted, new_leads_contacted = excluded.new_leads_contacted,
         replies = excluded.replies, replies_auto = excluded.replies_auto, bounced = excluded.bounced, unsubscribed = excluded.unsubscribed,
         opportunities = excluded.opportunities, updated_at = excluded.updated_at`,
      [day, c.id, ...vals]
    );
    saved++;
  }
  return saved;
}
