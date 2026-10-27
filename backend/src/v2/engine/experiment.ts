// The warmup test (plan §11): mailboxes in group "warmup_on" (Instantly warmup)
// against "warmup_off" (slow ramp only). Same ramp, same campaign, same copy.
// After 3 weeks the rule decides: unless warmup is >= 10 points better on the
// inbox tests, or clearly better on replies, warmup goes off everywhere.
import { q } from "../../db";

const TEST_DAYS = 21;
const PASS = ["inbox", "other_tab", "other"];

export interface GroupStats {
  group: "warmup_on" | "warmup_off";
  mailboxes: { id: string; email: string; provider: string; warmup: string }[];
  tests: number;
  inboxRate: number | null;
  bySeed: Record<string, { tests: number; rate: number | null }>;
  sent: number;
  contacted: number;
  replies: number;
  replyRate: number | null;
  bounces: number;
  bounceRate: number | null;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

async function stats(group: "warmup_on" | "warmup_off", rows: any[]): Promise<GroupStats> {
  const mine = rows.filter((r) => r.experiment_group === group);
  const ids = mine.map((r) => String(r.id));
  const empty: GroupStats = { group, mailboxes: [], tests: 0, inboxRate: null, bySeed: {}, sent: 0, contacted: 0, replies: 0, replyRate: null, bounces: 0, bounceRate: null };
  if (!ids.length) return empty;
  const ph = ids.map(() => "?").join(",");
  const tests = await q(
    `SELECT t.result, s.provider FROM placement_tests t JOIN seed_inboxes s ON s.id = t.seed_id WHERE t.mailbox_id IN (${ph}) AND t.result NOT IN ('pending','failed')`,
    ids
  );
  const bySeed: GroupStats["bySeed"] = {};
  for (const t of tests) {
    const k = String(t.provider);
    const b = (bySeed[k] = bySeed[k] || { tests: 0, rate: 0 });
    b.tests++;
    (b as any).pass = ((b as any).pass || 0) + (PASS.includes(String(t.result)) ? 1 : 0);
  }
  for (const k of Object.keys(bySeed)) bySeed[k] = { tests: bySeed[k].tests, rate: pct((bySeed[k] as any).pass, bySeed[k].tests) };
  const pass = tests.filter((t) => PASS.includes(String(t.result))).length;
  const n = async (sql: string) => Number((await q(sql, ids))[0]?.n) || 0;
  const sent = await n(`SELECT CAST(count(*) AS INTEGER) AS n FROM outbox WHERE mailbox_id IN (${ph}) AND kind = 'campaign' AND status IN ('sent','bounced','soft_bounced')`);
  const contacted = await n(`SELECT CAST(count(*) AS INTEGER) AS n FROM outbox WHERE mailbox_id IN (${ph}) AND kind = 'campaign' AND step = 0 AND status IN ('sent','bounced')`);
  const replies = await n(
    `SELECT CAST(count(DISTINCT o.prospect_id) AS INTEGER) AS n FROM outbox o JOIN prospects p ON p.id = o.prospect_id
      WHERE o.mailbox_id IN (${ph}) AND o.kind = 'campaign' AND o.step = 0 AND p.replied_at IS NOT NULL AND COALESCE(p.interest,'') NOT IN ('out_of_office','bounce')`
  );
  const bounces = await n(`SELECT CAST(count(*) AS INTEGER) AS n FROM outbox WHERE mailbox_id IN (${ph}) AND kind = 'campaign' AND status = 'bounced'`);
  return {
    group,
    mailboxes: mine.map((r) => ({ id: String(r.id), email: String(r.email), provider: String(r.provider), warmup: Number(r.warmup_status) === 1 ? "on" : r.warmup_mode === "instantly" ? "waiting for Instantly" : "off" })),
    tests: tests.length,
    inboxRate: pct(pass, tests.length),
    bySeed,
    sent,
    contacted,
    replies,
    replyRate: pct(replies, contacted),
    bounces,
    bounceRate: pct(bounces, contacted),
  };
}

export async function experimentView() {
  const rows = await q(`SELECT id, email, provider, experiment_group, warmup_mode, warmup_status, connected_at FROM mailboxes WHERE provider IN ('google','microsoft') AND missing_since IS NULL`);
  const inTest = rows.filter((r) => r.experiment_group === "warmup_on" || r.experiment_group === "warmup_off");
  if (!inTest.length) return { active: false as const, testDays: TEST_DAYS };
  const startedAt = inTest.map((r) => String(r.connected_at || "")).filter(Boolean).sort()[0] || null;
  const day = startedAt ? Math.max(1, Math.floor((Date.now() - Date.parse(startedAt)) / 86_400_000) + 1) : 1;
  const on = await stats("warmup_on", rows);
  const off = await stats("warmup_off", rows);
  let verdict: { decided: boolean; keepWarmup: boolean | null; text: string };
  if (!on.mailboxes.length || !off.mailboxes.length) {
    verdict = { decided: false, keepWarmup: null, text: "Put at least one mailbox in each group (warmup on and warmup off) to compare them." };
  } else if (day < TEST_DAYS) {
    verdict = { decided: false, keepWarmup: null, text: `Day ${day} of ${TEST_DAYS}. Keep both groups on the same ramp and campaign until the end.` };
  } else {
    const placementGap = on.inboxRate != null && off.inboxRate != null ? on.inboxRate - off.inboxRate : null;
    const replyLift = on.replyRate != null && off.replyRate != null ? on.replyRate - off.replyRate : null;
    const clearlyMoreReplies = replyLift != null && on.contacted >= 30 && off.contacted >= 30 && replyLift >= 1 && on.replyRate! >= off.replyRate! * 1.5;
    const keep = (placementGap != null && placementGap >= 10) || clearlyMoreReplies;
    verdict = {
      decided: true,
      keepWarmup: keep,
      text: keep
        ? `Warmup helped: ${placementGap != null ? `${placementGap.toFixed(1)} points better on inbox tests` : ""}${clearlyMoreReplies ? `${placementGap != null ? ", and " : ""}clearly more replies` : ""}. Keep it on.`
        : `Warmup didn't make a clear difference (${placementGap != null ? `${placementGap >= 0 ? "+" : ""}${placementGap.toFixed(1)} points on inbox tests` : "no inbox-test gap yet"}). Turn it off everywhere and cancel Instantly.`,
    };
  }
  return { active: true as const, testDays: TEST_DAYS, startedAt, day, on, off, verdict, note: "With 2 against 2 mailboxes this is a strong hint, not proof." };
}
