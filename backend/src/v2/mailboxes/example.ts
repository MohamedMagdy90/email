// Example pool for the preview shown before Instantly is connected. The
// mailboxes and their history are made up, but stages, reasons, checks and
// limits all come from the real policy (decide) and view code, so the preview
// shows exactly what the live pool will do with numbers like these.
import { addDays, decide, type HealthRow, type MailboxPolicy, type MailboxRow } from "./policy";
import { buildView, type PoolView } from "./view";

interface Spec {
  id: string;
  email: string;
  first: string;
  last: string;
  vendor: string;
  provider: number;
  preWarmed: boolean;
  warmStartAgo: number;
  /** Day the ramp started, as days ago (sending mailboxes only). */
  rampAgo?: number;
  stage: "warming" | "ready" | "ramping" | "active";
  hold?: boolean;
  inboxPct: number;
  /** Bounce share of campaign sends (%). */
  bouncePct?: number;
  dns: { mx: boolean; spf: boolean; dkim: boolean; dmarc: boolean };
}

const OK_DNS = { mx: true, spf: true, dkim: true, dmarc: true };

const SPECS: Spec[] = [
  { id: "ex-sara", email: "sara@dnaerp-mail.example", first: "Sara", last: "Haddad", vendor: "zapmail", provider: 2, preWarmed: true, warmStartAgo: 38, rampAgo: 12, stage: "ramping", inboxPct: 98, bouncePct: 1, dns: OK_DNS },
  { id: "ex-omar", email: "omar@dnaerp-mail.example", first: "Omar", last: "Khalil", vendor: "zapmail", provider: 2, preWarmed: true, warmStartAgo: 16, rampAgo: 3, stage: "ramping", inboxPct: 97, bouncePct: 0, dns: OK_DNS },
  { id: "ex-lina", email: "lina@dnaerp-mail.example", first: "Lina", last: "Nasser", vendor: "zapmail", provider: 2, preWarmed: true, warmStartAgo: 21, rampAgo: 6, stage: "ramping", inboxPct: 96, bouncePct: 5.5, dns: OK_DNS },
  { id: "ex-ahmed", email: "ahmed@dnaerp-hq.example", first: "Ahmed", last: "Saleh", vendor: "mailforge", provider: 3, preWarmed: true, warmStartAgo: 11, stage: "warming", hold: true, inboxPct: 97, dns: OK_DNS },
  { id: "ex-noor", email: "noor@dnaerp-hq.example", first: "Noor", last: "Aziz", vendor: "mailforge", provider: 3, preWarmed: true, warmStartAgo: 4, stage: "warming", inboxPct: 96, dns: OK_DNS },
  { id: "ex-karim", email: "karim@dnaerp-team.example", first: "Karim", last: "Mansour", vendor: "mailforge", provider: 3, preWarmed: false, warmStartAgo: 9, stage: "warming", inboxPct: 92, dns: { mx: true, spf: true, dkim: true, dmarc: false } },
];

/** Deterministic noise in [0, 1) so the preview looks the same on every load. */
function noise(seed: string, n: number): number {
  let h = 2166136261;
  const s = `${seed}:${n}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

function history(spec: Spec, policy: MailboxPolicy, today: string): HealthRow[] {
  const out: HealthRow[] = [];
  const days = Math.min(spec.warmStartAgo, 29);
  for (let ago = days; ago >= 0; ago--) {
    const day = addDays(today, -ago);
    const age = spec.warmStartAgo - ago;
    const volume = Math.min(40, (spec.preWarmed ? 18 : 6) + age * 2) + Math.round(noise(spec.id, ago) * 4);
    const pct = Math.min(100, spec.inboxPct + (noise(spec.id, ago + 100) - 0.5) * 3);
    const inbox = Math.round((volume * pct) / 100);
    let sent = 0;
    let bounced = 0;
    if (spec.rampAgo != null && ago <= spec.rampAgo) {
      const limit = Math.min(policy.targetLimit, policy.rampStart + policy.rampStep * (spec.rampAgo - ago));
      // Today is half done; earlier days sent close to their limit.
      sent = ago === 0 ? Math.round(limit * 0.45) : Math.max(0, limit - Math.round(noise(spec.id, ago + 200) * 2));
      bounced = Math.round((sent * (spec.bouncePct || 0)) / 100 + (noise(spec.id, ago + 300) > 0.7 ? 1 : 0) * Math.sign(spec.bouncePct || 0));
    }
    out.push({
      day,
      warmup_sent: volume,
      warmup_inbox: inbox,
      warmup_spam: volume - inbox,
      warmup_received: Math.round(volume * 0.9),
      inbox_rate: Math.round((inbox / volume) * 1000) / 10,
      health_score: null,
      campaign_sent: sent,
      bounced,
      replies: sent ? Math.round(sent * 0.04 * noise(spec.id, ago + 400) * 2) : 0,
    });
  }
  return out;
}

function at(today: string, ago: number, hm: string): string {
  return `${addDays(today, -ago)}T${hm}:00.000Z`;
}

export function examplePool(policy: MailboxPolicy, today: string) {
  const rows: MailboxRow[] = [];
  const health = new Map<string, HealthRow[]>();
  const now = new Date().toISOString();

  for (const s of SPECS) {
    const dns = { ...s.dns, allPass: s.dns.mx && s.dns.spf && s.dns.dkim && s.dns.dmarc, indeterminate: [] as string[], checkedAt: at(today, 0, "06:00") };
    const base: MailboxRow = {
      id: s.id,
      email: s.email,
      domain: s.email.split("@")[1],
      vendor: s.vendor,
      first_name: s.first,
      last_name: s.last,
      provider_code: s.provider,
      instantly_status: 1,
      warmup_status: 1,
      warmup_score: s.inboxPct,
      warmup_started_at: at(today, s.warmStartAgo, "09:00"),
      pre_warmed: s.preWarmed ? 1 : 0,
      stage: s.stage,
      stage_reason: null,
      stage_changed_at: at(today, s.rampAgo ?? Math.max(0, s.warmStartAgo - 1), "09:30"),
      daily_limit: s.rampAgo != null ? Math.min(policy.targetLimit, policy.rampStart + policy.rampStep * Math.max(0, s.rampAgo - 1)) : 0,
      target_limit: policy.targetLimit,
      ramp_start: policy.rampStart,
      ramp_step: policy.rampStep,
      ramp_started_at: s.rampAgo != null ? addDays(today, -s.rampAgo) : null,
      dns_json: JSON.stringify(dns),
      checks_json: null,
      last_vitals_at: dns.checkedAt,
      last_synced_at: now,
      manual_hold: s.hold ? 1 : 0,
      notes: null,
      created_at: at(today, s.warmStartAgo, "09:00"),
      updated_at: now,
      target_custom: 0,
      missing_since: null,
    };
    const h = history(s, policy, today);
    // One evaluation, exactly like a sync would run it.
    const d = decide(base, h, policy, today);
    rows.push({ ...base, stage: d.stage, stage_reason: d.reason, daily_limit: d.dailyLimit, ramp_started_at: d.rampStartedAt });
    health.set(s.id, h);
  }

  const view: PoolView = buildView(rows, health, policy, today);
  const byId = new Map(view.mailboxes.map((m) => [m.id, m]));
  const ev = (id: string, ago: number, hm: string, level: "info" | "success" | "warn", message: string) => ({
    id: `${id}-${ago}-${hm}`,
    kind: "mailbox",
    level,
    ref_type: "mailbox",
    ref_id: id,
    campaign_id: null,
    message,
    created_at: at(today, ago, hm),
  });
  const lina = byId.get("ex-lina");
  const events = [
    ...(lina?.stage === "paused" ? [ev("ex-lina", 0, "07:12", "warn", `Paused lina@dnaerp-mail.example: ${lina.reason}`)] : []),
    ev("ex-karim", 0, "06:00", "warn", "DNS check for dnaerp-team.example: missing DMARC."),
    ev("ex-omar", 0, "06:00", "info", `omar@dnaerp-mail.example ramped to ${byId.get("ex-omar")?.dailyLimit ?? policy.rampStart} emails a day.`),
    ev("ex-sara", 0, "06:00", "info", `sara@dnaerp-mail.example ramped to ${byId.get("ex-sara")?.dailyLimit ?? policy.rampStart} emails a day.`),
    ev("ex-ahmed", 1, "06:00", "success", "ahmed@dnaerp-hq.example passed every readiness check and is ready to send."),
    ev("ex-omar", 3, "06:00", "success", `omar@dnaerp-mail.example passed every readiness check. Sending started at ${policy.rampStart} emails a day.`),
    ev("ex-noor", 4, "09:00", "info", "Found noor@dnaerp-hq.example in Instantly and started tracking it."),
    ev("ex-karim", 9, "09:00", "info", "Found karim@dnaerp-team.example in Instantly and started tracking it."),
  ];
  const details = Object.fromEntries(
    view.mailboxes.map((m) => [m.id, { mailbox: m, health: health.get(m.id) || [], events: events.filter((e) => e.ref_id === m.id) }])
  );

  return {
    example: true as const,
    connected: false,
    syncing: false,
    lastSync: null,
    policy,
    ...view,
    events,
    details,
  };
}
