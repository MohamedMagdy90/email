// The crawler's shared HTTP floor.
//
// Everything that can put bytes on the wire — a plain fetch, the Jina reader,
// an archive, a paid proxy — goes through `rawFetch` here. It lives in its own
// module so the individual transports (fetcher.ts, archives.ts) can all build
// on it without importing each other in a cycle.

export const MAX_BYTES = 3_000_000; // 3 MB per page

/** How a page was obtained. Reported on every result, and counted. */
export type Via = "direct" | "proxy" | "reader" | "archive" | "commoncrawl";

export type BlockReason = "cloudflare" | "rate-limited" | "forbidden" | "blocked";

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string; // final URL after redirects (the TARGET url, even when proxied)
  html: string;
  contentType: string;
  error?: string;
  blocked?: boolean; // refused by bot protection (not a normal 404/5xx)
  blockReason?: BlockReason;
  via?: Via;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- fingerprint ----------------------------- */

// A single hard-coded User-Agent is itself a fingerprint: every request from
// this app looked identical, which is one of the cheapest things for a WAF to
// rule on. Rotating over a handful of current, real desktop browsers costs
// nothing and measurably reduces plain 403s.
export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
];

export const pickUserAgent = (n?: number) =>
  USER_AGENTS[(n == null ? Math.floor(Math.random() * USER_AGENTS.length) : n) % USER_AGENTS.length];

/**
 * The header set a real browser actually sends.
 *
 * The old crawler sent a UA and three headers. Plenty of "bot protection" is
 * nothing more than a check for the client hints and Sec-Fetch-* headers that
 * every Chrome request carries — so filling them in turns a share of hard 403s
 * into ordinary 200s, for free, before any paid tier is involved.
 */
export function browserHeaders(ua = pickUserAgent(), referer?: string): Record<string, string> {
  const chrome = ua.includes("Chrome/");
  const h: Record<string, string> = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "cross-site" : "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
  };
  if (chrome) {
    const v = ua.match(/Chrome\/(\d+)/)?.[1] || "122";
    h["sec-ch-ua"] = `"Chromium";v="${v}", "Not(A:Brand";v="24", "Google Chrome";v="${v}"`;
    h["sec-ch-ua-mobile"] = "?0";
    h["sec-ch-ua-platform"] = ua.includes("Macintosh") ? '"macOS"' : '"Windows"';
  }
  if (referer) h.Referer = referer;
  return h;
}

/* ------------------------------ counters ------------------------------- */

// Which transport is actually doing the work. This is the number that answers
// "are we still paying Jina for most of the crawl?" — without it the reader's
// share was pure guesswork.
export interface TransportStat { calls: number; ok: number }
const transportStats = new Map<Via, TransportStat>();

export function noteTransport(via: Via, ok: boolean): void {
  const s = transportStats.get(via) || { calls: 0, ok: 0 };
  s.calls++;
  if (ok) s.ok++;
  transportStats.set(via, s);
}

export function getTransportStats(): Record<Via, TransportStat> {
  const out = {} as Record<Via, TransportStat>;
  for (const via of ["direct", "commoncrawl", "archive", "reader", "proxy"] as Via[]) {
    out[via] = transportStats.get(via) || { calls: 0, ok: 0 };
  }
  return out;
}

export function resetTransportStats(): void {
  transportStats.clear();
}

/* --------------------------- block detection --------------------------- */

// Recognise the common bot-walls from a response's headers + body snippet so we
// can tell the user *why* a site couldn't be crawled instead of a bare "403".
export function detectBlock(status: number, headers: Headers, bodySnippet: string): BlockReason | undefined {
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
export function bodyIsChallenge(html: string): boolean {
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

/* ------------------------------- rawFetch ------------------------------ */

export interface RawFetchOptions {
  timeoutMs: number;
  headers: Record<string, string>;
  /** Report this URL in the result (proxy/archive fetches report the TARGET). */
  reportUrl?: string;
  via?: Via;
  /** Skip challenge detection — an archive's own error page is not a site block. */
  trustBody?: boolean;
  /**
   * Accept any content type.
   *
   * The page gate exists to skip binaries mid-crawl, but index APIs answer with
   * types it has never heard of — Common Crawl's CDX server returns
   * `text/x-ndjson`, which the gate rejected as "non-html". That silently made
   * every Common Crawl lookup look like a failure, backed the whole source off,
   * and cost us the single largest free corpus we have.
   */
  anyContentType?: boolean;
}

// Low-level fetch with timeout + streaming size cap.
export async function rawFetch(fetchUrl: string, opts: RawFetchOptions): Promise<FetchResult> {
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
      noteTransport(via, false);
      return { ok: false, status: res.status, url: finalUrl, html: "", contentType, blocked: !!blockReason, blockReason, via };
    }

    // Only parse HTML/XML/text; skip binaries (PDFs, images, etc.)
    if (contentType && !/(text\/html|application\/xhtml|text\/plain|application\/xml|\+xml|application\/json)/i.test(contentType) && !opts.anyContentType) {
      noteTransport(via, false);
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
    if (!opts.trustBody && bodyIsChallenge(html)) {
      const reason: BlockReason = /cloudflare|turnstile|cf[-_]chl/i.test(html) ? "cloudflare" : "blocked";
      noteTransport(via, false);
      return { ok: false, status: 403, url: finalUrl, html: "", contentType, blocked: true, blockReason: reason, via };
    }

    noteTransport(via, true);
    return { ok: true, status: res.status, url: finalUrl, html, contentType, via };
  } catch (e: any) {
    const isTimeout = e?.name === "AbortError";
    noteTransport(via, false);
    return {
      ok: false, status: 0, url: opts.reportUrl || fetchUrl, html: "", contentType: "",
      error: isTimeout ? "timeout" : String(e?.message || e), via,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch raw BYTES (no text decoding, no size cap games).
 *
 * Common Crawl hands back a gzipped byte range of a WARC file, which has to be
 * inflated before any of it is text — so it can't go through `rawFetch`.
 */
export async function rawBytes(
  url: string,
  opts: { timeoutMs: number; headers: Record<string, string>; maxBytes?: number }
): Promise<{ ok: boolean; status: number; bytes: Uint8Array; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: opts.headers, redirect: "follow" });
    if (res.status !== 200 && res.status !== 206) {
      return { ok: false, status: res.status, bytes: new Uint8Array(0), error: `HTTP ${res.status}` };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const cap = opts.maxBytes ?? MAX_BYTES;
    return { ok: true, status: res.status, bytes: buf.length > cap ? buf.subarray(0, cap) : buf };
  } catch (e: any) {
    return {
      ok: false, status: 0, bytes: new Uint8Array(0),
      error: e?.name === "AbortError" ? "timeout" : String(e?.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}
