// Step 8 — write every email of one prospect's sequence, in the agent's voice,
// from the research. The SEQUENCE decides the shape (Phase 7): how many steps,
// each step's angle, instructions, word limit, whether it starts a thread and
// whether it may carry the booking link; template steps are fixed text where
// the AI only fills {{observation}}. Guardrails run per step against its rules.
import { llm } from "../llm";
import { voicePrompt, type AgentSettings } from "../agent-settings";
import { nowIso } from "../../db";
import { offerText, type CampaignSettings, type EmailStep, type Offer, type ProspectEmails, type ResearchJson, type Row } from "./types";
import { ANGLES, hasAiSteps, needsObservation, renderTemplate, sequenceFacts, stepsFromSettings, type SequenceLanguage, type SequenceStep } from "../sequences/model";

const LINK_RE = /(?<![@\w.-])(?:https?:\/\/|www\.)[^\s<>()]+|(?<![@\w.-])[a-z0-9-]+\.(?:com|net|org|io|ai|co|sa|ae|qa|kw|bh|om|systems)(?:\/[^\s<>()]*)?\b/gi;
const PLACEHOLDER_RE = /\[[^\]]{2,40}\]|\{\{[^}]*\}\}|<(first ?name|name|company)>|\b(company name|first name|your name|insert)\b/i;
const AI_TELLS_RE = /\bas an ai\b|\blanguage model\b|i hope this (email|message) finds you|i hope you('| a)re (doing )?well/i;

export function resolveLanguage(settings: CampaignSettings, company: Row, sequenceLanguage?: SequenceLanguage): "en" | "ar" {
  if (sequenceLanguage === "en" || sequenceLanguage === "ar") return sequenceLanguage;
  if (settings.language === "en" || settings.language === "ar") return settings.language;
  return company.language === "ar" ? "ar" : "en";
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** The rules one step is checked against. */
export interface StepRule {
  /** Position in the whole sequence (0 = first email). */
  index: number;
  maxWords: number;
  needsSubject: boolean;
  /** null = no links at all; a URL = only that link (the booking link). */
  allowedLink: string | null;
}

export function rulesFor(steps: SequenceStep[], bookingLink: string): StepRule[] {
  return steps.map((s, i) => ({ index: i, maxWords: s.maxWords, needsSubject: i === 0 || s.newThread, allowedLink: i > 0 && s.bookingLink && bookingLink ? bookingLink : null }));
}

const hostOfUrl = (u: string) => {
  try {
    return new URL(/^https?:/i.test(u) ? u : `https://${u}`).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/** Clean and check written steps. Returns warnings, or an error when unusable. */
export function checkEmails(
  raw: { subject?: string; body?: string }[],
  wanted: number,
  ctx: { offer: Offer | null; agent: AgentSettings; maxWords1: number; rules?: StepRule[]; extraFacts?: string }
): { steps: { subject: string; body: string }[]; warnings: string[]; error?: string } {
  const warnings: string[] = [];
  const allowedFacts = `${offerText(ctx.offer)} ${ctx.agent.knowledgeBase} ${ctx.extraFacts || ""}`.toLowerCase();
  const rules: StepRule[] = ctx.rules || Array.from({ length: wanted }, (_, i) => ({ index: i, maxWords: i === 0 ? ctx.maxWords1 : 60, needsSubject: i === 0, allowedLink: i === 0 ? null : "*" }));
  const steps: { subject: string; body: string }[] = [];
  for (let k = 0; k < wanted; k++) {
    const rule = rules[k];
    const n = rule.index === 0 ? "Email 1" : `Email ${rule.index + 1}`;
    const s = raw[k];
    if (!s || typeof s.body !== "string" || !s.body.trim()) return { steps, warnings, error: `${n} came back empty` };
    let subject = rule.needsSubject ? String(s.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 90) : "";
    let body = s.body.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (rule.needsSubject && !subject) return { steps, warnings, error: `${n} has no subject` };
    if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) return { steps, warnings, error: `${n} still has a placeholder` };
    if (AI_TELLS_RE.test(body)) return { steps, warnings, error: `${n} has a stock AI phrase` };
    if (rule.allowedLink !== "*") {
      const okHost = rule.allowedLink ? hostOfUrl(rule.allowedLink) : "";
      const before = body;
      body = body.replace(LINK_RE, (m) => (okHost && hostOfUrl(m) === okHost ? m : "")).replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1");
      if (body !== before) warnings.push(rule.index === 0 ? "Email 1 had a link; it was removed (first emails go out without links)." : `${n} had a link the sequence doesn't allow there; it was removed.`);
      subject = subject.replace(LINK_RE, "").trim();
    }
    const claims = body.match(/\b\d{1,3}(?:[.,]\d+)?\s?%|\b\d{2,}\+?\s+(?:customers|clients|companies|businesses)\b/gi) || [];
    const invented = claims.filter((c) => !allowedFacts.includes(c.toLowerCase().replace(/\s/g, "")) && !allowedFacts.includes(c.toLowerCase()));
    if (invented.length) return { steps, warnings, error: `${n} claims "${invented[0]}", which isn't in the offer, the knowledge base or the sequence` };
    const limit = rule.maxWords + (rule.index === 0 ? 25 : 20);
    if (words(body) > limit) warnings.push(`${n} is ${words(body)} words, longer than its ${rule.maxWords}-word target.`);
    if (words(body) < 12) return { steps, warnings, error: `${n} is too short to make sense` };
    steps.push({ subject, body });
  }
  return { steps, warnings };
}

export class WriterRejected extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WriterRejected";
  }
}

/** Can this sequence be written without an AI key? (Only fixed templates with no {{observation}}.) */
export const writableWithoutAi = (steps: SequenceStep[]) => !hasAiSteps(steps) && !needsObservation(steps);

export async function writeEmails(input: {
  prospect: Row;
  company: Row;
  research: ResearchJson;
  segment: Row | null;
  offer: Offer | null;
  settings: CampaignSettings;
  agent: AgentSettings;
  /** The campaign's sequence. Without it, the old follow-up settings decide (back-compat). */
  steps?: SequenceStep[];
  sequenceLanguage?: SequenceLanguage;
  sequenceVersion?: number;
  instruction?: string;
  previous?: ProspectEmails | null;
}): Promise<ProspectEmails> {
  const { prospect: p, company: co, research, segment, offer, settings, agent } = input;
  const lengthCap = agent.tone.length === "very_short" ? 60 : agent.tone.length === "short" ? 90 : 120;
  const steps: SequenceStep[] = input.steps?.length ? input.steps : stepsFromSettings(settings.followUps, settings.followUpDelays, lengthCap);
  const language = resolveLanguage(settings, co, input.sequenceLanguage);
  const first = p.first_name || "";
  const aiIdx = steps.map((s, i) => (s.kind === "ai" ? i : -1)).filter((i) => i >= 0);
  const wantObservation = needsObservation(steps);
  const rules = rulesFor(steps, agent.bookingLink);
  const facts = sequenceFacts(steps);
  const vars = {
    first_name: first || (language === "ar" ? "" : "there"),
    company: String(co.name || co.domain || ""),
    hook: research.hooks[0] || "",
    sender_name: agent.senderName || "",
  };
  const angleLabel = (a: string) => ANGLES.find((x) => x.id === a)?.label || a;

  const describe = (s: SequenceStep, i: number) => {
    const head = i === 0 ? "Email 1 (first email, day 0)" : `Email ${i + 1} (${s.delayDays} day${s.delayDays === 1 ? "" : "s"} after email ${i})`;
    if (s.kind === "template") return `${head}: FIXED TEXT, do not write it. For context:\n${renderTemplate(`${s.subject ? `Subject: ${s.subject}\n` : ""}${s.body}`, { ...vars, observation: "[the observation you write]" })}`;
    const subj = i === 0 ? "a subject of 2-5 words, not clickbait, no exclamation marks" : s.newThread ? "its own short subject (it starts a new thread)" : 'subject "" (a reply in the same thread)';
    const link = i === 0 ? "NO links, no attachments." : s.bookingLink && agent.bookingLink ? `You may include the booking link ${agent.bookingLink}; no other links.` : "No links.";
    return `${head} — WRITE IT. Angle: ${angleLabel(s.angle)}. ${s.instructions} ${subj}. At most ${s.maxWords} words. ${link}`;
  };

  // Nothing for the AI to do: fixed templates without {{observation}}.
  if (!aiIdx.length && !wantObservation) {
    const rendered = steps.map((s) => ({ subject: renderTemplate(s.subject, vars), body: renderTemplate(s.body, vars) }));
    const checked = checkEmails(rendered, steps.length, { offer, agent, maxWords1: steps[0].maxWords, rules, extraFacts: facts });
    if (checked.error) throw new WriterRejected(checked.error);
    return finish(checked.steps, checked.warnings);
  }

  const prompt = [
    aiIdx.length ? "Write the emails of a cold email sequence to one person, following the plan below." : "Write one observation for a cold email to one person.",
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
    research.hooks.length ? `Specific observations (use ONE, in the first email you write): ${research.hooks.join(" | ")}` : "No specific observations — use what they do instead.",
    segment?.why ? `Why companies like this fit: ${segment.why}` : "",
    "",
    "THE SEQUENCE",
    ...steps.map(describe),
    "",
    "RULES",
    `Language: ${language === "ar" ? "Modern Standard Arabic, formal, no transliteration" : "English"}.`,
    first ? `Greet them as "${first}".` : "",
    "Each email you write takes a different angle from the others; never repeat a point. No guilt-tripping.",
    `Sign off as ${agent.senderName || "the sender"}${agent.signature ? ` with this signature:\n${agent.signature}` : ""}.`,
    "Never invent customers, numbers, discounts or features that are not in the facts above.",
    wantObservation ? 'Also write "observation": ONE sentence addressed to them about one specific thing from the research (it goes into the fixed text where it says [the observation you write]).' : "",
    input.instruction ? `Extra instruction from the user: ${input.instruction}` : "",
    input.previous ? `Previous version (improve on it, don't repeat it):\n${input.previous.steps.map((s, i) => `Email ${i + 1}: ${s.subject}\n${s.body}`).join("\n---\n")}` : "",
    "",
    `Return JSON: {${wantObservation ? '"observation": string, ' : ""}"steps":[{"subject": string, "body": string}]} with exactly ${aiIdx.length} item(s) in "steps", one per email marked WRITE IT, in order. Plain text bodies with \\n line breaks.`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await llm<any>({
      tier: "smart",
      json: true,
      task: aiIdx.length ? `campaign:write:${co.domain}` : `campaign:observe:${co.domain}`,
      temperature: attempt ? 0.5 : 0.7,
      system: voicePrompt(agent),
      prompt: attempt ? `${prompt}\n\nThe previous attempt was rejected: ${lastError}. Fix that.` : prompt,
    });
    const list = Array.isArray(r.data?.steps) ? r.data.steps : Array.isArray(r.data) ? r.data : [];
    const observation = typeof r.data?.observation === "string" ? r.data.observation.replace(/\s+/g, " ").trim() : "";
    if (wantObservation && observation.length < 12) {
      lastError = "the observation was missing or too short";
      continue;
    }
    // Merge: AI steps in order, templates rendered in place.
    const merged: { subject?: string; body?: string }[] = [];
    let k = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.kind === "ai") merged.push(list[k++] || {});
      else merged.push({ subject: renderTemplate(s.subject, { ...vars, observation }), body: renderTemplate(s.body, { ...vars, observation }) });
    }
    const checked = checkEmails(merged, steps.length, { offer, agent, maxWords1: steps[0].maxWords, rules, extraFacts: facts });
    if (!checked.error) return finish(checked.steps, checked.warnings);
    lastError = checked.error;
  }
  throw new WriterRejected(lastError);

  function finish(out: { subject: string; body: string }[], warnings: string[]): ProspectEmails {
    const emailSteps: EmailStep[] = out.map((s, i) => ({ subject: s.subject, body: s.body, delayDays: i === 0 ? 0 : steps[i].delayDays }));
    return { steps: emailSteps, language, source: "ai", writtenAt: nowIso(), warnings, ...(input.sequenceVersion ? { sequenceVersion: input.sequenceVersion } : {}) };
  }
}
