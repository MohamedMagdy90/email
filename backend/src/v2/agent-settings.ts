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
  s.sending.maxCatchAllShare = clamp(s.sending.maxCatchAllShare, 0, 1, d.sending.maxCatchAllShare);
  s.sending.minFitScore = clamp(s.sending.minFitScore, 0, 100, d.sending.minFitScore);
  if (!["auto", "en", "ar"].includes(s.language)) s.language = d.language;
  return s;
}

export async function getAgentSettings(): Promise<AgentSettings> {
  const saved = parseJson<Partial<AgentSettings>>(await getSetting("agent_settings"), {});
  return sanitize(mergeDeep(DEFAULT_AGENT_SETTINGS, saved));
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
