// Google Workspace / Gmail through the Gmail API (HTTPS — Railway Hobby blocks SMTP).
// Each mailbox signs in once through our OAuth app; we keep its refresh token.
import { htmlToText } from "../events";
import { isAutoSubmitted, messageIdsIn, normalizeMessageId, parseAddress, emailsIn } from "./mime";
import { EngineError, type Connection, type Folder, type FoundMessage, type InMessage, type MailProvider, type TokenSet } from "./types";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

function mapError(status: number, body: any, where: string): EngineError {
  const msg = String(body?.error?.message || body?.error_description || (typeof body?.error === "string" ? body.error : "") || `HTTP ${status}`);
  const reasons = `${(body?.error?.errors || []).map((e: any) => String(e?.reason || "")).join(",")} ${String(body?.error?.status || "")}`;
  const text = `Gmail ${where}: ${msg}`;
  if (status === 401 || /invalid_grant|invalid credentials|unauthorized_client|invalid_client/i.test(`${msg} ${body?.error || ""}`)) return new EngineError(text, "auth", status);
  if (/sending limit|daily user sending quota|dailyLimitExceeded|mail service not enabled|suspended|disabled/i.test(`${msg} ${reasons}`)) return new EngineError(text, "blocked", status);
  const retryAfter = msg.match(/retry after (\S+)/i);
  if (retryAfter && Date.parse(retryAfter[1]) - Date.now() > 30 * 60_000) return new EngineError(text, "blocked", status);
  if (status === 403 && /insufficientPermissions|PERMISSION_DENIED|accessNotConfigured|SERVICE_DISABLED|forbidden/i.test(`${reasons} ${msg}`) && !/rate/i.test(msg)) return new EngineError(text, "auth", status);
  if (status === 429 || status === 0 || status >= 500 || /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(reasons)) return new EngineError(text, "retry", status);
  return new EngineError(text, "bad", status);
}

async function call(access: string, method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${access}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new EngineError(`Gmail unreachable: ${String(e?.message || e)}`, "retry", 0);
  }
  const data: any = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw mapError(res.status, data, `${method} ${path.split("?")[0]}`);
  return data;
}

async function tokenCall(params: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    throw new EngineError(`Google sign-in unreachable: ${String(e?.message || e)}`, "retry", 0);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw mapError(res.status, data, "sign-in");
  return data;
}

function headersOf(payload: any): Record<string, string> {
  const h: Record<string, string> = {};
  for (const x of payload?.headers || []) {
    const k = String(x?.name || "").toLowerCase();
    if (k && !(k in h)) h[k] = String(x?.value || "");
  }
  return h;
}

function walk(part: any, out: { text: string[]; html: string[]; report: string[] }, depth = 0) {
  if (!part || depth > 8) return;
  const mt = String(part.mimeType || "").toLowerCase();
  const data = part.body?.data ? Buffer.from(String(part.body.data), "base64url").toString("utf8") : "";
  if (depth > 0 && Array.isArray(part.headers) && part.headers.length) out.report.push(part.headers.map((x: any) => `${x.name}: ${x.value}`).join("\n"));
  if (mt === "text/plain" && data) out.text.push(data);
  else if (mt === "text/html" && data) out.html.push(data);
  else if (data && /^(message\/delivery-status|text\/rfc822-headers|message\/rfc822)/.test(mt)) out.report.push(data);
  for (const p of part.parts || []) walk(p, out, depth + 1);
}

function folderOf(labels: string[]): Folder | null {
  if (labels.includes("DRAFT") || labels.includes("CHAT")) return null;
  if (labels.includes("SENT")) return "sent";
  if (labels.includes("SPAM")) return "junk";
  if (labels.includes("INBOX")) return "inbox";
  return "other";
}

export function parseGmailMessage(m: any): InMessage | null {
  const folder = folderOf(m?.labelIds || []);
  if (!folder) return null;
  const h = headersOf(m.payload);
  const parts = { text: [] as string[], html: [] as string[], report: [] as string[] };
  walk(m.payload, parts);
  const html = parts.html.join("\n");
  const text = [parts.text.join("\n") || htmlToText(html), ...parts.report].filter(Boolean).join("\n\n");
  const date = Number(m.internalDate) ? new Date(Number(m.internalDate)).toISOString() : new Date(Date.parse(h.date || "") || Date.now()).toISOString();
  return {
    providerId: String(m.id),
    threadId: m.threadId ? String(m.threadId) : null,
    folder,
    messageId: normalizeMessageId(h["message-id"]),
    inReplyTo: normalizeMessageId(h["in-reply-to"]),
    references: messageIdsIn(h.references),
    from: parseAddress(h.from),
    to: emailsIn(`${h.to || ""},${h.cc || ""}`),
    subject: h.subject || "",
    date,
    text,
    html,
    autoSubmitted: isAutoSubmitted(h),
    contentType: h["content-type"] || String(m.payload?.mimeType || ""),
  };
}

function placementOf(labels: string[]): FoundMessage["folder"] {
  if (labels.includes("TRASH")) return "trash";
  if (labels.includes("SPAM")) return "spam";
  if (labels.includes("INBOX")) return labels.some((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l)) ? "other_tab" : "inbox";
  if (labels.includes("SENT")) return "sent";
  return "other";
}

export const google: MailProvider = {
  kind: "google",

  scopes(purpose) {
    return purpose === "mailbox"
      ? ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.modify"]
      : ["https://www.googleapis.com/auth/gmail.modify"];
  },

  authUrl(conn, o) {
    const p = new URLSearchParams({
      client_id: conn.client_id,
      redirect_uri: o.redirectUri,
      response_type: "code",
      scope: this.scopes(o.purpose).join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: o.state,
    });
    if (o.loginHint) p.set("login_hint", o.loginHint);
    return `${AUTH}?${p}`;
  },

  async exchangeCode(conn, code, redirectUri): Promise<TokenSet> {
    const d = await tokenCall({ code, client_id: conn.client_id, client_secret: conn.client_secret, redirect_uri: redirectUri, grant_type: "authorization_code" });
    if (!d.refresh_token) {
      throw new EngineError("Google didn't hand over a long-lived sign-in. Remove the app at myaccount.google.com/permissions, then sign in again.", "auth", 400);
    }
    return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000, scope: d.scope };
  },

  async refresh(conn, token): Promise<TokenSet> {
    const d = await tokenCall({ client_id: conn.client_id, client_secret: conn.client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" });
    return { access_token: d.access_token, refresh_token: d.refresh_token || token.refresh_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000, scope: d.scope || token.scope };
  },

  async profile(access) {
    const p = await call(access, "GET", "/profile");
    let name: string | null = null;
    try {
      const s = await call(access, "GET", "/settings/sendAs");
      const primary = (s.sendAs || []).find((x: any) => x.isPrimary) || (s.sendAs || [])[0];
      name = primary?.displayName ? String(primary.displayName) : null;
    } catch {
      /* the name is optional */
    }
    return { email: String(p.emailAddress || "").toLowerCase(), name };
  },

  async send(access, mime, opts) {
    const sent = await call(access, "POST", "/messages/send", { raw: Buffer.from(mime, "utf8").toString("base64url"), ...(opts.threadId ? { threadId: opts.threadId } : {}) });
    let messageId: string | null = null;
    try {
      const m = await call(access, "GET", `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
      messageId = normalizeMessageId(headersOf(m.payload)["message-id"]);
    } catch {
      /* fall back to ours */
    }
    return { providerId: String(sent.id), threadId: sent.threadId ? String(sent.threadId) : null, messageId };
  },

  async listNew(access, cursor, sinceIso) {
    let historyId: string | null = null;
    let start: string | null = null;
    try {
      start = cursor ? String(JSON.parse(cursor)?.historyId || "") || null : null;
    } catch {
      start = null;
    }
    let ids: string[] = [];
    if (start) {
      try {
        let pageToken: string | undefined;
        for (let i = 0; i < 6; i++) {
          const r = await call(access, "GET", `/history?startHistoryId=${encodeURIComponent(start)}&historyTypes=messageAdded&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`);
          for (const h of r.history || []) for (const ma of h.messagesAdded || []) if (ma?.message?.id) ids.push(String(ma.message.id));
          historyId = r.historyId ? String(r.historyId) : historyId;
          if (!r.nextPageToken) break;
          pageToken = r.nextPageToken;
        }
      } catch (e) {
        // historyId too old (404): start over from the time window.
        if ((e as EngineError).status !== 404) throw e;
        start = null;
      }
    }
    if (!start) {
      const prof = await call(access, "GET", "/profile");
      historyId = String(prof.historyId || "");
      const after = Math.floor(Date.parse(sinceIso) / 1000);
      const r = await call(access, "GET", `/messages?q=${encodeURIComponent(`after:${after}`)}&includeSpamTrash=true&maxResults=200`);
      ids = (r.messages || []).map((m: any) => String(m.id));
    }
    const messages: InMessage[] = [];
    for (const id of [...new Set(ids)].slice(0, 300)) {
      try {
        const p = parseGmailMessage(await call(access, "GET", `/messages/${id}?format=full`));
        if (p) messages.push(p);
      } catch (e) {
        if ((e as EngineError).status === 404) continue; // deleted since
        throw e;
      }
    }
    return { messages, cursor: JSON.stringify({ historyId: historyId || start }) };
  },

  async findByMessageId(access, messageId) {
    const id = String(messageId).replace(/[<>]/g, "");
    const r = await call(access, "GET", `/messages?q=${encodeURIComponent(`rfc822msgid:${id}`)}&includeSpamTrash=true&maxResults=5`);
    const first = r.messages?.[0];
    if (!first) return { found: false, folder: null, ref: null };
    const m = await call(access, "GET", `/messages/${first.id}?format=minimal`);
    return { found: true, folder: placementOf(m.labelIds || []), ref: String(first.id) };
  },

  async trash(access, ref) {
    await call(access, "POST", `/messages/${encodeURIComponent(ref)}/trash`);
  },
};
