// Email verification + finder.
//
// Two layers:
//   1. Built-in (runs anywhere, free): syntax, MX lookup, disposable domain,
//      role address, free-mail provider. Catches the obviously dead, so the
//      paid layer is never spent on them.
//   2. No2Bounce (hosted, 1 credit per check): asks the recipient's mail
//      server whether the mailbox exists and whether the domain is catch-all.
//      Async API: POST the address, get a tracking ID, poll for the result.
//      API token in Agent → Connections (setting no2bounce_api_key) or the
//      NO2BOUNCE_API_KEY env var.
//
// Results are cached in email_verifications for 30 days, so an address is
// only ever paid for once a month.
import { q, getSetting, nowIso } from "../db";
import { isValidEmail, isRole, hasMx } from "../crawler/validate";
import { parseJson } from "./events";

export type VerifyStatus = "valid" | "invalid" | "risky" | "catch_all" | "unknown";

export interface VerifyResult {
  email: string;
  status: VerifyStatus;
  source: "builtin" | "no2bounce" | "cache";
  reasons: string[];
  checks: {
    syntax: boolean;
    mx: boolean;
    disposable: boolean;
    role: boolean;
    free: boolean;
    smtp?: "deliverable" | "undeliverable" | "catch_all" | "unknown";
  };
}

const CACHE_DAYS = 30;

const DISPOSABLE = new Set(
  "mailinator.com guerrillamail.com 10minutemail.com tempmail.com temp-mail.org yopmail.com trashmail.com getnada.com sharklasers.com throwawaymail.com maildrop.cc dispostable.com fakeinbox.com mintemail.com mohmal.com emailondeck.com tempail.com burnermail.io spamgourmet.com mailnesia.com mytemp.email tempr.email discard.email 33mail.com moakt.com tmail.ws inboxkitten.com".split(
    " "
  )
);
const FREE = new Set(
  "gmail.com googlemail.com yahoo.com yahoo.co.uk ymail.com hotmail.com outlook.com live.com msn.com icloud.com me.com aol.com protonmail.com proton.me gmx.com gmx.net yandex.com yandex.ru mail.ru zohomail.com".split(
    " "
  )
);
/** gmail.com, outlook.com … — a personal address says nothing about the company. */
export const isFreeMailDomain = (domain: string) => FREE.has(String(domain || "").toLowerCase());

/* ------------------------------ No2Bounce ------------------------------ */

const N2B_BASE = "https://connect.no2bounce.com/v2";

export async function getNo2BounceKey(): Promise<string> {
  return ((await getSetting("no2bounce_api_key")) || process.env.NO2BOUNCE_API_KEY || "").trim();
}

/** Is a paid mailbox verifier connected? (Guessed addresses depend on it.) */
export async function verifierConfigured(): Promise<boolean> {
  return !!(await getNo2BounceKey());
}

type N2bVerdict = "valid" | "invalid" | "catch_all" | "disposable" | "risky" | "unknown";
// ok = No2Bounce gave an answer (verdict/raw/score set); otherwise `error` says why not.
type N2bOutcome = { ok: boolean; verdict?: N2bVerdict; raw?: string; score?: number | null; error?: string };

// ~84 s in all before giving up for this pass. N2B_POLL_SCALE shrinks it in tests.
const N2B_POLL_SCALE = Number(process.env.N2B_POLL_SCALE) > 0 ? Number(process.env.N2B_POLL_SCALE) : 1;
const N2B_POLL_MS = [1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 15000].map((ms) => ms * N2B_POLL_SCALE);
// A check in flight is remembered, so a retry after a timeout polls the same
// tracking ID instead of paying for the address a second time.
const pending = new Map<string, { trackingId: string; at: number }>();
const PENDING_TTL_MS = 6 * 3600_000;

async function n2bFetch(key: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N2B_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apitoken: key, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const isKeyError = (msg: string) => /api key is invalid|invalid or expired|invalid api token|unauthori[sz]ed/i.test(msg);

/** Map No2Bounce's scoreStatus ("Valid", "Invalid", "Catch-All", "Disposable", "Unknown") to ours. */
function n2bVerdict(raw: string): N2bVerdict {
  const s = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (!s) return "unknown";
  if (s.includes("catchall") || s.includes("acceptall")) return "catch_all";
  if (s.includes("disposable")) return "disposable";
  if (s.includes("undeliverable") || s.includes("invalid") || s.includes("bounce") || s.includes("spamtrap")) return "invalid";
  if (s.includes("risky")) return "risky";
  if (s === "valid" || s.includes("deliverable") || s === "safe") return "valid";
  return "unknown";
}

/** Verify one address with No2Bounce: submit, then poll the tracking ID. */
async function no2bounceCheck(email: string, key: string): Promise<N2bOutcome> {
  try {
    let entry = pending.get(email);
    if (entry && Date.now() - entry.at > PENDING_TTL_MS) {
      pending.delete(email);
      entry = undefined;
    }
    if (!entry) {
      const sub = await n2bFetch(key, "/n2b_validate_email", { method: "POST", body: JSON.stringify({ email }) });
      const trackingId = sub.body?.data?.trackingId;
      if (sub.status !== 200 || !trackingId) {
        const msg = String(sub.body?.message || `HTTP ${sub.status}`);
        return { ok: false, error: isKeyError(msg) ? "No2Bounce rejected the API token" : `No2Bounce: ${msg}` };
      }
      entry = { trackingId: String(trackingId), at: Date.now() };
      pending.set(email, entry);
    }
    for (const wait of N2B_POLL_MS) {
      await new Promise((r) => setTimeout(r, wait));
      const got = await n2bFetch(key, `/n2b_validate_email?trackingId=${encodeURIComponent(entry.trackingId)}`);
      if (got.status === 404) continue; // not indexed yet
      if (got.status !== 200) {
        const msg = String(got.body?.message || `HTTP ${got.status}`);
        if (isKeyError(msg)) {
          pending.delete(email);
          return { ok: false, error: "No2Bounce rejected the API token" };
        }
        continue;
      }
      const b = got.body?.data && !got.body?.result ? got.body.data : got.body;
      const raw = String(b?.result?.scoreStatus || "").trim();
      const done = String(b?.overallStatus || "").toLowerCase() === "completed";
      if (raw || done) {
        pending.delete(email);
        const score = Number(b?.result?.score);
        return { ok: true, verdict: n2bVerdict(raw), raw: raw || "no status", score: Number.isFinite(score) ? score : null };
      }
    }
    return { ok: false, error: "No2Bounce is still checking this address; it is picked up on the next pass" };
  } catch (e: any) {
    return { ok: false, error: `No2Bounce unreachable (${String(e?.message || e)})` };
  }
}

/**
 * Validate a token without spending a credit. The token endpoint answers 200
 * for a good token; a lookup of a made-up tracking ID tells a bad token
 * ("invalid or expired") apart from a good one ("not found").
 */
export async function testNo2Bounce(keyOverride?: string): Promise<{ ok: boolean; error?: string }> {
  const key = (keyOverride || "").trim() || (await getNo2BounceKey());
  if (!key) return { ok: false, error: "No API token saved" };
  try {
    const tok = await n2bFetch(key, "/n2b_validate_token");
    if (tok.status === 200) return { ok: true };
    const probe = await n2bFetch(key, `/n2b_validate_email?trackingId=00000000-0000-0000-0000-000000000000`);
    const msg = String(probe.body?.message || tok.body?.message || "");
    if (probe.status === 401 || isKeyError(msg)) return { ok: false, error: "No2Bounce rejected this token (invalid, expired, or this server's IP is not on the token's allow-list)" };
    if (probe.status >= 500) return { ok: false, error: `No2Bounce had a server error: ${msg || probe.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Could not reach No2Bounce (${String(e?.message || e)})` };
  }
}

async function readCache(email: string): Promise<VerifyResult | null> {
  const r = await q(`SELECT status, source, detail_json, checked_at FROM email_verifications WHERE email = ?`, [email]);
  if (!r[0]) return null;
  const age = Date.now() - new Date(String(r[0].checked_at)).getTime();
  if (age > CACHE_DAYS * 86400_000) return null;
  const detail = parseJson<VerifyResult | null>(r[0].detail_json, null);
  if (!detail) return null;
  // Saved before any verifier was connected ("unknown" from the built-in
  // checks alone): now that one is, give the address a real check.
  const unverified =
    detail.source === "builtin" && detail.status !== "invalid" && (detail.reasons || []).some((x) => /no (smtp|email) verifier/i.test(x));
  if (unverified && (await verifierConfigured())) return null;
  return { ...detail, source: "cache" };
}

async function writeCache(res: VerifyResult) {
  try {
    await q(
      `INSERT INTO email_verifications (email, status, source, detail_json, checked_at) VALUES (?,?,?,?,?)
       ON CONFLICT (email) DO UPDATE SET status = ?, source = ?, detail_json = ?, checked_at = ?`,
      [res.email, res.status, res.source, JSON.stringify(res), nowIso(), res.status, res.source, JSON.stringify(res), nowIso()]
    );
  } catch {
    /* cache is best-effort */
  }
}

export async function verifyEmail(raw: string, opts: { noCache?: boolean } = {}): Promise<VerifyResult> {
  const email = String(raw || "").trim().toLowerCase();
  if (!opts.noCache) {
    const cached = await readCache(email);
    if (cached) return cached;
  }
  const domain = email.split("@")[1] || "";
  const checks: VerifyResult["checks"] = {
    syntax: isValidEmail(email),
    mx: false,
    disposable: DISPOSABLE.has(domain),
    role: isRole(email),
    free: FREE.has(domain),
  };
  const reasons: string[] = [];
  const done = async (status: VerifyStatus, source: VerifyResult["source"], cache = true) => {
    const res: VerifyResult = { email, status, source, reasons, checks };
    if (cache) await writeCache(res);
    return res;
  };

  if (!checks.syntax) {
    reasons.push("bad syntax");
    return done("invalid", "builtin");
  }
  if (checks.disposable) {
    reasons.push("disposable domain");
    return done("invalid", "builtin");
  }
  checks.mx = await hasMx(domain);
  if (!checks.mx) {
    reasons.push("domain has no mail server");
    return done("invalid", "builtin");
  }
  if (checks.role) reasons.push("role address (info@, sales@ …)");
  if (checks.free) reasons.push("free mail provider");

  const key = await getNo2BounceKey();
  if (key) {
    const r = await no2bounceCheck(email, key);
    if (r.ok) {
      if (r.verdict === "catch_all") {
        checks.smtp = "catch_all";
        reasons.push("domain accepts every address (catch-all)");
        return done("catch_all", "no2bounce");
      }
      if (r.verdict === "valid") {
        checks.smtp = "deliverable";
        return done(checks.role ? "risky" : "valid", "no2bounce");
      }
      if (r.verdict === "invalid") {
        checks.smtp = "undeliverable";
        reasons.push("mailbox does not exist");
        return done("invalid", "no2bounce");
      }
      if (r.verdict === "disposable") {
        checks.smtp = "undeliverable";
        checks.disposable = true;
        reasons.push("disposable address");
        return done("invalid", "no2bounce");
      }
      if (r.verdict === "risky") {
        checks.smtp = "unknown";
        reasons.push(`verifier rated it risky (${r.raw})`);
        return done("risky", "no2bounce");
      }
      checks.smtp = "unknown";
      reasons.push(r.raw && r.raw !== "Unknown" ? `mail server would not say (${r.raw})` : "mail server would not say");
      // Fall through: a real answer of "unknown" is worth caching.
    } else {
      // Not an answer (bad token, out of credits, still checking): don't
      // remember it, so the next pass asks again.
      checks.smtp = "unknown";
      reasons.push(r.error || "verifier unavailable");
      return done(checks.role ? "risky" : "unknown", "builtin", false);
    }
  } else {
    reasons.push("no email verifier connected");
  }
  // Built-in only: the address CAN receive mail, but we can't prove the mailbox.
  return done(checks.role ? "risky" : "unknown", key ? "no2bounce" : "builtin");
}

/* ----------------------------- email finder ----------------------------- */

function ascii(s: string): string {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .trim();
}

/** Split a display name into first/last, dropping honorifics and Arabic particles. */
export function splitName(full: string): { first: string; last: string } {
  const parts = ascii(full)
    .split(/\s+/)
    .filter((p) => p && !/^(mr|mrs|ms|dr|eng|engr|sheikh|shaikh|prof|hh|he)$/.test(p));
  if (!parts.length) return { first: "", last: "" };
  const first = parts[0];
  // "al", "el", "bin", "abu" belong to the surname: "Khalid Al Mansour" -> almansour
  let lastParts = parts.slice(1);
  if (lastParts.length > 1 && /^(al|el|bin|ibn|abu|abd|bou)$/.test(lastParts[lastParts.length - 2])) {
    lastParts = lastParts.slice(-2);
  } else {
    lastParts = lastParts.slice(-1);
  }
  return { first, last: lastParts.join("").replace(/-/g, "") };
}

type Pattern = (f: string, l: string) => string;
const PATTERNS: Record<string, Pattern> = {
  "first.last": (f, l) => `${f}.${l}`,
  first: (f) => f,
  firstlast: (f, l) => `${f}${l}`,
  "f.last": (f, l) => `${f[0]}.${l}`,
  flast: (f, l) => `${f[0]}${l}`,
  first_last: (f, l) => `${f}_${l}`,
  "first.l": (f, l) => `${f}.${l[0]}`,
  firstl: (f, l) => `${f}${l[0]}`,
  last: (_f, l) => l,
  "last.first": (f, l) => `${l}.${f}`,
};

/** Infer the company's address pattern from published person emails. */
export function inferPattern(known: { email: string; name?: string }[]): string | null {
  for (const k of known) {
    if (!k.name || !k.email.includes("@")) continue;
    const local = k.email.split("@")[0].toLowerCase();
    const { first, last } = splitName(k.name);
    if (!first) continue;
    for (const [name, fn] of Object.entries(PATTERNS)) {
      if ((name.includes("l") && !last) || !first) continue;
      try {
        if (fn(first, last) === local) return name;
      } catch {
        /* missing initial */
      }
    }
  }
  return null;
}

export function candidateEmails(fullName: string, domain: string, preferred?: string | null): string[] {
  const { first, last } = splitName(fullName);
  if (!first || !domain) return [];
  const order = [
    ...(preferred && PATTERNS[preferred] ? [preferred] : []),
    "first.last",
    "first",
    "firstlast",
    "f.last",
    "flast",
    "first_last",
    "firstl",
    "last",
  ];
  const out: string[] = [];
  for (const p of order) {
    if (!last && p !== "first") continue;
    const local = PATTERNS[p](first, last);
    const e = `${local}@${domain}`.toLowerCase();
    if (isValidEmail(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

export interface FoundEmail {
  email: string | null;
  status: VerifyStatus;
  source: "published" | "pattern" | "none";
  pattern?: string | null;
  tried: string[];
}

/**
 * Find a person's address at a company. Published addresses win; otherwise
 * try name patterns, verifying with No2Bounce when connected (1 credit per
 * pattern tried, stopping at the first hit or a catch-all domain).
 * Without a verifier the best guess comes back with status "unknown".
 */
export async function findEmail(input: {
  fullName: string;
  domain: string;
  publishedEmail?: string | null;
  knownPeopleEmails?: { email: string; name?: string }[];
  maxProbes?: number;
}): Promise<FoundEmail> {
  const tried: string[] = [];
  if (input.publishedEmail) {
    const v = await verifyEmail(input.publishedEmail);
    tried.push(input.publishedEmail);
    if (v.status !== "invalid") return { email: input.publishedEmail.toLowerCase(), status: v.status, source: "published", tried };
  }
  const pattern = inferPattern(input.knownPeopleEmails || []);
  const candidates = candidateEmails(input.fullName, input.domain, pattern);
  if (!candidates.length) return { email: null, status: "unknown", source: "none", pattern, tried };
  const hasSmtp = await verifierConfigured();
  if (!hasSmtp) {
    // Can't probe: the inferred pattern (if any) is our best evidence.
    return { email: candidates[0], status: "unknown", source: "pattern", pattern, tried: [candidates[0]] };
  }
  const max = Math.min(candidates.length, input.maxProbes ?? 5);
  for (let i = 0; i < max; i++) {
    const e = candidates[i];
    tried.push(e);
    const v = await verifyEmail(e);
    // The verifier gave no answer (out of credits, token rejected, still
    // checking): stop spending, keep the best guess; the verify step holds
    // it and asks again later instead of the person being dropped.
    if (v.source === "builtin" && v.status !== "invalid") return { email: candidates[0], status: "unknown", source: "pattern", pattern, tried };
    if (v.status === "valid") return { email: e, status: "valid", source: "pattern", pattern, tried };
    if (v.status === "catch_all") return { email: candidates[0], status: "catch_all", source: "pattern", pattern, tried };
    if (v.status === "invalid" && v.reasons.includes("domain has no mail server")) break;
  }
  return { email: null, status: "invalid", source: "none", pattern, tried };
}
