// Step 5 — the decision maker and a candidate address. People come from the
// company research; if none fit, Gemini search may name one (we never fetch
// linkedin.com ourselves), then Anymail Finder's decision-maker lookup. The
// address comes from findEmail() (published first, then name patterns checked
// by No2Bounce); when that fails or can't be confirmed, Anymail Finder's person
// lookup is the last resort. Role addresses only when the sending policy allows them.
import { llm, LlmUnavailable } from "../llm";
import { findEmail, rememberFinderVerified, splitName } from "../verify";
import { categoriesForTitles, findDecisionMaker, findPersonEmail, type FinderOutcome } from "../finder";
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
  emailSource?: "published" | "pattern" | "role" | "finder";
  emailStatus?: string;
  /** Gemini refused to search: the caller stops person searches for this pass (the AI stays on). */
  searchFailed?: boolean;
  /** Anymail Finder couldn't be asked (cap reached, out of credits, key rejected …): the caller stops asking this pass. */
  finderUnavailable?: string;
  /** Anymail Finder credits this lead used. */
  finderCredits?: number;
}

type ContactOpts = {
  canSearch: boolean;
  aiOk: boolean;
  allowRole: boolean;
  allowPerson?: PersonFilter;
  /** Anymail Finder connected: the last resort after the site and our own guess. */
  finder?: boolean;
};

type ContactState = { searchFailed: boolean; finderUnavailable: string | null; finderCredits: number; finderTried: boolean };

/** Only the daily-budget error propagates; a refused search is reported as `searchFailed`. */
export async function findContact(company: Row, research: ResearchJson, titles: string[], opts: ContactOpts): Promise<ContactResult> {
  const state: ContactState = { searchFailed: false, finderUnavailable: null, finderCredits: 0, finderTried: false };
  const r = await findContactInner(company, research, titles, opts, state);
  const out: ContactResult = { ...r };
  if (state.searchFailed) out.searchFailed = true;
  if (state.finderUnavailable) out.finderUnavailable = state.finderUnavailable;
  if (state.finderCredits) out.finderCredits = state.finderCredits;
  return out;
}

/** Ask Anymail Finder, keeping count of credits and of "couldn't ask". */
async function askFinder(state: ContactState, run: () => Promise<FinderOutcome>): Promise<FinderOutcome> {
  state.finderTried = true;
  const r = await run();
  if (r.status === "found") state.finderCredits += r.credits;
  if (r.status === "unavailable") state.finderUnavailable = r.reason;
  return r;
}

const FINDER_HINT = "Anymail Finder (Agent → Connections) or web search (a Gemini key with billing on) would let the agent look";

async function findContactInner(company: Row, research: ResearchJson, titles: string[], opts: ContactOpts, state: ContactState): Promise<ContactResult> {
  const domain = String(company.domain);
  let person = pickPerson(research.people, titles, opts.allowPerson);
  let linkedin: string | null = person?.linkedin || null;
  let viaSearch = false;
  if (!person && opts.canSearch && opts.aiOk) {
    let found: Awaited<ReturnType<typeof personFromSearch>> = null;
    try {
      found = await personFromSearch(company, titles);
    } catch (e) {
      // Gemini refused to search: carry on without it (the AI stays on for the rest).
      if (!(e instanceof LlmUnavailable)) throw e;
      state.searchFailed = true;
    }
    if (found && opts.allowPerson && !opts.allowPerson(found.title).ok) {
      // Search named someone the targeting rules out (e.g. HR, or below manager level).
    } else if (found) {
      person = { name: found.name, title: found.title, email: null, linkedin: found.linkedin };
      linkedin = found.linkedin;
      viaSearch = true;
    }
  }
  const domainEmails = research.emailsOnSite.filter((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));

  // Nobody on the site or in search: ask Anymail Finder for the decision maker (2 credits, only when found).
  let finderNote = "";
  if (!person && opts.finder) {
    const dm = await askFinder(state, () => findDecisionMaker({ domain, categories: categoriesForTitles(titles) }));
    if (dm.status === "found") {
      const name = dm.fullName || [dm.firstName, dm.lastName].filter(Boolean).join(" ") || "";
      const title = dm.title || "";
      const allowed = !opts.allowPerson || !title ? { ok: true } : opts.allowPerson(title);
      if (allowed.ok) {
        await rememberFinderVerified(dm.email);
        const split = splitName(name);
        const first = dm.firstName || split.first;
        const last = dm.lastName || split.last;
        return {
          ok: true,
          reason: `${name || "A decision maker"}${title ? `, ${title}` : ""} at ${dm.email} (found by Anymail Finder)`,
          person: name ? { fullName: name, first, last, title, linkedin: dm.linkedin } : undefined,
          email: dm.email,
          emailSource: "finder",
          emailStatus: "valid",
        };
      }
      finderNote = ` Anymail Finder named ${name || "someone"}${title ? ` (${title})` : ""}, but ${allowed.reason || "the targeting rules them out"}.`;
    } else if (dm.status === "not_found") {
      finderNote = ` Anymail Finder had no decision maker for ${domain}.`;
    }
  }

  if (person) {
    const published = person.email || domainEmails.find((e) => !isRole(e) && emailMatchesPerson(e, person!.name)) || null;
    const known = research.people.filter((p) => p.email).map((p) => ({ email: String(p.email), name: p.name }));
    for (const e of domainEmails) if (!isRole(e) && !known.some((k) => k.email === e)) known.push({ email: e, name: "" });
    const found = await findEmail({ fullName: person.name, domain, publishedEmail: published, knownPeopleEmails: known });
    const { first, last } = splitName(person.name);
    const p = { fullName: person.name, first, last, title: person.title, linkedin };
    const who = `${person.name}${person.title ? `, ${person.title}` : ""}${viaSearch ? " (found by search)" : ""}`;
    // Published on the site, or a guess the verifier confirmed: done, no paid lookup.
    const confirmed = !!found.email && (found.source === "published" || found.status === "valid");
    if (confirmed) {
      return { ok: true, reason: `${who} at ${found.email} (${found.source === "published" ? "published on the site" : "name pattern"})`, person: p, email: found.email!, emailSource: found.source === "published" ? "published" : "pattern", emailStatus: found.status };
    }
    // Our guess failed or couldn't be confirmed (no verifier, catch-all domain): Anymail Finder (1 credit, only when found).
    if (opts.finder) {
      const r = await askFinder(state, () => findPersonEmail({ fullName: person!.name, domain, linkedinUrl: linkedin }));
      if (r.status === "found") {
        await rememberFinderVerified(r.email);
        return { ok: true, reason: `${who} at ${r.email} (found by Anymail Finder)`, person: p, email: r.email, emailSource: "finder", emailStatus: "valid" };
      }
      if (r.status === "not_found") finderNote = " Anymail Finder didn't find it either.";
    }
    if (found.email) {
      return { ok: true, reason: `${who} at ${found.email} (name pattern)${finderNote}`, person: p, email: found.email, emailSource: "pattern", emailStatus: found.status };
    }
    if (opts.allowRole) {
      const role = domainEmails.find((e) => isRole(e));
      if (role) return { ok: true, reason: `Couldn't work out ${person.name}'s address, using ${role} (role addresses are allowed)`, person: p, email: role, emailSource: "role", emailStatus: "unknown" };
    }
    // Anymail Finder couldn't be asked (cap, credits): wait and ask again rather than drop them.
    if (state.finderUnavailable) {
      return { ok: false, hold: true, reason: `Found ${who}, but no working address yet; Anymail Finder wasn't asked: ${state.finderUnavailable}. Tried again later.` };
    }
    return { ok: false, reason: `Found ${person.name}${person.title ? ` (${person.title})` : ""}, but no working address for them at ${domain}.${finderNote}`.replace(/\.\./g, ".") };
  }
  if (opts.allowRole) {
    const role = domainEmails.find((e) => isRole(e));
    if (role) return { ok: true, reason: `No named decision maker, using ${role} (role addresses are allowed)`, email: role, emailSource: "role", emailStatus: "unknown" };
  }
  const base = research.people.length ? "None of the people on the site has a decision-maker title." : "No people named on the site.";
  if (state.finderUnavailable) {
    return { ok: false, hold: true, reason: `${base} Anymail Finder wasn't asked: ${state.finderUnavailable}. Tried again later.` };
  }
  if (!opts.canSearch || !opts.aiOk || state.searchFailed) {
    if (state.finderTried) {
      return { ok: false, hold: true, reason: `${base}${finderNote} Web search (a Gemini key with billing on) would let the agent look further.` };
    }
    return { ok: false, hold: true, reason: research.people.length ? `${base} ${FINDER_HINT} them up.` : `${base} ${FINDER_HINT} up the decision maker.` };
  }
  return { ok: false, reason: `No decision maker found on the site or in search results.${finderNote}` };
}
