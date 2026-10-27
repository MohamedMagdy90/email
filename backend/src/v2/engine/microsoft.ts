// Microsoft 365 / Outlook through Microsoft Graph (HTTPS).
// Sending: the message is created as a MIME draft and then sent, because
// Graph's JSON format only allows x- headers and we need List-Unsubscribe.
// Ids are requested as ImmutableId so a message keeps its id in Sent Items.
import { htmlToText } from "../events";
import { isAutoSubmitted, messageIdsIn, normalizeMessageId, emailsIn } from "./mime";
import { EngineError, type Folder, type FoundMessage, type InMessage, type MailProvider, type TokenSet } from "./types";

const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const API = "https://graph.microsoft.com/v1.0/me";
const PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';
const G = "https://graph.microsoft.com/";

function mapError(status: number, body: any, where: string): EngineError {
  const code = String(body?.error?.code || (typeof body?.error === "string" ? body.error : "") || "");
  const msg = String(body?.error?.message || body?.error_description || code || `HTTP ${status}`);
  const all = `${code} ${msg}`;
  const text = `Microsoft ${where}: ${msg.split("\r\n")[0].slice(0, 300)}`;
  if (status === 401 || /invalid_grant|InvalidAuthenticationToken|interaction_required|consent_required|unauthorized_client|invalid_client/i.test(all)) return new EngineError(text, "auth", status);
  if (/SendAsDenied|SubmissionBlocked|restricted|blocked from sending|OutboundSpam|QuotaExceeded|MailboxNotEnabledForRESTAPI|account (?:is )?disabled|SendingLimit/i.test(all)) return new EngineError(text, "blocked", status);
  if (status === 403 && /AccessDenied|Authorization_RequestDenied/i.test(code)) return new EngineError(text, "auth", status);
  if (status === 429 || status === 0 || status >= 500 || /Throttled|TooManyRequests|ServiceNotAvailable/i.test(code)) return new EngineError(text, "retry", status);
  return new EngineError(text, "bad", status);
}

async function call(access: string, method: string, path: string, opts: { json?: unknown; raw?: string } = {}): Promise<any> {
  const url = path.startsWith("https://") ? path : `${API}${path}`;
  if (!url.startsWith(G)) throw new EngineError("Refusing a non-Graph URL", "bad", 400);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        Prefer: PREFER,
        ...(opts.json !== undefined ? { "Content-Type": "application/json" } : opts.raw !== undefined ? { "Content-Type": "text/plain" } : {}),
      },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.raw,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new EngineError(`Microsoft Graph unreachable: ${String(e?.message || e)}`, "retry", 0);
  }
  const data: any = res.status === 202 || res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw mapError(res.status, data, `${method} ${url.replace(G, "").split("?")[0]}`);
  return data;
}

async function tokenCall(params: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) });
  } catch (e: any) {
    throw new EngineError(`Microsoft sign-in unreachable: ${String(e?.message || e)}`, "retry", 0);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw mapError(res.status, data, "sign-in");
  return data;
}

const toToken = (d: any, prev?: TokenSet): TokenSet => ({
  access_token: d.access_token,
  refresh_token: d.refresh_token || prev?.refresh_token || "",
  expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
  scope: d.scope || prev?.scope,
});

const DETAIL = "id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,internetMessageHeaders,isDraft";
const FOLDERS: [string, Folder][] = [
  ["inbox", "inbox"],
  ["junkemail", "junk"],
  ["sentitems", "sent"],
];

export function parseGraphMessage(m: any, folder: Folder): InMessage {
  const h: Record<string, string> = {};
  for (const x of m?.internetMessageHeaders || []) {
    const k = String(x?.name || "").toLowerCase();
    if (k && !(k in h)) h[k] = String(x?.value || "");
  }
  const isHtml = String(m?.body?.contentType || "").toLowerCase() === "html";
  const content = String(m?.body?.content || "");
  return {
    providerId: String(m.id),
    threadId: m.conversationId ? String(m.conversationId) : null,
    folder,
    messageId: normalizeMessageId(m.internetMessageId || h["message-id"]),
    inReplyTo: normalizeMessageId(h["in-reply-to"]),
    references: messageIdsIn(h.references),
    from: { email: String(m?.from?.emailAddress?.address || "").toLowerCase(), name: m?.from?.emailAddress?.name ? String(m.from.emailAddress.name) : null },
    to: emailsIn([...(m.toRecipients || []), ...(m.ccRecipients || [])].map((r: any) => r?.emailAddress?.address || "").join(",")),
    subject: String(m.subject || ""),
    date: String(m.receivedDateTime || m.sentDateTime || new Date().toISOString()),
    text: isHtml ? htmlToText(content) : content,
    html: isHtml ? content : "",
    autoSubmitted: isAutoSubmitted(h),
    contentType: h["content-type"] || "",
  };
}

const folderIds = new Map<string, { at: number; ids: Record<string, string> }>();
async function wellKnown(access: string): Promise<Record<string, string>> {
  const hit = folderIds.get(access);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.ids;
  const ids: Record<string, string> = {};
  for (const f of ["inbox", "junkemail", "sentitems", "deleteditems"]) {
    try {
      ids[f] = String((await call(access, "GET", `/mailFolders/${f}?$select=id`)).id || "");
    } catch {
      ids[f] = "";
    }
  }
  folderIds.set(access, { at: Date.now(), ids });
  return ids;
}

export const microsoft: MailProvider = {
  kind: "microsoft",

  scopes(purpose) {
    const base = ["offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.ReadWrite"];
    return purpose === "mailbox" ? [...base, "https://graph.microsoft.com/Mail.Send"] : base;
  },

  authUrl(conn, o) {
    const p = new URLSearchParams({
      client_id: conn.client_id,
      response_type: "code",
      redirect_uri: o.redirectUri,
      response_mode: "query",
      scope: this.scopes(o.purpose).join(" "),
      state: o.state,
      prompt: "select_account",
    });
    if (o.loginHint) p.set("login_hint", o.loginHint);
    return `${AUTH}?${p}`;
  },

  async exchangeCode(conn, code, redirectUri) {
    const d = await tokenCall({ client_id: conn.client_id, client_secret: conn.client_secret, code, redirect_uri: redirectUri, grant_type: "authorization_code", scope: this.scopes("mailbox").join(" ") });
    if (!d.refresh_token) throw new EngineError("Microsoft didn't hand over a long-lived sign-in (offline access). Sign in again.", "auth", 400);
    return toToken(d);
  },

  async refresh(conn, token) {
    const d = await tokenCall({ client_id: conn.client_id, client_secret: conn.client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" });
    return toToken(d, token);
  },

  async profile(access) {
    const me = await call(access, "GET", "?$select=mail,userPrincipalName,displayName");
    return { email: String(me.mail || me.userPrincipalName || "").toLowerCase(), name: me.displayName ? String(me.displayName) : null };
  },

  async send(access, mime) {
    const draft = await call(access, "POST", "/messages", { raw: Buffer.from(mime, "utf8").toString("base64") });
    try {
      await call(access, "POST", `/messages/${encodeURIComponent(draft.id)}/send`);
    } catch (e) {
      await call(access, "DELETE", `/messages/${encodeURIComponent(draft.id)}`).catch(() => {});
      throw e;
    }
    return { providerId: String(draft.id), threadId: draft.conversationId ? String(draft.conversationId) : null, messageId: normalizeMessageId(draft.internetMessageId) };
  },

  async listNew(access, cursor, sinceIso) {
    let cur: Record<string, string> = {};
    try {
      cur = cursor ? JSON.parse(cursor) || {} : {};
    } catch {
      cur = {};
    }
    const next: Record<string, string> = { ...cur };
    const found: { id: string; folder: Folder }[] = [];
    for (const [name, folder] of FOLDERS) {
      const first = !cur[folder];
      let url =
        cur[folder] ||
        `/mailFolders/${name}/messages/delta?$select=id,receivedDateTime,isDraft&$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(sinceIso).toISOString()}`)}`;
      for (let page = 0; page < 20; page++) {
        let r: any;
        try {
          r = await call(access, "GET", url);
        } catch (e) {
          // An expired delta token: start this folder over from the time window.
          if ((e as EngineError).status === 410 || ((e as EngineError).status === 400 && !first)) {
            delete next[folder];
            break;
          }
          throw e;
        }
        for (const it of r.value || []) {
          if (it["@removed"] || it.isDraft) continue;
          if (first && it.receivedDateTime && it.receivedDateTime < sinceIso) continue;
          found.push({ id: String(it.id), folder });
        }
        if (r["@odata.deltaLink"]) {
          next[folder] = r["@odata.deltaLink"];
          break;
        }
        if (!r["@odata.nextLink"]) break;
        url = r["@odata.nextLink"];
        next[folder] = url;
      }
    }
    const messages: InMessage[] = [];
    const seen = new Set<string>();
    for (const f of found) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      try {
        messages.push(parseGraphMessage(await call(access, "GET", `/messages/${encodeURIComponent(f.id)}?$select=${DETAIL}`), f.folder));
      } catch (e) {
        if ((e as EngineError).status === 404) continue;
        throw e;
      }
    }
    return { messages, cursor: JSON.stringify(next) };
  },

  async findByMessageId(access, messageId) {
    const id = String(messageId).trim();
    const filter = `internetMessageId eq '${id.replace(/'/g, "''")}'`;
    const r = await call(access, "GET", `/messages?$filter=${encodeURIComponent(filter)}&$select=id,parentFolderId,inferenceClassification&$top=5`);
    const m = r.value?.[0];
    if (!m) return { found: false, folder: null, ref: null };
    const ids = await wellKnown(access);
    const pf = String(m.parentFolderId || "");
    let folder: FoundMessage["folder"] = "other";
    if (pf && pf === ids.junkemail) folder = "spam";
    else if (pf && pf === ids.inbox) folder = String(m.inferenceClassification || "").toLowerCase() === "other" ? "other_tab" : "inbox";
    else if (pf && pf === ids.sentitems) folder = "sent";
    else if (pf && pf === ids.deleteditems) folder = "trash";
    return { found: true, folder, ref: String(m.id) };
  },

  async trash(access, ref) {
    await call(access, "DELETE", `/messages/${encodeURIComponent(ref)}`);
  },
};
