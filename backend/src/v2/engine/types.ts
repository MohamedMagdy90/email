// Shared types for the own sending engine.

export type ProviderKind = "google" | "microsoft";

/**
 * What went wrong, in terms the queue can act on:
 *   auth     the sign-in is gone (revoked, expired, password changed) -> sign in again
 *   blocked  the provider stopped this mailbox from sending (limit, restriction) -> pause it
 *   retry    temporary (rate limit, 5xx, network) -> try again later
 *   bad      this message was refused (bad recipient, bad request) -> don't retry
 */
export type ErrorCode = "auth" | "blocked" | "retry" | "bad";

export class EngineError extends Error {
  status: number;
  code: ErrorCode;
  constructor(message: string, code: ErrorCode, status = 0) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.status = status;
  }
}

export const isEngineError = (e: unknown): e is EngineError => e instanceof EngineError || (e as any)?.name === "EngineError";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  /** epoch ms */
  expires_at: number;
  scope?: string;
}

export interface Connection {
  id: string;
  provider: ProviderKind;
  label: string | null;
  client_id: string;
  client_secret: string;
}

export type Folder = "inbox" | "junk" | "sent" | "other";

/** A message read from a mailbox, provider-neutral. */
export interface InMessage {
  providerId: string;
  threadId: string | null;
  folder: Folder;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { email: string; name: string | null };
  to: string[];
  subject: string;
  /** ISO */
  date: string;
  text: string;
  html: string;
  autoSubmitted: boolean;
  contentType: string;
}

export type Placement = "inbox" | "other_tab" | "spam" | "sent" | "trash" | "other";

export interface FoundMessage {
  found: boolean;
  folder: Placement | null;
  /** Provider id inside the seed (to trash it later). */
  ref: string | null;
}

export interface SendResult {
  providerId: string;
  threadId: string | null;
  /** The Message-ID the provider actually used. */
  messageId: string | null;
}

export interface MailProvider {
  kind: ProviderKind;
  scopes(purpose: "mailbox" | "seed"): string[];
  authUrl(conn: Connection, opts: { redirectUri: string; state: string; loginHint?: string | null; purpose: "mailbox" | "seed" }): string;
  exchangeCode(conn: Connection, code: string, redirectUri: string): Promise<TokenSet>;
  refresh(conn: Connection, token: TokenSet): Promise<TokenSet>;
  profile(access: string): Promise<{ email: string; name: string | null }>;
  send(access: string, mime: string, opts: { threadId?: string | null }): Promise<SendResult>;
  /** New messages since `cursor` (null = start from `sinceIso`). */
  listNew(access: string, cursor: string | null, sinceIso: string): Promise<{ messages: InMessage[]; cursor: string }>;
  findByMessageId(access: string, messageId: string): Promise<FoundMessage>;
  trash(access: string, ref: string): Promise<void>;
}
