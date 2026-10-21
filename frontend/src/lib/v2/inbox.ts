// Inbox API (v2 workstream B). Mirrors backend/src/v2/inbox/{service,example,module}.ts.
import { req } from "../api";
import { j, type AgentSettings } from "./core";

export type InboxFilter = "active" | "needs_human" | "scheduled" | "unread" | "closed" | "all";
export type ThreadStatus = "open" | "needs_human" | "handled" | "closed";
export type AiStatus = "pending" | "classified" | "scheduled" | "replied" | "drafted" | "skipped" | "needs_human" | "failed";

export interface Pending {
  kind: AiStatus;
  dueAt: string | null;
  reason: string | null;
  messageId: string;
}

export interface ThreadRow {
  id: string;
  leadEmail: string;
  leadName: string | null;
  company: string | null;
  subject: string;
  eaccount: string;
  lastMessageAt: string | null;
  lastDirection: string | null;
  lastPreview: string;
  unread: boolean;
  status: ThreadStatus;
  classification: string | null;
  aiPaused: boolean;
  autoReplies: number;
  campaignId: string | null;
  pending: Pending | null;
}

export interface InboxMessage {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  subject: string;
  text: string;
  replyText: string;
  hasQuote: boolean;
  sentAt: string;
  isAutoReply: boolean;
  step: string | null;
  classification: string | null;
  confidence: number | null;
  summary: string | null;
  aiStatus: AiStatus | null;
  aiReason: string | null;
  aiDraft: string | null;
  aiSource: "rules" | "ai" | "none" | "human" | null;
  replyDueAt: string | null;
  sentBy: "campaign" | "instantly" | "agent" | "approved" | "you" | null;
  meta: { language?: string; returnDate?: string | null; referral?: string | null; error?: string | null; provider?: string | null };
}

export interface LeadInfo {
  name: string | null;
  email: string;
  title: string | null;
  linkedin: string | null;
  company: string | null;
  website: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  phone: string | null;
  stage: string | null;
  fitScore: number | null;
  research: string[];
  source: "campaign" | "contacts" | null;
}

export interface ThreadEvent {
  id: string;
  kind: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  created_at: string;
}

export interface ThreadDetail {
  thread: ThreadRow;
  messages: InboxMessage[];
  lead: LeadInfo;
  campaign: { id: string; name: string; kind: string; status: string } | null;
  mailbox: { email: string; stage: string | null; dailyLimit: number | null; vendor: string | null } | null;
  events: ThreadEvent[];
}

export interface LastSync {
  at: string;
  ok: boolean;
  fetched: number;
  stored: number;
  newThreads: number;
  errors: string[];
}

export interface InboxList {
  filter: InboxFilter;
  threads: ThreadRow[];
  hasMore?: boolean;
  counts: Record<InboxFilter, number>;
  example: boolean;
  connected?: boolean;
  ai?: { configured: boolean };
  syncing?: boolean;
  lastSync?: LastSync | null;
  /** Example mode only: every thread's detail, so the preview needs no more calls. */
  details?: Record<string, ThreadDetail>;
}

export interface PlaygroundResult {
  classification: {
    category: string;
    confidence: number;
    summary: string;
    language: string;
    source: "rules" | "ai" | "none" | "human";
    returnDate?: string | null;
    referral?: string | null;
    error?: string | null;
  };
  decision: { action: "send" | "draft" | "handoff" | "silent"; reason: string; delayMinutes?: [number, number] };
  reply: { body: string; provider: string; model: string } | null;
  held: string | null;
  writeError: string | null;
}

type DetailResp = { ok: true; detail: ThreadDetail | null };

export const inboxApi = {
  list: (o: { filter?: InboxFilter; q?: string; category?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (o.filter) qs.set("filter", o.filter);
    if (o.q) qs.set("q", o.q);
    if (o.category) qs.set("category", o.category);
    if (o.limit) qs.set("limit", String(o.limit));
    return req<InboxList>(`/api/v2/inbox/threads?${qs}`);
  },
  example: () => req<InboxList & { details: Record<string, ThreadDetail> }>("/api/v2/inbox/example"),
  thread: (id: string) => req<ThreadDetail>(`/api/v2/inbox/threads/${id}`),
  sync: () => req<{ result: LastSync }>("/api/v2/inbox/sync", j({})),
  playground: (b: { message: string; subject?: string; category?: string; settings?: Partial<AgentSettings>; write?: boolean }) =>
    req<PlaygroundResult>("/api/v2/inbox/playground", j(b)),

  reply: (threadId: string, body: string) => req<DetailResp>(`/api/v2/inbox/threads/${threadId}/reply`, j({ body })),
  read: (threadId: string, read = true) => req<DetailResp>(`/api/v2/inbox/threads/${threadId}/read`, j({ read })),
  setAi: (threadId: string, paused: boolean) => req<DetailResp>(`/api/v2/inbox/threads/${threadId}/ai`, j({ paused })),
  setStatus: (threadId: string, status: "closed" | "handled" | "open") => req<DetailResp>(`/api/v2/inbox/threads/${threadId}/status`, j({ status })),

  approve: (messageId: string, body?: string) => req<DetailResp>(`/api/v2/inbox/messages/${messageId}/approve`, j({ body })),
  saveDraft: (messageId: string, body: string) => req<DetailResp>(`/api/v2/inbox/messages/${messageId}/draft`, j({ body })),
  discard: (messageId: string) => req<DetailResp>(`/api/v2/inbox/messages/${messageId}/discard`, j({})),
  rewrite: (messageId: string, instruction?: string) => req<DetailResp>(`/api/v2/inbox/messages/${messageId}/rewrite`, j({ instruction })),
  sendNow: (messageId: string) => req<DetailResp>(`/api/v2/inbox/messages/${messageId}/send-now`, j({})),
  classify: (messageId: string, category: string) => req<DetailResp>(`/api/v2/inbox/messages/${messageId}/classify`, j({ category })),
  rerun: (messageId: string) => req<DetailResp>(`/api/v2/inbox/messages/${messageId}/rerun`, j({})),
};

/* ------------------------------ vocabulary ------------------------------ */

// Same ids as backend REPLY_CATEGORIES. Chip colours: every status has fg + bg.
export const CATEGORY: Record<string, { label: string; chip: string }> = {
  interested: { label: "Interested", chip: "bg-okb text-good" },
  question: { label: "Question", chip: "bg-inb text-inf" },
  not_now: { label: "Not now", chip: "bg-wnb text-warn" },
  referral: { label: "Referral", chip: "bg-pub text-puf" },
  not_interested: { label: "Not interested", chip: "bg-ink/[0.06] text-muted" },
  negotiation: { label: "Negotiation", chip: "bg-orb text-orf" },
  complaint: { label: "Complaint", chip: "bg-dgb text-bad" },
  legal: { label: "Legal", chip: "bg-dgb text-bad" },
  needs_human: { label: "Unclear", chip: "bg-wnb text-warn" },
  unsubscribe: { label: "Unsubscribe", chip: "bg-ink/[0.06] text-muted" },
  out_of_office: { label: "Out of office", chip: "bg-ink/[0.06] text-ink-soft" },
  bounce: { label: "Bounce", chip: "bg-dgb text-bad" },
};

export const CATEGORY_ORDER = [
  "interested",
  "question",
  "not_now",
  "referral",
  "not_interested",
  "negotiation",
  "complaint",
  "legal",
  "needs_human",
  "unsubscribe",
  "out_of_office",
  "bounce",
];

export const STATUS: Record<ThreadStatus, { label: string; chip: string }> = {
  needs_human: { label: "Needs you", chip: "bg-wnb text-warn" },
  open: { label: "Agent on it", chip: "bg-tlb text-accent" },
  handled: { label: "Handled", chip: "bg-ink/[0.06] text-ink-soft" },
  closed: { label: "Closed", chip: "bg-ink/[0.06] text-muted" },
};

export function initials(name: string) {
  const clean = name.replace(/@.*/, "").trim();
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

/** "in 12m", "in 2h" for a due time; "now" when it's overdue. */
export function dueIn(iso?: string | null): string {
  if (!iso) return "";
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 30) return "any moment";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

export function clock(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
