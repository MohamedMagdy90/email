// Shared runtime config assembled from Settings (with env fallbacks).
// Kept in its own module so both the HTTP layer (index.ts) and the always-on
// discovery bot (discovery.ts) build identical proxy/reader config without a
// circular import.

import { getSetting } from "./db";
import type { ProxyConfig, ScrapeProvider } from "./crawler/fetcher";

export const SCRAPE_PROVIDERS: ScrapeProvider[] = ["scrapingbee", "scraperapi", "zenrows"];

// Assemble the scraping-proxy config from settings, or undefined when disabled.
export async function getProxyConfig(): Promise<ProxyConfig | undefined> {
  const provider = (await getSetting("scrape_provider")) as ScrapeProvider | null;
  const apiKey = await getSetting("scrape_api_key");
  if (!provider || !SCRAPE_PROVIDERS.includes(provider) || !apiKey) return undefined;
  const mode = (await getSetting("scrape_mode")) === "always" ? "always" : "blocked";
  const premium = (await getSetting("scrape_premium")) !== "0"; // default ON (needed for Cloudflare)
  return { provider, apiKey, mode, premium, renderJs: true };
}

// Optional (free) Jina Reader key: raises the free rate limit. Prefer the value
// saved in Settings, then the Railway env var.
export async function getReaderKey(): Promise<string> {
  return ((await getSetting("jina_api_key")) || process.env.JINA_API_KEY || "").trim();
}
