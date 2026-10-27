// Mailbox policy — the readiness gate, the daily ramp and the auto-pause rules.
// Pure functions only: no database, no network, and the clock is passed in, so
// the same code runs the live pool, the example preview and the tests.
//
// Stages (see v2/schema.ts):
//   warming -> ready -> ramping -> active      and      any -> paused
// A mailbox only sends campaign mail in `ramping` or `active`.

export type Stage = "warming" | "ready" | "ramping" | "active" | "paused";

export interface MailboxPolicy {
  /** Days of warmup before a fresh mailbox may send. */
  minWarmDays: number;
  /** Days for a mailbox the vendor sold as pre-warmed. */
  minWarmDaysPreWarmed: number;
  /** Warmup inbox rate (last 7 days, %) needed to pass the gate. */
  minInboxRate: number;
  /** Warmup emails needed in the 7-day window before the inbox rate counts. */
  minWarmupSample: number;
  /** A sending mailbox is paused when its warmup inbox rate drops below this (%). */
  pauseInboxRate: number;
  /** A sending mailbox is paused when its 7-day bounce rate goes above this (%). */
  maxBounceRate: number;
  /** Campaign sends needed in the 7-day window before the bounce rate counts. */
  minSendsForBounce: number;
  /** Daily limit on the first day of the ramp. */
  rampStart: number;
  /** Added to the daily limit each day of the ramp. */
  rampStep: number;
  /** Full daily limit per mailbox. */
  targetLimit: number;
  /** Start the ramp as soon as every check passes (off = wait for "Start sending"). */
  autoStart: boolean;
  /** Turn warmup back on whenever Instantly reports it off. Warmup runs for life. */
  keepWarmupOn: boolean;
  /* ---- own engine (Google / Microsoft mailboxes we connect ourselves) ---- */
  /** The domain must be at least this old (registration date) before sending. */
  minDomainAgeDays: number;
  /** The mailbox must exist this many days before sending (0 for bought pre-warmed ones). */
  minMailboxDays: number;
  /** Inbox tests needed in the last 3 days before the rate counts. */
  minPlacementTests: number;
  /** Share of inbox tests (business seeds count double) that must land in the inbox. */
  minPlacementRate: number;
  /** A sending mailbox pauses when inbox tests are under this two days running. */
  pausePlacementRate: number;
  /** A sending mailbox pauses when unsubscribes + complaints pass this share of its sends. */
  maxComplaintRate: number;
  /** Sends since the ramp started before the complaint rate counts. */
  minSendsForComplaints: number;
}

export const DEFAULT_POLICY: MailboxPolicy = {
  minWarmDays: 14,
  minWarmDaysPreWarmed: 7,
  minInboxRate: 95,
  minWarmupSample: 20,
  pauseInboxRate: 90,
  maxBounceRate: 3,
  // One bounce in 20 sends is noise, not a signal. 50 is about the first four
  // days of a ramp, and needs at least two bounces to cross 3%.
  minSendsForBounce: 50,
  // Slow start for fresh domains (decided 2026-10-24): 5 a day, +2 a day, up to 30.
  rampStart: 5,
  rampStep: 2,
  targetLimit: 30,
  autoStart: true,
  keepWarmupOn: true,
  minDomainAgeDays: 14,
  minMailboxDays: 7,
  minPlacementTests: 12,
  minPlacementRate: 75,
  pausePlacementRate: 50,
  maxComplaintRate: 1,
  minSendsForComplaints: 100,
};

const LIMITS: Record<Exclude<keyof MailboxPolicy, "autoStart" | "keepWarmupOn">, [number, number]> = {
  minWarmDays: [0, 60],
  minWarmDaysPreWarmed: [0, 60],
  minInboxRate: [50, 100],
  minWarmupSample: [0, 1000],
  pauseInboxRate: [0, 100],
  maxBounceRate: [0.5, 20],
  minSendsForBounce: [1, 1000],
  rampStart: [1, 200],
  rampStep: [1, 100],
  targetLimit: [1, 200],
  minDomainAgeDays: [0, 90],
  minMailboxDays: [0, 60],
  minPlacementTests: [1, 200],
  minPlacementRate: [30, 100],
  pausePlacementRate: [0, 100],
  maxComplaintRate: [0.1, 20],
  minSendsForComplaints: [10, 2000],
};

/** Merge a stored/posted policy onto the defaults and clamp every number. */
export function normalizePolicy(raw: unknown): MailboxPolicy {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: MailboxPolicy = { ...DEFAULT_POLICY };
  for (const [key, [lo, hi]] of Object.entries(LIMITS) as [keyof typeof LIMITS, [number, number]][]) {
    const n = Number(src[key]);
    if (src[key] !== undefined && src[key] !== "" && Number.isFinite(n)) out[key] = Math.min(hi, Math.max(lo, n));
  }
  if (typeof src.autoStart === "boolean") out.autoStart = src.autoStart;
  if (typeof src.keepWarmupOn === "boolean") out.keepWarmupOn = src.keepWarmupOn;
  for (const k of [
    "minWarmDays",
    "minWarmDaysPreWarmed",
    "minWarmupSample",
    "minSendsForBounce",
    "rampStart",
    "rampStep",
    "targetLimit",
    "minDomainAgeDays",
    "minMailboxDays",
    "minPlacementTests",
    "minSendsForComplaints",
  ] as const) {
    out[k] = Math.round(out[k]);
  }
  // The pause line must sit below the pass line, or a mailbox could pass the
  // gate and be paused on the same day.
  if (out.pauseInboxRate >= out.minInboxRate) out.pauseInboxRate = Math.max(0, out.minInboxRate - 1);
  if (out.pausePlacementRate >= out.minPlacementRate) out.pausePlacementRate = Math.max(0, out.minPlacementRate - 1);
  if (out.rampStart > out.targetLimit) out.rampStart = out.targetLimit;
  return out;
}

/* ------------------------------- rows ------------------------------- */

/** A `mailboxes` row, as stored. */
export interface MailboxRow {
  id: string;
  email: string;
  domain: string | null;
  vendor: string;
  first_name: string | null;
  last_name: string | null;
  provider_code: number | null;
  instantly_status: number | null;
  warmup_status: number | null;
  warmup_score: number | null;
  warmup_started_at: string | null;
  pre_warmed: number;
  stage: string;
  stage_reason: string | null;
  stage_changed_at: string | null;
  daily_limit: number;
  target_limit: number;
  ramp_start: number;
  ramp_step: number;
  ramp_started_at: string | null;
  dns_json: string | null;
  checks_json: string | null;
  last_vitals_at: string | null;
  last_synced_at: string | null;
  manual_hold: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** 1 = target_limit was set for this mailbox; 0 = follow the pool rule. */
  target_custom?: number | null;
  /** Set when the mailbox disappeared from Instantly. */
  missing_since?: string | null;
  /* own engine */
  /** 'instantly' (synced from Instantly) | 'google' | 'microsoft' (connected here). */
  provider?: string | null;
  auth_status?: string | null;
  auth_error?: string | null;
  warmup_mode?: string | null;
  experiment_group?: string | null;
  domain_registered_at?: string | null;
  sender_name?: string | null;
  connected_at?: string | null;
}

export const isOwn = (row: Pick<MailboxRow, "provider">) => row.provider === "google" || row.provider === "microsoft";

/** Inbox-test results for one mailbox (engine/placement.ts builds it). */
export interface PlacementSummary {
  tests3d: number;
  pass3d: number;
  /** Weighted: business seeds (Workspace, Microsoft 365) count double. */
  rate3d: number | null;
  /** Last results from Microsoft 365 seeds, newest first. */
  m365Last: string[];
  /** Last 7 days, oldest first. */
  byDay: { day: string; tests: number; pass: number; spam: number; missing: number; rate: number | null }[];
  lastAt: string | null;
}

/** What the gate needs beyond the row and the health days, for own mailboxes. */
export interface OwnExtra {
  placement?: PlacementSummary | null;
  seeds?: number;
  /** Sends and unsubscribes/complaints since the current ramp started. */
  complaints?: { sent: number; complaints: number } | null;
}

/** A `mailbox_health` row (one mailbox, one UTC day). */
export interface HealthRow {
  day: string;
  warmup_sent: number;
  warmup_inbox: number;
  warmup_spam: number;
  warmup_received: number;
  inbox_rate: number | null;
  health_score: number | null;
  campaign_sent: number;
  bounced: number;
  replies: number;
}

export interface Dns {
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  allPass: boolean;
  indeterminate: string[];
  checkedAt: string;
}

export type CheckKey = "connection" | "warmup" | "dns" | "age" | "inbox" | "domain_age" | "placement";
export type CheckState = "pass" | "fail" | "pending";
export interface Check {
  key: CheckKey;
  label: string;
  state: CheckState;
  detail: string;
}

export interface Metrics {
  warmDays: number | null;
  warmDaysNeeded: number;
  readyEta: string | null;
  inboxRate7: number | null;
  warmupVolume7: number;
  sent7: number;
  bounced7: number;
  replies7: number;
  /**
   * Bounce rate over the last 7 days, but never counting sends from before the
   * current ramp began — so a resumed mailbox starts with a clean slate.
   */
  bounceRate7: number | null;
  bounceSent: number;
  bounceBounced: number;
  /** First day counted in the bounce rate. */
  bounceFrom: string;
}

/* ------------------------------- dates ------------------------------ */

const DAY_MS = 86_400_000;

function dayStart(isoOrDay: string): number {
  return Date.parse(`${isoOrDay.slice(0, 10)}T00:00:00Z`);
}

/** Whole UTC days from `from` to `to` (both ISO timestamps or YYYY-MM-DD). */
export function dayDiff(from: string, to: string): number {
  const a = dayStart(from);
  const b = dayStart(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / DAY_MS);
}

export function addDays(day: string, n: number): string {
  return new Date(dayStart(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** "29 Oct" */
export function fmtDay(day: string): string {
  return new Date(dayStart(day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function parseDns(raw: string | null): Dns | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return d && typeof d === "object" && "allPass" in d ? (d as Dns) : null;
  } catch {
    return null;
  }
}

/* ------------------------------ metrics ----------------------------- */

/** Numbers the gate and the screen both use. `health` may hold any days. */
export function metrics(row: MailboxRow, health: HealthRow[], policy: MailboxPolicy, today: string): Metrics {
  const from = addDays(today, -6); // the last 7 days, today included
  const rampFrom = row.ramp_started_at ? row.ramp_started_at.slice(0, 10) : null;
  const bounceFrom = rampFrom && rampFrom > from ? rampFrom : from;
  let inbox = 0;
  let spam = 0;
  let sent7 = 0;
  let bounced7 = 0;
  let replies7 = 0;
  let bounceSent = 0;
  let bounceBounced = 0;
  let firstWarm: string | null = null;
  for (const h of health) {
    if (h.warmup_sent > 0 && (!firstWarm || h.day < firstWarm)) firstWarm = h.day;
    if (h.day < from || h.day > today) continue;
    inbox += Number(h.warmup_inbox) || 0;
    spam += Number(h.warmup_spam) || 0;
    sent7 += Number(h.campaign_sent) || 0;
    bounced7 += Number(h.bounced) || 0;
    replies7 += Number(h.replies) || 0;
    if (h.day >= bounceFrom) {
      bounceSent += Number(h.campaign_sent) || 0;
      bounceBounced += Number(h.bounced) || 0;
    }
  }
  const volume = inbox + spam;
  // Own mailboxes: "days" = how long the mailbox has existed here; the earliest
  // ready day also waits for the domain to be old enough.
  const own = isOwn(row);
  const warmStart = own ? row.connected_at || row.created_at : row.warmup_started_at || firstWarm;
  const needed = own ? (row.pre_warmed ? 0 : policy.minMailboxDays) : row.pre_warmed ? policy.minWarmDaysPreWarmed : policy.minWarmDays;
  let eta = warmStart ? addDays(warmStart, needed) : null;
  if (own) {
    const domainFrom = row.domain_registered_at || row.connected_at || row.created_at;
    const domainEta = domainFrom ? addDays(domainFrom, policy.minDomainAgeDays) : null;
    if (domainEta && (!eta || domainEta > eta)) eta = domainEta;
  }
  return {
    warmDays: warmStart ? Math.max(0, dayDiff(warmStart, today)) : null,
    warmDaysNeeded: needed,
    readyEta: eta,
    inboxRate7: volume > 0 ? round1((inbox / volume) * 100) : null,
    warmupVolume7: volume,
    sent7,
    bounced7,
    replies7,
    bounceRate7: bounceSent > 0 ? round1((bounceBounced / bounceSent) * 100) : null,
    bounceSent,
    bounceBounced,
    bounceFrom,
  };
}

/* --------------------------- readiness gate --------------------------- */

const CONNECTION_FAIL: Record<string, string> = {
  "2": "Paused in Instantly.",
  "3": "Instantly has this mailbox in maintenance.",
  "-1": "Instantly can't sign in to this mailbox. Reconnect it in Instantly.",
  "-2": "Instantly stopped it after soft bounces. Check the mailbox in Instantly.",
  "-3": "Instantly reports sending errors. Check the mailbox in Instantly.",
};

const WARMUP_FAIL: Record<string, string> = {
  "0": "Warmup is off. Turn it on and leave it on.",
  "-1": "Banned from Instantly's warmup network.",
  "-2": "Warmup can't see where mail lands (spam folder unknown in Instantly).",
  "-3": "Permanently suspended from warmup.",
};

export function missingDns(dns: Dns): string[] {
  const out: string[] = [];
  if (!dns.mx) out.push("MX");
  if (!dns.spf) out.push("SPF");
  if (!dns.dkim) out.push("DKIM");
  if (!dns.dmarc) out.push("DMARC");
  return out;
}

/** True when every failing record is one the DNS lookup could not reach. */
function dnsOnlyIndeterminate(dns: Dns): boolean {
  const miss = missingDns(dns);
  const unsure = new Set((dns.indeterminate || []).map((s) => String(s).toUpperCase()));
  return miss.length > 0 && miss.every((m) => unsure.has(m));
}

function dnsCheck(row: MailboxRow, ownHint: boolean): Check {
  const dns = parseDns(row.dns_json);
  if (!dns) return { key: "dns", label: "DNS records", state: "pending", detail: "Not checked yet. Checked within a few minutes." };
  if (dns.allPass) return { key: "dns", label: "DNS records", state: "pass", detail: "MX, SPF, DKIM and DMARC all found." };
  if (dnsOnlyIndeterminate(dns)) {
    return { key: "dns", label: "DNS records", state: "pending", detail: `Couldn't look up ${missingDns(dns).join(", ")} (DNS timeout). Checked again shortly.` };
  }
  return {
    key: "dns",
    label: "DNS records",
    state: "fail",
    detail: ownHint
      ? `Missing ${missingDns(dns).join(", ")}. Open "DNS setup" on this domain for the exact records to add.`
      : `Missing ${missingDns(dns).join(", ")}. Add the record at the domain's DNS provider (the mailbox vendor usually does this for you).`,
  };
}

const PASS_RESULTS = new Set(["inbox", "other_tab", "other"]);

/** The gate for mailboxes connected to our own engine (plan §10). */
function ownChecks(row: MailboxRow, m: Metrics, policy: MailboxPolicy, extra: OwnExtra = {}, today?: string): Check[] {
  const checks: Check[] = [];
  const t = today || new Date().toISOString().slice(0, 10);

  // 1. We can send and read with its sign-in.
  checks.push(
    row.auth_status === "failed"
      ? { key: "connection", label: "Signed in", state: "fail", detail: row.auth_error ? `Sign in again: ${row.auth_error}` : "The sign-in stopped working. Sign in again." }
      : { key: "connection", label: "Signed in", state: "pass", detail: `Connected to ${row.provider === "microsoft" ? "Microsoft 365" : "Google Workspace"}.` }
  );

  // 2. DNS.
  checks.push(dnsCheck(row, true));

  // 3. Domain age.
  const regFrom = row.domain_registered_at || null;
  const from = regFrom || row.connected_at || row.created_at;
  const domainDays = from ? Math.max(0, dayDiff(from, t)) : 0;
  const needD = policy.minDomainAgeDays;
  checks.push(
    domainDays >= needD
      ? { key: "domain_age", label: `Domain ${needD}+ days old`, state: "pass", detail: regFrom ? `Registered ${plural(domainDays, "day")} ago.` : `Added ${plural(domainDays, "day")} ago (the registry didn't give a registration date).` }
      : {
          key: "domain_age",
          label: `Domain ${needD}+ days old`,
          state: "pending",
          detail: `${regFrom ? "Registered" : "Added"} ${plural(domainDays, "day")} ago. Old enough on ${fmtDay(addDays(from as string, needD))}.`,
        }
  );

  // 4. Mailbox age.
  const needM = m.warmDaysNeeded;
  const ageM = m.warmDays ?? 0;
  checks.push(
    ageM >= needM
      ? { key: "age", label: needM ? `Mailbox ${needM}+ days old` : "Mailbox age", state: "pass", detail: row.pre_warmed ? "Bought pre-warmed: no waiting." : `Connected ${plural(ageM, "day")} ago.` }
      : { key: "age", label: `Mailbox ${needM}+ days old`, state: "pending", detail: `Day ${ageM} of ${needM}. Ready around ${fmtDay(addDays(row.connected_at || row.created_at, needM))}.` }
  );

  // 5. Inbox tests.
  const p = extra.placement || null;
  const label = `${policy.minPlacementRate}% in the inbox`;
  // A mailbox sends each test inbox ONE test a day, and the 3-day window includes TODAY,
  // whose tests may still be in flight. So the most that is reliably there is two full
  // days: seeds x 2. With the recommended pair (Workspace + Microsoft 365) that is 4;
  // requiring the full minPlacementTests (12, sized for more test inboxes) would hold
  // every mailbox at "not enough tests" forever. The bar scales down to what is possible.
  const needTests = Math.max(1, Math.min(policy.minPlacementTests, (extra.seeds || 0) * 2));
  if (!extra.seeds) {
    checks.push({ key: "placement", label, state: "pending", detail: "No test inbox connected yet. Add one under Agent → Connections → Test inboxes." });
  } else if (!p || p.tests3d < needTests || p.rate3d == null) {
    const capped = needTests < policy.minPlacementTests ? ` (${extra.seeds} test inbox${extra.seeds === 1 ? "" : "es"} x 2 full days)` : "";
    checks.push({ key: "placement", label, state: "pending", detail: `Not enough inbox tests yet: ${p?.tests3d || 0} of ${needTests} in the last 3 days${capped}.` });
  } else {
    const m365Pass = p.m365Last.filter((r) => PASS_RESULTS.has(r)).length;
    const m365Bad = p.m365Last.length >= 3 && m365Pass < 2;
    if (p.rate3d < policy.minPlacementRate) {
      checks.push({ key: "placement", label, state: "fail", detail: `Only ${p.rate3d}% of ${p.tests3d} inbox tests landed in the inbox in the last 3 days (needs ${policy.minPlacementRate}%).` });
    } else if (m365Bad) {
      checks.push({ key: "placement", label, state: "fail", detail: `${p.rate3d}% in the inbox overall, but the Microsoft 365 test inbox got it in the inbox only ${m365Pass} of the last 3 times (needs 2).` });
    } else {
      checks.push({ key: "placement", label, state: "pass", detail: `${p.rate3d}% of ${p.tests3d} inbox tests landed in the inbox in the last 3 days.` });
    }
  }
  return checks;
}

function ownPauseTrigger(row: MailboxRow, m: Metrics, policy: MailboxPolicy, extra: OwnExtra = {}): string | null {
  if (row.auth_status === "failed") return `Sign-in stopped working${row.auth_error ? ` (${row.auth_error})` : ""}. Sign in again on the Mailboxes tab.`;
  const dns = parseDns(row.dns_json);
  if (dns && !dns.allPass && !dnsOnlyIndeterminate(dns)) return `DNS check failed: ${missingDns(dns).join(", ")} missing.`;
  const p = extra.placement;
  if (p) {
    const last2 = p.byDay.filter((d) => d.tests >= 2 && d.rate != null).slice(-2);
    if (last2.length === 2 && last2.every((d) => (d.rate as number) < policy.pausePlacementRate)) {
      return `Inbox tests under ${policy.pausePlacementRate}% two days running (${last2.map((d) => `${d.rate}%`).join(", ")}).`;
    }
    if (p.m365Last.length >= 3 && p.m365Last.every((r) => r === "spam" || r === "missing")) {
      return "The last 3 tests to the Microsoft 365 test inbox went to junk or never arrived.";
    }
  }
  if (m.bounceRate7 != null && m.bounceSent >= policy.minSendsForBounce && m.bounceRate7 > policy.maxBounceRate) {
    return `Bounce rate ${m.bounceRate7}%: ${m.bounceBounced} of ${m.bounceSent} emails bounced since ${fmtDay(m.bounceFrom)} (limit ${policy.maxBounceRate}%).`;
  }
  const c = extra.complaints;
  if (c && c.sent >= policy.minSendsForComplaints) {
    const rate = round1((c.complaints / c.sent) * 100);
    if (rate > policy.maxComplaintRate) return `${c.complaints} unsubscribes or complaints from ${c.sent} emails since the ramp started (${rate}%, limit ${policy.maxComplaintRate}%).`;
  }
  return null;
}

export function readinessChecks(row: MailboxRow, m: Metrics, policy: MailboxPolicy, extra?: OwnExtra, today?: string): Check[] {
  if (isOwn(row)) return ownChecks(row, m, policy, extra, today);
  const checks: Check[] = [];

  // 1. The account itself is healthy in Instantly.
  const st = row.instantly_status;
  checks.push(
    st == null
      ? { key: "connection", label: "Connected", state: "pending", detail: "Not seen in Instantly yet." }
      : st === 1
        ? { key: "connection", label: "Connected", state: "pass", detail: "Connected to Instantly, no errors." }
        : { key: "connection", label: "Connected", state: "fail", detail: CONNECTION_FAIL[String(st)] || `Instantly status ${st}.` }
  );

  // 2. Warmup is running.
  const ws = row.warmup_status;
  checks.push(
    ws == null
      ? { key: "warmup", label: "Warmup on", state: "pending", detail: "Warmup status not known yet." }
      : ws === 1
        ? { key: "warmup", label: "Warmup on", state: "pass", detail: "Warmup is running." }
        : { key: "warmup", label: "Warmup on", state: "fail", detail: WARMUP_FAIL[String(ws)] || `Warmup status ${ws}.` }
  );

  // 3. The domain's DNS records (per domain, shared by its mailboxes).
  const dns = parseDns(row.dns_json);
  if (!dns) {
    checks.push({ key: "dns", label: "DNS records", state: "pending", detail: "Not checked yet. Checked on the next sync." });
  } else if (dns.allPass) {
    checks.push({ key: "dns", label: "DNS records", state: "pass", detail: "MX, SPF, DKIM and DMARC all found." });
  } else if (dnsOnlyIndeterminate(dns)) {
    checks.push({
      key: "dns",
      label: "DNS records",
      state: "pending",
      detail: `Couldn't look up ${missingDns(dns).join(", ")} (DNS timeout). Re-checked on the next sync.`,
    });
  } else {
    checks.push({
      key: "dns",
      label: "DNS records",
      state: "fail",
      detail: `Missing ${missingDns(dns).join(", ")}. Add the record at the domain's DNS provider (the mailbox vendor usually does this for you).`,
    });
  }

  // 4. Enough days of warmup.
  const need = m.warmDaysNeeded;
  const pre = row.pre_warmed ? ", pre-warmed" : "";
  checks.push(
    m.warmDays == null
      ? { key: "age", label: `${need} days warming`, state: "pending", detail: "Warmup hasn't started yet." }
      : m.warmDays >= need
        ? { key: "age", label: `${need} days warming`, state: "pass", detail: `Warmed for ${plural(m.warmDays, "day")} (needs ${need}${pre}).` }
        : {
            key: "age",
            label: `${need} days warming`,
            state: "pending",
            detail: `Day ${m.warmDays} of ${need}${pre}. Ready around ${fmtDay(m.readyEta as string)}.`,
          }
  );

  // 5. Warmup mail lands in the inbox.
  if (m.warmupVolume7 < Math.max(1, policy.minWarmupSample) || m.inboxRate7 == null) {
    checks.push({
      key: "inbox",
      label: `${policy.minInboxRate}% inbox rate`,
      state: "pending",
      detail: `Not enough warmup data yet: ${m.warmupVolume7} of ${policy.minWarmupSample} emails in the last 7 days.`,
    });
  } else if (m.inboxRate7 >= policy.minInboxRate) {
    checks.push({
      key: "inbox",
      label: `${policy.minInboxRate}% inbox rate`,
      state: "pass",
      detail: `${m.inboxRate7}% of ${m.warmupVolume7} warmup emails landed in the inbox this week.`,
    });
  } else {
    checks.push({
      key: "inbox",
      label: `${policy.minInboxRate}% inbox rate`,
      state: "fail",
      detail: `Only ${m.inboxRate7}% of ${m.warmupVolume7} warmup emails landed in the inbox this week (needs ${policy.minInboxRate}%).`,
    });
  }

  return checks;
}

/* ----------------------------- auto-pause ----------------------------- */

/** Why a SENDING mailbox must stop now, or null if it may keep sending. */
export function pauseTrigger(row: MailboxRow, m: Metrics, policy: MailboxPolicy, extra?: OwnExtra): string | null {
  if (isOwn(row)) return ownPauseTrigger(row, m, policy, extra);
  const st = row.instantly_status;
  if (st === 2) return "Paused in Instantly.";
  if (st != null && st < 0) return CONNECTION_FAIL[String(st)] || `Instantly status ${st}.`;
  const ws = row.warmup_status;
  if (ws != null && ws < 0) return WARMUP_FAIL[String(ws)] || `Warmup status ${ws}.`;
  const dns = parseDns(row.dns_json);
  if (dns && !dns.allPass && !dnsOnlyIndeterminate(dns)) return `DNS check failed: ${missingDns(dns).join(", ")} missing.`;
  if (m.inboxRate7 != null && m.warmupVolume7 >= policy.minWarmupSample && m.inboxRate7 < policy.pauseInboxRate) {
    return `Warmup inbox rate fell to ${m.inboxRate7}% this week (pauses below ${policy.pauseInboxRate}%).`;
  }
  if (m.bounceRate7 != null && m.bounceSent >= policy.minSendsForBounce && m.bounceRate7 > policy.maxBounceRate) {
    return `Bounce rate ${m.bounceRate7}%: ${m.bounceBounced} of ${m.bounceSent} emails bounced since ${fmtDay(m.bounceFrom)} (limit ${policy.maxBounceRate}%).`;
  }
  return null;
}

/* -------------------------------- ramp -------------------------------- */

/**
 * The ramp numbers for one mailbox. Start and step always follow the pool
 * rules; the full limit follows them too unless it was set for this mailbox.
 */
export function rampParams(row: MailboxRow, policy: MailboxPolicy) {
  const target = row.target_custom === 1 && row.target_limit > 0 ? row.target_limit : policy.targetLimit;
  const start = Math.min(target, policy.rampStart);
  const step = Math.max(1, policy.rampStep);
  return { target, start, step };
}

/** Today's daily limit for a sending mailbox. */
export function rampLimit(row: MailboxRow, policy: MailboxPolicy, today: string): number {
  const { target, start, step } = rampParams(row, policy);
  if (!row.ramp_started_at) return start;
  const days = Math.max(0, dayDiff(row.ramp_started_at, today));
  return Math.min(target, start + step * days);
}

/** The day a ramping mailbox reaches its full limit. */
export function fullRampDay(row: MailboxRow, policy: MailboxPolicy, today: string): string | null {
  const { target, start, step } = rampParams(row, policy);
  const from = row.ramp_started_at ? row.ramp_started_at.slice(0, 10) : today;
  return addDays(from, Math.max(0, Math.ceil((target - start) / step)));
}

/* ------------------------------ decision ------------------------------ */

export interface Decision {
  stage: Stage;
  reason: string;
  dailyLimit: number;
  rampStartedAt: string | null;
  checks: Check[];
  metrics: Metrics;
  /** Something worth a line in the activity feed. */
  event: { level: "info" | "success" | "warn"; message: string } | null;
}

function waitingOn(checks: Check[]): string {
  const open = checks.filter((c) => c.state !== "pass");
  const fail = open.find((c) => c.state === "fail");
  if (fail) return fail.detail;
  if (open.length === 1) return open[0].detail;
  return `Waiting on ${open.map((c) => c.label.toLowerCase()).join(", ")}.`;
}

/**
 * The next state of one mailbox. `held` = the user (or the policy) wants a
 * mailbox that passes every check to wait for a manual start.
 */
export function decide(row: MailboxRow, health: HealthRow[], policy: MailboxPolicy, today: string, extra?: OwnExtra): Decision {
  const m = metrics(row, health, policy, today);
  const checks = readinessChecks(row, m, policy, extra, today);
  const who = row.email;
  const base = { checks, metrics: m };

  if (row.stage === "paused") {
    return { ...base, stage: "paused", reason: row.stage_reason || "Paused.", dailyLimit: row.daily_limit, rampStartedAt: row.ramp_started_at, event: null };
  }

  if (row.stage === "ramping" || row.stage === "active") {
    const trigger = pauseTrigger(row, m, policy, extra);
    if (trigger) {
      return {
        ...base,
        stage: "paused",
        reason: trigger,
        dailyLimit: row.daily_limit,
        rampStartedAt: row.ramp_started_at,
        event: { level: "warn", message: `Paused ${who}: ${trigger}` },
      };
    }
    const { target } = rampParams(row, policy);
    const limit = rampLimit(row, policy, today);
    if (limit >= target) {
      return {
        ...base,
        stage: "active",
        reason: `Sending at its full limit of ${target} a day.`,
        dailyLimit: target,
        rampStartedAt: row.ramp_started_at,
        event: row.stage !== "active" ? { level: "success", message: `${who} reached its full limit of ${target} emails a day.` } : null,
      };
    }
    const day = row.ramp_started_at ? dayDiff(row.ramp_started_at, today) + 1 : 1;
    const full = fullRampDay(row, policy, today);
    return {
      ...base,
      stage: "ramping",
      reason: `Ramp day ${day}: ${limit} a day, reaching ${target} on ${fmtDay(full as string)}.`,
      dailyLimit: limit,
      rampStartedAt: row.ramp_started_at,
      event: limit !== row.daily_limit && row.daily_limit > 0 ? { level: "info", message: `${who} ramped to ${limit} emails a day.` } : null,
    };
  }

  // warming / ready (and anything unknown) go through the gate.
  const allPass = checks.every((c) => c.state === "pass");
  if (!allPass) {
    return {
      ...base,
      stage: "warming",
      reason: waitingOn(checks),
      dailyLimit: 0,
      rampStartedAt: null,
      event:
        row.stage === "ready"
          ? { level: "warn", message: `${who} no longer passes every check and is back to warming: ${waitingOn(checks)}` }
          : null,
    };
  }

  const held = row.manual_hold === 1 || !policy.autoStart;
  if (held) {
    return {
      ...base,
      stage: "ready",
      reason: row.manual_hold === 1 ? "Passed every check. Held by you until you start sending." : "Passed every check. Waiting for you to start sending.",
      dailyLimit: 0,
      rampStartedAt: null,
      event: row.stage !== "ready" ? { level: "success", message: `${who} passed every readiness check and is ready to send.` } : null,
    };
  }

  const { target, start } = rampParams(row, policy);
  return {
    ...base,
    stage: start >= target ? "active" : "ramping",
    reason: start >= target ? `Sending at its full limit of ${target} a day.` : `Ramp day 1: ${start} a day.`,
    dailyLimit: start,
    rampStartedAt: today,
    event: { level: "success", message: `${who} passed every readiness check. Sending started at ${start} emails a day.` },
  };
}
