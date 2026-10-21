// Agent playground: build the exact prompts the writer and the auto-replier
// use, against a fixed made-up prospect, so the Agent tab can show what the
// model is told and (with an AI key) write a sample in the current voice.
import { voicePrompt, type AgentSettings } from "./agent-settings";

export type SampleKind = "first_touch" | "reply";

/** Fictional prospect — never mailed, only used for previews. */
export const SAMPLE_PROSPECT = {
  name: "Khalid Al-Mansouri",
  title: "Operations Manager",
  company: "Gulf Fasteners Trading W.L.L.",
  city: "Doha",
  country: "Qatar",
  research: [
    "Distributes industrial fasteners and fixings to contractors across Qatar from three branches.",
    "Opened a second warehouse in Mesaieed this year.",
    "Currently hiring a storekeeper and an accountant.",
    "Invoices still go out from a desktop accounting package; stock is tracked per branch in spreadsheets.",
  ],
};

export const SAMPLE_INBOUND = {
  subject: "Re: two warehouses",
  body: "Thanks for reaching out. We run two warehouses and about 15 people would use it. Does it handle stock across both locations, and can invoices be in Arabic? Roughly what does it cost?",
};

function languageRule(s: AgentSettings): string {
  if (s.language === "ar") return "Write in Modern Standard Arabic.";
  if (s.language === "en") return "Write in English.";
  return "Write in the language the prospect uses (for this prospect: English).";
}

function signOff(s: AgentSettings): string {
  if (s.signature.trim()) return `End the body with a short sign-off, then this signature exactly as written:\n${s.signature.trim()}`;
  return `End the body with a short sign-off and the sender's first name${s.senderName ? ` (${s.senderName.split(/\s+/)[0]})` : ""}.`;
}

export function buildSamplePrompt(s: AgentSettings, kind: SampleKind): { system: string; prompt: string } {
  const p = SAMPLE_PROSPECT;
  if (kind === "first_touch") {
    return {
      system: [
        "You write the first cold email to one B2B prospect.",
        voicePrompt(s),
        "Structure: one specific observation from the research, one outcome that matters to this person, one question as the call to action.",
        "No links, no images, no attachments, no pricing. Never claim facts that aren't in the research or the company notes.",
        "Subject line: 2 to 5 words, specific, no clickbait, no emojis.",
        languageRule(s),
        signOff(s),
        'Respond with JSON only: {"subject": string, "body": string}. Use \\n for line breaks in the body.',
      ].join("\n\n"),
      prompt: [
        `Prospect: ${p.name}, ${p.title} at ${p.company} (${p.city}, ${p.country}).`,
        `Research:\n- ${p.research.join("\n- ")}`,
        `What we sell (company notes):\n${s.knowledgeBase || "(no notes yet)"}`,
      ].join("\n\n"),
    };
  }
  return {
    system: [
      "You answer a reply from a prospect, in the same email thread.",
      voicePrompt(s),
      "Answer every question they asked, using ONLY the facts below. If a fact isn't there (a price, for example), say you'll confirm it — never guess or invent numbers.",
      `Facts you may use:\n---\n${s.knowledgeBase || "(none)"}\n---`,
      s.bookingLink
        ? `If they want to talk, offer this booking link once: ${s.bookingLink}`
        : "If they want to talk, suggest two short time slots in the next few working days.",
      languageRule(s),
      signOff(s),
      'Respond with JSON only: {"subject": string, "body": string}. The subject starts with "Re: ". Use \\n for line breaks.',
    ].join("\n\n"),
    prompt: [
      `Prospect: ${p.name}, ${p.title} at ${p.company} (${p.city}, ${p.country}).`,
      `Their message (subject "${SAMPLE_INBOUND.subject}"):\n${SAMPLE_INBOUND.body}`,
    ].join("\n\n"),
  };
}

/** Normalise whatever the model returned into a subject + plain-text body. */
export function readSample(data: any, text: string): { subject: string; body: string } {
  const subject = String(data?.subject ?? "").trim();
  let body = String(data?.body ?? "").trim();
  if (!body) body = text.trim();
  body = body.replace(/\\n/g, "\n").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n");
  return { subject: subject.slice(0, 200), body: body.slice(0, 4000) };
}
