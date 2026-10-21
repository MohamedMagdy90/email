// Reading company websites for the lead engine: fetch (direct, with the free
// reader / proxy fallback), turn pages into prompt-sized text, pick the right
// internal pages, detect the site language.
import { fetchWithRetry } from "../../crawler/fetcher";
import { getProxyConfig, getReaderKey } from "../../config";
import { extractLinks, hostOf, registrableDomain } from "../../crawler/urls";

export interface Page {
  ok: boolean;
  url: string;
  html: string;
  text: string;
  blocked: boolean;
  error?: string;
}

export function toUrl(input: string): string {
  const s = String(input || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
}

/** Visible text: drop scripts/styles/nav noise, decode a few entities, collapse whitespace. */
export function pageText(html: string, max = 6000): string {
  return String(html || "")
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // markdown images (reader output)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links -> text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export async function fetchPage(url: string, maxText = 6000): Promise<Page> {
  const target = toUrl(url);
  if (!target) return { ok: false, url, html: "", text: "", blocked: false, error: "No URL" };
  try {
    const r = await fetchWithRetry(target, 2, 15000, await getProxyConfig(), await getReaderKey());
    const html = r.ok ? r.html || "" : "";
    return { ok: r.ok && !!html, url: r.url || target, html, text: pageText(html, maxText), blocked: !!r.blocked, error: r.ok ? undefined : r.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, url: target, html: "", text: "", blocked: false, error: String(e?.message || e) };
  }
}

/** Internal links whose URL or anchor matches one of the patterns, best first. */
export function pickLinks(html: string, base: string, patterns: RegExp[], max: number): string[] {
  const baseDomain = (() => {
    try {
      return registrableDomain(hostOf(base));
    } catch {
      return "";
    }
  })();
  const links = new Set<string>();
  try {
    for (const l of extractLinks(html, base)) links.add(l);
  } catch {
    /* ignore */
  }
  // Reader output is markdown: [text](url)
  for (const m of String(html).matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) links.add(m[1]);
  const scored: { url: string; score: number }[] = [];
  for (const raw of links) {
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (baseDomain && registrableDomain(u.hostname) !== baseDomain) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4)$/i.test(u.pathname)) continue;
    const path = decodeURIComponent(u.pathname + u.search).toLowerCase();
    if (path === "/" || path === "") continue;
    let score = 0;
    patterns.forEach((p, i) => {
      if (p.test(path)) score += 10 - Math.min(i, 9);
    });
    if (score > 0) scored.push({ url: `${u.protocol}//${u.host}${u.pathname}`, score: score - path.split("/").length * 0.1 });
  }
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.url.replace(/\/$/, ""))
    .filter((u) => (seen.has(u) ? false : (seen.add(u), true)))
    .slice(0, max);
}

export function titleOf(html: string): string {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || String(html).match(/^Title:\s*(.+)$/m);
  return m ? pageText(m[1], 200) : "";
}

export function metaDescription(html: string): string {
  const m =
    String(html).match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    String(html).match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
    String(html).match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  return m ? pageText(m[1], 400) : "";
}

/** Company name from a page title: "Acme Trading | Home" -> "Acme Trading". */
export function nameFromTitle(title: string, domain: string): string {
  const parts = title
    .split(/\s[|\-–—:·•]\s|\s\|\s?/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(home|homepage|welcome|main|index|الرئيسية)$/i.test(s));
  const best = parts.sort((a, b) => a.length - b.length).find((s) => s.length >= 3 && s.length <= 60);
  if (best) return best;
  const label = domain.split(".")[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function detectLanguage(text: string): "en" | "ar" | "mixed" {
  const sample = String(text).slice(0, 4000);
  const ar = (sample.match(/[\u0600-\u06FF]/g) || []).length;
  const lat = (sample.match(/[A-Za-z]/g) || []).length;
  if (ar + lat === 0) return "en";
  const share = ar / (ar + lat);
  return share > 0.7 ? "ar" : share > 0.2 ? "mixed" : "en";
}

export function phoneFrom(html: string): string | null {
  const m = String(html).match(/href=["']tel:([+\d][\d\s().-]{6,20})["']/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}
