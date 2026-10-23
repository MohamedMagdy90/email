// Dashboard (Phase 8, plan §8.2) — "is it working, and what needs me?" in one
// call: needs-you cards, KPI tiles with the previous period and a 14-day
// sparkline, the funnel, the daily trend, campaigns and segments tables,
// capacity, AI use and the latest activity. Cached for 60 s.
import { getSetting, q, setSetting } from "../../db";
import { listEvents, parseJson, todayUtc } from "../events";
import { aiStatus, budgetRemaining, usageToday } from "../llm";
import { instantlyConfigured } from "../instantly";
import { emptyFunnel, STAGES, type Funnel, type Row } from "../campaigns/types";
import { pauseCampaign, startCampaign } from "../campaigns/service";
import { sendableMailboxes } from "../campaigns/sender";
import { ensureDailyTable } from "./daily";
import { evaluate, getRules, loopStatusOf, segmentStats } from "../targeting/learning";

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; data: any }>();
export const clearDashboardCache = () => cache.clear();

const DAY_MS = 86400000;
const iso = (t: number) => new Date(t).toISOString();
const day = (t: number) => iso(t).slice(0, 10);
const REPLY_STAGES = ["replied", "interested", "meeting", "won", "lost", "unsubscribed"];
const HOT_STAGES = ["interested", "meeting", "won"];
const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");

export interface NeedsYou {
  id: string;
  tone: "warn" | "bad" | "info" | "good";
  title: string;
  body: string;
  action: { label: string; tab: string; leadsView?: string; campaignId?: string } | null;
  count?: number;
}

export async function dashboard(params: { range?: string | number; campaign?: string }) {
  const range = [7, 30, 90].includes(Number(params.range)) ? Number(params.range) : 30;
  const campaign = typeof params.campaign === "string" && params.campaign ? params.campaign : "";
  const key = `${range}|${campaign}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await build(range, campaign);
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function build(range: number, campaign: string) {
  await ensureDailyTable();
  const now = Date.now();
  const from = now - range * DAY_MS;
  const prevFrom = now - 2 * range * DAY_MS;
  const campaigns = campaign ? await q(`SELECT * FROM campaigns WHERE id = ?`, [campaign]) : await q(`SELECT * FROM campaigns WHERE status <> 'archived' ORDER BY created_at DESC`);
  const ids = campaigns.map((c) => String(c.id));
  const cIn = ids.length ? `p.campaign_id IN (${ids.map(() => "?").join(",")})` : "1 = 0";
  const dIn = ids.length ? `campaign_id IN (${ids.map(() => "?").join(",")})` : "1 = 0";
  const one = async (sql: string, args: any[]) => Number((await q(sql, args))[0]?.n) || 0;

  /* ------------------------------ KPIs ------------------------------ */
  const dailyRows = await q(`SELECT day, CAST(SUM(sent) AS INTEGER) AS sent, CAST(SUM(replies) AS INTEGER) AS replies FROM campaign_daily WHERE ${dIn} AND day >= ? GROUP BY day`, [...ids, day(prevFrom)]);
  const dailySent = new Map(dailyRows.map((r) => [String(r.day), Number(r.sent) || 0]));
  const haveDaily = dailyRows.length > 0;
  const firstSends = await q(`SELECT substr(p.sent_at, 1, 10) AS d, CAST(count(*) AS INTEGER) AS n FROM prospects p WHERE ${cIn} AND p.sent_at >= ? GROUP BY substr(p.sent_at, 1, 10)`, [...ids, iso(prevFrom)]);
  const ourSent = new Map(firstSends.map((r) => [String(r.d), Number(r.n) || 0]));
  const byDay = async (col: string, stages: string[] | null) =>
    new Map(
      (await q(`SELECT substr(p.${col}, 1, 10) AS d, CAST(count(*) AS INTEGER) AS n FROM prospects p WHERE ${cIn} AND p.${col} >= ? ${stages ? `AND p.stage IN (${inList(stages)})` : ""} GROUP BY substr(p.${col}, 1, 10)`, [...ids, iso(prevFrom)])).map((r) => [String(r.d), Number(r.n) || 0])
    );
  const repliesD = await byDay("replied_at", REPLY_STAGES);
  const hotD = await byDay("stage_changed_at", HOT_STAGES);
  const meetD = await byDay("stage_changed_at", ["meeting", "won"]);
  const bounceD = await byDay("stage_changed_at", ["bounced"]);
  const newD = await byDay("created_at", null);
  const sentOn = (d: string) => (haveDaily ? dailySent.get(d) || 0 : ourSent.get(d) || 0);

  const days = (a: number, b: number) => {
    const out: string[] = [];
    for (let t = a; t <= b; t += DAY_MS) out.push(day(t));
    return out;
  };
  const cur = days(from + DAY_MS, now);
  const prev = days(prevFrom + DAY_MS, from);
  const sum = (m: Map<string, number> | ((d: string) => number), ds: string[]) => ds.reduce((n, d) => n + (typeof m === "function" ? m(d) : m.get(d) || 0), 0);
  const spark = days(now - 13 * DAY_MS, now);
  const kpi = (curV: number | null, prevV: number | null, series: (number | null)[]) => ({ value: curV, prev: prevV, series });
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const contacted = (ds: string[]) => sum(ourSent, ds);
  const monthly = Number(await getSetting("monthly_cost")) || 75;
  const hotCur = sum(hotD, cur);
  const hotPrev = sum(hotD, prev);
  const kpis = {
    sent: kpi(sum(sentOn, cur), sum(sentOn, prev), spark.map(sentOn)),
    replyRate: kpi(rate(sum(repliesD, cur), contacted(cur)), rate(sum(repliesD, prev), contacted(prev)), spark.map((d) => rate(repliesD.get(d) || 0, ourSent.get(d) || 0))),
    hot: kpi(hotCur, hotPrev, spark.map((d) => hotD.get(d) || 0)),
    meetings: kpi(sum(meetD, cur), sum(meetD, prev), spark.map((d) => meetD.get(d) || 0)),
    bounceRate: kpi(rate(sum(bounceD, cur), contacted(cur)), rate(sum(bounceD, prev), contacted(prev)), spark.map((d) => rate(bounceD.get(d) || 0, ourSent.get(d) || 0))),
    newLeads: kpi(sum(newD, cur), sum(newD, prev), spark.map((d) => newD.get(d) || 0)),
    costPerHot: kpi(hotCur ? Math.round((monthly * range) / 30 / hotCur) : null, hotPrev ? Math.round((monthly * range) / 30 / hotPrev) : null, []),
  };
  const trend = cur.map((d) => ({ day: d, sent: sentOn(d), replies: repliesD.get(d) || 0, hot: hotD.get(d) || 0, bounced: bounceD.get(d) || 0 }));

  /* ------------------------------ funnel ----------------------------- */
  const funnel: Funnel = emptyFunnel();
  for (const r of await q(`SELECT p.stage, CAST(count(*) AS INTEGER) AS n FROM prospects p WHERE ${cIn} GROUP BY p.stage`, ids)) {
    if ((STAGES as string[]).includes(r.stage)) funnel[r.stage as keyof Funnel] = Number(r.n) as never;
    funnel.total += Number(r.n) || 0;
  }

  /* ---------------------------- campaigns ---------------------------- */
  const sendable = await sendableMailboxes();
  const capacityToday = sendable.reduce((n, m) => n + m.dailyLimit, 0);
  const todayIso = `${todayUtc()}T00:00:00.000Z`;
  const campaignRows = [];
  for (const c of campaigns) {
    const cid = String(c.id);
    const settings = parseJson<any>(c.settings_json, {}) || {};
    const stats = parseJson<any>(c.stats_json, {}) || {};
    const contactedN = await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND sent_at IS NOT NULL`, [cid]);
    const repliesN = await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage IN (${inList(REPLY_STAGES)})`, [cid]);
    const hotN = await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage IN (${inList(HOT_STAGES)})`, [cid]);
    const bouncedN = await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'bounced'`, [cid]);
    campaignRows.push({
      id: cid,
      name: String(c.name),
      kind: c.kind === "partner" ? "partner" : "customer",
      status: String(c.status),
      sent: Number(stats.sent) || contactedN,
      contacted: contactedN,
      replyRate: rate(repliesN, contactedN),
      hot: hotN,
      bounceRate: rate(bouncedN, contactedN),
      review: await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'written'`, [cid]),
      queuedToday: await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND queued_at >= ?`, [cid, todayIso]),
      queueLimit: Math.min(Number(settings.dailyNewLeads) || 30, capacityToday),
      lastError: c.last_error || null,
    });
  }

  /* ----------------------------- segments ---------------------------- */
  const segRows = ids.length ? await q(`SELECT s.*, c.name AS campaign_name FROM segments s JOIN campaigns c ON c.id = s.campaign_id WHERE s.campaign_id IN (${ids.map(() => "?").join(",")})`, ids) : [];
  const segStats = await segmentStats(segRows.map((s) => String(s.id)));
  const rules = await getRules();
  const segments = segRows
    .map((s) => {
      const st = segStats.get(String(s.id))!;
      return {
        id: String(s.id),
        name: String(s.name),
        campaignId: String(s.campaign_id),
        campaignName: String(s.campaign_name),
        status: loopStatusOf(s),
        exhausted: Number(s.exhausted) === 1,
        suggested: s.suggested_status ? { status: String(s.suggested_status), reason: String(s.suggested_reason || "") } : null,
        found: st.found,
        contacted: st.contacted,
        replies: st.replies,
        positive: st.positive,
        replyRate: st.replyRate,
        positiveRate: st.positiveRate,
        verdict: evaluate(st, rules).reason,
      };
    })
    .sort((a, b) => b.contacted - a.contacted || b.found - a.found)
    .slice(0, 12);

  /* ------------------------ capacity + mailboxes ----------------------- */
  let mb = { total: 0, sending: sendable.length, warming: 0, paused: 0, firstReadyAt: null as string | null };
  try {
    const rows = await q(`SELECT stage, warmup_started_at, pre_warmed FROM mailboxes WHERE missing_since IS NULL`);
    const policy = await import("../mailboxes/service").then((m) => m.getPolicy()).catch(() => null);
    const warmDays = (pre: boolean) => (pre ? policy?.minWarmDaysPreWarmed ?? 7 : policy?.minWarmDays ?? 14);
    let first: number | null = null;
    for (const r of rows) {
      if (r.stage === "warming" || r.stage === "ready") {
        mb.warming++;
        const started = Date.parse(String(r.warmup_started_at || ""));
        if (Number.isFinite(started)) {
          const ready = started + warmDays(Number(r.pre_warmed) === 1) * DAY_MS;
          if (first === null || ready < first) first = ready;
        }
      }
      if (r.stage === "paused") mb.paused++;
    }
    mb = { ...mb, total: rows.length, firstReadyAt: first !== null ? iso(Math.max(first, now)) : null };
  } catch {
    /* mailboxes not migrated */
  }
  const usedToday = await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects p WHERE ${cIn} AND p.queued_at >= ?`, [...ids, todayIso]);
  const ai = await aiStatus();
  const usage = await usageToday();
  const remaining = await budgetRemaining();
  const instantly = await instantlyConfigured();
  const everSent = funnel.sent + funnel.replied + funnel.interested + funnel.meeting + funnel.won + funnel.lost + funnel.bounced + funnel.unsubscribed + funnel.queued > 0;

  /* ----------------------------- needs you ---------------------------- */
  const needs: NeedsYou[] = [];
  if (funnel.written > 0) needs.push({ id: "review", tone: "warn", count: funnel.written, title: `${funnel.written} email${funnel.written === 1 ? "" : "s"} to review`, body: "Written and waiting for your approval before they go to Instantly.", action: { label: "Review them", tab: "leads", leadsView: "review" } });
  let humans = 0;
  try {
    const t = (await q(`SELECT CAST(SUM(CASE WHEN status = 'needs_human' THEN 1 ELSE 0 END) AS INTEGER) AS n FROM threads`))[0];
    humans = Number(t?.n) || 0;
  } catch {
    humans = 0;
  }
  if (humans) needs.push({ id: "inbox", tone: "warn", count: humans, title: `${humans} repl${humans === 1 ? "y needs" : "ies need"} a human`, body: "The agent handed these over: pricing, a meeting request, or something it shouldn't answer alone.", action: { label: "Open the Inbox", tab: "inbox" } });
  if (mb.paused) needs.push({ id: "mailboxes", tone: "bad", count: mb.paused, title: `${mb.paused} mailbox${mb.paused === 1 ? " is" : "es are"} paused`, body: "Pulled out of sending (bounces, inbox rate or an Instantly error). Check why before resuming.", action: { label: "Open Mailboxes", tab: "mailboxes" } });
  if (!ai.configured) needs.push({ id: "ai", tone: "bad", title: "No AI key", body: "Companies get a basic read only, and nothing is scored or written.", action: { label: "Connect one", tab: "agent" } });
  else if (remaining <= 0) needs.push({ id: "budget", tone: "warn", title: "Today's AI budget is used up", body: "Research, scoring and writing carry on tomorrow, or raise the budget.", action: { label: "Agent settings", tab: "agent" } });
  if (funnel.approved > 0 && !instantly) needs.push({ id: "instantly", tone: "bad", count: funnel.approved, title: "Approved emails can't go out", body: "Connect Instantly to start sending.", action: { label: "Connect Instantly", tab: "agent" } });
  else if (funnel.approved > 0 && !sendable.length) needs.push({ id: "capacity", tone: "info", count: funnel.approved, title: `${funnel.approved} approved email${funnel.approved === 1 ? "" : "s"} waiting for a mailbox`, body: mb.firstReadyAt ? `The first mailbox should be ready around ${new Date(mb.firstReadyAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.` : "Mailboxes are still warming up.", action: { label: "Open Mailboxes", tab: "mailboxes" } });
  const suggestions = segments.filter((s) => s.suggested).length || (await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM segments WHERE suggested_status IS NOT NULL ${ids.length ? `AND campaign_id IN (${ids.map(() => "?").join(",")})` : ""}`, ids));
  if (suggestions) needs.push({ id: "learning", tone: "good", count: suggestions, title: `${suggestions} segment change${suggestions === 1 ? "" : "s"} suggested`, body: "The learning loop has numbers to back a change (scale up or pause). Nothing changes until you apply it.", action: { label: "See them in Targeting", tab: "targeting" } });
  for (const c of campaignRows.filter((x) => x.lastError).slice(0, 2)) needs.push({ id: `err-${c.id}`, tone: "bad", title: `"${c.name}" hit a problem`, body: String(c.lastError).slice(0, 200), action: { label: "Open the campaign", tab: "campaigns", campaignId: c.id } });

  let firstSendNote: string | null = null;
  if (!everSent) {
    if (!campaigns.length) firstSendNote = "Create a campaign: the agent starts finding and researching companies straight away.";
    else if (!instantly) firstSendNote = "First emails go out once Instantly is connected and a mailbox has finished warming up.";
    else if (!sendable.length) firstSendNote = mb.firstReadyAt ? `First emails go out when the first mailbox finishes warming up, around ${new Date(mb.firstReadyAt).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}.` : "First emails go out when a mailbox finishes warming up.";
    else if (!campaigns.some((c) => c.status === "active")) firstSendNote = "A mailbox is ready. Start a campaign and approved emails go out today.";
    else firstSendNote = "Mailboxes are ready: approved emails go out at the next send slot.";
  }

  const pausedAll = parseJson<string[]>(await getSetting("paused_all_ids"), []);
  return {
    range,
    campaign: campaign || null,
    generatedAt: iso(now),
    needsYou: needs,
    kpis,
    funnel,
    trend,
    campaigns: campaignRows,
    segments,
    capacity: { mailboxes: mb, dailyCapacity: capacityToday, usedToday },
    ai: { configured: ai.configured, canSearch: ai.canSearch, callsToday: usage.calls, budgetLeft: remaining },
    events: await listEvents({ campaignId: campaign || undefined, limit: 15 }),
    firstSendNote,
    hasData: everSent,
    pause: { active: campaigns.filter((c) => c.status === "active").length, pausedByAll: pausedAll.filter((id) => campaigns.some((c) => c.id === id && c.status === "paused")).length },
    monthlyCost: monthly,
  };
}

/* ------------------------------ pause all ------------------------------ */

export async function pauseAll() {
  const active = await q(`SELECT id FROM campaigns WHERE status = 'active'`);
  const ids: string[] = [];
  for (const c of active) {
    await pauseCampaign(String(c.id));
    ids.push(String(c.id));
  }
  const before = parseJson<string[]>(await getSetting("paused_all_ids"), []);
  await setSetting("paused_all_ids", JSON.stringify([...new Set([...before, ...ids])]));
  clearDashboardCache();
  return { paused: ids.length };
}

export async function resumeAll() {
  const ids = parseJson<string[]>(await getSetting("paused_all_ids"), []);
  let resumed = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const c = (await q(`SELECT id, name, status FROM campaigns WHERE id = ?`, [id]))[0] as Row | undefined;
    if (!c || c.status !== "paused") continue;
    try {
      await startCampaign(id);
      resumed++;
    } catch (e: any) {
      failed.push(`${c.name}: ${String(e?.message || e)}`);
    }
  }
  await setSetting("paused_all_ids", "[]");
  clearDashboardCache();
  return { resumed, failed };
}

export async function setMonthlyCost(v: unknown) {
  const n = Math.max(0, Math.min(100000, Math.round(Number(v))));
  if (!Number.isFinite(n)) throw new Error("Enter a monthly amount in dollars");
  await setSetting("monthly_cost", String(n));
  clearDashboardCache();
  return { monthlyCost: n };
}
