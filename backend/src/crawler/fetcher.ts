// Robust HTTP fetching for the crawler.
// Handles: timeouts, retries with backoff, realistic browser headers,
// redirect following, non-HTML skipping, a hard response-size cap, bot-wall
// detection, and an OPTIONAL scraping proxy (ScrapingBee / ScraperAPI / ZenRows)
// that renders JavaScript so Cloudflare-protected sites become crawlable.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const MAX_BYTES = 3_000_000; // 3 MB per page
const PROXY_TIMEOUT_MS = 70_000; // JS rendering + antibot solving can be slow

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── Free-reader rate limiter ─────────────────────────────────────────────
 * The free Jina reader (r.jina.ai) is the crawler's only no-cost way past a
 * Cloudflare "Just a moment" wall — but WITHOUT an API key it allows only
 * ~20 requests/minute. At the discovery bot's scale that cap is hit constantly,
 * and every resulting 429 looks exactly like "this site has no email". We fix
 * that by SERIALIZING reader reservations so calls are spaced just under the
 * free limit (and much faster once a key raises it): 429 storms become an
 * orderly queue. Only the slot reservation is serialized — the actual network
 * fetch still runs concurrently the moment a slot is granted.
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
 * whole crawler to the free tier. Keys are free, so stacking two or three makes
 * exhaustion a non-event. A rejected key is re-tested periodically in case it
 * was topped up.
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

// Reader health, surfaced in the Discovery UI so the operator knows when the
// free tier is saturated and it's time to add a free key or a scraping proxy.
let readerCalls = 0;
let reader429s = 0;
let reader429At = 0;
let readerKeysConfigured = 0;

export interface ReaderStats {
  calls: number;
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
    rateLimited: reader429s,
    lastRateLimitedAt: reader429At ? new Date(reader429At).toISOString() : null,
    keysConfigured: configured,
    keysLive,
    keyRejected: configured > 0 && keysLive === 0,
    keyRejectedStatus: status,
  };
}

export type BlockReason = "cloudflare" | "rate-limited" | "forbidden" | "blocked";

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string; // final URL after redirects (the TARGET url, even when proxied)
  html: string;
  contentType: string;
  error?: string;
  blocked?: boolean; // request was refused by bot protection (not a normal 404/5xx)
  blockReason?: BlockReason;
  via?: "direct" | "proxy" | "reader" | "archive"; // how the page was fetched
}

export type ScrapeProvider = "scrapingbee" | "scraperapi" | "zenrows";

export interface ProxyConfig {
  provider: ScrapeProvider;
  apiKey: string;
  mode: "blocked" | "always"; // retry only blocked pages, or route everything
  renderJs?: boolean; // default true
  premium?: boolean; // premium/stealth proxy — needed for Cloudflare (default true)
}

// Recognise the common bot-walls from a response's headers + body snippet so we
// can tell the user *why* a site couldn't be crawled instead of a bare "403".
function detectBlock(status: number, headers: Headers, bodySnippet: string): BlockReason | undefined {
  const server = (headers.get("server") || "").toLowerCase();
  const cfMitigated = (headers.get("cf-mitigated") || "").toLowerCase();
  const body = bodySnippet.toLowerCase();
  const looksCloudflare =
    server.includes("cloudflare") ||
    cfMitigated === "challenge" ||
    /just a moment|challenge-platform|cf[-_]chl|__cf_|turnstile|attention required|cloudflare/.test(body);
  const looksChallenge =
    /you have been blocked|access denied|are you a robot|verify you are human|captcha|please enable (?:js|javascript)/.test(body);
  if (status === 403 || status === 429 || status === 503) {
    if (looksCloudflare) return "cloudflare";
    if (status === 429) return "rate-limited";
    if (looksChallenge) return "blocked";
    return "forbidden";
  }
  return undefined;
}

// Does a 200 body actually look like an unsolved challenge page?
// Two flavours, both served with HTTP 200 so the status code tells us nothing:
//   • Cloudflare's "Just a moment…" interstitial (usually via an under-powered proxy)
//   • a bare reCAPTCHA/hCaptcha auto-submit page, which WAFs (Imperva, F5, Akamai)
//     return once you've asked for a few pages too quickly
// Both are tiny compared to a real page, so the size cap keeps false positives
// away from genuine pages that merely embed a captcha in a contact form.
function bodyIsChallenge(html: string): boolean {
  if (html.length > 30_000) return false;
  const b = html.toLowerCase();
  const cloudflare =
    /just a moment|challenge-platform|cf[-_]chl|turnstile/.test(b) &&
    /enable javascript|cloudflare|checking your browser/.test(b);
  const captchaWall =
    html.length < 10_000 &&
    /recaptcha|hcaptcha|captcha_form|g-recaptcha|are you a robot|verify you are human/.test(b);
  return cloudflare || captchaWall;
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

// Low-level fetch with timeout + streaming size cap. `reportUrl` overrides the
// URL reported in the result (proxy fetches report the TARGET, not the proxy).
async function rawFetch(
  fetchUrl: string,
  opts: { timeoutMs: number; headers: Record<string, string>; reportUrl?: string; via?: "direct" | "proxy" | "reader" | "archive" }
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const via = opts.via || "direct";
  try {
    const res = await fetch(fetchUrl, { redirect: "follow", signal: controller.signal, headers: opts.headers });
    const contentType = res.headers.get("content-type") || "";
    const finalUrl = opts.reportUrl || res.url || fetchUrl;

    if (!res.ok) {
      // Peek at a little of the body to recognise bot-protection interstitials.
      let snippet = "";
      try { snippet = (await res.text()).slice(0, 4000); } catch { /* ignore */ }
      const blockReason = detectBlock(res.status, res.headers, snippet);
      return { ok: false, status: res.status, url: finalUrl, html: "", contentType, blocked: !!blockReason, blockReason, via };
    }

    // Only parse HTML/XML/text; skip binaries (PDFs, images, etc.)
    if (contentType && !/(text\/html|application\/xhtml|text\/plain|application\/xml|\+xml|application\/json)/i.test(contentType)) {
      return { ok: false, status: res.status, url: finalUrl, html: "", contentType, error: "non-html", via };
    }

    // Stream with a size cap so a huge file can't blow up memory.
    const reader = res.body?.getReader();
    let html = "";
    if (!reader) {
      html = (await res.text()).slice(0, MAX_BYTES);
    } else {
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          if (received > MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
        }
      }
      const buf = new Uint8Array(Math.min(received, MAX_BYTES));
      let offset = 0;
      for (const c of chunks) {
        if (offset >= buf.length) break;
        const slice = c.subarray(0, Math.min(c.length, buf.length - offset));
        buf.set(slice, offset);
        offset += slice.length;
      }
      html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    }

    // A 200 can still be an unsolved challenge / captcha wall — treat as blocked
    // whichever transport served it, so the crawl reports WHY it went quiet
    // instead of silently recording an empty page.
    if (bodyIsChallenge(html)) {
      const reason: BlockReason = /cloudflare|turnstile|cf[-_]chl/i.test(html) ? "cloudflare" : "blocked";
      return { ok: false, status: 403, url: finalUrl, html: "", contentType, blocked: true, blockReason: reason, via };
    }

    return { ok: true, status: res.status, url: finalUrl, html, contentType, via };
  } catch (e: any) {
    const isTimeout = e?.name === "AbortError";
    return { ok: false, status: 0, url: opts.reportUrl || fetchUrl, html: "", contentType: "", error: isTimeout ? "timeout" : String(e?.message || e), via };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPage(url: string, timeoutMs = 15000): Promise<FetchResult> {
  return rawFetch(url, {
    timeoutMs,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    },
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

// ── Free reader fallback (Jina Reader, https://r.jina.ai) ──────────────────
// A no-key, free service that fetches a URL, RENDERS JavaScript, and returns
// clean HTML — so JS-heavy / Cloudflare-"soft"-blocked sites become crawlable
// WITHOUT a paid scraping proxy. Optional JINA keys (also free) raise the rate
// limit. It can't defeat hard LOGIN walls (Facebook/Instagram), but those are
// unreachable by paid proxies too.
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
          : `No keys left — falling back to the free tier (~${READER_RPM_NOKEY}/min). Top up or replace the keys in Settings → Crawler.`)
    );
  }

  if (r && !r.ok && (r.status === 401 || r.status === 402 || r.status === 429)) {
    if (r.status === 429) { reader429s++; reader429At = Date.now(); }
    r.error = `reader ${r.status}` + (r.status === 429 ? " (free rate limit — add a free JINA_API_KEY or a scraping proxy)" : "");
  }
  return r as FetchResult;
}

/* ── Free archive fallback (Wayback Machine) ───────────────────────────────
 * The strongest FREE way past a wall we cannot open.
 *
 * When a site answers Cloudflare's challenge to our datacenter IP, no amount of
 * retrying changes that — but Archive.org almost certainly holds a snapshot of
 * its contact page, and reading Archive.org is not reading the site, so there
 * is no challenge to solve. Unlimited, no key, no signup.
 *
 * "id_" is the raw-content modifier: it returns the ORIGINAL html exactly as
 * archived, without the Wayback toolbar/banner injected. That matters because
 * the toolbar carries archive.org's own addresses, which would otherwise be
 * extracted as if they belonged to the company.
 *
 * The obvious limitation: a snapshot can be old, so an address may be stale.
 * That is still strictly better than the alternative, which is nothing at all.
 */
const WAYBACK_ENABLED = process.env.DISABLE_WAYBACK !== "1";
const WAYBACK_TIMEOUT_MS = 25_000;

export async function fetchViaWayback(target: string, timeoutMs = WAYBACK_TIMEOUT_MS): Promise<FetchResult> {
  const clean = target.replace(/^https?:\/\//i, "");
  const r = await rawFetch(`https://web.archive.org/web/2id_/https://${clean}`, {
    timeoutMs,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
    reportUrl: target,
    via: "archive",
  });
  // Archive.org has no snapshot (404) or is rate-limiting us (429). Neither is
  // a property of the TARGET site, so never report it as a site block.
  if (!r.ok) {
    r.blocked = false;
    r.blockReason = undefined;
    r.error = r.status === 404 ? "no archived snapshot" : `archive ${r.status}`;
  }
  return r;
}

export async function fetchWithRetry(url: string, tries = 2, timeoutMs = 15000, proxy?: ProxyConfig, readerKey?: string, allowReader = true, allowArchive = true): Promise<FetchResult> {
  // "always" mode: route every request through the proxy (with one transient retry).
  if (proxy && proxy.mode === "always") {
    let p = await fetchViaProxy(url, proxy);
    if (!p.ok && (p.status === 0 || p.status === 429 || p.status >= 500)) {
      await sleep(800);
      p = await fetchViaProxy(url, proxy);
    }
    return p;
  }

  // Otherwise try direct first…
  let last: FetchResult | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetchPage(url, timeoutMs);
    if (r.ok) return r;
    last = r;
    const transient = r.status === 0 || r.status === 429 || r.status >= 500;
    if (!transient) break;
    await sleep(400 * (i + 1));
  }

  // …and if a bot-wall blocked us, escalate through the FREE tiers first and
  // only then the paid proxy, so the overwhelming majority of sites cost
  // nothing to crawl:
  //   1. Jina reader  — renders JS, defeats soft walls        (free, keyed pool)
  //   2. Wayback      — sidesteps the wall entirely           (free, unlimited)
  //   3. Scraping proxy — rotates residential IPs             (paid, optional)
  // The reader escalation is gated by `allowReader` so callers can spend the
  // scarce (rate-limited) reader budget only on their highest-value pages;
  // Wayback has no such ceiling, so it is always worth one attempt.
  if (last && last.blocked) {
    if (READER_ENABLED && allowReader) {
      const rd = await fetchViaReader(url, READER_TIMEOUT_MS, readerKey).catch(() => null);
      if (rd?.ok && rd.html) return rd;
    }
    if (WAYBACK_ENABLED && allowArchive) {
      const wb = await fetchViaWayback(url).catch(() => null);
      if (wb?.ok && wb.html) return wb;
    }
    if (proxy) {
      const p = await fetchViaProxy(url, proxy);
      if (p.ok) return p;
      return last.blocked ? last : p; // keep original block info if proxy also failed
    }
  }
  return last as FetchResult;
}
