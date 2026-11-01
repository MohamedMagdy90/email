// Dashboard (Phase 8, plan §8.2) — "is it working, and what needs me?" in one
// call: needs-you cards, KPI tiles with the previous period and a 14-day
// sparkline, the funnel, the daily trend, campaigns and segments tables,
// capacity, AI use and the latest activity. Cached for 60 s.
import { getSetting, q, setSetting } from "../../db";
import { listEvents, parseJson, todayUtc } from "../events";
import { aiStatus, budgetRemaining, usageToday } from "../llm";
import { instantlyConfigured } from "../instantly";
import { emptyFunnel, STAGES, type Funnel, type Row } from "../campaigns/types";
import { pauseCampaign, readiness, startCampaign } from "../campaigns/service";
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
  // Sending capacity follows the engine, exactly as the senders see it:
  // Instantly mailboxes for Instantly campaigns, our own for own-engine ones.
  const ready = await readiness("all");
  const own = ready.ownMailboxes;
  const inst = {
    total: Math.max(0, ready.mailboxes.total - own.total),
    sending: Math.max(0, ready.mailboxes.sending - own.sending),
    dailyCapacity: Math.max(0, ready.mailboxes.dailyCapacity - own.dailyCapacity),
  };
  const engineOf = (c: Row): "own" | "instantly" => (c.engine === "own" ? "own" : "instantly");
  const capacityToday = ready.mailboxes.dailyCapacity;
  const todayIso = `${todayUtc()}T00:00:00.000Z`;
  const campaignRows = [];
  for (const c of campaigns) {
    const cid = String(c.id);
    const engine = engineOf(c);
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
      engine,
      sent: Number(stats.sent) || contactedN,
      contacted: contactedN,
      replyRate: rate(repliesN, contactedN),
      hot: hotN,
      bounceRate: rate(bouncedN, contactedN),
      review: await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'written'`, [cid]),
      approved: await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'approved'`, [cid]),
      queuedToday: await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND queued_at >= ?`, [cid, todayIso]),
      queueLimit: Math.min(Number(settings.dailyNewLeads) || 30, (engine === "own" ? own : inst).dailyCapacity),
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
  // Stages and "next ready" come from the Mailboxes tab's own view (both
  // engines, same gate), so the two screens can never disagree.
  const mb = {
    total: ready.mailboxes.total,
    sending: ready.mailboxes.sending,
    warming: 0,
    ready: 0,
    paused: 0,
    failing: 0,
    nextReady: null as { email: string; day: string } | null,
    own: { total: own.total, sending: own.sending, dailyCapacity: own.dailyCapacity },
    instantly: { total: inst.total, sending: inst.sending, dailyCapacity: inst.dailyCapacity },
  };
  // The next mailbox to become ready, per engine: same rule as the Mailboxes
  // summary (warming, has a date, nothing failing).
  const nextReadyBy: Record<"own" | "instantly", { email: string; day: string } | null> = { own: null, instantly: null };
  try {
    const { listView } = await import("../mailboxes/service");
    const view = await listView();
    const s = view.summary;
    mb.total = s.total;
    mb.warming = s.byStage.warming || 0;
    mb.ready = s.byStage.ready || 0;
    mb.paused = s.byStage.paused || 0;
    mb.failing = Math.max(0, s.attention - mb.paused);
    mb.nextReady = s.nextReady;
    const t = todayUtc();
    for (const m of view.mailboxes) {
      const eta = m.metrics.readyEta;
      if (m.missing || m.stage !== "warming" || !eta || eta < t || m.checks.some((c) => c.state === "fail")) continue;
      const cur = nextReadyBy[m.engine];
      if (!cur || eta < cur.day) nextReadyBy[m.engine] = { email: m.email, day: eta };
    }
  } catch {
    /* mailboxes not migrated */
  }
  const usedToday = await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects p WHERE ${cIn} AND p.queued_at >= ?`, [...ids, todayIso]);
  const ai = await aiStatus();
  const usage = await usageToday();
  const remaining = await budgetRemaining();
  const instantly = await instantlyConfigured();
  const everSent = funnel.sent + funnel.replied + funnel.interested + funnel.meeting + funnel.won + funnel.lost + funnel.bounced + funnel.unsubscribed + funnel.queued > 0;
  // Engine-scoped helpers: only the engines of the campaigns in view matter
  // (no campaigns yet = either engine could be used).
  type Engine = "own" | "instantly";
  const scope: Engine[] = campaigns.length ? [...new Set(campaigns.map(engineOf))] : ["own", "instantly"];
  const pools = { own, instantly: inst };
  const sendingIn = (es: Engine[]) => es.reduce((n, e) => n + pools[e].sending, 0);
  const mailboxesIn = (es: Engine[]) => es.reduce((n, e) => n + pools[e].total, 0);
  const readyOn = (es: Engine[], fmt: "short" | "long") => {
    const day = es.map((e) => nextReadyBy[e]?.day).filter((d): d is string => !!d).sort()[0];
    return day ? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: fmt, timeZone: "UTC" }) : null;
  };

  /* ----------------------------- needs you ---------------------------- */
  const needs: NeedsYou[] = [];
  if (funnel.written > 0) needs.push({ id: "review", tone: "warn", count: funnel.written, title: `${funnel.written} email${funnel.written === 1 ? "" : "s"} to review`, body: "Written and waiting for your approval before they're sent.", action: { label: "Review them", tab: "leads", leadsView: "review" } });
  let humans = 0;
  try {
    const t = (await q(`SELECT CAST(SUM(CASE WHEN status = 'needs_human' THEN 1 ELSE 0 END) AS INTEGER) AS n FROM threads`))[0];
    humans = Number(t?.n) || 0;
  } catch {
    humans = 0;
  }
  if (humans) needs.push({ id: "inbox", tone: "warn", count: humans, title: `${humans} repl${humans === 1 ? "y needs" : "ies need"} a human`, body: "The agent handed these over: pricing, a meeting request, or something it shouldn't answer alone.", action: { label: "Open the Inbox", tab: "inbox" } });
  if (mb.paused) needs.push({ id: "mailboxes", tone: "bad", count: mb.paused, title: `${mb.paused} mailbox${mb.paused === 1 ? " is" : "es are"} paused`, body: "Pulled out of sending (bounces, inbox tests, a sign-in or Instantly error). Check why before resuming.", action: { label: "Open Mailboxes", tab: "mailboxes" } });
  if (mb.failing) needs.push({ id: "mailbox-checks", tone: "warn", count: mb.failing, title: `${mb.failing} mailbox${mb.failing === 1 ? " is" : "es are"} failing a check`, body: "A readiness check failed (DNS, sign-in or inbox tests), so it won't start sending until that's fixed.", action: { label: "Open Mailboxes", tab: "mailboxes" } });
  if (!ai.configured) needs.push({ id: "ai", tone: "bad", title: "No AI key", body: "Companies get a basic read only, and nothing is scored or written.", action: { label: "Connect one", tab: "agent" } });
  else if (remaining <= 0) needs.push({ id: "budget", tone: "warn", title: "Today's AI budget is used up", body: "Research, scoring and writing carry on tomorrow, or raise the budget.", action: { label: "Agent settings", tab: "agent" } });
  // Approved emails wait on THEIR campaign's engine: an own-engine campaign
  // never needs Instantly, an Instantly one never uses our own mailboxes.
  const approvedBy = { own: 0, instantly: 0 };
  for (const c of campaignRows) approvedBy[c.engine] += c.approved;
  const waitingOn: Engine[] = [];
  let waiting = 0;
  if (approvedBy.instantly > 0 && !instantly) {
    const n = approvedBy.instantly;
    needs.push({ id: "instantly", tone: "bad", count: n, title: `${n} approved email${n === 1 ? " can't" : "s can't"} go out`, body: "Their campaigns send through Instantly, which isn't connected. Connect it, or switch those campaigns to your own mailboxes.", action: { label: "Connect Instantly", tab: "agent" } });
  } else if (approvedBy.instantly > 0 && !inst.sending) {
    waiting += approvedBy.instantly;
    waitingOn.push("instantly");
  }
  if (approvedBy.own > 0 && !own.sending) {
    waiting += approvedBy.own;
    waitingOn.push("own");
  }
  if (waiting) {
    const on = readyOn(waitingOn, "short");
    const body = on ? `The first mailbox should be ready around ${on}.` : mailboxesIn(waitingOn) ? "Mailboxes are still warming up or finishing their checks." : waitingOn.includes("own") ? "No mailbox of your own yet. Sign one in from the Mailboxes tab." : "No Instantly mailbox is sending yet.";
    needs.push({ id: "capacity", tone: "info", count: waiting, title: `${waiting} approved email${waiting === 1 ? "" : "s"} waiting for a mailbox`, body, action: { label: "Open Mailboxes", tab: "mailboxes" } });
  }
  const suggestions = segments.filter((s) => s.suggested).length || (await one(`SELECT CAST(count(*) AS INTEGER) AS n FROM segments WHERE suggested_status IS NOT NULL ${ids.length ? `AND campaign_id IN (${ids.map(() => "?").join(",")})` : ""}`, ids));
  if (suggestions) needs.push({ id: "learning", tone: "good", count: suggestions, title: `${suggestions} segment change${suggestions === 1 ? "" : "s"} suggested`, body: "The learning loop has numbers to back a change (scale up or pause). Nothing changes until you apply it.", action: { label: "See them in Targeting", tab: "targeting" } });
  for (const c of campaignRows.filter((x) => x.lastError).slice(0, 2)) needs.push({ id: `err-${c.id}`, tone: "bad", title: `"${c.name}" hit a problem`, body: String(c.lastError).slice(0, 200), action: { label: "Open the campaign", tab: "campaigns", campaignId: c.id } });

  let firstSendNote: string | null = null;
  if (!everSent) {
    const on = readyOn(scope, "long");
    if (!campaigns.length) firstSendNote = "Create a campaign: the agent starts finding and researching companies straight away.";
    else if (scope.length === 1 && scope[0] === "instantly" && !instantly) firstSendNote = "First emails go out once Instantly is connected and a mailbox has finished warming up, or switch the campaign to your own mailboxes.";
    else if (!sendingIn(scope)) {
      if (on) firstSendNote = `First emails go out when the first mailbox is ready, around ${on}.`;
      else if (mailboxesIn(scope)) firstSendNote = "First emails go out when a mailbox finishes warming up and passes its checks.";
      else firstSendNote = scope.includes("own") ? "First emails go out once you sign in a mailbox of your own (Google Workspace or Microsoft 365) in the Mailboxes tab." : "First emails go out once an Instantly mailbox is sending.";
    } else if (!campaigns.some((c) => c.status === "active")) firstSendNote = "A mailbox is ready. Start a campaign and approved emails go out today.";
    else firstSendNote = "Mailboxes are ready: approved emails go out at the next send slot.";
  }

  // Pause / resume act on EVERY campaign, so their counts ignore the filter.
  const pausedAll = parseJson<string[]>(await getSetting("paused_all_ids"), []);
  const statusRows = await q(`SELECT id, status FROM campaigns WHERE status IN ('active', 'paused')`);
  const pause = {
    active: statusRows.filter((c) => c.status === "active").length,
    pausedByAll: statusRows.filter((c) => c.status === "paused" && pausedAll.includes(String(c.id))).length,
  };
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
    // dailyCapacity / sending = what the campaigns in view can use; mailboxes = the whole pool.
    capacity: { mailboxes: mb, engines: scope, sending: sendingIn(scope), dailyCapacity: scope.reduce((n, e) => n + pools[e].dailyCapacity, 0), poolCapacity: capacityToday, usedToday },
    ai: { configured: ai.configured, canSearch: ai.canSearch, callsToday: usage.calls, budgetLeft: remaining },
    events: await listEvents({ campaignId: campaign || undefined, limit: 15 }),
    firstSendNote,
    hasData: everSent,
    pause,
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
