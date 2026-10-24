// Agent tab API: reply categories, rule previews, voice previews and
// candidate-key tests. Settings + integrations themselves live in core.ts.
import { req } from "../api";
import { j, type AgentSettings, type IntegrationTarget } from "./core";

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
  description: string;
  kind: "reply" | "silent" | "human";
  safe: boolean;
  locked?: boolean;
  handling: string;
}

export type ReplyAction = "send" | "draft" | "handoff" | "silent";

export interface ReplyDecision {
  action: ReplyAction;
  reason: string;
  delayMinutes?: [number, number];
}

export interface SampleProspect {
  name: string;
  title: string;
  company: string;
  city: string;
  country: string;
  research: string[];
}

export interface AgentMeta {
  categories: ReplyCategory[];
  defaults: AgentSettings;
  sample: { prospect: SampleProspect; inbound: { subject: string; body: string } };
}

export interface RulesPreview {
  categories: { id: ReplyCategoryId; outcome: ReplyDecision }[];
  scenario: ReplyDecision | null;
}

export interface Scenario {
  category: ReplyCategoryId;
  confidence: number;
  autoRepliesInThread: number;
}

export type SampleKind = "first_touch" | "reply";

export interface VoicePreview {
  kind: SampleKind;
  voice: string;
  system: string;
  prompt: string;
  sample: { subject: string; body: string; provider: string; model: string } | null;
  error?: string;
  errorKind?: "budget" | "unavailable";
}

export interface TestResult {
  ok: boolean;
  error?: string;
  model?: string;
  ms?: number;
  accounts?: number;
  sample?: string;
}

export const agentApi = {
  meta: () => req<AgentMeta>("/api/v2/agent/meta"),
  rules: (settings: AgentSettings, scenario?: Scenario) => req<RulesPreview>("/api/v2/agent/rules/preview", j({ settings, scenario })),
  voice: (settings: AgentSettings, sample: SampleKind, generate = false) =>
    req<VoicePreview>("/api/v2/agent/voice/preview", j({ settings, sample, generate })),
  /** Test values BEFORE saving them (no values = test what's saved). */
  test: (target: IntegrationTarget, values: { key?: string } = {}) =>
    req<TestResult>("/api/v2/integrations/test", j({ target, ...values })),
};
