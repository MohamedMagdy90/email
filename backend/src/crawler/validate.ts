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

// Domains that are almost always tooling/asset noise, not real inboxes.
const JUNK_DOMAINS =
  /(^|\.)(example\.(com|org|net)|domain\.com|yourdomain\.com|email\.com|test\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|wix\.com|schema\.org|w3\.org|googleapis\.com|gstatic\.com|cloudflare\.com|jsdelivr\.net|unpkg\.com|gravatar\.com|sentry\.wixpress\.com|placeholder\.com|lorempixel\.com|2x|3x)$/i;

const ROLE_RE =
  /^(info|sales|contact|support|admin|hello|hi|team|office|enquir(y|ies)|inquir(y|ies)|marketing|hr|jobs|careers|recruit(ment)?|help|helpdesk|service|services|account|accounts|billing|finance|orders?|order|booking|bookings|reservation|reservations|general|mail|webmaster|no-?reply|do-?not-?reply|newsletter|press|media|partnership|partners?)@/i;

export function cleanEmail(raw: string): string | null {
  if (!raw) return null;
  let e = raw.trim().toLowerCase();
  e = e.replace(/^mailto:/, "");
  e = e.split("?")[0]; // drop mailto query params
  e = e.replace(/^[<("'\s]+/, "");
  e = e.replace(/[)>.,;:'"\]\s]+$/g, "");
  // strip zero-width & control chars
  e = e.replace(/[\u200b-\u200d\uFEFF]/g, "");
  if (!e.includes("@")) return null;
  return e;
}

export function isValidEmail(e: string): boolean {
  if (!e || e.length > 254) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(e)) return false;
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
  const domain = e.split("@")[1] || "";
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
