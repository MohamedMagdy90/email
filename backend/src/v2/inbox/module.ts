// Inbox feature module, loaded by v2/index.ts.
//   register(app)  routes under /api/v2/inbox (token-gated by the global /api/* middleware)
//   start()        poll Instantly every 3 min, read pending replies, send due replies
import type { Context, Hono } from "hono";
import { getAgentSettings, resolveAgentSettings } from "../agent-settings";
import { instantlyConfigured } from "../instantly";
import { aiStatus } from "../llm";
import { exampleInbox } from "./example";
import {
  InboxError,
  approveDraft,
  counts,
  discardDraft,
  ensureInboxColumns,
  isSyncing,
  lastSync,
  listThreads,
  playground,
  processMessage,
  redraft,
  replyAsYou,
  saveDraft,
  sendNow,
  setThreadAi,
  setThreadRead,
  setThreadStatus,
  startInboxWorker,
  syncInbox,
  threadDetail,
  threadIdOf,
} from "./service";

function fail(c: Context, e: unknown) {
  if (e instanceof InboxError) return c.json({ error: e.message }, e.status as 400);
  const msg = String((e as any)?.message || e);
  console.error(`[inbox] ${String((e as any)?.stack || e)}`);
  return c.json({ error: msg }, 500);
}

export async function register(app: Hono) {
  await ensureInboxColumns();
  const base = "/api/v2/inbox";

  // Shell badge (polled every 20s): { unread, needsHuman }.
  app.get(`${base}/counts`, async (c) => {
    try {
      return c.json(await counts());
    } catch {
      return c.json({ unread: 0, needsHuman: 0 });
    }
  });

  app.get(`${base}/threads`, async (c) => {
    try {
      const list = await listThreads({
        filter: c.req.query("filter") || undefined,
        search: c.req.query("q") || undefined,
        category: c.req.query("category") || undefined,
        limit: Number(c.req.query("limit")) || undefined,
        offset: Number(c.req.query("offset")) || undefined,
      });
      const ai = await aiStatus();
      return c.json({
        ...list,
        example: false,
        connected: await instantlyConfigured(),
        ai: { configured: ai.configured },
        syncing: isSyncing(),
        lastSync: await lastSync(),
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get(`${base}/example`, async (c) => c.json(exampleInbox(await getAgentSettings())));

  app.post(`${base}/sync`, async (c) => {
    try {
      if (!(await instantlyConfigured())) return c.json({ error: "Connect Instantly first." }, 400);
      return c.json({ result: await syncInbox() });
    } catch (e) {
      return fail(c, e);
    }
  });

  // Test any reply against the (possibly unsaved) rules. Never stores or sends.
  app.post(`${base}/playground`, async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const settings = await resolveAgentSettings(b.settings);
      return c.json(
        await playground({
          message: String(b.message || ""),
          subject: typeof b.subject === "string" ? b.subject : undefined,
          category: typeof b.category === "string" && b.category ? b.category : undefined,
          settings,
          write: b.write !== false,
        })
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get(`${base}/threads/:id`, async (c) => {
    try {
      const d = await threadDetail(c.req.param("id"));
      return d ? c.json(d) : c.json({ error: "Thread not found." }, 404);
    } catch (e) {
      return fail(c, e);
    }
  });

  const threadAction = (path: string, fn: (id: string, b: any) => Promise<unknown>) =>
    app.post(`${base}/threads/:id/${path}`, async (c) => {
      try {
        const id = c.req.param("id");
        await fn(id, await c.req.json().catch(() => ({})));
        return c.json({ ok: true, detail: await threadDetail(id) });
      } catch (e) {
        return fail(c, e);
      }
    });

  threadAction("reply", (id, b) => replyAsYou(id, String(b.body || "")));
  threadAction("read", (id, b) => setThreadRead(id, b.read !== false));
  threadAction("ai", (id, b) => setThreadAi(id, !!b.paused));
  threadAction("status", (id, b) => {
    const s = String(b.status || "");
    if (!["closed", "handled", "open"].includes(s)) throw new InboxError("Status must be closed, handled or open.");
    return setThreadStatus(id, s as "closed" | "handled" | "open");
  });

  // Message actions return the whole thread, so the screen redraws in one go.
  const messageAction = (path: string, fn: (id: string, b: any) => Promise<unknown>) =>
    app.post(`${base}/messages/:id/${path}`, async (c) => {
      try {
        const id = c.req.param("id");
        const b = await c.req.json().catch(() => ({}));
        await fn(id, b);
        const threadId = await threadIdOf(id);
        return c.json({ ok: true, detail: threadId ? await threadDetail(threadId) : null });
      } catch (e) {
        return fail(c, e);
      }
    });

  messageAction("approve", (id, b) => approveDraft(id, typeof b.body === "string" ? b.body : undefined));
  messageAction("draft", (id, b) => saveDraft(id, String(b.body || "")));
  messageAction("discard", (id) => discardDraft(id));
  messageAction("rewrite", (id, b) => redraft(id, typeof b.instruction === "string" ? b.instruction : undefined));
  messageAction("send-now", (id) => sendNow(id));
  messageAction("classify", (id, b) => processMessage(id, { forceCategory: String(b.category || "") }));
  messageAction("rerun", (id) => processMessage(id));
}

export function start() {
  startInboxWorker();
}
