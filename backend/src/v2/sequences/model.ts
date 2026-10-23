// Sequences (Phase 7, plan §8.5) — the steps every lead gets. Pure: types,
// validation, the starter library, the conversion from the old follow-up
// settings, and template rendering. No database here.

export type StepKind = "ai" | "template";
export type StepAngle = "observation" | "outcome" | "proof" | "question" | "close";
export type SequenceLanguage = "auto" | "en" | "ar";

export interface SequenceStep {
  id: string;
  /** 0 for the first email; otherwise days after the previous step. */
  delayDays: number;
  kind: StepKind;
  angle: StepAngle;
  /** Plain words: what this step must do. */
  instructions: string;
  maxWords: number;
  /** Step 2+: its own subject (a new thread) or a reply in the same thread. Step 1 always has a subject. */
  newThread: boolean;
  /** May this step carry the booking link? Never on step 1. */
  bookingLink: boolean;
  /** Template steps: fixed text with {{variables}}. */
  subject: string;
  body: string;
}

export interface SequenceDef {
  name: string;
  language: SequenceLanguage;
  steps: SequenceStep[];
}

export const MAX_STEPS = 4;
export const ANGLES: { id: StepAngle; label: string; hint: string }[] = [
  { id: "observation", label: "Observation", hint: "Something specific about their company, then why it matters" },
  { id: "outcome", label: "Outcome", hint: "One result companies like theirs get" },
  { id: "proof", label: "Proof", hint: "A fact from the offer or knowledge base that backs it up" },
  { id: "question", label: "Question", hint: "One short, easy question" },
  { id: "close", label: "Close the loop", hint: "A polite last note that makes it easy to say no" },
];
export const VARIABLES = ["first_name", "company", "observation", "hook", "sender_name"] as const;
export type Variable = (typeof VARIABLES)[number];

const rid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : "");

/** Default instructions per angle (also what the old hard-coded writer did). */
export const ANGLE_INSTRUCTIONS: Record<StepAngle, string> = {
  observation: "Greet them by first name. Open with ONE specific observation about their company from the research, link it to ONE relevant outcome we give companies like theirs, and end with ONE short question. No links, no attachments.",
  outcome: "A new angle: one concrete outcome companies like theirs get from us, in their terms. One short question at the end.",
  proof: "A new angle: one proof point from the facts (a feature, a regulation we already handle, a customer type we serve). Keep it short; a quick question at the end.",
  question: "One short, easy-to-answer question about how they handle this today. Nothing else.",
  close: "A polite close-the-loop: if it isn't a priority, that's fine; ask them to say so and you'll stop writing. No guilt-tripping.",
};

export function newStep(i: number, angle: StepAngle = i === 0 ? "observation" : i === 1 ? "proof" : "close", delay?: number): SequenceStep {
  return {
    id: rid(),
    delayDays: i === 0 ? 0 : delay ?? (i === 1 ? 3 : 4),
    kind: "ai",
    angle,
    instructions: ANGLE_INSTRUCTIONS[angle],
    maxWords: i === 0 ? 90 : 60,
    newThread: i === 0,
    bookingLink: false,
    subject: "",
    body: "",
  };
}

export function sanitizeStep(raw: any, i: number): SequenceStep {
  const r = raw && typeof raw === "object" ? raw : {};
  const angle: StepAngle = ANGLES.some((a) => a.id === r.angle) ? r.angle : i === 0 ? "observation" : "proof";
  const kind: StepKind = r.kind === "template" ? "template" : "ai";
  return {
    id: typeof r.id === "string" && /^[\w-]{1,40}$/.test(r.id) ? r.id : rid(),
    delayDays: i === 0 ? 0 : clamp(r.delayDays, 1, 30, 3),
    kind,
    angle,
    instructions: s(r.instructions, 1200) || ANGLE_INSTRUCTIONS[angle],
    maxWords: clamp(r.maxWords, 25, 250, i === 0 ? 90 : 60),
    newThread: i === 0 ? true : !!r.newThread,
    bookingLink: i === 0 ? false : !!r.bookingLink,
    subject: s(r.subject, 160),
    body: s(r.body, 4000),
  };
}

export class SequenceInvalid extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SequenceInvalid";
  }
}

/** Validate a sequence from the editor. Throws SequenceInvalid with a plain-English reason. */
export function sanitizeSequence(raw: any, base?: SequenceDef): SequenceDef {
  const r = raw && typeof raw === "object" ? raw : {};
  const list = Array.isArray(r.steps) ? r.steps : base?.steps || [];
  if (!list.length) throw new SequenceInvalid("A sequence needs at least the first email.");
  if (list.length > MAX_STEPS) throw new SequenceInvalid(`At most ${MAX_STEPS} steps: the first email and ${MAX_STEPS - 1} follow-ups.`);
  const steps = list.map((x: any, i: number) => sanitizeStep(x, i));
  const seen = new Set<string>();
  for (const st of steps) {
    if (seen.has(st.id)) st.id = rid();
    seen.add(st.id);
  }
  steps.forEach((st: SequenceStep, i: number) => {
    if (st.kind !== "template") return;
    const n = i === 0 ? "The first email" : `Follow-up ${i}`;
    if (!st.body.trim()) throw new SequenceInvalid(`${n} is a template but has no text.`);
    if ((i === 0 || st.newThread) && !st.subject.trim()) throw new SequenceInvalid(`${n} starts a thread, so its template needs a subject.`);
    const bad = unknownVariables(`${st.subject}\n${st.body}`);
    if (bad.length) throw new SequenceInvalid(`${n} uses ${bad.map((v) => `{{${v}}}`).join(", ")}, which isn't a variable. Use ${VARIABLES.map((v) => `{{${v}}}`).join(" ")}.`);
  });
  const language: SequenceLanguage = ["auto", "en", "ar"].includes(r.language) ? r.language : base?.language || "auto";
  return { name: s(r.name, 80) || base?.name || "Sequence", language, steps };
}

export function unknownVariables(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!(VARIABLES as readonly string[]).includes(m[1])) out.add(m[1]);
  return [...out];
}

/** The sequence the old settings described (followUps + followUpDelays) — what the writer did before Phase 7. */
export function stepsFromSettings(followUps: number, delays: [number, number], maxWords1 = 90): SequenceStep[] {
  const steps = [newStep(0)];
  steps[0].maxWords = maxWords1;
  if (followUps >= 1) steps.push(newStep(1, "proof", delays[0] || 3));
  if (followUps >= 2) steps.push(newStep(2, "close", delays[1] || 4));
  return steps;
}

/* ------------------------------- starters ------------------------------- */

export interface StarterTemplate {
  id: string;
  name: string;
  description: string;
  kind: "customer" | "partner" | "any";
  language: SequenceLanguage;
  steps: SequenceStep[];
}

function st(i: number, p: Partial<SequenceStep>): SequenceStep {
  return sanitizeStep({ ...newStep(i, p.angle), ...p }, i);
}

export const STARTERS: StarterTemplate[] = [
  {
    id: "customer-3",
    name: "Customer · 3 steps",
    description: "Observation, then a proof point, then a polite close. The default for customer campaigns.",
    kind: "customer",
    language: "auto",
    steps: [st(0, { angle: "observation" }), st(1, { angle: "proof", delayDays: 3 }), st(2, { angle: "close", delayDays: 4 })],
  },
  {
    id: "partner-3",
    name: "Partner · 3 steps (Makers program)",
    description: "For accountants, IT resellers and consultancies: the fit with their clients, the Makers commission, then a close.",
    kind: "partner",
    language: "auto",
    steps: [
      st(0, { angle: "observation", instructions: "Greet them by first name. One specific observation about their firm and the kind of clients they serve, then why an ERP built for Gulf SMEs fits those clients. End with one short question about whether they recommend or implement software for clients. No links." }),
      st(1, { angle: "outcome", delayDays: 4, instructions: "Explain the Makers partner program in two sentences: 15% recurring commission for referrals, 35% for partners who resell and implement. One question: which would suit them?" }),
      st(2, { angle: "close", delayDays: 5, bookingLink: true, instructions: "Short close-the-loop. Offer a 15-minute call to walk through the program; you may include the booking link. Easy to say no." }),
    ],
  },
  {
    id: "arabic-formal-3",
    name: "Arabic formal · 3 steps",
    description: "Modern Standard Arabic, formal address, for companies whose site is Arabic first.",
    kind: "any",
    language: "ar",
    steps: [
      st(0, { angle: "observation", instructions: "اكتب بالعربية الفصحى وبأسلوب رسمي. ابدأ بتحية رسمية بالاسم، ثم ملاحظة واحدة محددة عن شركتهم من البحث، ثم فائدة واحدة نقدمها لشركات مثلها، واختم بسؤال قصير واحد. بدون روابط." }),
      st(1, { angle: "proof", delayDays: 3, instructions: "اكتب بالعربية الفصحى. زاوية جديدة: حقيقة واحدة من المعلومات المتاحة (مثل الفوترة الإلكترونية مع هيئة الزكاة)، ثم سؤال قصير." }),
      st(2, { angle: "close", delayDays: 4, instructions: "اكتب بالعربية الفصحى. رسالة ختامية مهذبة: إن لم يكن الموضوع أولوية الآن فلا بأس، ويكفي أن يخبرونا لنتوقف عن المراسلة." }),
    ],
  },
  {
    id: "short-2",
    name: "Short · 2 steps",
    description: "One short email and one question. For lists where less is more.",
    kind: "any",
    language: "auto",
    steps: [st(0, { angle: "observation", maxWords: 60 }), st(1, { angle: "question", delayDays: 4, maxWords: 40 })],
  },
  {
    id: "template-opener",
    name: "Template opener · 3 steps",
    description: "Your own wording for the first email; the AI fills in one observation. Follow-ups are written per lead.",
    kind: "any",
    language: "en",
    steps: [
      st(0, {
        kind: "template",
        angle: "observation",
        subject: "{{company}} and month-end",
        body: "Hi {{first_name}},\n\n{{observation}}\n\nMost distributors we talk to in the Gulf still close the month across three systems. DNA ERP keeps stock, sales and accounts in one place, with ZATCA e-invoicing built in.\n\nWorth a short call to see if it fits {{company}}?\n\n{{sender_name}}",
      }),
      st(1, { angle: "proof", delayDays: 3 }),
      st(2, { angle: "close", delayDays: 4 }),
    ],
  },
];

export function starterFor(kind: "customer" | "partner"): StarterTemplate {
  return STARTERS.find((t) => t.kind === kind) || STARTERS[0];
}

/** A fresh copy of a starter's steps (new ids). */
export function cloneSteps(steps: SequenceStep[]): SequenceStep[] {
  return steps.map((x, i) => sanitizeStep({ ...x, id: rid() }, i));
}

/* ------------------------------ rendering ------------------------------- */

export function renderTemplate(text: string, vars: Partial<Record<Variable, string>>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k: string) => (vars[k as Variable] !== undefined ? String(vars[k as Variable]) : all));
}

export const needsObservation = (steps: SequenceStep[]) => steps.some((x) => x.kind === "template" && /\{\{\s*observation\s*\}\}/.test(`${x.subject} ${x.body}`));
export const hasAiSteps = (steps: SequenceStep[]) => steps.some((x) => x.kind === "ai");

/** Words used in the rules (instructions + templates): numbers there are sanctioned by the user. */
export function sequenceFacts(steps: SequenceStep[]): string {
  return steps.map((x) => `${x.instructions} ${x.subject} ${x.body}`).join(" ");
}
