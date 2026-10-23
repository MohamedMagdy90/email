// Sequences API (Phase 7, plan §8.5) — the steps every lead gets.
// BINDING CONTRACT with backend/src/v2/sequences/**.
import { req } from "../api";
import { j, put } from "./core";

export type StepKind = "ai" | "template";
export type StepAngle = "observation" | "outcome" | "proof" | "question" | "close";
export type SequenceLanguage = "auto" | "en" | "ar";

export interface SequenceStep {
  id: string;
  delayDays: number; // 0 for the first email; days after the previous step otherwise
  kind: StepKind;
  angle: StepAngle;
  instructions: string;
  maxWords: number;
  newThread: boolean; // step 2+: own subject (true) or a reply in the thread
  bookingLink: boolean; // never on step 1
  subject: string; // template steps
  body: string; // template steps
}

export interface Sequence {
  id: string;
  campaignId: string;
  name: string;
  language: SequenceLanguage;
  steps: SequenceStep[];
  version: number;
  updatedAt: string;
}

export interface SequenceCounts {
  /** written / approved, not in Instantly yet */
  unsent: number;
  /** of those, written with an older version */
  stale: number;
  inInstantly: number;
  /** in Instantly and still going through the steps */
  active: number;
}

export interface SequenceDetail extends SequenceCounts {
  campaign: { id: string; name: string; kind: "customer" | "partner"; status: string; instantly: boolean };
  sequence: Sequence;
  versions: { version: number; steps: number; createdAt: string }[];
  bookingLink: string;
  senderName: string;
  ai: boolean;
  previewLeads: { id: string; name: string | null; title: string | null; company: string | null; stage: string }[];
}

export interface SequenceOverview extends SequenceCounts {
  campaign: { id: string; name: string; kind: "customer" | "partner"; status: string };
  sequence: Sequence;
  repliesByStep: Record<number, number>;
}

export interface PreviewEmail {
  subject: string;
  body: string;
  delayDays: number;
  words: number;
  maxWords: number;
  kind: StepKind;
}
export interface SequencePreview {
  lead: { id: string | null; name: string | null; company: string | null; sample: boolean } | null;
  emails: PreviewEmail[];
  language?: "en" | "ar";
  warnings: string[];
  error: string | null;
  ai: boolean;
}

export interface StarterTemplate {
  id: string;
  name: string;
  description: string;
  kind: "customer" | "partner" | "any";
  language: SequenceLanguage;
  steps: SequenceStep[];
}

export interface StepStats {
  step: number;
  angle: StepAngle;
  kind: StepKind;
  sent: number;
  replies: number;
  replyRate: number | null;
  reached: number;
  ourReplies: number;
  bounced: number;
  unsubscribed: number;
}

export const ANGLE_LABEL: Record<StepAngle, string> = { observation: "Observation", outcome: "Outcome", proof: "Proof", question: "Question", close: "Close the loop" };
export const ANGLE_HINT: Record<StepAngle, string> = {
  observation: "Something specific about their company, then why it matters",
  outcome: "One result companies like theirs get",
  proof: "A fact from the offer or knowledge base that backs it up",
  question: "One short, easy question",
  close: "A polite last note that makes it easy to say no",
};
export const VARIABLES = ["first_name", "company", "observation", "hook", "sender_name"] as const;
export const MAX_STEPS = 4;

const C = (id: string) => `/api/v2/campaigns/${id}/sequence`;

export const sequencesApi = {
  list: (campaign?: string) => req<{ sequences: SequenceOverview[] }>(`/api/v2/sequences${campaign ? `?campaign=${encodeURIComponent(campaign)}` : ""}`),
  templates: () => req<{ templates: StarterTemplate[]; angleInstructions: Record<StepAngle, string>; maxSteps: number; variables: string[] }>("/api/v2/sequences/templates"),
  get: (campaignId: string) => req<SequenceDetail>(C(campaignId)),
  save: (campaignId: string, sequence: Pick<Sequence, "name" | "language" | "steps">) => req<SequenceDetail & { changed: boolean; instantlyUpdate: "patched" | "skipped" | "failed" }>(C(campaignId), put({ sequence })),
  preview: (campaignId: string, body: { prospectId?: string; sequence?: Pick<Sequence, "name" | "language" | "steps"> }) => req<SequencePreview>(`${C(campaignId)}/preview`, j(body)),
  rewriteUnsent: (campaignId: string, all = false) => req<{ rewritten: number; version: number }>(`${C(campaignId)}/rewrite-unsent`, j({ all })),
  stats: (campaignId: string) => req<{ version: number; source: "instantly" | "ours"; contacted: number; steps: StepStats[] }>(`${C(campaignId)}/stats`),
};

export function newStep(i: number): SequenceStep {
  const angle: StepAngle = i === 0 ? "observation" : i === 1 ? "proof" : i === 2 ? "close" : "question";
  return { id: Math.random().toString(36).slice(2, 10), delayDays: i === 0 ? 0 : i === 1 ? 3 : 4, kind: "ai", angle, instructions: "", maxWords: i === 0 ? 90 : 60, newThread: i === 0, bookingLink: false, subject: "", body: "" };
}

/** Day each step goes out (cumulative), e.g. [0, 3, 7]. */
export const dayOf = (steps: SequenceStep[]) => steps.reduce<number[]>((acc, s, i) => [...acc, i === 0 ? 0 : acc[i - 1] + (s.delayDays || 0)], []);
