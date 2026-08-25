// Fill rate — is discovery feeding the automation fast enough to keep it running?
//
// Every other number on the Discovery and Overview screens is a LEVEL: how many
// leads are pending, how many have an email, how many contacts exist. A level
// cannot answer the only operational question that matters day to day — "will
// the machine still be sending tomorrow?" — because a pool of 4,000 with
// nothing coming in and a pool of 400 with plenty coming in look identical
// until the first one suddenly stops.
//
// This is the RATE, and it is measured against what the automation actually
// consumes, so it can be judged rather than merely read.
//
// ────────────────────────────────────────────────────────────────────────────
// DEMAND is derived, never configured.
//
// A lane approves `threshold` leads at a time and can only fire once per
// `cooldownMinutes`. So the most it can ever consume is threshold / cooldown —
// 150 leads every 3 hours, which is 8.3 every 10 minutes. There is nothing for
// anyone to enter and nothing to keep in sync: change the batch size or the
// cooldown and the target moves with it.
//
// SUPPLY is emailable leads ARRIVING, over the same horizon.
//
// Deliberately measured on `email_at`, not `created_at`. A lead is worthless to
// the automation until it has an address, and the gap between the two is the
// crawl queue — days long exactly when the crawler is being walled, which is
// exactly when this number needs to be right. Counting `created_at` would have
// reported a healthy inflow all the way through an outage.
// ────────────────────────────────────────────────────────────────────────────

import { q, getSetting } from "./db";
import { getAutomationConfig, AUDIENCES } from "./automation";
import { countApprovableLeads, type Audience } from "./pool";
import { STALE_AFTER_RUNS } from "./discovery";

/** Everything is quoted per TEN MINUTES: short enough to feel live, long enough
 *  that one lucky directory page doesn't swing it. */
export const UNIT_MINUTES = 10;

/** Below target, but the pool on hand still covers this much sending. Not an
 *  emergency, so it warns in amber rather than red — crying wolf on a pool with
 *  two days of leads banked is how a red light gets ignored when it counts. */
const COVER_OK_MINUTES = 12 * 60;

/** The measurement window is the cooldown — the horizon the lane actually runs
 *  on — clamped so a 15-minute cooldown doesn't make the number jitter and a
 *  weekly one doesn't average a dead day away to nothing. */
const MIN_WINDOW = 60;
const MAX_WINDOW = 24 * 60;

/** Sparkline resolution. Buckets are whole multiples of the quoted unit, so a
 *  bar and the headline number mean the same thing. */
const MAX_BUCKETS = 24;

/** Rows read for the sparkline. Far beyond any real inflow; if it is ever hit
 *  the window is narrowed to the span actually covered rather than under-
 *  reporting the rate. */
const SERIES_ROW_CAP = 5000;

/** Too little history to say anything. */
const MIN_HISTORY_MINUTES = 20;

/** Both screens poll on their own timers; one computation serves both. */
const CACHE_MS = 15_000;

export type FillStatus = "ok" | "slow" | "starved" | "idle";

export interface FillRateLane {
  audience: Audience;
  /** Master switch AND this lane's own switch are on — i.e. it is consuming. */
  live: boolean;
  /** Emailable leads arriving, per UNIT_MINUTES. */
  rate: number;
  /** What this lane eats, per UNIT_MINUTES. Reported even when the lane is off,
   *  because "what would it need" is a useful thing to know before switching
   *  it on. */
  required: number;
  /** rate / required. 0 when there is no demand. */
  ratio: number;
  status: FillStatus;
  /** Leads counted in the window. */
  found: number;
  /** Emailable leads waiting right now, and the batch they are filling. */
  ready: number;
  threshold: number;
  /** How long the leads on hand keep this lane fed. null = no demand. */
  coverMinutes: number | null;
  /** Until the next batch is full at this rate. 0 = already full, null = never. */
  etaMinutes: number | null;
  /** One count per bucket, oldest first. */
  series: number[];
}

export interface FillRate {
  lanes: FillRateLane[];
  /** Across the lanes that are actually consuming (or both, when none is). */
  rate: number;
  required: number;
  ratio: number;
  status: FillStatus;
  /** Minutes the rate is quoted over — 10. */
  unitMinutes: number;
  /** Minutes the rate was measured over, and how much of that we have history for. */
  windowMinutes: number;
  coveredMinutes: number;
  bucketMinutes: number;
  /** Not enough history yet to judge — a fresh install, or the bot just came on. */
  warming: boolean;
  /** Why the inflow is short, when it is. Named so the card is actionable
   *  instead of merely alarming. */
  reason: string | null;
  /** The shared daily ceiling, not the batch size, is what caps the demand. */
  cappedByDaily: boolean;
  measuredAt: string;
}

function clamp(n: number, lo: number, hi: number): number {
  const x = Number(n);
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

/** Two decimals is noise on a lead count; one is enough to see 8.3 vs 8.0. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

let cache: { at: number; value: FillRate } | null = null;

/** The snapshot both `/api/discovery/status` and `/api/overview` embed. */
export async function getFillRate(force = false): Promise<FillRate> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await computeFillRate();
  cache = { at: Date.now(), value };
  return value;
}

/** Drop the cache — used by the tests, and after anything that moves the pool. */
export function resetFillRateCache(): void {
  cache = null;
}

async function computeFillRate(): Promise<FillRate> {
  const cfg = await getAutomationConfig();
  const cooldown = clamp(cfg.cooldownMinutes, 1, 10080);
  const windowMinutes = clamp(cooldown, MIN_WINDOW, MAX_WINDOW);
  const bucketMinutes = Math.max(
    UNIT_MINUTES,
    Math.ceil(windowMinutes / MAX_BUCKETS / UNIT_MINUTES) * UNIT_MINUTES
  );
  const buckets = Math.max(1, Math.round(windowMinutes / bucketMinutes));

  // Buckets run BACKWARDS from now, so every one of them is exactly
  // `bucketMinutes` wide. Anchoring them to the clock instead would leave the
  // newest bar covering however many minutes have elapsed since the last
  // boundary — permanently short, and permanently reading as a collapse.
  const endMs = Date.now();
  const spanMs = buckets * bucketMinutes * 60_000;
  const sinceIso = new Date(endMs - spanMs).toISOString();

  const [rows, historyMinutes] = await Promise.all([
    q(
      // 'rejected' and 'duplicate' are excluded because they never reached the
      // automation: counting them would report an inflow that no lane can eat.
      `SELECT email_at AS t, audience FROM discovered_leads
        WHERE email_at IS NOT NULL AND email_at >= ?
          AND status NOT IN ('duplicate','rejected')
        ORDER BY email_at DESC LIMIT ?`,
      [sinceIso, SERIES_ROW_CAP]
    ),
    measurableMinutes(windowMinutes, endMs),
  ]);

  // The cap is far above any real inflow, but if it is ever hit the oldest part
  // of the window is missing — so measure over the span we genuinely have
  // rather than dividing a partial count by a full window.
  let coveredMinutes = historyMinutes;
  if (rows.length >= SERIES_ROW_CAP) {
    const oldest = Date.parse(String(rows[rows.length - 1]?.t || "")) || endMs;
    coveredMinutes = Math.min(coveredMinutes, Math.max(1, (endMs - oldest) / 60_000));
  }

  const per: Record<Audience, { found: number; series: number[] }> = {
    customer: { found: 0, series: new Array(buckets).fill(0) },
    partner: { found: 0, series: new Array(buckets).fill(0) },
  };
  const cutoffMs = endMs - Math.max(1, coveredMinutes) * 60_000;
  for (const r of rows as any[]) {
    const ms = Date.parse(String(r.t || ""));
    if (!Number.isFinite(ms)) continue;
    const lane: Audience = String(r.audience || "").trim().toLowerCase() === "partner" ? "partner" : "customer";
    // The sparkline shows the whole span; the RATE only counts the part we can
    // legitimately divide by (see coveredMinutes).
    const idx = Math.floor((endMs - ms) / (bucketMinutes * 60_000));
    if (idx >= 0 && idx < buckets) per[lane].series[buckets - 1 - idx]++;
    if (ms >= cutoffMs) per[lane].found++;
  }

  const warming = coveredMinutes < MIN_HISTORY_MINUTES;
  const divisor = Math.max(MIN_HISTORY_MINUTES, coveredMinutes);

  // The shared daily ceiling caps what BOTH lanes can consume between them, so
  // the raw batch-per-cooldown demand is scaled down to fit it. You cannot need
  // more leads than the sender will ever send.
  const rawRequired: Record<Audience, number> = { customer: 0, partner: 0 };
  for (const a of AUDIENCES) {
    rawRequired[a] = (cfg[a].threshold / cooldown) * UNIT_MINUTES;
  }
  const liveTotal = AUDIENCES.reduce((n, a) => n + (cfg.enabled && cfg[a].enabled ? rawRequired[a] : 0), 0);
  const ceiling = cfg.dailyLimit > 0 ? (cfg.dailyLimit / 1440) * UNIT_MINUTES : Infinity;
  const cappedByDaily = liveTotal > 0 && liveTotal > ceiling;
  const scale = cappedByDaily ? ceiling / liveTotal : 1;

  const readyCounts = await Promise.all(AUDIENCES.map((a) => countApprovableLeads(null, null, a)));

  const lanes: FillRateLane[] = [];
  AUDIENCES.forEach((audience, i) => {
    const live = cfg.enabled && cfg[audience].enabled;
    const required = round1(rawRequired[audience] * (live ? scale : 1));
    const rate = round1((per[audience].found / divisor) * UNIT_MINUTES);
    const ready = readyCounts[i];
    const threshold = Math.max(1, cfg[audience].threshold);
    const perMinute = required / UNIT_MINUTES;
    const coverMinutes = live && perMinute > 0 ? Math.round(ready / perMinute) : null;
    const ratePerMinute = rate / UNIT_MINUTES;
    const etaMinutes =
      ready >= threshold ? 0 : ratePerMinute > 0 ? Math.round((threshold - ready) / ratePerMinute) : null;
    lanes.push({
      audience,
      live,
      rate,
      required,
      ratio: required > 0 ? Math.round((rate / required) * 100) / 100 : 0,
      status: warming ? "idle" : verdict(live ? required : 0, rate, coverMinutes),
      found: per[audience].found,
      ready,
      threshold,
      coverMinutes,
      etaMinutes,
      series: per[audience].series,
    });
  });

  // The headline is about the lanes that are CONSUMING. A partner lane that is
  // switched off cannot help feed the customer lane, so its leads must not be
  // allowed to make the total look healthy. With no lane live at all there is
  // no demand to judge, and the number is simply reported.
  const live = lanes.filter((l) => l.live);
  const counted = live.length ? live : lanes;
  const rate = round1(counted.reduce((n, l) => n + l.rate, 0));
  const required = round1(live.reduce((n, l) => n + l.required, 0));
  const cover = live.length
    ? live.reduce((n, l) => Math.min(n, l.coverMinutes ?? Infinity), Infinity)
    : null;
  const status = warming ? "idle" : verdict(required, rate, cover === Infinity ? null : cover);

  return {
    lanes,
    rate,
    required,
    ratio: required > 0 ? Math.round((rate / required) * 100) / 100 : 0,
    status,
    unitMinutes: UNIT_MINUTES,
    windowMinutes,
    coveredMinutes: Math.round(coveredMinutes),
    bucketMinutes,
    warming,
    reason:
      status === "ok" || status === "idle"
        ? null
        : await shortfallReason(sinceIso, counted.reduce((n, l) => n + l.found, 0)),
    cappedByDaily,
    measuredAt: new Date(endMs).toISOString(),
  };
}

/**
 * ok       keeping up
 * slow     behind — worth knowing, not worth panicking about
 * starved  well behind AND nearly out of banked leads
 * idle     nothing is consuming the pool, so there is nothing to fall behind
 *
 * The two bands exist because the first live reading was 8.0 against a target
 * of 8.3 and turned the card red. Being 4% under target over a three-hour
 * window is measurement noise — one directory page landing a minute either side
 * of the boundary moves it further than that — and a light that goes red for
 * noise is a light nobody looks at. Red is reserved for genuinely running out:
 * under 60% of demand with less than half a day of leads on hand.
 */
const OK_RATIO = 0.95;
const STARVED_RATIO = 0.6;

function verdict(required: number, rate: number, coverMinutes: number | null): FillStatus {
  if (required <= 0) return "idle";
  const ratio = rate / required;
  if (ratio >= OK_RATIO) return "ok";
  if (ratio >= STARVED_RATIO) return "slow";
  if (coverMinutes !== null && coverMinutes >= COVER_OK_MINUTES) return "slow";
  return "starved";
}

/**
 * How many minutes of the window we may honestly divide by.
 *
 * Two things shorten it, and both would otherwise report a false collapse:
 * a pool younger than the window (a fresh install), and a bot that was switched
 * on part-way through it. Time the bot spent switched off is not time it failed
 * to find anything — it is time it was not asked to.
 */
async function measurableMinutes(windowMinutes: number, endMs: number): Promise<number> {
  const [poolRow, botOn, botOnAt] = await Promise.all([
    q(`SELECT min(created_at) AS t FROM discovered_leads`),
    getSetting("discovery_enabled"),
    getSetting("discovery_enabled_at"),
  ]);
  const anchors: number[] = [];
  const first = Date.parse(String(poolRow[0]?.t || ""));
  anchors.push(Number.isFinite(first) ? first : endMs);
  if (botOn === "1" && botOnAt) {
    const on = Date.parse(String(botOnAt));
    if (Number.isFinite(on)) anchors.push(on);
  }
  const from = Math.max(...anchors);
  return Math.max(0, Math.min(windowMinutes, (endMs - from) / 60_000));
}

/**
 * Why nothing is coming in.
 *
 * Ordered by how much it explains: a bot that is off explains everything, and
 * saying "8 leads short" without saying "because the bot is off" is a puzzle
 * rather than a warning. The last check separates the two completely different
 * failures that look identical from the outside — no leads at all (a discovery
 * problem) versus plenty of leads and no addresses (a crawler problem).
 */
async function shortfallReason(sinceIso: string, found: number): Promise<string | null> {
  if ((await getSetting("discovery_enabled")) !== "1") return "the discovery bot is switched off";

  const row = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n,
            CAST(sum(CASE WHEN barren_runs >= ? THEN 1 ELSE 0 END) AS INTEGER) AS dry
       FROM discovery_sources WHERE enabled=1 AND archived=0`,
    [STALE_AFTER_RUNS]
  ))[0] || {};
  const active = Number(row.n) || 0;
  const dry = Number(row.dry) || 0;
  if (!active) return "no sources are switched on";
  if (dry >= active) return active === 1 ? "its only live source has run dry" : "every live source has run dry";

  // Nothing emailable came out, but companies DID come in: that is a crawler
  // problem (walls, no reader key), not a discovery one, and the two have
  // completely different fixes while looking identical from the outside.
  if (found === 0) {
    const arrived = Number(
      (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE created_at >= ?`, [sinceIso]))[0]?.n
    ) || 0;
    if (arrived > 0) return `${arrived.toLocaleString()} companies arrived, none with an email`;
  }
  if (dry) return `${dry} of the ${active} live sources have run dry`;
  return "the live sources aren't turning up enough new companies";
}
