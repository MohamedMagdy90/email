// The agent's voice and behaviour — one JSON blob in settings["agent_settings"].
// Used by the email writer (first touch + follow-ups) and the auto-replier.
import { getSetting, setSetting } from "../db";
import { parseJson } from "./events";

export interface ToneSettings {
  /** 0 = very casual, 100 = very formal */
  formality: number;
  /** 0 = matter-of-fact, 100 = very warm/friendly */
  warmth: number;
  /** 0 = soft, 100 = direct/assertive */
  directness: number;
  length: "very_short" | "short" | "medium";
  /** Free-text style guidance, e.g. "no buzzwords, sound like a founder" */
  styleNotes: string;
  /** Things the agent must never say/claim */
  avoid: string;
}

export interface AutoReplySettings {
  enabled: boolean;
  /** full = send automatically · safe = only low-risk categories · drafts = never send, draft only */
  mode: "full" | "safe" | "drafts";
  /** Never auto-send more than this many replies in one thread; then hand to a human. */
  maxPerThread: number;
  /** Below this classifier confidence the thread goes to a human. 0-1 */
  minConfidence: number;
  /** Human-like delay before an auto-reply is sent. */
  delayMinMinutes: number;
  delayMaxMinutes: number;
  /** Categories that ALWAYS go to a human (never auto-replied). */
  handoffCategories: string[];
  /** Reply politely to "not interested" (true) or stay silent (false). */
  acknowledgeNotInterested: boolean;
}

export interface SendingPolicy {
  /** Send to role addresses (info@, sales@) when no person is found. */
  allowRoleAddresses: boolean;
  /** Send to pattern-guessed addresses that could not be SMTP-verified. */
  allowUnverifiedGuesses: boolean;
  /** Max share of a day's sends that may go to catch-all domains (0-1). */
  maxCatchAllShare: number;
  /** Minimum fit score (0-100) for a company to be contacted. */
  minFitScore: number;
}

export interface AgentSettings {
  senderName: string;
  senderTitle: string;
  companyName: string;
  website: string;
  signature: string;
  bookingLink: string;
  /** Facts the agent may use when answering questions (pricing, features, regions, proof). */
  knowledgeBase: string;
  tone: ToneSettings;
  autoReply: AutoReplySettings;
  sending: SendingPolicy;
  /** auto = Arabic for Arabic replies / when the lead writes Arabic; else English */
  language: "auto" | "en" | "ar";
}

/* --------------------------- reply categories --------------------------- */
// What the inbox classifier can call a reply, and what the agent does with it.
// The Inbox workstream classifies into these ids and calls decideReply().
//   reply   the agent writes an answer (subject to mode, hand-off, guardrails)
//   silent  housekeeping only — no email goes out (stop / block / pause)
//   human   always handed to a person; can't be switched to automatic

export type ReplyCategoryId =
  | "interested"
  | "question"
  | "not_now"
  | "referral"
  | "not_interested"
  | "negotiation"
  | "complaint"
  | "legal"
  | "needs_human"
  | "unsubscribe"
  | "out_of_office"
  | "bounce";

export interface ReplyCategory {
  id: ReplyCategoryId;
  label: string;
  /** What the prospect's message looks like. */
  description: string;
  kind: "reply" | "silent" | "human";
  /** Low-risk: "Safe replies only" mode may send these without approval. */
  safe: boolean;
  /** Always handed to a person, whatever the settings say. */
  locked?: boolean;
  /** What the agent writes / does when it handles it automatically. */
  handling: string;
}

export const REPLY_CATEGORIES: ReplyCategory[] = [
  {
    id: "interested",
    label: "Interested",
    description: "Wants a call, a demo or the next step.",
    kind: "reply",
    safe: false,
    handling: "Proposes a time and adds your booking link.",
  },
  {
    id: "question",
    label: "Question",
    description: "Asks about price, features, Arabic, ZATCA, fit.",
    kind: "reply",
    safe: false,
    handling: "Answers from the knowledge base only, then asks one question back.",
  },
  {
    id: "not_now",
    label: "Not now",
    description: "Timing is wrong, asks you to come back later.",
    kind: "reply",
    safe: true,
    handling: "Thanks them and confirms when it will check back.",
  },
  {
    id: "referral",
    label: "Referral",
    description: "Points to a colleague who handles this.",
    kind: "reply",
    safe: true,
    handling: "Thanks them and asks for a short intro to that person.",
  },
  {
    id: "not_interested",
    label: "Not interested",
    description: "A clear, polite no.",
    kind: "reply",
    safe: true,
    handling: "Stops the sequence. Sends a one-line thank-you only if you allow it.",
  },
  {
    id: "negotiation",
    label: "Negotiation",
    description: "Discounts, contracts, payment terms, custom deals.",
    kind: "reply",
    safe: false,
    handling: "Answers within the knowledge base; never offers a discount.",
  },
  {
    id: "complaint",
    label: "Complaint",
    description: "Annoyed, or says the email is spam.",
    kind: "reply",
    safe: false,
    handling: "Apologises briefly and confirms they won't be emailed again.",
  },
  {
    id: "legal",
    label: "Legal or data request",
    description: "Data-protection requests, legal language, threats.",
    kind: "human",
    safe: false,
    locked: true,
    handling: "Always comes to you. The sequence stops straight away.",
  },
  {
    id: "needs_human",
    label: "Unclear",
    description: "Doesn't fit anything above, or the agent can't tell.",
    kind: "human",
    safe: false,
    locked: true,
    handling: "Always comes to you.",
  },
  {
    id: "unsubscribe",
    label: "Unsubscribe",
    description: "Asks to stop or be removed.",
    kind: "silent",
    safe: true,
    handling: "Stops everything and blocks the address in Instantly. No reply.",
  },
  {
    id: "out_of_office",
    label: "Out of office",
    description: "Auto-responder: away, on leave, changed jobs.",
    kind: "silent",
    safe: true,
    handling: "Pauses the sequence until their return date. No reply.",
  },
  {
    id: "bounce",
    label: "Bounce",
    description: "Delivery failure from a mail server.",
    kind: "silent",
    safe: true,
    handling: "Marks the address undeliverable. No reply.",
  },
];

export type ReplyAction = "send" | "draft" | "handoff" | "silent";

export interface ReplyDecision {
  action: ReplyAction;
  /** Plain-English why, shown in the UI and logged by the inbox. */
  reason: string;
  /** For `send`: wait a random number of minutes in this window first. */
  delayMinutes?: [number, number];
}

/**
 * The one place that decides what happens to a classified reply.
 * Pure — no I/O — so the Agent tab can preview it with unsaved settings.
 */
export function decideReply(
  s: AgentSettings,
  input: { category: string; confidence?: number; autoRepliesInThread?: number }
): ReplyDecision {
  const cat = REPLY_CATEGORIES.find((c) => c.id === input.category) || REPLY_CATEGORIES.find((c) => c.id === "needs_human")!;
  const a = s.autoReply;
  const rawConf = Number(input.confidence ?? 1);
  const confidence = Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0; // garbage -> hand to a human
  const rawSent = Number(input.autoRepliesInThread ?? 0);
  const sent = Number.isFinite(rawSent) ? Math.max(0, Math.floor(rawSent)) : 0;
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  // Housekeeping happens even with auto-reply off — it protects the domains.
  if (cat.kind === "silent") return { action: "silent", reason: cat.handling };
  if (cat.id === "not_interested" && !a.acknowledgeNotInterested) {
    return { action: "silent", reason: "Stops the sequence and sends nothing, because acknowledging a no is switched off." };
  }
  if (cat.locked) return { action: "handoff", reason: `${cat.label} always comes to you.` };
  if (!a.enabled) return { action: "handoff", reason: "Auto-reply is off, so every reply waits for you." };
  if (a.handoffCategories.includes(cat.id)) return { action: "handoff", reason: `You chose to handle ${cat.label.toLowerCase()} replies yourself.` };
  if (confidence < a.minConfidence) {
    return {
      action: "handoff",
      reason: `The agent is only ${pct(confidence)} sure this is "${cat.label}", under your ${pct(a.minConfidence)} bar.`,
    };
  }
  if (sent >= a.maxPerThread) {
    return {
      action: "handoff",
      reason:
        a.maxPerThread === 0
          ? "Auto-replies per thread is set to 0, so the agent never sends on its own."
          : `The agent already sent ${sent} auto-repl${sent === 1 ? "y" : "ies"} in this thread (limit ${a.maxPerThread}).`,
    };
  }
  if (a.mode === "drafts") return { action: "draft", reason: "Drafts only: the reply is written and waits for you to press send." };
  if (a.mode === "safe" && !cat.safe) {
    return { action: "draft", reason: `Safe replies only: ${cat.label.toLowerCase()} is not on the low-risk list, so it's drafted for approval.` };
  }
  const delay: [number, number] = [a.delayMinMinutes, a.delayMaxMinutes];
  return {
    action: "send",
    reason:
      delay[1] > 0
        ? `Sent ${delay[0] === delay[1] ? `${delay[0]}` : `${delay[0]}–${delay[1]}`} minutes after it arrives, from the same mailbox and thread.`
        : "Sent straight away, from the same mailbox and thread.",
    delayMinutes: delay,
  };
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  senderName: "",
  senderTitle: "",
  companyName: "DNA ERP",
  website: "https://dna.systems",
  signature: "",
  bookingLink: "",
  knowledgeBase: [
    "DNA ERP is a cloud ERP for growing companies in the Gulf and MENA: accounting, inventory, sales, purchasing, manufacturing, HR/payroll and POS in one system.",
    "Arabic and English interface, ZATCA e-invoicing ready (KSA), VAT ready for the GCC.",
    "Free trial available at dna.systems; implementation and data migration support included.",
    "Makers partner program: resellers earn 35% and referral partners 15% commission.",
  ].join("\n"),
  tone: {
    formality: 55,
    warmth: 60,
    directness: 60,
    length: "short",
    styleNotes: "Sound like a helpful founder, not a marketer. One clear idea per email. No buzzwords, no exclamation marks.",
    avoid: "Never invent customers, numbers or discounts. Never promise prices that are not in the knowledge base. No links in the first email.",
  },
  autoReply: {
    enabled: true,
    mode: "full",
    maxPerThread: 4,
    minConfidence: 0.7,
    delayMinMinutes: 6,
    delayMaxMinutes: 25,
    handoffCategories: ["needs_human", "complaint", "legal", "negotiation"],
    acknowledgeNotInterested: false,
  },
  sending: {
    allowRoleAddresses: false,
    allowUnverifiedGuesses: false,
    maxCatchAllShare: 0.15,
    minFitScore: 60,
  },
  language: "auto",
};

function mergeDeep<T>(base: T, patch: any): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return (patch ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch)) {
    const b = (base as any)?.[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? mergeDeep(b, v) : v;
  }
  return out;
}

const clamp = (n: any, lo: number, hi: number, d: number) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};

function sanitize(s: AgentSettings): AgentSettings {
  const d = DEFAULT_AGENT_SETTINGS;
  s.tone.formality = clamp(s.tone.formality, 0, 100, d.tone.formality);
  s.tone.warmth = clamp(s.tone.warmth, 0, 100, d.tone.warmth);
  s.tone.directness = clamp(s.tone.directness, 0, 100, d.tone.directness);
  if (!["very_short", "short", "medium"].includes(s.tone.length)) s.tone.length = d.tone.length;
  if (!["full", "safe", "drafts"].includes(s.autoReply.mode)) s.autoReply.mode = d.autoReply.mode;
  s.autoReply.maxPerThread = clamp(s.autoReply.maxPerThread, 0, 20, d.autoReply.maxPerThread);
  s.autoReply.minConfidence = clamp(s.autoReply.minConfidence, 0, 1, d.autoReply.minConfidence);
  s.autoReply.delayMinMinutes = clamp(s.autoReply.delayMinMinutes, 0, 600, d.autoReply.delayMinMinutes);
  s.autoReply.delayMaxMinutes = Math.max(s.autoReply.delayMinMinutes, clamp(s.autoReply.delayMaxMinutes, 0, 1440, d.autoReply.delayMaxMinutes));
  if (!Array.isArray(s.autoReply.handoffCategories)) s.autoReply.handoffCategories = d.autoReply.handoffCategories;
  // Known ids only, de-duplicated; the locked ones are always in the list.
  const known = new Set<string>(REPLY_CATEGORIES.map((c) => c.id));
  const locked = REPLY_CATEGORIES.filter((c) => c.locked).map((c) => c.id);
  s.autoReply.handoffCategories = [...new Set([...s.autoReply.handoffCategories.map(String).filter((c) => known.has(c)), ...locked])];
  s.autoReply.enabled = !!s.autoReply.enabled;
  s.autoReply.acknowledgeNotInterested = !!s.autoReply.acknowledgeNotInterested;
  s.sending.allowRoleAddresses = !!s.sending.allowRoleAddresses;
  s.sending.allowUnverifiedGuesses = !!s.sending.allowUnverifiedGuesses;
  for (const k of ["senderName", "senderTitle", "companyName", "website", "signature", "bookingLink", "knowledgeBase"] as const) {
    s[k] = String(s[k] ?? "").slice(0, k === "knowledgeBase" ? 20000 : k === "signature" ? 2000 : 300);
  }
  s.tone.styleNotes = String(s.tone.styleNotes ?? "").slice(0, 2000);
  s.tone.avoid = String(s.tone.avoid ?? "").slice(0, 2000);
  s.sending.maxCatchAllShare = clamp(s.sending.maxCatchAllShare, 0, 1, d.sending.maxCatchAllShare);
  s.sending.minFitScore = clamp(s.sending.minFitScore, 0, 100, d.sending.minFitScore);
  if (!["auto", "en", "ar"].includes(s.language)) s.language = d.language;
  return s;
}

export async function getAgentSettings(): Promise<AgentSettings> {
  const saved = parseJson<Partial<AgentSettings>>(await getSetting("agent_settings"), {});
  // Clone: sanitize() writes in place and must never touch the shared defaults.
  return sanitize(mergeDeep(structuredClone(DEFAULT_AGENT_SETTINGS), saved));
}

/** Saved settings with an unsaved patch on top — for previews. Never writes. */
export async function resolveAgentSettings(patch?: Partial<AgentSettings> | null): Promise<AgentSettings> {
  const base = await getAgentSettings();
  if (!patch || typeof patch !== "object") return base;
  return sanitize(mergeDeep(base, structuredClone(patch)));
}

export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettings> {
  const next = sanitize(mergeDeep(await getAgentSettings(), patch));
  await setSetting("agent_settings", JSON.stringify(next));
  return next;
}

/** The voice section every writing prompt includes, so tone stays consistent. */
export function voicePrompt(s: AgentSettings, overrides?: Partial<ToneSettings>): string {
  const t = { ...s.tone, ...(overrides || {}) };
  const scale = (n: number, lo: string, mid: string, hi: string) => (n < 34 ? lo : n < 67 ? mid : hi);
  const words = t.length === "very_short" ? "40-60 words" : t.length === "short" ? "60-90 words" : "90-130 words";
  return [
    `You write as ${s.senderName || "a member of the team"}${s.senderTitle ? `, ${s.senderTitle}` : ""} at ${s.companyName} (${s.website}).`,
    `Tone: ${scale(t.formality, "casual and relaxed", "professional but conversational", "formal and polished")}; ${scale(
      t.warmth,
      "matter-of-fact",
      "friendly",
      "very warm and personable"
    )}; ${scale(t.directness, "soft and low-pressure", "clear", "direct and confident")}.`,
    `Length: ${words}. Plain text only — no markdown, no bullet symbols, no emojis, no HTML.`,
    t.styleNotes ? `Style: ${t.styleNotes}` : "",
    t.avoid ? `Hard rules: ${t.avoid}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
