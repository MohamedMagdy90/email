// Reply classification for the Inbox (v2 workstream B).
//
// Order of trust:
//   1. Strong rules   bounces, auto-responders, short "remove me" notes and legal
//                     language are recognised without AI — they are the cases
//                     where a mistake costs a domain, so they never wait on a key.
//   2. The AI         everything else, into the 12 ids from agent-settings.
//   3. Weak rules     only when no AI is available.
//   4. A person       anything left: "needs_human" with confidence 0.
import { REPLY_CATEGORIES, type ReplyCategoryId } from "../agent-settings";
import { llm, LlmBudgetExceeded, LlmUnavailable } from "../llm";

export type ClassSource = "rules" | "ai" | "none" | "human";

export interface Classification {
  category: ReplyCategoryId;
  confidence: number;
  /** One plain-English sentence: what they said. */
  summary: string;
  language: string;
  source: ClassSource;
  /** Out-of-office return date (YYYY-MM-DD) when the message gives one. */
  returnDate?: string | null;
  /** Referral target ("Sara, sara@acme.com") when they point to a colleague. */
  referral?: string | null;
  /** Why the AI could not be used (no key, budget, provider error). */
  error?: string | null;
  provider?: string | null;
}

const KNOWN = new Set<string>(REPLY_CATEGORIES.map((c) => c.id));

/* ----------------------------- text helpers ----------------------------- */

/**
 * The part of an email the person actually typed: everything above the quoted
 * history ("On ... wrote:", "> ...", Outlook headers, Arabic Gmail headers).
 */
export function latestReply(text: string): string {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const next = (lines[i + 1] || "").trim();
    if (/^>/.test(t)) break;
    if (/^On\s.{4,240}\swrote:?$/i.test(t)) break;
    if (/^On\s.{4,240}$/i.test(t) && /wrote:?$/i.test(next)) break;
    if (/^-{2,}\s*(Original Message|Forwarded message|Reply above this line)/i.test(t)) break;
    if (/^_{6,}$/.test(t)) break;
    if (/^(From|De|Von|من)\s*:\s*.+/i.test(t) && lines.slice(i + 1, i + 5).some((x) => /^(Sent|Date|To|Subject|Envoy|Gesendet|التاريخ|بتاريخ|إلى|الموضوع)\s*:/i.test(x.trim()))) break;
    // Gmail in Arabic: "في الأحد، 18 أكتوبر 2026 في 10:02 ص، كتب Name <a@b>:" (needs a digit, so "كتب" = "books" never matches)
    if (/^في\s.*\d.*\sكتب(\s.{0,200})?:?$/.test(t)) break;
    if (/^في\s.*\d.{0,240}$/.test(t) && /^.{0,200}كتب.{0,200}:$/.test(next)) break;
    out.push(lines[i]);
  }
  const s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return s || raw.trim();
}

/** "ar" when most letters are Arabic, else "en" (good enough to pick a reply language). */
export function detectLanguage(text: string): string {
  const s = String(text || "");
  const ar = (s.match(/[\u0600-\u06FF]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return ar > 0 && ar >= lat * 0.6 ? "ar" : "en";
}

export function stripRe(subject: string): string {
  return String(subject || "")
    .replace(/^\s*((re|aw|fw|fwd|sv|rif|رد)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim();
}

/* -------------------------------- rules -------------------------------- */

export interface RuleInput {
  from?: string | null;
  subject?: string | null;
  /** The typed part only (latestReply). */
  text: string;
  isAutoReply?: boolean;
}

interface RuleHit {
  category: ReplyCategoryId;
  confidence: number;
  summary: string;
  /** strong = final even when an AI is available. */
  strong: boolean;
  returnDate?: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Best-effort "back on 12 November" / "until 2026-11-12" / "returning 12/11". */
export function findReturnDate(text: string, now = new Date()): string | null {
  const s = String(text || "");
  const iso = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const mk = (d: number, m: number, y?: number) => {
    if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return null;
    let year = y || now.getUTCFullYear();
    const candidate = Date.UTC(year, m - 1, d);
    if (!y && candidate < now.getTime() - 86_400_000) year += 1; // "back on 3 Jan" in December
    return `${year}-${pad(m)}-${pad(d)}`;
  };
  const dm = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:,?\s+(20\d{2}))?/i);
  if (dm) return mk(Number(dm[1]), MONTHS[dm[2].toLowerCase()], dm[3] ? Number(dm[3]) : undefined);
  const md = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/i);
  if (md) return mk(Number(md[2]), MONTHS[md[1].toLowerCase()], md[3] ? Number(md[3]) : undefined);
  const num = s.match(/\b(?:until|till|back on|return(?:ing)? on|from)\s+(\d{1,2})[/.](\d{1,2})(?:[/.](20\d{2}))?/i);
  if (num) return mk(Number(num[1]), Number(num[2]), num[3] ? Number(num[3]) : undefined); // Gulf: day first
  return null;
}

const RX = {
  bounceFrom: /(mailer-daemon|postmaster|mail-daemon|mail delivery subsystem|no-?reply-?bounce)/i,
  bounceSubject:
    /(undeliver|delivery status notification|delivery has failed|delivery failure|mail delivery (failed|subsystem)|returned mail|failure notice|could not be delivered|address not found|message not delivered|rejected:)/i,
  oooSubject: /(automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|out of (the )?office|\booo\b|on leave|vacation|away from|رد تلقائي|خارج المكتب|إجازة)/i,
  oooBody:
    /(out of (the )?office|on (annual |sick |maternity |paternity )?leave|away (from the office|until|on business)|limited access to (my )?e-?mail|i('| a)m currently away|will be back on|returning on|no longer (with|works? (at|for))|has left the company|رد تلقائي|خارج المكتب|في إجازة)/i,
  unsubscribe:
    /(\bunsubscribe\b|\bremove me\b|take me off|stop (e-?mailing|sending|contacting|messaging)|\bopt[- ]?out\b|do not (e-?mail|contact|message)|don'?t (e-?mail|contact|message) me|no more e-?mails|remove (my|this) (e-?mail|address)|إلغاء الاشتراك|أزلني|احذف(وا)? (بريدي|إيميلي)|توقف(وا)? عن (مراسلتي|الإرسال)|لا ترسل)/i,
  legal:
    /(\bgdpr\b|\bpdpl\b|data protection|personal data|my data|\blawyer\b|\battorney\b|legal action|cease and desist|\bsue\b|report (you|this) to|privacy (law|regulator)|حماية البيانات|محامي|إجراء قانوني)/i,
};

export function ruleClassify(m: RuleInput, now = new Date()): RuleHit | null {
  const from = String(m.from || "");
  const subject = String(m.subject || "");
  const text = String(m.text || "");
  const short = text.length < 320;

  if (RX.bounceFrom.test(from) || RX.bounceSubject.test(subject)) {
    return { category: "bounce", confidence: 0.98, summary: "The mail server says the message could not be delivered.", strong: true };
  }
  if (RX.legal.test(text)) {
    return { category: "legal", confidence: 0.9, summary: "Uses legal or data-protection language.", strong: true };
  }
  if (RX.unsubscribe.test(text)) {
    return short
      ? { category: "unsubscribe", confidence: 0.94, summary: "Asks to stop receiving emails.", strong: true }
      : { category: "unsubscribe", confidence: 0.72, summary: "Mentions stopping the emails.", strong: false };
  }
  if (m.isAutoReply || RX.oooSubject.test(subject)) {
    if (RX.oooBody.test(text) || RX.oooSubject.test(subject) || m.isAutoReply) {
      const left = /no longer (with|works?)|has left the company/i.test(text);
      return {
        category: "out_of_office",
        confidence: 0.95,
        summary: left ? "Auto-reply: this person has left the company." : "Auto-reply: they are away.",
        strong: true,
        returnDate: left ? null : findReturnDate(text, now),
      };
    }
  }
  if (RX.oooBody.test(text) && short && !/\?/.test(text)) {
    return { category: "out_of_office", confidence: 0.75, summary: "Looks like an away message.", strong: false, returnDate: findReturnDate(text, now) };
  }
  return null;
}

/* --------------------------------- AI ---------------------------------- */

export function classifierPrompt(input: { subject: string; text: string; ourLast?: { subject: string; text: string } | null }) {
  const cats = REPLY_CATEGORIES.map((c) => `- ${c.id}: ${c.description}`).join("\n");
  const system = [
    "You classify one reply to a B2B cold email sent by a software company (a cloud ERP).",
    `Pick exactly one category id:\n${cats}`,
    [
      "Rules:",
      "- Any request to stop, unsubscribe or be removed is unsubscribe, however polite.",
      "- Wants a call, a demo, a trial or pricing for a purchase decision: interested. A plain question without buying intent: question.",
      "- Legal threats or data-protection requests: legal.",
      "- Auto-responders, including 'has left the company': out_of_office.",
      "- If you are unsure, use needs_human and a low confidence.",
      "- confidence is how sure you are (0 to 1). Be honest: 0.5 means a coin flip.",
    ].join("\n"),
    'Respond with JSON only: {"category": string, "confidence": number, "summary": string (one sentence, at most 20 words, English), "language": "en" | "ar" | other ISO 639-1 code, "returnDate": "YYYY-MM-DD" | null, "referral": string | null}',
  ].join("\n\n");
  const prompt = [
    input.ourLast ? `Our last email (subject "${input.ourLast.subject}"):\n${input.ourLast.text.slice(0, 900)}` : "",
    `Their reply (subject "${input.subject}"):\n${input.text.slice(0, 2500)}`,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
  return { system, prompt };
}

function readAi(data: any): Omit<Classification, "source"> | null {
  if (!data || typeof data !== "object") return null;
  const category = String(data.category || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!KNOWN.has(category)) return null;
  const c = Number(data.confidence);
  const date = typeof data.returnDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.returnDate) ? data.returnDate : null;
  return {
    category: category as ReplyCategoryId,
    confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c > 1 ? c / 100 : c)) : 0.5,
    summary: String(data.summary || "").slice(0, 240),
    language: String(data.language || "").slice(0, 5).toLowerCase() || "en",
    returnDate: date,
    referral: data.referral ? String(data.referral).slice(0, 200) : null,
  };
}

export interface ClassifyInput extends RuleInput {
  ourLast?: { subject: string; text: string } | null;
}

/** Rules first, then AI, then weak rules, then a person. Never throws. */
export async function classifyMessage(m: ClassifyInput, now = new Date()): Promise<Classification> {
  const language = detectLanguage(m.text);
  const hit = ruleClassify(m, now);
  if (hit?.strong) {
    return { category: hit.category, confidence: hit.confidence, summary: hit.summary, language, source: "rules", returnDate: hit.returnDate ?? null };
  }
  let error: string | null = null;
  try {
    const { system, prompt } = classifierPrompt({ subject: String(m.subject || ""), text: m.text, ourLast: m.ourLast });
    const r = await llm({ system, prompt, json: true, tier: "fast", temperature: 0, maxTokens: 300, task: "inbox:classify" });
    const ai = readAi(r.data);
    if (ai) return { ...ai, language: ai.language || language, source: "ai", provider: r.provider };
    error = "The AI answered with an unknown category.";
  } catch (e: any) {
    error =
      e instanceof LlmBudgetExceeded
        ? String(e.message)
        : e instanceof LlmUnavailable
          ? String(e.message)
          : `AI error: ${String(e?.message || e)}`;
  }
  if (hit) {
    return { category: hit.category, confidence: hit.confidence, summary: hit.summary, language, source: "rules", returnDate: hit.returnDate ?? null, error };
  }
  return {
    category: "needs_human",
    confidence: 0,
    summary: "The agent could not read this one.",
    language,
    source: "none",
    error,
  };
}
