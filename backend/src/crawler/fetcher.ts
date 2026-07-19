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
  via?: "direct" | "proxy"; // how the page was fetched
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

// Does a 200 body actually look like an unsolved challenge page? (Happens when a
// proxy renders without a strong enough antibot mode.)
function bodyIsChallenge(html: string): boolean {
  if (html.length > 30_000) return false;
  const b = html.toLowerCase();
  return /just a moment|challenge-platform|cf[-_]chl|turnstile/.test(b) && /enable javascript|cloudflare|checking your browser/.test(b);
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
  opts: { timeoutMs: number; headers: Record<string, string>; reportUrl?: string; via?: "direct" | "proxy" }
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

    // A proxy can return 200 with an unsolved challenge page — treat as blocked.
    if (via === "proxy" && bodyIsChallenge(html)) {
      return { ok: false, status: 403, url: finalUrl, html: "", contentType, blocked: true, blockReason: "cloudflare", via };
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

export async function fetchWithRetry(url: string, tries = 2, timeoutMs = 15000, proxy?: ProxyConfig): Promise<FetchResult> {
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

  // …and if a bot-wall blocked us and a proxy is configured, retry through it.
  if (proxy && last && last.blocked) {
    const p = await fetchViaProxy(url, proxy);
    if (p.ok) return p;
    // Keep the original block info if the proxy also couldn't get through.
    return last.blocked ? last : p;
  }
  return last as FetchResult;
}
