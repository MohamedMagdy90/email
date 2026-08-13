// Email cleaning, validation, junk filtering, role detection, and MX checks.

import { promises as dns } from "node:dns";

const ASSET_EXT =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|json|xml|map|mp4|webm|mov|mp3|wav|woff2?|ttf|eot|otf|pdf|zip|rar|gz|doc|docx|xls|xlsx|ppt|pptx)$/i;

// Common placeholder / demo addresses that appear in templates & docs.
const PLACEHOLDERS = new Set([
  "email@example.com", "you@example.com", "your@email.com", "name@example.com",
  "name@company.com", "email@domain.com", "user@example.com", "john@example.com",
  "john@doe.com", "jane@doe.com", "test@test.com", "example@example.com",
  "firstname.lastname@example.com", "hello@example.com", "email@yourdomain.com",
  "sample@email.com", "yourname@email.com", "info@example.com", "no-reply@example.com",
  "someone@example.com", "first.last@example.com", "abc@abc.com", "mail@example.com",
]);

// Placeholder LOCAL parts. Themes ship with these and the site owner never
// replaces them — "yoursite@mail.com" was filed as a real lead in production.
// Matched on the local part so any domain is covered, not just example.com.
const PLACEHOLDER_LOCAL =
  /^(?:your\s*(?:site|name|email|company|mail)|my(?:site|email|name)|username|user|firstname|lastname|first\.last|someone|somebody|anyone|sample|example|demo|dummy|placeholder|changeme|replaceme|enter[-_]?your[-_]?email|youremail|emailaddress)$/i;

// A local part that is really a mangled "mailto:" prefix the page glued on.
// Real production leak: "mailoinfo@dmxlogistics.ae" — the scheme survived the
// extractor with a character dropped, so the peel in cleanEmail() (which needs
// the colon) never fired. No legitimate inbox begins this way.
const MAILTO_ARTIFACT = /^(?:e?mail|mail)(?:t?o)(?=[a-z0-9])/i;

// Domains that are almost always tooling/asset noise, not real inboxes.
const JUNK_DOMAINS =
  /(^|\.)(example\.(com|org|net)|domain\.com|yourdomain\.com|email\.com|test\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|wix\.com|schema\.org|w3\.org|googleapis\.com|gstatic\.com|cloudflare\.com|jsdelivr\.net|unpkg\.com|gravatar\.com|sentry\.wixpress\.com|placeholder\.com|lorempixel\.com|2x|3x)$/i;

const ROLE_RE =
  /^(info|sales|contact|support|admin|hello|hi|team|office|enquir(y|ies)|inquir(y|ies)|marketing|hr|jobs|careers|recruit(ment)?|help|helpdesk|service|services|account|accounts|billing|finance|orders?|order|booking|bookings|reservation|reservations|general|mail|webmaster|no-?reply|do-?not-?reply|newsletter|press|media|partnership|partners?)@/i;

// Prefixes that pages glue onto an address and that RFC 5321 unfortunately
// tolerates inside a local part, so a naive syntax check waves them through:
//   <a href="mailto://info@x.com">   → "//info@x.com"
//   <a href="mailto:%20info@x.com">  → "%20info@x.com"
//   <a href="mailto:mailto:info@x">  → "mailto:info@x.com"
// All three were filed as real contacts and are unmailable.
const SCHEME_RE = /^(?:(?:mailto|e-?mail|mail|url|href|to)\s*:+|https?:\/\/|\/{1,}|\\+)\s*/i;
// Characters that can only be markup/URL glue, never part of a local part.
const LOCAL_CUT = /[\s/\\:<>"(){}\[\],;|@=#&?!*^~$]+/;
const DOMAIN_CUT = /[\s/\\?#:<>"'(){}\[\],;|]+/;

// Keep only the trailing run of address-legal characters ("//info" → "info").
function cleanLocal(local: string): string {
  let l = local;
  // Percent-encoded padding/newlines left behind by mailto: links.
  l = l.replace(/%[0-9a-f]{2}/gi, " ");
  // JS/JSON escapes that survived undecoded ("\u003einfo" → "3einfo").
  l = l.replace(/^(?:u00[0-9a-f]{2}|x[0-9a-f]{2})+/i, "");
  l = l.split(LOCAL_CUT).pop() || "";
  // A local part never opens or closes on punctuation.
  return l.replace(/^[^a-z0-9]+/i, "").replace(/[^a-z0-9]+$/i, "");
}

function cleanDomain(domain: string): string {
  let d = (domain.split(DOMAIN_CUT)[0] || "").replace(/%[0-9a-f]{2}[\s\S]*$/i, "");
  return d.replace(/^[^a-z0-9]+/i, "").replace(/[^a-z0-9]+$/i, "");
}

export function cleanEmail(raw: string): string | null {
  if (!raw) return null;
  let e = raw.trim().toLowerCase();
  // Peel repeated / malformed schemes ("mailto://", "mailto:mailto:").
  for (let i = 0; i < 4; i++) {
    const before = e;
    e = e.replace(SCHEME_RE, "").trim();
    if (e === before) break;
  }
  e = e.split("?")[0]; // drop mailto query params
  // strip zero-width & control chars
  e = e.replace(/[\u200b-\u200d\uFEFF]/g, "");
  e = e.replace(/^[<("'\s]+/, "");
  e = e.replace(/[)>.,;:'"\]\s]+$/g, "");
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  const local = cleanLocal(e.slice(0, at));
  const domain = cleanDomain(e.slice(at + 1));
  if (!local || !domain || !domain.includes(".")) return null;
  return `${local}@${domain}`;
}

export function isValidEmail(e: string): boolean {
  if (!e || e.length > 254) return false;
  // Deliberately stricter than RFC 5321: "/", "%", "!" and friends are legal in
  // a local part but in scraped text they only ever mean the address picked up
  // surrounding markup. Also force alphanumeric first/last characters.
  if (!/^[a-z0-9](?:[a-z0-9._+'-]*[a-z0-9])?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(e)) return false;
  const at = e.split("@");
  if (at.length !== 2) return false;
  const [local, domain] = at;
  if (!local || !domain) return false;
  if (local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  if (local.includes("..") || domain.includes("..")) return false;
  if (ASSET_EXT.test(e)) return false;
  const labels = domain.split(".");
  const tld = labels[labels.length - 1];
  if (!tld || tld.length < 2) return false;
  if (/^\d+$/.test(tld)) return false; // e.g. an IP-like tail
  return true;
}

export function isJunk(e: string): boolean {
  if (PLACEHOLDERS.has(e)) return true;
  const local = e.split("@")[0] || "";
  const domain = e.split("@")[1] || "";
  if (PLACEHOLDER_LOCAL.test(local)) return true; // yoursite@…, youremail@…
  if (MAILTO_ARTIFACT.test(local)) return true;   // mailoinfo@…, mailtoinfo@…
  if (JUNK_DOMAINS.test(domain)) return true;
  if (ASSET_EXT.test(e)) return true;
  if (/@\d+x$/.test(e)) return true; // retina asset leftovers like foo@2x
  if (/^[0-9a-f]{16,}@/.test(e)) return true; // hashed/generated locals
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-/.test(e)) return true; // uuid-like locals
  return false;
}

export function isRole(e: string): boolean {
  return ROLE_RE.test(e);
}

/* ------------------------- inbox preference ---------------------------- */
// A named individual outranks every shared inbox: a person reads their own
// mail and can reply, whereas info@ is a queue that may be triaged by nobody.
// Among the shared inboxes it still matters which one — a site exposing both
// info@ and hr@ must not be filed under hr@, and fujairahrefinery.ae must never
// be saved as "reportscam@". Lower rank wins.
const ROLE_TIERS: [RegExp, number][] = [
  [/^(?:info|sales|contact|enquir(?:y|ies)|inquir(?:y|ies)|hello|office|mail|general|business|marketing)@/i, 1],
  [/^(?:support|help|helpdesk|service|services|admin|team|reception|orders?|booking|bookings|reservations?)@/i, 2],
  [/^(?:accounts?|account|billing|finance|purchase|procurement|tender|tenders|projects?)@/i, 3],
  [/^(?:hr|jobs|careers?|recruit(?:ment)?|cv|apply|hiring)@/i, 4],
  [/^(?:press|media|newsletter|partnership|partners?|webmaster|postmaster|hostmaster|abuse|spam|phishing|reportscam|report|fraud|security|privacy|legal|dpo|unsubscribe|no-?reply|do-?not-?reply|bounce|mailer-daemon)@/i, 5],
];

// Does the local part read like a PERSON — "adil", "m.saleh", "mubarak.ahmed"?
// Letters and single separators only. The digit rule is what keeps the
// preference safe: "abdullahalmamun9145855@gmail.com" and "quantumcont14@" are
// not people, they're throwaway mailboxes, and promoting those above a
// company's info@ would be a clear downgrade.
const PERSON_LOCAL = /^[a-z]+(?:[._-][a-z]+)*$/i;

/**
 * How desirable an address is (0 = best).
 *
 *   0  a named individual          adil@, m.saleh@, prabal@
 *   1  primary shared inbox        info@, sales@, contact@
 *   2  service desk                support@, admin@, bookings@
 *   3  finance / unrecognised      accounts@, tender@, xyz123@
 *   4  recruitment                 hr@, careers@
 *   5  administrative / automated  webmaster@, abuse@, no-reply@
 */
export function roleRank(e: string): number {
  for (const [re, rank] of ROLE_TIERS) if (re.test(e)) return rank;
  const local = e.split("@")[0] || "";
  return local.length >= 3 && PERSON_LOCAL.test(local) ? 0 : 3;
}

const mxCache = new Map<string, boolean>();

// Verify the domain can actually receive mail (MX record, with an A/AAAA fallback).
export async function hasMx(domain: string): Promise<boolean> {
  const d = (domain || "").toLowerCase();
  if (!d) return false;
  if (mxCache.has(d)) return mxCache.get(d) as boolean;

  let ok = false;
  try {
    const mx = await dns.resolveMx(d);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch {
    ok = false;
  }
  if (!ok) {
    // Some domains accept mail on their A record even without MX.
    try {
      const a = await dns.resolve4(d);
      ok = a.length > 0;
    } catch {
      try {
        const aaaa = await dns.resolve6(d);
        ok = aaaa.length > 0;
      } catch {
        ok = false;
      }
    }
  }
  mxCache.set(d, ok);
  return ok;
}
