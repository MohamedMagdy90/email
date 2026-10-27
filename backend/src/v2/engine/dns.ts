// Domain setup for our own mailboxes: what DNS each provider needs, whether it
// is there, whether the website forwards to dna.systems, and how old the
// domain is (RDAP — the public, structured successor of WHOIS).
import dns from "node:dns/promises";
import { registrableDomain } from "../../crawler/urls";

export type DnsProvider = "google" | "microsoft" | "unknown";

export interface RecordCheck {
  ok: boolean;
  found: string[];
  indeterminate?: boolean;
  note?: string;
}

export interface DomainCheck {
  domain: string;
  provider: DnsProvider;
  mx: RecordCheck;
  spf: RecordCheck;
  dkim: RecordCheck;
  dmarc: RecordCheck;
  forward: { ok: boolean | null; finalUrl: string | null };
  allPass: boolean;
  indeterminate: string[];
  checkedAt: string;
}

export interface ExpectedRecord {
  key: "mx" | "spf" | "dkim" | "dmarc" | "forward";
  type: string;
  host: string;
  value: string;
  priority?: number;
  note?: string;
}

const MISSING = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ENOENT", "NOTFOUND", "ENONAME"]);

function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms))]);
}

async function txt(name: string): Promise<{ values: string[]; unsure: boolean }> {
  try {
    const r = await withTimeout(dns.resolveTxt(name));
    return { values: r.map((x) => x.join("")), unsure: false };
  } catch (e: any) {
    return { values: [], unsure: !MISSING.has(String(e?.code || "")) };
  }
}

async function mxOf(name: string): Promise<{ values: string[]; unsure: boolean }> {
  try {
    const r = await withTimeout(dns.resolveMx(name));
    return { values: r.sort((a, b) => a.priority - b.priority).map((x) => x.exchange.toLowerCase()), unsure: false };
  } catch (e: any) {
    return { values: [], unsure: !MISSING.has(String(e?.code || "")) };
  }
}

const MX_RE: Record<Exclude<DnsProvider, "unknown">, RegExp> = {
  google: /(^|\.)(google\.com|googlemail\.com)\.?$/i,
  microsoft: /(mail\.protection\.outlook\.com|mx\.microsoft)\.?$/i,
};
const SPF_INCLUDE: Record<Exclude<DnsProvider, "unknown">, string> = { google: "_spf.google.com", microsoft: "spf.protection.outlook.com" };

/** The records a domain needs for its provider, in the order to add them. */
export function expectedRecords(domain: string, provider: DnsProvider, reportTo?: string | null, websiteHost = "dna.systems"): ExpectedRecord[] {
  const d = domain.toLowerCase();
  const dmarc: ExpectedRecord = {
    key: "dmarc",
    type: "TXT",
    host: "_dmarc",
    value: `v=DMARC1; p=none;${reportTo ? ` rua=mailto:${reportTo};` : ""} adkim=r; aspf=r`,
    note: "Start with p=none. After 3–4 weeks of clean sending, change it to p=quarantine.",
  };
  const forward: ExpectedRecord = {
    key: "forward",
    type: "Redirect",
    host: d,
    value: `https://${websiteHost}`,
    note: "URL forwarding at the registrar (301). People who type the domain land on your real site.",
  };
  if (provider === "microsoft") {
    return [
      { key: "mx", type: "MX", host: "@", value: `${d.replace(/\./g, "-")}.mail.protection.outlook.com`, priority: 0, note: "Use the exact value Microsoft 365 shows under Settings → Domains." },
      { key: "spf", type: "TXT", host: "@", value: "v=spf1 include:spf.protection.outlook.com -all", note: "Only one SPF record per domain." },
      {
        key: "dkim",
        type: "CNAME",
        host: "selector1._domainkey  and  selector2._domainkey",
        value: "Copy both values from Microsoft Defender → Email & collaboration → Policies → Email authentication settings → DKIM",
        note: "Then switch DKIM signing on for the domain in the same screen.",
      },
      dmarc,
      forward,
    ];
  }
  return [
    { key: "mx", type: "MX", host: "@", value: "smtp.google.com", priority: 1 },
    { key: "spf", type: "TXT", host: "@", value: "v=spf1 include:_spf.google.com ~all", note: "Only one SPF record per domain." },
    {
      key: "dkim",
      type: "TXT",
      host: "google._domainkey",
      value: "Copy it from Google Admin → Apps → Google Workspace → Gmail → Authenticate email → Generate new record",
      note: "After adding it, press Start authentication in the same screen.",
    },
    dmarc,
    forward,
  ];
}

async function forwardOf(domain: string, websiteHost: string): Promise<DomainCheck["forward"]> {
  try {
    const res = await fetch(`https://${domain}`, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    const host = new URL(res.url).hostname.toLowerCase();
    return { ok: host === websiteHost || host.endsWith(`.${websiteHost}`), finalUrl: res.url };
  } catch {
    return { ok: null, finalUrl: null };
  }
}

export async function checkDomain(domain: string, provider: DnsProvider, websiteHost = "dna.systems"): Promise<DomainCheck> {
  const d = domain.toLowerCase();
  const [mx, root, dmarcTxt, gk, s1, s2, forward] = await Promise.all([
    mxOf(d),
    txt(d),
    txt(`_dmarc.${d}`),
    provider !== "microsoft" ? txt(`google._domainkey.${d}`) : Promise.resolve({ values: [], unsure: false }),
    provider !== "google" ? txt(`selector1._domainkey.${d}`) : Promise.resolve({ values: [], unsure: false }),
    provider !== "google" ? txt(`selector2._domainkey.${d}`) : Promise.resolve({ values: [], unsure: false }),
    forwardOf(d, websiteHost),
  ]);

  const mxOk = mx.values.length > 0 && (provider === "unknown" || mx.values.some((v) => MX_RE[provider].test(v)));
  const mxCheck: RecordCheck = {
    ok: mxOk,
    found: mx.values,
    indeterminate: mx.unsure || undefined,
    note: !mx.values.length ? "No MX record." : !mxOk ? `MX points to ${mx.values[0]}, not ${provider === "google" ? "Google" : "Microsoft"}.` : undefined,
  };

  const spfs = root.values.filter((v) => /^v=spf1\b/i.test(v.trim()));
  const spfOk = spfs.length === 1 && (provider === "unknown" || spfs[0].toLowerCase().includes(SPF_INCLUDE[provider]));
  const spfCheck: RecordCheck = {
    ok: spfOk,
    found: spfs,
    indeterminate: root.unsure || undefined,
    note: spfs.length > 1 ? "Two SPF records: merge them into one." : !spfs.length ? "No SPF record." : !spfOk ? `SPF doesn't include ${provider === "unknown" ? "the provider" : SPF_INCLUDE[provider as "google"]}.` : undefined,
  };

  const keys = [...gk.values, ...s1.values, ...s2.values].filter((v) => /(^|;)\s*p=\S/i.test(v) || /v=DKIM1/i.test(v));
  const dkimCheck: RecordCheck = {
    ok: keys.length > 0,
    found: keys.map((k) => (k.length > 60 ? `${k.slice(0, 60)}…` : k)),
    indeterminate: gk.unsure || s1.unsure || s2.unsure || undefined,
    note: keys.length ? undefined : provider === "microsoft" ? "No DKIM key at selector1/selector2._domainkey yet." : "No DKIM key at google._domainkey yet.",
  };

  const dm = dmarcTxt.values.filter((v) => /^v=DMARC1\b/i.test(v.trim()));
  const dmarcCheck: RecordCheck = { ok: dm.length > 0, found: dm, indeterminate: dmarcTxt.unsure || undefined, note: dm.length ? undefined : "No DMARC record at _dmarc." };

  const checks = { mx: mxCheck, spf: spfCheck, dkim: dkimCheck, dmarc: dmarcCheck };
  const indeterminate = (Object.keys(checks) as (keyof typeof checks)[]).filter((k) => !checks[k].ok && checks[k].indeterminate).map((k) => k.toUpperCase());
  return {
    domain: d,
    provider,
    ...checks,
    forward,
    allPass: mxCheck.ok && spfCheck.ok && dkimCheck.ok && dmarcCheck.ok,
    indeterminate,
    checkedAt: new Date().toISOString(),
  };
}

/** The mailboxes table's `dns_json` shape (what the Mailboxes screen reads), with the full check attached. */
export function toDnsJson(c: DomainCheck) {
  return { mx: c.mx.ok, spf: c.spf.ok, dkim: c.dkim.ok, dmarc: c.dmarc.ok, allPass: c.allPass, indeterminate: c.indeterminate, checkedAt: c.checkedAt, details: c };
}

/** Registration date from RDAP, or null when the registry doesn't say. */
export async function domainRegisteredAt(domain: string): Promise<string | null> {
  const d = registrableDomain(domain.toLowerCase()) || domain.toLowerCase();
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(d)}`, { headers: { Accept: "application/rdap+json, application/json" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data: any = await res.json();
    const ev = (data?.events || []).find((e: any) => /registration/i.test(String(e?.eventAction || "")));
    const t = ev?.eventDate ? Date.parse(String(ev.eventDate)) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  } catch {
    return null;
  }
}
