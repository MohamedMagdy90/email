// Step 5 — the decision maker and a candidate address. People come from the
// company research; if none fit, Gemini search may name one (we never fetch
// linkedin.com ourselves). The address comes from findEmail() (published first,
// then name patterns). Role addresses only when the sending policy allows them.
import { llm } from "../llm";
import { findEmail, splitName } from "../verify";
import { isRole } from "../../crawler/validate";
import type { ResearchJson, Row } from "./types";

const DEFAULT_TITLES = [
  "owner", "founder", "co-founder", "ceo", "chief executive", "managing director", "general manager", "managing partner", "partner",
  "cfo", "chief financial", "finance director", "finance manager", "coo", "operations director", "operations manager",
  "it manager", "it director", "cto", "director",
];

export function titleRank(title: string, priorities: string[]): number {
  const t = String(title || "").toLowerCase();
  if (!t) return 999;
  const list = [...priorities.map((p) => p.toLowerCase()), ...DEFAULT_TITLES];
  for (let i = 0; i < list.length; i++) {
    const p = list[i].trim();
    if (!p) continue;
    if (p.length <= 3 ? new RegExp(`\\b${p}\\b`).test(t) : t.includes(p)) return i;
  }
  return 999;
}

export type PersonFilter = (title: string) => { ok: boolean; reason?: string };

export function pickPerson(people: ResearchJson["people"], titles: string[], allow?: PersonFilter) {
  const ranked = people
    .filter((p) => p.name && p.name.split(/\s+/).length >= 2)
    .filter((p) => !allow || allow(p.title).ok)
    .map((p) => ({ p, rank: titleRank(p.title, titles) }))
    .filter((x) => x.rank < 999)
    .sort((a, b) => a.rank - b.rank);
  return ranked[0]?.p || null;
}

async function personFromSearch(company: Row, titles: string[]): Promise<{ name: string; title: string; linkedin: string | null } | null> {
  const want = (titles.length ? titles : ["CEO", "Managing Director", "General Manager", "Owner"]).slice(0, 4).join(" OR ");
  const r = await llm<any>({
    tier: "smart",
    search: true,
    json: true,
    task: `campaign:person:${company.domain}`,
    temperature: 0.1,
    system: "You identify the right person to contact at a company using public search results (company website, news, LinkedIn search results). If you are not confident, say so. Never guess a name.",
    prompt: [
      `Company: ${company.name || company.domain} (${company.domain})${company.country ? `, ${company.country}` : ""}.`,
      `Who currently holds one of these roles: ${want}? A search like site:linkedin.com/in "${company.name || company.domain}" (${want}) may help.`,
      'Return JSON: {"name": string|null, "title": string|null, "linkedinUrl": string|null (a linkedin.com/in/ profile URL if one appeared in the results), "confident": boolean}',
    ].join("\n"),
  });
  const d = r.data || {};
  if (!d.confident || typeof d.name !== "string" || d.name.trim().split(/\s+/).length < 2) return null;
  const linkedin = typeof d.linkedinUrl === "string" && /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^\s/]+/i.test(d.linkedinUrl) ? d.linkedinUrl.slice(0, 300) : null;
  return { name: d.name.trim().slice(0, 100), title: String(d.title || "").trim().slice(0, 120), linkedin };
}

function emailMatchesPerson(email: string, fullName: string): boolean {
  const local = email.split("@")[0].toLowerCase();
  const { first, last } = splitName(fullName);
  return (!!first && first.length >= 3 && local.includes(first.toLowerCase())) || (!!last && last.length >= 3 && local.includes(last.toLowerCase()));
}

export interface ContactResult {
  ok: boolean;
  reason: string;
  hold?: boolean; // keep in place and retry later (not a skip)
  person?: { fullName: string; first: string; last: string; title: string; linkedin: string | null };
  email?: string;
  emailSource?: "published" | "pattern" | "role";
  emailStatus?: string;
}

/** AI errors from the search step propagate (the pass stops AI work). */
export async function findContact(
  company: Row,
  research: ResearchJson,
  titles: string[],
  opts: { canSearch: boolean; aiOk: boolean; allowRole: boolean; allowPerson?: PersonFilter }
): Promise<ContactResult> {
  const domain = String(company.domain);
  let person = pickPerson(research.people, titles, opts.allowPerson);
  let linkedin: string | null = person?.linkedin || null;
  let viaSearch = false;
  if (!person && opts.canSearch && opts.aiOk) {
    const found = await personFromSearch(company, titles);
    if (found && opts.allowPerson && !opts.allowPerson(found.title).ok) {
      // Search named someone the targeting rules out (e.g. HR, or below manager level).
    } else if (found) {
      person = { name: found.name, title: found.title, email: null, linkedin: found.linkedin };
      linkedin = found.linkedin;
      viaSearch = true;
    }
  }
  const domainEmails = research.emailsOnSite.filter((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));
  if (person) {
    const published = person.email || domainEmails.find((e) => !isRole(e) && emailMatchesPerson(e, person!.name)) || null;
    const known = research.people.filter((p) => p.email).map((p) => ({ email: String(p.email), name: p.name }));
    for (const e of domainEmails) if (!isRole(e) && !known.some((k) => k.email === e)) known.push({ email: e, name: "" });
    const found = await findEmail({ fullName: person.name, domain, publishedEmail: published, knownPeopleEmails: known });
    const { first, last } = splitName(person.name);
    const p = { fullName: person.name, first, last, title: person.title, linkedin };
    if (found.email) {
      return {
        ok: true,
        reason: `${person.name}${person.title ? `, ${person.title}` : ""}${viaSearch ? " (found by search)" : ""} at ${found.email} (${found.source === "published" ? "published on the site" : "name pattern"})`,
        person: p,
        email: found.email,
        emailSource: found.source === "published" ? "published" : "pattern",
        emailStatus: found.status,
      };
    }
    if (opts.allowRole) {
      const role = domainEmails.find((e) => isRole(e));
      if (role) return { ok: true, reason: `Couldn't work out ${person.name}'s address, using ${role} (role addresses are allowed)`, person: p, email: role, emailSource: "role", emailStatus: "unknown" };
    }
    return { ok: false, reason: `Found ${person.name}${person.title ? ` (${person.title})` : ""}, but no working address for them at ${domain}` };
  }
  if (opts.allowRole) {
    const role = domainEmails.find((e) => isRole(e));
    if (role) return { ok: true, reason: `No named decision maker, using ${role} (role addresses are allowed)`, email: role, emailSource: "role", emailStatus: "unknown" };
  }
  if (!opts.canSearch || !opts.aiOk) {
    return { ok: false, hold: true, reason: research.people.length ? "None of the people on the site has a decision-maker title. A Gemini key would let the agent look them up." : "No people named on the site. A Gemini key would let the agent look up the decision maker." };
  }
  return { ok: false, reason: "No decision maker found on the site or in search results" };
}
