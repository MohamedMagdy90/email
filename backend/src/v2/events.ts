// Shared v2 helpers: the agent activity feed and small utilities.
import { q, nowIso } from "../db";

export const uid = () => crypto.randomUUID();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function todayUtc(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

export type EventLevel = "info" | "success" | "warn" | "error";

export interface AgentEvent {
  id: string;
  kind: string;
  level: EventLevel;
  ref_type: string | null;
  ref_id: string | null;
  campaign_id: string | null;
  message: string;
  created_at: string;
}

/**
 * Record something the agent did, in plain English, for the activity feed.
 * Never throws — logging must not break the pipeline.
 *   kind: 'mailbox' | 'campaign' | 'research' | 'contact' | 'verify' | 'write' |
 *         'send' | 'reply' | 'classify' | 'system'
 */
export async function logEvent(
  kind: string,
  message: string,
  opts: { level?: EventLevel; refType?: string; refId?: string; campaignId?: string } = {}
): Promise<void> {
  try {
    await q(
      `INSERT INTO agent_events (id, kind, level, ref_type, ref_id, campaign_id, message, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uid(), kind, opts.level || "info", opts.refType || null, opts.refId || null, opts.campaignId || null, message.slice(0, 1000), nowIso()]
    );
    console.log(`[agent:${kind}] ${message}`);
  } catch (e: any) {
    console.error(`[agent] logEvent failed: ${String(e?.message || e)}`);
  }
}

export async function listEvents(opts: { campaignId?: string; kind?: string; limit?: number } = {}): Promise<AgentEvent[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.campaignId) {
    where.push("campaign_id = ?");
    params.push(opts.campaignId);
  }
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  const limit = Math.min(500, Math.max(1, opts.limit || 100));
  const rows = await q(
    `SELECT * FROM agent_events ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC LIMIT ${limit}`,
    params
  );
  return rows as AgentEvent[];
}

/** Convert plain text to the HTML Instantly expects (`<br/>` line breaks). */
export function textToHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br/>");
}

/** Strip HTML to readable plain text (for inbound bodies without a text part). */
export function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
