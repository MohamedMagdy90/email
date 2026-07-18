// Email extraction from raw HTML.
// Techniques (in order of reliability):
//   1. Cloudflare "email protection" (data-cfemail / __cf_email__) decoding
//   2. mailto: links
//   3. Plain-text emails (after HTML-entity decoding)
//   4. De-obfuscated patterns: name [at] domain [dot] com, name(at)..., name AT ... DOT ...

export interface EmailHit {
  email: string;
  method: "cloudflare" | "mailto" | "jsonld" | "text" | "deobfuscated";
}

function safeChar(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

// Decode the numeric / named HTML entities that matter for emails.
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&commat;/gi, "@")
    .replace(/&period;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ");
}

// Cloudflare stores obfuscated emails as hex; first byte is the XOR key.
export function decodeCfEmail(hex: string): string | null {
  try {
    if (hex.length < 4 || hex.length % 2 !== 0) return null;
    const key = parseInt(hex.substr(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
    }
    return out;
  } catch {
    return null;
  }
}

const EMAIL_RE =
  /([a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})/gi;

// name [at] domain [dot] tld  — with optional brackets and "at"/"dot" words.
const OBF_RE =
  /([a-z0-9._%+-]+)\s*(?:\(|\[|\{)?\s*(?:@|\bat\b)\s*(?:\)|\]|\})?\s*([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\s*(?:\(|\[|\{)?\s*(?:\.|\bdot\b)\s*(?:\)|\]|\})?\s*([a-z]{2,24})\b/gi;

export function extractEmails(rawHtml: string): EmailHit[] {
  const hits: EmailHit[] = [];
  const push = (email: string, method: EmailHit["method"]) => {
    const e = (email || "").trim();
    if (e) hits.push({ email: e, method });
  };

  // 1) Cloudflare protected emails
  let cm: RegExpExecArray | null;
  const cfAttr = /data-cfemail=["']([0-9a-fA-F]+)["']/g;
  while ((cm = cfAttr.exec(rawHtml))) {
    const dec = decodeCfEmail(cm[1]);
    if (dec) push(dec, "cloudflare");
  }
  const cfHash = /\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/g;
  while ((cm = cfHash.exec(rawHtml))) {
    const dec = decodeCfEmail(cm[1]);
    if (dec) push(dec, "cloudflare");
  }

  const decoded = decodeEntities(rawHtml);

  // 2) mailto: links (most reliable explicit signal)
  const mailto = /mailto:([^"'>\s?]+)/gi;
  let mm: RegExpExecArray | null;
  while ((mm = mailto.exec(decoded))) {
    let addr = mm[1].split(",")[0];
    try { addr = decodeURIComponent(addr); } catch {}
    push(addr.trim(), "mailto");
  }

  // 2b) JSON-LD (schema.org) structured data — Organization / ContactPoint
  //     often expose an "email" field that never appears in visible text.
  const ld = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = ld.exec(rawHtml))) {
    for (const e of emailsFromJsonLd(lm[1])) push(e, "jsonld");
  }

  // 3) plain-text emails
  let em: RegExpExecArray | null;
  EMAIL_RE.lastIndex = 0;
  while ((em = EMAIL_RE.exec(decoded))) push(em[0], "text");

  // 4) de-obfuscated patterns
  OBF_RE.lastIndex = 0;
  let om: RegExpExecArray | null;
  while ((om = OBF_RE.exec(decoded))) {
    const candidate = `${om[1]}@${om[2]}.${om[3]}`.replace(/\s+/g, "");
    push(candidate, "deobfuscated");
  }

  return hits;
}

// Walk a JSON-LD blob (object/array/nested) and collect any string that looks
// like an email, plus explicit `email` / `contactPoint.email` fields.
function emailsFromJsonLd(raw: string): string[] {
  const out: string[] = [];
  let data: any;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    // Some sites embed multiple JSON objects or trailing commas — salvage any
    // "email": "..." pairs with a targeted regex as a fallback.
    const re = /"email"\s*:\s*"([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) out.push(m[1].replace(/^mailto:/i, "").trim());
    return out;
  }
  const seen = new Set<any>();
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const it of node) walk(it);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        const cand = v.replace(/^mailto:/i, "").trim();
        // Accept explicit email fields, or any value that looks like an address.
        if (k.toLowerCase() === "email" || /^mailto:/i.test(v) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cand)) {
          if (cand.includes("@")) out.push(cand);
        }
      } else if (v && typeof v === "object") {
        walk(v);
      }
    }
  };
  walk(data);
  return out;
}
