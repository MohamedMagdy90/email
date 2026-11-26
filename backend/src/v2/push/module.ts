// Alerts feature module, loaded by v2/index.ts.
//   register(app)  routes under /api/v2/push (token-gated by the global /api/* middleware)
//   start()        every minute: send alerts held back during a burst, as one
import type { Context, Hono } from "hono";
import { PushError, ensurePushTables, flushHeld, pushView, removeDevice, savePrefs, sendTest, subscribe, unsubscribe } from "./service";

function fail(c: Context, e: unknown) {
  if (e instanceof PushError) return c.json({ error: e.message }, e.status as 400);
  console.error(`[push] ${String((e as any)?.stack || e)}`);
  return c.json({ error: String((e as any)?.message || e) }, 500);
}

export async function register(app: Hono) {
  await ensurePushTables();
  const base = "/api/v2/push";

  app.get(base, async (c) => {
    try {
      return c.json(await pushView());
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post(`${base}/subscribe`, async (c) => {
    try {
      const device = await subscribe(await c.req.json().catch(() => ({})), c.req.header("User-Agent") || "");
      return c.json({ device, view: await pushView() });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post(`${base}/unsubscribe`, async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const removed = await unsubscribe(String(b?.endpoint || ""));
      return c.json({ removed, view: await pushView() });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete(`${base}/devices/:id`, async (c) => {
    try {
      await removeDevice(c.req.param("id"));
      return c.json({ view: await pushView() });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.put(`${base}/prefs`, async (c) => {
    try {
      await savePrefs(await c.req.json().catch(() => ({})));
      return c.json({ view: await pushView() });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post(`${base}/test`, async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const result = await sendTest(typeof b?.endpoint === "string" ? b.endpoint : undefined);
      return c.json({ result, view: await pushView() });
    } catch (e) {
      return fail(c, e);
    }
  });
}

let started = false;

export function start() {
  if (started) return;
  started = true;
  setInterval(() => {
    flushHeld().catch((e) => console.error(`[push] grouped alerts: ${String((e as any)?.message || e)}`));
  }, 60_000);
}
