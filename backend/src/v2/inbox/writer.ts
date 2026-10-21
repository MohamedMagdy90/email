// The auto-replier's pen. Builds the exact prompt (same voice rules as the
// Agent tab preview), asks the model, and checks the result before anything
// can be sent on its own.
import { voicePrompt, REPLY_CATEGORIES, type AgentSettings, type ReplyCategoryId } from "../agent-settings";
import { llm } from "../llm";
import { stripRe } from "./classify";

export interface ReplyContext {
  lead: {
    name?: string | null;
    email: string;
    title?: string | null;
    company?: string | null;
    city?: string | null;
    country?: string | null;
  };
  /** Short facts about the company from research (may be empty). */
  research: string[];
  /** Earlier messages, oldest first. Text = the typed part only. */
  history: { direction: "in" | "out"; at: string | null; text: string }[];
  latest: { subject: string; text: string };
  category: ReplyCategoryId | string;
  /** Detected language of their message ("ar", "en", ...). */
  language?: string | null;
  /** Referral target, if the classifier found one. */
  referral?: string | null;
  returnDate?: string | null;
}

const GUIDE: Partial<Record<ReplyCategoryId, string>> = {
  interested:
    "They want to talk. Confirm in one warm line, then make booking the call effortless. Do not pitch again and do not repeat what the first email said.",
  question:
    "Answer each question they asked, directly and in order, using only the facts. If a fact is missing (a price, for example), say you will confirm it. End with one short question that moves toward a call.",
  not_now:
    "Respect the timing. Thank them, confirm when you will check back (use the time they gave, otherwise about three months), and stop. No pitch. Two or three sentences.",
  referral:
    "Thank them and ask for a short introduction to the colleague they mentioned (use the name if they gave one). One or two sentences.",
  not_interested: "One short line: thank them for replying and confirm you will not follow up. Nothing else.",
  negotiation:
    "Answer within the facts. Never offer, hint at or agree to a discount, special price, payment terms or contract change. Offer a short call to go through specifics.",
  complaint:
    "Apologise in one sentence and confirm they will not be emailed again. No justification, no pitch, no link.",
};

function languageRule(s: AgentSettings, lang?: string | null): string {
  if (s.language === "ar") return "Write in Modern Standard Arabic.";
  if (s.language === "en") return "Write in English.";
  if (lang && lang !== "en") return lang === "ar" ? "They wrote in Arabic: reply in Modern Standard Arabic." : `Reply in the language they used (${lang}).`;
  return "Reply in the language they used (English).";
}

function signOff(s: AgentSettings): string {
  if (s.signature.trim()) return `End with a short sign-off, then this signature exactly as written:\n${s.signature.trim()}`;
  return `End with a short sign-off and the sender's first name${s.senderName ? ` (${s.senderName.split(/\s+/)[0]})` : ""}.`;
}

export function buildReplyPrompt(s: AgentSettings, ctx: ReplyContext, instruction?: string | null): { system: string; prompt: string } {
  const cat = REPLY_CATEGORIES.find((c) => c.id === ctx.category);
  const guide = GUIDE[ctx.category as ReplyCategoryId] || "Reply helpfully and briefly, and hand anything you can't answer to a call.";
  const system = [
    "You answer a reply from a B2B prospect, in the same email thread, as the person who emailed them.",
    voicePrompt(s),
    `What they sent: ${cat ? `${cat.label} — ${cat.description}` : "a reply"}\nHow to answer: ${guide}`,
    "Use ONLY the facts below and the conversation. Never invent customers, numbers, prices, dates or features. If something isn't covered, say you'll confirm it.",
    `Facts you may use:\n---\n${s.knowledgeBase || "(none)"}\n---`,
    ctx.category === "interested" || ctx.category === "question" || ctx.category === "negotiation"
      ? s.bookingLink
        ? `If a call makes sense, offer this booking link once, written out in full: ${s.bookingLink}`
        : "If a call makes sense, suggest two short time slots in the next two working days (Sunday to Thursday in the Gulf)."
      : "Do not include any link.",
    "Never include a link other than the booking link above. No placeholders like [Name] — write the real words or leave the detail out.",
    languageRule(s, ctx.language),
    signOff(s),
    instruction ? `Extra instruction from your colleague for this reply: ${instruction}` : "",
    'Respond with JSON only: {"body": string}. Plain text, use \\n for line breaks. Do not repeat the subject or quote their email.',
  ]
    .filter(Boolean)
    .join("\n\n");

  const L = ctx.lead;
  const who = [L.name || L.email, L.title, L.company && `at ${L.company}`, [L.city, L.country].filter(Boolean).join(", ") && `(${[L.city, L.country].filter(Boolean).join(", ")})`]
    .filter(Boolean)
    .join(" ");
  const history = ctx.history
    .slice(-6)
    .map((h) => `${h.direction === "out" ? "US" : "THEM"}${h.at ? ` (${h.at.slice(0, 10)})` : ""}:\n${h.text.slice(0, 1200)}`)
    .join("\n\n");
  const prompt = [
    `Prospect: ${who}`,
    ctx.research.length ? `Research:\n- ${ctx.research.slice(0, 8).join("\n- ")}` : "",
    ctx.referral ? `They pointed to: ${ctx.referral}` : "",
    ctx.returnDate ? `Return date they gave: ${ctx.returnDate}` : "",
    history ? `Conversation so far (oldest first):\n${history}` : "",
    `Their latest message (subject "${stripRe(ctx.latest.subject)}"):\n${ctx.latest.text.slice(0, 3000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt };
}

export function readBody(data: any, text: string): string {
  let body = String(data?.body ?? "").trim();
  if (!body) body = String(text || "").trim();
  return body
    .replace(/^```[a-z]*\s*|\s*```$/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

export async function writeReply(
  s: AgentSettings,
  ctx: ReplyContext,
  instruction?: string | null
): Promise<{ body: string; provider: string; model: string }> {
  const { system, prompt } = buildReplyPrompt(s, ctx, instruction);
  const r = await llm({ system, prompt, json: true, tier: "smart", temperature: 0.5, maxTokens: 900, task: `inbox:reply:${ctx.category}` });
  return { body: readBody(r.data, r.text), provider: r.provider, model: r.model };
}

function hostOf(u: string): string {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Anything here means "a person should look before this goes out".
 * Returns the reason, or null when the reply may be sent on its own.
 */
export function checkReply(body: string, s: AgentSettings): string | null {
  const b = String(body || "").trim();
  if (b.length < 15) return "The reply came out empty or too short.";
  if (/\[(name|first ?name|company|your name|date|time|link|insert)[^\]]*\]|\{\{|\}\}|<insert|lorem ipsum|xx:xx/i.test(b)) {
    return "The reply still has a placeholder in it.";
  }
  if (/\bas an ai\b|language model|i('m| am) an ai/i.test(b)) return "The reply talks about being an AI.";
  const allowed = new Set([hostOf(s.bookingLink), hostOf(s.website)].filter(Boolean));
  const links = b.match(/\bhttps?:\/\/[^\s)>\]"']+|\bwww\.[^\s)>\]"']+/gi) || [];
  for (const l of links) {
    const h = hostOf(l);
    const ok = [...allowed].some((a) => h === a || h.endsWith(`.${a}`));
    if (!ok) return `The reply has a link that isn't your website or booking link (${h || l}).`;
  }
  if (/\b\d{1,2}\s?%\s?(off|discount)|\bdiscount(ed)? (of|price)|\bspecial (price|offer)\b|خصم/i.test(b) && !/discount|خصم/i.test(s.knowledgeBase)) {
    return "The reply mentions a discount that isn't in your knowledge base.";
  }
  if (b.length > 2200) return "The reply is much longer than your length setting.";
  return null;
}
