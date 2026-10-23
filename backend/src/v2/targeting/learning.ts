// The learning loop (Phase 9, plan §8.4.5): each segment is Testing until it
// has enough sends, then Scaling (doing well), Working, or Paused (no hot leads
// after many sends, or too many bounces). In "suggest" mode a change waits for
// the user's Apply; in "auto" mode the loop applies it. The quota split decides
// how much of each day's discovery and sending goes to each status.
import { getSetting, nowIso, q, setSetting } from "../../db";
import { logEvent, parseJson } from "../events";
import type { Row } from "../campaigns/types";

export type LoopStatus = "testing" | "working" | "scaling" | "paused";

export interface SegmentRules {
  /** Testing until this many leads were emailed. */
  testUntil: number;
  /** Scaling when the positive-reply rate reaches this (%)… */
  scalePositiveRate: number;
  /** …or the reply rate reaches this (%). */
  scaleReplyRate: number;
  /** Paused when there is no hot lead after this many emailed. */
  pauseAfter: number;
  /** Paused when bounces go above this (%). */
  pauseBounceRate: number;
  mode: "suggest" | "auto";
  /** Share of each day's new leads (discovery and push order), by status. */
  quota: { scaling: number; working: number; testing: number };
}

export const DEFAULT_RULES: SegmentRules = {
  testUntil: 50,
  scalePositiveRate: 2,
  scaleReplyRate: 5,
  pauseAfter: 100,
  pauseBounceRate: 4,
  mode: "suggest",
  quota: { scaling: 60, working: 30, testing: 10 },
};

const KEY = "segment_rules";
const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n * 10) / 10)) : d;
};

export function sanitizeRules(raw: any, base: SegmentRules = DEFAULT_RULES): SegmentRules {
  const r = raw && typeof raw === "object" ? raw : {};
  const qt = r.quota && typeof r.quota === "object" ? r.quota : {};
  let quota = { scaling: clamp(qt.scaling, 0, 100, base.quota.scaling), working: clamp(qt.working, 0, 100, base.quota.working), testing: clamp(qt.testing, 0, 100, base.quota.testing) };
  const sum = quota.scaling + quota.working + quota.testing;
  if (sum <= 0) quota = { ...DEFAULT_RULES.quota };
  else if (Math.abs(sum - 100) > 0.5) quota = { scaling: Math.round((quota.scaling / sum) * 100), working: Math.round((quota.working / sum) * 100), testing: 0 };
  if (Math.abs(quota.scaling + quota.working + quota.testing - 100) > 0.5) quota.testing = Math.max(0, 100 - quota.scaling - quota.working);
  const testUntil = clamp(r.testUntil, 10, 1000, base.testUntil);
  return {
    testUntil,
    scalePositiveRate: clamp(r.scalePositiveRate, 0, 100, base.scalePositiveRate),
    scaleReplyRate: clamp(r.scaleReplyRate, 0, 100, base.scaleReplyRate),
    pauseAfter: Math.max(testUntil, clamp(r.pauseAfter, 10, 5000, base.pauseAfter)),
    pauseBounceRate: clamp(r.pauseBounceRate, 0, 100, base.pauseBounceRate),
    mode: r.mode === "auto" ? "auto" : r.mode === "suggest" ? "suggest" : base.mode,
    quota,
  };
}

export async function getRules(): Promise<SegmentRules> {
  return sanitizeRules(parseJson(await getSetting(KEY), {}), DEFAULT_RULES);
}
export async function saveRules(raw: any): Promise<SegmentRules> {
  const next = sanitizeRules(raw, await getRules());
  await setSetting(KEY, JSON.stringify(next));
  return next;
}

/* ------------------------------- stats ------------------------------- */

export interface SegmentStats {
  found: number;
  researched: number;
  offTarget: number;
  inTargetPct: number | null;
  contacted: number;
  replies: number;
  positive: number;
  bounced: number;
  replyRate: number | null;
  positiveRate: number | null;
  bounceRate: number | null;
  foundToday: number;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** Per-segment numbers from our own records, for many segments at once. */
export async function segmentStats(segmentIds: string[]): Promise<Map<string, SegmentStats>> {
  const out = new Map<string, SegmentStats>();
  if (!segmentIds.length) return out;
  const day = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  for (let i = 0; i < segmentIds.length; i += 300) {
    const part = segmentIds.slice(i, i + 300);
    const rows = await q(
      `SELECT p.segment_id AS sid,
              CAST(count(*) AS INTEGER) AS found,
              CAST(SUM(CASE WHEN co.researched_at IS NOT NULL THEN 1 ELSE 0 END) AS INTEGER) AS researched,
              CAST(SUM(CASE WHEN p.skip_rule IS NOT NULL THEN 1 ELSE 0 END) AS INTEGER) AS off_target,
              CAST(SUM(CASE WHEN p.sent_at IS NOT NULL THEN 1 ELSE 0 END) AS INTEGER) AS contacted,
              CAST(SUM(CASE WHEN p.stage IN ('replied','interested','meeting','won','lost','unsubscribed') THEN 1 ELSE 0 END) AS INTEGER) AS replies,
              CAST(SUM(CASE WHEN p.stage IN ('interested','meeting','won') THEN 1 ELSE 0 END) AS INTEGER) AS positive,
              CAST(SUM(CASE WHEN p.stage = 'bounced' THEN 1 ELSE 0 END) AS INTEGER) AS bounced,
              CAST(SUM(CASE WHEN p.created_at >= ? THEN 1 ELSE 0 END) AS INTEGER) AS found_today
         FROM prospects p LEFT JOIN companies co ON co.id = p.company_id
        WHERE p.segment_id IN (${part.map(() => "?").join(",")})
        GROUP BY p.segment_id`,
      [day, ...part]
    );
    for (const r of rows) {
      const n = (k: string) => Number(r[k]) || 0;
      out.set(String(r.sid), {
        found: n("found"),
        researched: n("researched"),
        offTarget: n("off_target"),
        inTargetPct: n("researched") ? Math.round(((n("researched") - n("off_target")) / n("researched")) * 1000) / 10 : null,
        contacted: n("contacted"),
        replies: n("replies"),
        positive: n("positive"),
        bounced: n("bounced"),
        replyRate: pct(n("replies"), n("contacted")),
        positiveRate: pct(n("positive"), n("contacted")),
        bounceRate: pct(n("bounced"), n("contacted")),
        foundToday: n("found_today"),
      });
    }
  }
  for (const id of segmentIds) if (!out.has(id)) out.set(id, { found: 0, researched: 0, offTarget: 0, inTargetPct: null, contacted: 0, replies: 0, positive: 0, bounced: 0, replyRate: null, positiveRate: null, bounceRate: null, foundToday: 0 });
  return out;
}

/* ----------------------------- evaluation ---------------------------- */

/** What the rules say a segment should be, and why (with the numbers). */
export function evaluate(s: SegmentStats, r: SegmentRules): { status: LoopStatus; reason: string } {
  const numbers = `${s.contacted} emailed, ${s.replies} repl${s.replies === 1 ? "y" : "ies"} (${s.replyRate ?? 0}%), ${s.positive} hot (${s.positiveRate ?? 0}%)`;
  if (s.contacted < r.testUntil) return { status: "testing", reason: `Testing: ${s.contacted} of ${r.testUntil} emailed so far.` };
  if ((s.bounceRate ?? 0) > r.pauseBounceRate) return { status: "paused", reason: `Bounces at ${s.bounceRate}% are above ${r.pauseBounceRate}%: the addresses this segment finds are poor. ${numbers}.` };
  if (s.positive === 0 && s.contacted >= r.pauseAfter) return { status: "paused", reason: `No hot lead after ${s.contacted} emailed (the rule pauses at ${r.pauseAfter}). ${numbers}.` };
  if ((s.positiveRate ?? 0) >= r.scalePositiveRate || (s.replyRate ?? 0) >= r.scaleReplyRate) return { status: "scaling", reason: `Doing well: ${numbers}. Scaling gets ${r.quota.scaling}% of each day's new leads.` };
  return { status: "working", reason: `Working: ${numbers}. Not yet at ${r.scaleReplyRate}% replies or ${r.scalePositiveRate}% hot.` };
}

/** The loop's view of a segment row's stored status ('active' is Testing). */
export function loopStatusOf(seg: Row): LoopStatus {
  if (Number(seg.enabled) !== 1 || seg.status === "paused") return "paused";
  return seg.status === "scaling" ? "scaling" : seg.status === "working" ? "working" : "testing";
}
const toDb = (s: LoopStatus) => (s === "testing" ? "active" : s);
const LABEL: Record<LoopStatus, string> = { testing: "Testing", working: "Working", scaling: "Scaling", paused: "Paused" };

/** Set a segment's status (by the user, or by the loop in auto mode). */
export async function setSegmentStatus(seg: Row, status: LoopStatus, reason: string, by: "loop" | "user") {
  await q(`UPDATE segments SET status = ?, enabled = ?, status_reason = ?, suggested_status = NULL, suggested_reason = NULL, suggested_at = NULL, updated_at = ? WHERE id = ?`, [
    toDb(status),
    status === "paused" ? 0 : 1,
    reason.slice(0, 500),
    nowIso(),
    seg.id,
  ]);
  await logEvent("campaign", `${by === "loop" ? "The learning loop moved" : "Moved"} "${seg.name}" to ${LABEL[status]}. ${reason}`, { campaignId: seg.campaign_id, level: status === "scaling" ? "success" : status === "paused" ? "warn" : "info" });
}

/**
 * Run the rules over a campaign's segments (after each campaign sync).
 * Paused-by-hand segments are left alone; segments the loop paused can come back only by hand.
 */
export async function applyLearning(campaignId: string): Promise<{ suggested: number; applied: number }> {
  const rules = await getRules();
  const segs = await q(`SELECT * FROM segments WHERE campaign_id = ? AND enabled = 1`, [campaignId]);
  const stats = await segmentStats(segs.map((s) => String(s.id)));
  let suggested = 0;
  let applied = 0;
  for (const seg of segs) {
    const cur = loopStatusOf(seg);
    const ev = evaluate(stats.get(String(seg.id))!, rules);
    if (ev.status === cur) {
      if (seg.suggested_status) await q(`UPDATE segments SET suggested_status = NULL, suggested_reason = NULL, suggested_at = NULL WHERE id = ?`, [seg.id]);
      continue;
    }
    if (ev.status === "testing") continue; // never "un-test" a segment the user moved on
    if (rules.mode === "auto") {
      await setSegmentStatus(seg, ev.status, ev.reason, "loop");
      applied++;
    } else if (seg.suggested_status !== ev.status) {
      await q(`UPDATE segments SET suggested_status = ?, suggested_reason = ?, suggested_at = ? WHERE id = ?`, [ev.status, ev.reason.slice(0, 500), nowIso(), seg.id]);
      await logEvent("campaign", `Suggests moving "${seg.name}" to ${LABEL[ev.status]}. ${ev.reason} Apply it in Targeting.`, { campaignId });
      suggested++;
    }
  }
  return { suggested, applied };
}

/* -------------------------------- quota ------------------------------- */

/** Weight of one segment in the daily split: its status's share, divided among the segments with that status. */
export function quotaWeights(segs: Row[], rules: SegmentRules): Map<string, number> {
  const groups: Record<LoopStatus, Row[]> = { testing: [], working: [], scaling: [], paused: [] };
  for (const s of segs) groups[loopStatusOf(s)].push(s);
  const present = (["scaling", "working", "testing"] as const).filter((k) => groups[k].length);
  const total = present.reduce((n, k) => n + rules.quota[k], 0) || 1;
  const w = new Map<string, number>();
  for (const k of present) for (const s of groups[k]) w.set(String(s.id), rules.quota[k] / total / groups[k].length);
  return w;
}

/** Order segments for discovery: the one furthest below its share of today's finds goes first. */
export function discoveryOrder(segs: Row[], foundToday: Map<string, number>, rules: SegmentRules): Row[] {
  const w = quotaWeights(segs, rules);
  const total = [...foundToday.values()].reduce((n, x) => n + x, 0) + 1;
  return [...segs].sort((a, b) => {
    const da = (foundToday.get(String(a.id)) || 0) / total - (w.get(String(a.id)) || 0);
    const db = (foundToday.get(String(b.id)) || 0) / total - (w.get(String(b.id)) || 0);
    return da - db;
  });
}
