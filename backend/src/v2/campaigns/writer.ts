// Step 8 — write the first email and follow-ups for one prospect, in the
// agent's voice, from the research. Guardrails strip links from email 1 and
// reject placeholders, AI tells and invented claims.
import { llm } from "../llm";
import { voicePrompt, type AgentSettings } from "../agent-settings";
import { nowIso } from "../../db";
import { offerText, type CampaignSettings, type EmailStep, type Offer, type ProspectEmails, type ResearchJson, type Row } from "./types";

const LINK_RE = /(?<![@\w.-])(?:https?:\/\/|www\.)[^\s<>()]+|(?<![@\w.-])[a-z0-9-]+\.(?:com|net|org|io|ai|co|sa|ae|qa|kw|bh|om|systems)(?:\/[^\s<>()]*)?\b/gi;
const PLACEHOLDER_RE = /\[[^\]]{2,40}\]|\{\{[^}]*\}\}|<(first ?name|name|company)>|\b(company name|first name|your name|insert)\b/i;
const AI_TELLS_RE = /\bas an ai\b|\blanguage model\b|i hope this (email|message) finds you|i hope you('| a)re (doing )?well/i;

export function resolveLanguage(settings: CampaignSettings, company: Row): "en" | "ar" {
  if (settings.language === "en" || settings.language === "ar") return settings.language;
  return company.language === "ar" ? "ar" : "en";
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Clean and check the AI's steps. Returns warnings, or an error when unusable. */
export function checkEmails(raw: { subject?: string; body?: string }[], wanted: number, ctx: { offer: Offer | null; agent: AgentSettings; maxWords1: number }): { steps: { subject: string; body: string }[]; warnings: string[]; error?: string } {
  const warnings: string[] = [];
  const allowedFacts = `${offerText(ctx.offer)} ${ctx.agent.knowledgeBase}`.toLowerCase();
  const steps: { subject: string; body: string }[] = [];
  for (let i = 0; i < wanted; i++) {
    const s = raw[i];
    if (!s || typeof s.body !== "string" || !s.body.trim()) return { steps, warnings, error: `Email ${i + 1} came back empty` };
    let subject = i === 0 ? String(s.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 90) : "";
    let body = s.body.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (i === 0 && !subject) return { steps, warnings, error: "Email 1 has no subject" };
    if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) return { steps, warnings, error: `Email ${i + 1} still has a placeholder` };
    if (AI_TELLS_RE.test(body)) return { steps, warnings, error: `Email ${i + 1} has a stock AI phrase` };
    if (i === 0) {
      const before = body;
      body = body.replace(LINK_RE, "").replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1");
      if (body !== before) warnings.push("Email 1 had a link; it was removed (first emails go out without links).");
      subject = subject.replace(LINK_RE, "").trim();
    }
    const claims = body.match(/\b\d{1,3}(?:[.,]\d+)?\s?%|\b\d{2,}\+?\s+(?:customers|clients|companies|businesses)\b/gi) || [];
    const invented = claims.filter((c) => !allowedFacts.includes(c.toLowerCase().replace(/\s/g, "")) && !allowedFacts.includes(c.toLowerCase()));
    if (invented.length) return { steps, warnings, error: `Email ${i + 1} claims "${invented[0]}", which isn't in the offer or the knowledge base` };
    const limit = i === 0 ? ctx.maxWords1 + 25 : 80;
    if (words(body) > limit) warnings.push(`Email ${i + 1} is ${words(body)} words, longer than the ${i === 0 ? ctx.maxWords1 : 60}-word target.`);
    if (words(body) < 12) return { steps, warnings, error: `Email ${i + 1} is too short to make sense` };
    steps.push({ subject, body });
  }
  return { steps, warnings };
}

export async function writeEmails(input: {
  prospect: Row;
  company: Row;
  research: ResearchJson;
  segment: Row | null;
  offer: Offer | null;
  settings: CampaignSettings;
  agent: AgentSettings;
  instruction?: string;
  previous?: ProspectEmails | null;
}): Promise<ProspectEmails> {
  const { prospect: p, company: co, research, segment, offer, settings, agent } = input;
  const language = resolveLanguage(settings, co);
  const wanted = 1 + settings.followUps;
  const maxWords1 = agent.tone.length === "very_short" ? 60 : agent.tone.length === "short" ? 90 : 120;
  const first = p.first_name || "";
  const prompt = [
    "Write a cold email sequence to one person.",
    "",
    "ABOUT US",
    offerText(offer) || `${agent.companyName} (${agent.website})`,
    agent.knowledgeBase ? `Facts you may use: ${agent.knowledgeBase.replace(/\n+/g, " ")}` : "",
    "",
    "THE PROSPECT",
    `Person: ${p.full_name || "(no name — address the team politely)"}${p.title ? `, ${p.title}` : ""}`,
    `Company: ${co.name || co.domain} (${co.domain})${co.city || co.country ? `, ${[co.city, co.country].filter(Boolean).join(", ")}` : ""}`,
    co.description ? `What they do: ${co.description}` : "",
    co.industry ? `Industry: ${co.industry}` : "",
    research.hooks.length ? `Specific observations (use ONE in email 1): ${research.hooks.join(" | ")}` : "No specific observations — use what they do instead.",
    segment?.why ? `Why companies like this fit: ${segment.why}` : "",
    "",
    "RULES",
    `Language: ${language === "ar" ? "Modern Standard Arabic, formal, no transliteration" : "English"}.`,
    `Email 1: subject of 2-5 words, not clickbait, no exclamation marks. Body: greet ${first ? `"${first}"` : "them"} by first name, ONE specific observation about their company, ONE relevant outcome we give companies like theirs, ONE short question as the call to action. At most ${maxWords1} words. NO links, no attachments, no "I hope this email finds you well".`,
    wanted > 1 ? `Follow-ups (${wanted - 1}): subject "" (same thread), 30-60 words each, a new angle each time (a proof point, a quick question, then a polite close-the-loop). No guilt-tripping.${agent.bookingLink ? ` You may include the booking link ${agent.bookingLink} in a follow-up.` : ""}` : "",
    `Sign off as ${agent.senderName || "the sender"}${agent.signature ? ` with this signature:\n${agent.signature}` : ""}.`,
    "Never invent customers, numbers, discounts or features that are not in the facts above.",
    input.instruction ? `Extra instruction from the user: ${input.instruction}` : "",
    input.previous ? `Previous version (improve on it, don't repeat it):\n${input.previous.steps.map((s, i) => `Email ${i + 1}: ${s.subject}\n${s.body}`).join("\n---\n")}` : "",
    "",
    `Return JSON: {"steps":[{"subject": string, "body": string}]} with exactly ${wanted} item(s). Plain text bodies with \\n line breaks.`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await llm<any>({
      tier: "smart",
      json: true,
      task: `campaign:write:${co.domain}`,
      temperature: attempt ? 0.5 : 0.7,
      system: voicePrompt(agent),
      prompt: attempt ? `${prompt}\n\nThe previous attempt was rejected: ${lastError}. Fix that.` : prompt,
    });
    const list = Array.isArray(r.data?.steps) ? r.data.steps : Array.isArray(r.data) ? r.data : [];
    const checked = checkEmails(list, wanted, { offer, agent, maxWords1 });
    if (!checked.error) {
      const steps: EmailStep[] = checked.steps.map((s, i) => ({ subject: s.subject, body: s.body, delayDays: i === 0 ? 0 : settings.followUpDelays[i - 1] || 3 }));
      return { steps, language, source: "ai", writtenAt: nowIso(), warnings: checked.warnings };
    }
    lastError = checked.error;
  }
  throw new WriterRejected(lastError);
}

export class WriterRejected extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WriterRejected";
  }
}
