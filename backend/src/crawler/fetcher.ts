// The crawler's transport ladder.
//
// Every fetch escalates through tiers, cheapest first, and stops at the first
// one that returns a real page:
//
//   1. direct         free, unlimited      — a plain browser-shaped request
//   2. Common Crawl   free, unlimited      — someone already crawled it
//   3. Wayback        free, rate-limited   — someone already archived it
//   4. Jina reader    PAID (token budget)  — renders JS, solves soft walls
//   5. scraping proxy PAID (per request)   — residential IPs, solves hard walls
//
// The order matters more than anything else in this file. The reader used to be
// tier 2, so it absorbed essentially every blocked fetch in the system and the
// Jina keys kept hitting HTTP 402. Both archives answer the same question — "what
// does this page say?" — for nothing, and between them they cover the large
// majority of the sites that wall a datacenter IP. The reader is now what you
// fall back to when the free corpora genuinely don't have the page.

import {
  rawFetch, browserHeaders, pickUserAgent, sleep,
  getTransportStats, resetTransportStats,
  type FetchResult, type BlockReason, type Via, type TransportStat,
} from "./http";
import { fetchViaArchives, fetchViaCommonCrawl, fetchViaWayback, archivedPagesFor, archiveHealth, type ArchivedPage } from "./archives";

// Re-exported so the rest of the app keeps importing everything from ./fetcher.
export type { FetchResult, BlockReason, Via, TransportStat, ArchivedPage };
export {
  fetchViaArchives, fetchViaCommonCrawl, fetchViaWayback, archivedPagesFor, archiveHealth,
  getTransportStats, resetTransportStats,
};

const PROXY_TIMEOUT_MS = 70_000; // JS rendering + antibot solving can be slow

/* ── Free-reader rate limiter ─────────────────────────────────────────────
 * The Jina reader (r.jina.ai) renders JavaScript and gets past soft walls, but
 * WITHOUT an API key it allows only ~20 requests/minute, and WITH one it spends
 * tokens you have to pay for. We SERIALIZE reader reservations so calls are
 * spaced under the limit: 429 storms become an orderly queue. Only the slot
 * reservation is serialized — the actual network fetch still runs concurrently
 * the moment a slot is granted.
 */
const READER_RPM_NOKEY = Math.max(1, Number(process.env.READER_RPM) || 15); // < 20/min free cap
const READER_RPM_KEYED = Math.max(1, Number(process.env.READER_RPM_KEYED) || 120);
let readerReserveChain: Promise<void> = Promise.resolve();
let readerNextSlotAt = 0;

async function reserveReaderSlot(keyed: boolean): Promise<void> {
  const minGapMs = Math.ceil(60_000 / (keyed ? READER_RPM_KEYED : READER_RPM_NOKEY));
  const wait = readerReserveChain.then(async () => {
    const now = Date.now();
    const at = Math.max(now, readerNextSlotAt);
    readerNextSlotAt = at + minGapMs;
    const delay = at - now;
    if (delay > 0) await sleep(delay);
  });
  readerReserveChain = wait.catch(() => {});
  return wait;
}

/* ── Reader key pool ───────────────────────────────────────────────────────
 * A Jina key that is out of tokens (401/402) is WORSE than no key: every call
 * fails, and we pace at the keyed 120/min as if it worked. Production lost
 * hours to exactly that — the key died mid-run, throughput fell to the free
 * 15/min, and the UI still displayed "Jina key active · 120 pages/min".
 *
 * So: accept a LIST of keys (comma/whitespace separated). Each is tracked
 * independently — one running dry rotates to the next instead of dropping the
 * whole crawler to the free tier. A rejected key is re-tested periodically in
 * case it was topped up.
 */
const READER_KEY_RECHECK_MS = 30 * 60_000;

interface KeyState { rejectedAt: number; status: number }
const keyState = new Map<string, KeyState>();
let keyCursor = 0;

/** Split a settings value / env var into individual keys. */
export function parseReaderKeys(raw: string): string[] {
  return [...new Set(String(raw || "").split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean))];
}

function keyIsUsable(key: string): boolean {
  const st = keyState.get(key);
  if (!st) return true;
  if (Date.now() - st.rejectedAt > READER_KEY_RECHECK_MS) {
    keyState.delete(key); // give a topped-up key another chance
    return true;
  }
  return false;
}

/** Next usable key from the pool, round-robin, or "" when all are spent. */
function nextUsableKey(keys: string[]): string {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(keyCursor + i) % keys.length];
    if (keyIsUsable(k)) {
      keyCursor = (keyCursor + i + 1) % keys.length;
      return k;
    }
  }
  return "";
}

function markKeyRejected(key: string, status: number): void {
  if (!key || keyState.has(key)) return;
  keyState.set(key, { rejectedAt: Date.now(), status });
}

/**
 * A short, non-secret fingerprint for a key, so the UI can list and delete
 * individual keys without ever displaying one in full.
 * "jina_1a2b3c4d5e6f7g8h" → "jina_1a2…7g8h"
 */
export function maskReaderKey(key: string): string {
  const k = String(key || "").trim();
  if (k.length <= 12) return k.replace(/.(?=.{3})/g, "•");
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

/** Per-key health, for the Settings list. Never returns the key itself. */
export function readerKeyHealth(keys: string[]): { masked: string; live: boolean; status: number }[] {
  return keys.map((k) => ({
    masked: maskReaderKey(k),
    live: keyIsUsable(k),
    status: keyState.get(k)?.status ?? 0,
  }));
}

// Reader health, surfaced in the Discovery UI so the operator knows when the
// free tier is saturated and it's time to add a free key or a scraping proxy.
let readerCalls = 0;
let readerSaved = 0;
let reader429s = 0;
let reader429At = 0;
let readerKeysConfigured = 0;

/** A page a free tier served that would otherwise have cost a reader call. */
export function noteReaderSaved(): void { readerSaved++; }

export interface ReaderStats {
  calls: number;
  /** Blocked pages the FREE tiers rescued — i.e. reader calls not made. */
  saved: number;
  rateLimited: number;
  lastRateLimitedAt: string | null;
  keysConfigured: number;
  keysLive: number;
  /** True only when keys ARE configured and every one of them is spent. */
  keyRejected: boolean;
  keyRejectedStatus: number;
}

/**
 * Reader health.
 *
 * Pass the CONFIGURED keys (from Settings) so the answer is correct even before
 * the first reader call — otherwise a freshly booted server reports "no keys"
 * while several are sitting in the database.
 */
export function getReaderStats(configuredKeys?: string[]): ReaderStats {
  const keys = configuredKeys ?? [];
  const configured = keys.length || readerKeysConfigured;
  let status = 0;
  let rejected = 0;
  for (const k of keys) {
    if (keyIsUsable(k)) continue;
    rejected++;
    status = keyState.get(k)?.status ?? status;
  }
  // No list supplied (internal callers): fall back to whatever the last reader
  // call observed.
  if (!keys.length) {
    for (const [k, st] of keyState) {
      if (keyIsUsable(k)) continue;
      rejected++;
      status = st.status;
    }
  }
  const keysLive = Math.max(0, configured - rejected);
  return {
    calls: readerCalls,
    saved: readerSaved,
    rateLimited: reader429s,
    lastRateLimitedAt: reader429At ? new Date(reader429At).toISOString() : null,
    keysConfigured: configured,
    keysLive,
    keyRejected: configured > 0 && keysLive === 0,
    keyRejectedStatus: status,
  };
}

export type ScrapeProvider = "scrapingbee" | "scraperapi" | "zenrows";

export interface ProxyConfig {
  provider: ScrapeProvider;
  apiKey: string;
  mode: "blocked" | "always"; // retry only blocked pages, or route everything
  renderJs?: boolean; // default true
  premium?: boolean; // premium/stealth proxy — needed for Cloudflare (default true)
}

// Build the provider request URL that wraps a target URL. All three providers
// follow the same "?key=…&url=…&render=…" GET shape.
export function buildProxyUrl(cfg: ProxyConfig, target: string): string {
  const url = encodeURIComponent(target);
  const key = encodeURIComponent(cfg.apiKey);
  const render = cfg.renderJs !== false;
  const premium = cfg.premium !== false;
  switch (cfg.provider) {
    case "scrapingbee":
      return `https://app.scrapingbee.com/api/v1/?api_key=${key}&url=${url}&render_js=${render}${premium ? "&stealth_proxy=true" : ""}`;
    case "scraperapi":
      return `https://api.scraperapi.com/?api_key=${key}&url=${url}&render=${render}${premium ? "&ultra_premium=true" : ""}`;
    case "zenrows":
      return `https://api.zenrows.com/v1/?apikey=${key}&url=${url}&js_render=${render}${premium ? "&premium_proxy=true" : ""}`;
    default:
      return target;
  }
}

/** A plain, browser-shaped request. Free and unlimited — always tier one. */
export async function fetchPage(url: string, timeoutMs = 15000, attempt = 0): Promise<FetchResult> {
  return rawFetch(url, {
    timeoutMs,
    // Rotate the fingerprint between attempts: a site that refuses one browser
    // profile often serves another, and this costs nothing to try.
    headers: browserHeaders(pickUserAgent(attempt), attempt > 0 ? "https://www.google.com/" : undefined),
  });
}

// Fetch a target THROUGH the configured scraping proxy (renders JS, rotates IPs).
export async function fetchViaProxy(target: string, cfg: ProxyConfig, timeoutMs = PROXY_TIMEOUT_MS): Promise<FetchResult> {
  const r = await rawFetch(buildProxyUrl(cfg, target), {
    timeoutMs,
    headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    reportUrl: target,
    via: "proxy",
  });
  // Distinguish a proxy-account problem (bad key / out of credits) from a site block.
  if (!r.ok && !r.blocked && (r.status === 401 || r.status === 403 || r.status === 402 || r.status === 429)) {
    r.error = `proxy ${r.status}` + (r.status === 401 ? " (check API key)" : r.status === 402 || r.status === 429 ? " (out of credits / rate limited)" : "");
  }
  return r;
}

// ── Jina Reader (https://r.jina.ai) ────────────────────────────────────────
// Fetches a URL, RENDERS JavaScript, and returns clean HTML, so JS-heavy and
// soft-walled sites become crawlable. Keys are metered and cost money, which is
// exactly why this now sits BELOW the free archives in the ladder.
const READER_TIMEOUT_MS = 45_000;
const READER_ENABLED = process.env.DISABLE_READER !== "1";
const READER_KEY = process.env.JINA_API_KEY || "";

export async function fetchViaReader(target: string, timeoutMs = READER_TIMEOUT_MS, apiKey?: string): Promise<FetchResult> {
  const keys = parseReaderKeys(apiKey || READER_KEY);
  readerKeysConfigured = keys.length;

  const call = async (withKey: string): Promise<FetchResult> => {
    await reserveReaderSlot(!!withKey); // pace calls under the rate limit (queue, don't 429)
    readerCalls++;
    const headers: Record<string, string> = {
      "X-Return-Format": "html", // give us HTML so the existing extractors work
      "X-Timeout": "30", // tell Jina to cap its own render time
      Accept: "text/html,*/*;q=0.8",
    };
    if (withKey) headers.Authorization = `Bearer ${withKey}`;
    return rawFetch(`https://r.jina.ai/${target}`, { timeoutMs, headers, reportUrl: target, via: "reader" });
  };

  // Walk the key pool. 401 = bad key, 402 = out of tokens; either way that key
  // is dead weight, so retire it and try the NEXT one rather than dropping the
  // whole crawler to the free tier. Only when every key is spent do we fall
  // back keyless — which still serves ~20/min and is far better than failing.
  let r: FetchResult | null = null;
  for (let i = 0; i <= keys.length; i++) {
    const key = nextUsableKey(keys);
    r = await call(key);
    if (!key) break;                                   // already on the free tier
    if (r.ok || (r.status !== 401 && r.status !== 402)) break;
    markKeyRejected(key, r.status);
    const live = getReaderStats().keysLive;
    console.warn(
      `[reader] Jina key ${i + 1}/${keys.length} rejected (HTTP ${r.status}${r.status === 402 ? " — out of tokens" : " — invalid"}). ` +
        (live > 0
          ? `Rotating to the next key (${live} still live).`
          : `No keys left — falling back to the free tier (~${READER_RPM_NOKEY}/min). The free archives still run, so crawling continues.`)
    );
  }

  if (r && !r.ok && (r.status === 401 || r.status === 402 || r.status === 429)) {
    if (r.status === 429) { reader429s++; reader429At = Date.now(); }
    r.error = `reader ${r.status}` + (r.status === 429 ? " (free rate limit)" : "");
  }
  return r as FetchResult;
}

/* ------------------------------ the ladder ----------------------------- */

export async function fetchWithRetry(
  url: string,
  tries = 2,
  timeoutMs = 15000,
  proxy?: ProxyConfig,
  readerKey?: string,
  allowReader = true,
  allowArchive = true
): Promise<FetchResult> {
  // "always" mode: route every request through the proxy (with one transient retry).
  if (proxy && proxy.mode === "always") {
    let p = await fetchViaProxy(url, proxy);
    if (!p.ok && (p.status === 0 || p.status === 429 || p.status >= 500)) {
      await sleep(800);
      p = await fetchViaProxy(url, proxy);
    }
    return p;
  }

  // Tier 1 — direct, with a fresh browser fingerprint on each attempt.
  let last: FetchResult | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetchPage(url, timeoutMs, i);
    if (r.ok) return r;
    last = r;
    const transient = r.status === 0 || r.status === 429 || r.status >= 500;
    if (!transient) break;
    await sleep(400 * (i + 1));
  }

  // A wall, or a site we simply couldn't reach. Both are cases where somebody
  // else's copy of the page is just as good as ours — and free.
  const worthArchiving = !!last && (last.blocked || last.status === 0);
  if (!last || !worthArchiving) return last as FetchResult;

  // Tier 2 + 3 — the free archives. Unmetered, so they go first; `allowArchive`
  // only exists so a caller can keep a long crawl from spending seconds per page
  // on snapshots of pages that hold no address anyway.
  if (allowArchive) {
    const arc = await fetchViaArchives(url).catch(() => null);
    if (arc?.ok && arc.html) {
      noteReaderSaved();
      return arc;
    }
  }

  // Tier 4 — the paid reader. Only now, and only when the caller says this page
  // is worth a token.
  if (READER_ENABLED && allowReader) {
    const rd = await fetchViaReader(url, READER_TIMEOUT_MS, readerKey).catch(() => null);
    if (rd?.ok && rd.html) return rd;
  }

  // Tier 5 — the paid proxy.
  if (proxy) {
    const p = await fetchViaProxy(url, proxy);
    if (p.ok) return p;
    return last.blocked ? last : p; // keep original block info if the proxy also failed
  }

  return last;
}
