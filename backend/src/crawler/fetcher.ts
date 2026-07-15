// Robust HTTP fetching for the crawler.
// Handles: timeouts, retries with backoff, realistic browser headers,
// redirect following, non-HTML skipping, and a hard response-size cap.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const MAX_BYTES = 3_000_000; // 3 MB per page

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string; // final URL after redirects
  html: string;
  contentType: string;
  error?: string;
}

export async function fetchPage(url: string, timeoutMs = 15000): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    const contentType = res.headers.get("content-type") || "";
    const finalUrl = res.url || url;

    if (!res.ok) {
      return { ok: false, status: res.status, url: finalUrl, html: "", contentType };
    }

    // Only parse HTML/XML/text; skip binaries (PDFs, images, etc.)
    if (contentType && !/(text\/html|application\/xhtml|text\/plain|application\/xml|\+xml)/i.test(contentType)) {
      return { ok: false, status: res.status, url: finalUrl, html: "", contentType, error: "non-html" };
    }

    // Stream with a size cap so a huge file can't blow up memory.
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return { ok: true, status: res.status, url: finalUrl, html: text.slice(0, MAX_BYTES), contentType };
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        if (received > MAX_BYTES) {
          try { await reader.cancel(); } catch {}
          break;
        }
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
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return { ok: true, status: res.status, url: finalUrl, html, contentType };
  } catch (e: any) {
    const isTimeout = e?.name === "AbortError";
    return { ok: false, status: 0, url, html: "", contentType: "", error: isTimeout ? "timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithRetry(url: string, tries = 2, timeoutMs = 15000): Promise<FetchResult> {
  let last: FetchResult | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetchPage(url, timeoutMs);
    if (r.ok) return r;
    last = r;
    // Retry only transient failures (network error, 429, 5xx).
    const transient = r.status === 0 || r.status === 429 || r.status >= 500;
    if (!transient) break;
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  return last as FetchResult;
}
