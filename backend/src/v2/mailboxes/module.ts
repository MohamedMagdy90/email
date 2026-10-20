// Mailboxes feature module, loaded by v2/index.ts.
//   register(app)  routes under /api/v2/mailboxes (token-gated by the global /api/* middleware)
//   start()        background sync every 30 minutes while Instantly is connected
import type { Context, Hono } from "hono";
import { todayUtc } from "../events";
import { instantlyConfigured } from "../instantly";
import { examplePool } from "./example";
import {
  MailboxError,
  ensureMailboxColumns,
  evaluateAll,
  forgetMailbox,
  getPolicy,
  listView,
  mailboxDetail,
  pauseMailbox,
  resumeMailbox,
  savePolicy,
  setWarmup,
  startMailbox,
  syncMailboxes,
  updateMailbox,
} from "./service";

const SYNC_EVERY_MS = 30 * 60_000;

function fail(c: Context, e: unknown) {
  if (e instanceof MailboxError) return c.json({ error: e.message }, e.status as 400);
  console.error(`[mailboxes] ${String((e as any)?.stack || e)}`);
  return c.json({ error: String((e as any)?.message || e) }, 500);
}

export async function register(app: Hono) {
  await ensureMailboxColumns();
  const base = "/api/v2/mailboxes";

  // Static paths first, so they are never read as an :id.
  app.get(base, async (c) => {
    try {
      return c.json(await listView());
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get(`${base}/example`, async (c) => c.json(examplePool(await getPolicy(), todayUtc())));

  app.get(`${base}/policy`, async (c) => c.json(await getPolicy()));

  app.put(`${base}/policy`, async (c) => {
    try {
      const policy = await savePolicy(await c.req.json().catch(() => ({})));
      const ev = await evaluateAll({ push: true });
      return c.json({ policy, warning: ev.errors[0] || null, view: await listView() });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post(`${base}/sync`, async (c) => {
    try {
      if (!(await instantlyConfigured())) return c.json({ error: "Connect Instantly first." }, 400);
      const result = await syncMailboxes({ forceDns: true });
      return c.json({ result, view: await listView() });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get(`${base}/:id`, async (c) => {
    try {
      const d = await mailboxDetail(c.req.param("id"));
      return d ? c.json(d) : c.json({ error: "Mailbox not found." }, 404);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.patch(`${base}/:id`, async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const r = await updateMailbox(c.req.param("id"), {
        vendor: b.vendor,
        preWarmed: typeof b.preWarmed === "boolean" ? b.preWarmed : undefined,
        manualHold: typeof b.manualHold === "boolean" ? b.manualHold : undefined,
        targetLimit: b.targetLimit === null ? null : b.targetLimit === undefined || b.targetLimit === "" ? undefined : Number(b.targetLimit),
        notes: typeof b.notes === "string" ? b.notes : undefined,
      });
      return c.json({ ok: true, warning: r?.warning || null, detail: await mailboxDetail(c.req.param("id")) });
    } catch (e) {
      return fail(c, e);
    }
  });

  const action = (name: string, fn: (id: string, body: any) => Promise<{ warning?: string | null } | void>) =>
    app.post(`${base}/:id/${name}`, async (c) => {
      try {
        const id = c.req.param("id");
        const r = await fn(id, await c.req.json().catch(() => ({})));
        return c.json({ ok: true, warning: (r && r.warning) || null, detail: await mailboxDetail(id) });
      } catch (e) {
        return fail(c, e);
      }
    });

  action("pause", (id, b) => pauseMailbox(id, typeof b.reason === "string" ? b.reason : undefined));
  action("resume", (id) => resumeMailbox(id));
  action("start", (id) => startMailbox(id));
  action("warmup", (id, b) => setWarmup(id, b.on !== false));

  app.delete(`${base}/:id`, async (c) => {
    try {
      await forgetMailbox(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });
}

let started = false;

export function start() {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      if (!(await instantlyConfigured())) return;
      const r = await syncMailboxes();
      console.log(`[mailboxes] synced ${r.synced} mailbox(es)${r.errors.length ? ` · ${r.errors.length} problem(s): ${r.errors[0]}` : ""}`);
    } catch (e) {
      console.error(`[mailboxes] sync failed: ${String((e as any)?.message || e)}`);
    }
  };
  setTimeout(tick, 20_000);
  setInterval(tick, SYNC_EVERY_MS);
}
