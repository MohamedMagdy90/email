// Shared v2 API: status, integrations, agent settings, activity feed.
// Feature modules (mailboxes / inbox / campaigns) live next to this file.
import { req } from "../api";

export const j = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
export const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });
export const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
export const del: RequestInit = { method: "DELETE" };

export interface V2Status {
  ai: { configured: boolean; canSearch: boolean; usage: { calls: number; errors: number; byProvider: Record<string, number> }; budget: number };
  instantly: { configured: boolean };
  reacher: { configured: boolean; url: string; hasSecret: boolean };
}

export interface Integrations {
  ai: {
    configured: boolean;
    canSearch: boolean;
    providers: {
      gemini: { configured: boolean; model: string; fastModel: string };
      groq: { configured: boolean; model: string };
      openrouter: { configured: boolean; model: string };
    };
    budget: number;
    usage: { calls: number; errors: number; byProvider: Record<string, number> };
  };
  keys: { gemini: string; groq: string; openrouter: string; instantly: string };
  instantly: { configured: boolean };
  reacher: { configured: boolean; url: string; hasSecret: boolean };
}

export type IntegrationTarget = "gemini" | "groq" | "openrouter" | "instantly" | "reacher";

export interface IntegrationsPatch {
  geminiKey?: string;
  groqKey?: string;
  openrouterKey?: string;
  instantlyKey?: string;
  reacherUrl?: string;
  reacherSecret?: string;
  geminiModel?: string;
  geminiFastModel?: string;
  groqModel?: string;
  openrouterModel?: string;
  aiDailyBudget?: string;
}

export interface ToneSettings {
  formality: number;
  warmth: number;
  directness: number;
  length: "very_short" | "short" | "medium";
  styleNotes: string;
  avoid: string;
}
export interface AgentSettings {
  senderName: string;
  senderTitle: string;
  companyName: string;
  website: string;
  signature: string;
  bookingLink: string;
  knowledgeBase: string;
  tone: ToneSettings;
  autoReply: {
    enabled: boolean;
    mode: "full" | "safe" | "drafts";
    maxPerThread: number;
    minConfidence: number;
    delayMinMinutes: number;
    delayMaxMinutes: number;
    handoffCategories: string[];
    acknowledgeNotInterested: boolean;
  };
  sending: {
    allowRoleAddresses: boolean;
    allowUnverifiedGuesses: boolean;
    maxCatchAllShare: number;
    minFitScore: number;
  };
  language: "auto" | "en" | "ar";
}

export interface AgentEvent {
  id: string;
  kind: string;
  level: "info" | "success" | "warn" | "error";
  ref_type: string | null;
  ref_id: string | null;
  campaign_id: string | null;
  message: string;
  created_at: string;
}

export interface VerifyResult {
  email: string;
  status: "valid" | "invalid" | "risky" | "catch_all" | "unknown";
  source: string;
  reasons: string[];
  checks: { syntax: boolean; mx: boolean; disposable: boolean; role: boolean; free: boolean; smtp?: string };
}

export const v2 = {
  status: () => req<V2Status>("/api/v2/status"),
  integrations: () => req<Integrations>("/api/v2/integrations"),
  saveIntegrations: (p: IntegrationsPatch) => req<Integrations>("/api/v2/integrations", put(p)),
  testIntegration: (target: IntegrationTarget) =>
    req<{ ok: boolean; error?: string; model?: string; ms?: number; accounts?: number; sample?: string }>("/api/v2/integrations/test", j({ target })),
  agentSettings: () => req<AgentSettings>("/api/v2/agent-settings"),
  saveAgentSettings: (p: Partial<AgentSettings>) => req<AgentSettings>("/api/v2/agent-settings", put(p)),
  events: (opts: { campaignId?: string; kind?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.campaignId) qs.set("campaignId", opts.campaignId);
    if (opts.kind) qs.set("kind", opts.kind);
    if (opts.limit) qs.set("limit", String(opts.limit));
    return req<{ events: AgentEvent[] }>(`/api/v2/events?${qs}`);
  },
  verify: (email: string) => req<VerifyResult>("/api/v2/verify", j({ email })),
};

/** "3m ago", "2h ago", "Oct 4" */
export function ago(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.max(1, Math.round(f / 60))}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86400)}d`;
  }
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
