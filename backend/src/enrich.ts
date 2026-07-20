// Turn a company NAME (from a parsed PDF row) into its official WEBSITE, by
// asking the existing keyword web-search and picking the result whose title /
// domain best matches the company name. Returns null when nothing is a
// confident match, so we never attach a random domain to a company.

import { searchCompanies } from "./search";
import { registrableDomain, hostOf } from "./crawler/urls";

// Legal suffixes / generic words that shouldn't count toward a name match.
const STOP = new Set([
  "the", "and", "for", "co", "company", "trading", "group", "est", "establishment",
  "llc", "wll", "w", "l", "ll", "ltd", "limited", "inc", "corporation", "corp",
  "services", "service", "international", "intl", "general", "contracting",
  "trad", "ind", "industries", "industrial", "enterprises", "enterprise",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

export interface ResolvedSite {
  website: string; // full URL (https://…/)
  domain: string; // registrable domain
}

export async function resolveWebsite(company: string, country: string): Promise<ResolvedSite | null> {
  const name = company.trim();
  if (!name) return null;

  let candidates;
  try {
    candidates = await searchCompanies(name, country || "", 5);
  } catch {
    return null; // search rate-limited / unavailable — treat as "not found"
  }
  if (!candidates.length) return null;

  const nameToks = tokens(name);
  let best: ResolvedSite | null = null;
  let bestScore = -1;

  for (const cnd of candidates) {
    if (!cnd.website) continue;
    const domain = registrableDomain(hostOf(cnd.website)) || "";
    if (!domain) continue;
    const domCore = domain.replace(/\.[a-z.]+$/i, "").toLowerCase();
    const titleToks = tokens(cnd.name || "");

    let score = 0;
    for (const t of nameToks) {
      if (domCore.includes(t)) score += 3; // domain match is the strongest signal
      if (titleToks.includes(t)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { website: cnd.website, domain };
    }
  }

  // Require at least one shared, meaningful token — otherwise it's a guess.
  if (!best || bestScore <= 0) return null;
  return best;
}
