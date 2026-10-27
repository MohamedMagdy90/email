// Plain-text RFC 5322 messages (UTF-8, quoted-printable) and the small parsing
// helpers the reply reader needs. No dependencies.
import { randomToken } from "./crypto";

const CRLF = "\r\n";
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);
/** Strip line breaks so no value can inject a header. */
const oneLine = (s: string) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

/** RFC 2047 encoded words (UTF-8, base64), split on whole characters. */
export function encodeWords(raw: string): string {
  const s = oneLine(raw);
  if (isAscii(s)) return s;
  const chunks: string[] = [];
  let cur = "";
  for (const ch of s) {
    const next = cur + ch;
    if (Buffer.byteLength(next, "utf8") > 45 && cur) {
      chunks.push(cur);
      cur = ch;
    } else cur = next;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

export interface Address {
  email: string;
  name?: string | null;
}

export function formatAddress(a: Address): string {
  const email = oneLine(a.email).replace(/[<>\s]/g, "");
  const name = oneLine(a.name || "").replace(/"/g, "");
  if (!name) return email;
  return isAscii(name) ? `"${name}" <${email}>` : `${encodeWords(name)} <${email}>`;
}

function qpLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  const tokens: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const last = i === bytes.length - 1;
    if ((b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)) tokens.push(String.fromCharCode(b));
    else tokens.push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`);
  }
  const out: string[] = [];
  let cur = "";
  for (const t of tokens) {
    if (cur.length + t.length > 75) {
      out.push(`${cur}=`);
      cur = "";
    }
    cur += t;
  }
  out.push(cur);
  return out.join(CRLF);
}

export function quotedPrintable(text: string): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(qpLine)
    .join(CRLF);
}

export function decodeQuotedPrintable(s: string): string {
  const bin = String(s || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bin, "latin1").toString("utf8");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function rfc2822(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function newMessageId(domain: string): string {
  return `<${Date.now().toString(36)}.${randomToken(9)}@${oneLine(domain).replace(/[^a-z0-9.-]/gi, "") || "localhost"}>`;
}

export interface OutgoingMail {
  from: Address;
  to: Address;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** https one-click URL and/or a mailto address. */
  listUnsubscribe?: { url?: string | null; mailto?: string | null } | null;
  date?: Date;
}

export function buildMime(m: OutgoingMail): string {
  const h: string[] = [
    `From: ${formatAddress(m.from)}`,
    `To: ${formatAddress(m.to)}`,
    `Subject: ${encodeWords(m.subject)}`,
    `Date: ${rfc2822(m.date)}`,
    `Message-ID: ${oneLine(m.messageId)}`,
  ];
  if (m.inReplyTo) h.push(`In-Reply-To: ${oneLine(m.inReplyTo)}`);
  const refs = (m.references || []).map(oneLine).filter(Boolean);
  if (refs.length) h.push(`References: ${refs.join(" ")}`);
  const lu = m.listUnsubscribe;
  if (lu && (lu.url || lu.mailto)) {
    const parts = [lu.url ? `<${oneLine(lu.url)}>` : "", lu.mailto ? `<mailto:${oneLine(lu.mailto)}?subject=unsubscribe>` : ""].filter(Boolean);
    h.push(`List-Unsubscribe: ${parts.join(", ")}`);
    if (lu.url) h.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  h.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: quoted-printable");
  return `${h.join(CRLF)}${CRLF}${CRLF}${quotedPrintable(m.text)}${CRLF}`;
}

/* -------------------------------- parsing -------------------------------- */

const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function parseAddress(v: string | null | undefined): { email: string; name: string | null } {
  const s = String(v || "").trim();
  const angle = s.match(/<([^>]+)>/);
  const email = (angle ? angle[1] : (s.match(EMAIL_RE) || [""])[0]).trim().toLowerCase();
  let name = angle ? s.slice(0, s.indexOf("<")).trim().replace(/^"|"$/g, "").trim() : "";
  if (name.includes("@")) name = "";
  return { email, name: name || null };
}

export function emailsIn(text: string | null | undefined): string[] {
  return [...new Set((String(text || "").match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
}

/** Every <message-id> in a header value or a block of text. */
export function messageIdsIn(v: string | null | undefined): string[] {
  return [...new Set((String(v || "").match(/<[^<>\s]+@[^<>\s]+>/g) || []).map((x) => x.trim()))];
}

export function normalizeMessageId(v: string | null | undefined): string | null {
  const s = String(v || "").trim();
  if (!s) return null;
  const inside = s.match(/<[^<>\s]+>/);
  if (inside) return inside[0];
  return s.includes("@") ? `<${s.replace(/[<>\s]/g, "")}>` : null;
}

/** An auto-reply (out of office, vacation responder), from its headers. */
export function isAutoSubmitted(headers: Record<string, string>): boolean {
  const as = (headers["auto-submitted"] || "").toLowerCase();
  if (as && as !== "no") return true;
  if (headers["x-autoreply"] || headers["x-autorespond"] || headers["x-autoresponse"]) return true;
  const prec = (headers["precedence"] || "").toLowerCase();
  return prec === "auto_reply";
}

/* -------------------------------- bounces -------------------------------- */

export interface Bounce {
  kind: "invalid" | "blocked" | "soft";
  status: string | null;
  recipients: string[];
  messageIds: string[];
  diagnostic: string;
}

export function looksLikeBounce(m: { from: string; subject: string; contentType?: string }): boolean {
  if (/multipart\/report/i.test(m.contentType || "") && /delivery-status/i.test(m.contentType || "")) return true;
  const from = m.from.toLowerCase();
  const fromBot = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/.test(from) || /mail delivery (subsystem|system)/i.test(from);
  const subj = /(undeliverable|undelivered mail|delivery status notification|delivery failure|failure notice|returned mail|mail delivery failed|message not delivered|delivery has failed|couldn't be delivered|could not be delivered)/i.test(m.subject);
  return fromBot || subj;
}

const INVALID_RE =
  /(does not exist|doesn't exist|no such user|user unknown|unknown user|address not found|recipient address rejected|mailbox unavailable|invalid recipient|no mailbox here|account (?:has been )?disabled|address couldn'?t be found|recipient not found|RecipNotFound|unrouteable address|no such recipient)/i;
const BLOCKED_RE = /(spam|blocked|blacklist|blocklist|policy|reputation|rejected for policy|access denied|not authori[sz]ed|unsolicited)/i;
const SOFT_RE = /(mailbox (?:is )?full|over quota|quota exceeded|temporar|try again later|deferred|greylist)/i;

export function parseBounce(text: string): Bounce {
  const t = String(text || "");
  const status = (t.match(/Status:\s*([245]\.\d{1,3}\.\d{1,3})/i) || t.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/) || [])[1] || null;
  const finals = [...t.matchAll(/(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/gi)].map((x) => x[1].toLowerCase());
  const diag = (t.match(/Diagnostic-Code:\s*(?:smtp;)?\s*([^\r\n]+)/i) || t.match(/(5\d\d[ -][^\r\n]{0,200})/) || [])[1] || "";
  let kind: Bounce["kind"];
  if (status?.startsWith("4") || (!status?.startsWith("5") && SOFT_RE.test(t))) kind = "soft";
  else if (status?.startsWith("5.7") || (!INVALID_RE.test(t) && BLOCKED_RE.test(diag || t.slice(0, 3000)))) kind = "blocked";
  else kind = "invalid";
  return { kind, status, recipients: finals.length ? [...new Set(finals)] : [], messageIds: messageIdsIn(t), diagnostic: oneLine(diag).slice(0, 300) };
}
