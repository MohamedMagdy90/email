// Email verification + finder.
//
// Two layers:
//   1. Built-in (runs anywhere, free): syntax, MX lookup, disposable domain,
//      role address, free-mail provider. Catches the obviously dead.
//   2. Reacher (self-hosted, free, open source — reacherhq/backend): a real
//      SMTP RCPT probe that answers "does this mailbox exist" and "is the
//      domain catch-all". Needs a server with outbound port 25, which Railway
//      does not allow — so it runs on a small VPS and we call it over HTTP.
//
//   docker run -d -p 8080:8080 \
//     -e RCH__HTTP_HOST=0.0.0.0 -e RCH__HEADER_SECRET=<secret> \
//     -e RCH__FROM_EMAIL=verify@<a-spare-domain> -e RCH__HELLO_NAME=<a-spare-domain> \
//     reacherhq/backend:latest
//
// Results are cached in email_verifications for 30 days.
import { q, getSetting, nowIso } from "../db";
import { isValidEmail, isRole, hasMx } from "../crawler/validate";
import { parseJson } from "./events";

export type VerifyStatus = "valid" | "invalid" | "risky" | "catch_all" | "unknown";

export interface VerifyResult {
  email: string;
  status: VerifyStatus;
  source: "builtin" | "reacher" | "cache";
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

export async function getReacherConfig(): Promise<{ url: string; secret: string } | null> {
  const url = ((await getSetting("reacher_url")) || process.env.REACHER_URL || "").trim().replace(/\/+$/, "");
  if (!url) return null;
  const secret = ((await getSetting("reacher_secret")) || process.env.REACHER_SECRET || "").trim();
  return { url, secret };
}

async function readCache(email: string): Promise<VerifyResult | null> {
  const r = await q(`SELECT status, source, detail_json, checked_at FROM email_verifications WHERE email = ?`, [email]);
  if (!r[0]) return null;
  const age = Date.now() - new Date(String(r[0].checked_at)).getTime();
  if (age > CACHE_DAYS * 86400_000) return null;
  const detail = parseJson<VerifyResult | null>(r[0].detail_json, null);
  if (!detail) return null;
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

/** Call a self-hosted Reacher backend. Returns null if unreachable. */
async function reacherCheck(email: string, cfg: { url: string; secret: string }): Promise<any | null> {
  try {
    const res = await fetch(`${cfg.url}/v0/check_email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.secret ? { "x-reacher-secret": cfg.secret } : {}) },
      body: JSON.stringify({ to_email: email }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Is the Reacher server reachable and answering? */
export async function testReacher(
  /** Test these values instead of the saved ones (checked before saving). */
  override?: { url: string; secret?: string }
): Promise<{ ok: boolean; error?: string; sample?: string }> {
  const cfg = override?.url ? { url: override.url.trim().replace(/\/+$/, ""), secret: (override.secret || "").trim() } : await getReacherConfig();
  if (!cfg) return { ok: false, error: "No Reacher URL saved" };
  const r = await reacherCheck("postmaster@gmail.com", cfg);
  if (!r) return { ok: false, error: `Could not reach ${cfg.url}/v0/check_email (check the URL, secret and that the server is running)` };
  return { ok: true, sample: String(r.is_reachable || "unknown") };
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
  const done = async (status: VerifyStatus, source: VerifyResult["source"]) => {
    const res: VerifyResult = { email, status, source, reasons, checks };
    await writeCache(res);
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

  const cfg = await getReacherConfig();
  if (cfg) {
    const r = await reacherCheck(email, cfg);
    if (r) {
      const smtp = r.smtp || {};
      if (smtp.is_catch_all) {
        checks.smtp = "catch_all";
        reasons.push("domain accepts every address (catch-all)");
        return done("catch_all", "reacher");
      }
      if (r.is_reachable === "safe") {
        checks.smtp = "deliverable";
        return done(checks.role ? "risky" : "valid", "reacher");
      }
      if (r.is_reachable === "invalid") {
        checks.smtp = "undeliverable";
        reasons.push(smtp.is_disabled ? "mailbox disabled" : smtp.has_full_inbox ? "mailbox full" : "mailbox does not exist");
        return done("invalid", "reacher");
      }
      if (r.is_reachable === "risky") {
        checks.smtp = smtp.is_deliverable ? "deliverable" : "unknown";
        reasons.push("SMTP answer was ambiguous");
        return done("risky", "reacher");
      }
      checks.smtp = "unknown";
      reasons.push("SMTP server would not say");
    } else {
      reasons.push("verifier unreachable");
    }
  } else {
    reasons.push("no SMTP verifier configured");
  }
  // Built-in only: the address CAN receive mail, but we can't prove the mailbox.
  return done(checks.role ? "risky" : "unknown", "builtin");
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
 * try name patterns, verifying with Reacher when available.
 * Without Reacher the best guess comes back with status "unknown".
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
  const hasSmtp = !!(await getReacherConfig());
  if (!hasSmtp) {
    // Can't probe: the inferred pattern (if any) is our best evidence.
    return { email: candidates[0], status: "unknown", source: "pattern", pattern, tried: [candidates[0]] };
  }
  const max = Math.min(candidates.length, input.maxProbes ?? 5);
  for (let i = 0; i < max; i++) {
    const e = candidates[i];
    tried.push(e);
    const v = await verifyEmail(e);
    if (v.status === "valid") return { email: e, status: "valid", source: "pattern", pattern, tried };
    if (v.status === "catch_all") return { email: candidates[0], status: "catch_all", source: "pattern", pattern, tried };
    if (v.status === "invalid" && v.reasons.includes("domain has no mail server")) break;
  }
  return { email: null, status: "invalid", source: "none", pattern, tried };
}
