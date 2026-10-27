// Own sending engine — feature module (loaded by v2/index.ts).
//   register(app)  routes under /api/v2/engine (token-gated) + two public ones:
//                  GET /api/v2/oauth/callback (the provider redirects here)
//                  GET|POST /api/u/:token (unsubscribe link + one-click)
//   start()        queue every 30 s, read mail + check tests every 2 min,
//                  plan tests every 5 min, DNS + mailbox checks every 10 min
import type { Context, Hono } from "hono";
import { q } from "../../db";
import { ensureEngineSchema } from "./schema";
import { CALLBACK_PATH, callbackPage, finishOAuth, publicBase, startOAuth } from "./oauth";
import {
  addImapSeed,
  deleteConnection,
  deleteSeed,
  domainSetup,
  engineSecretWarning,
  listConnections,
  listSeeds,
  refreshDomain,
  refreshStaleDomains,
  removeOwnMailbox,
  saveConnection,
  testMailbox,
  testSeed,
  updateSeed,
} from "./accounts";
import { checkDue, cleanupTests, placementGrid, planTests, runTestsNow } from "./placement";
import { queueTick, sendingToday } from "./queue";
import { readAll } from "./reader";
import { experimentView } from "./experiment";
import { unsubscribeToken } from "./bridge";
import { isEngineError } from "./types";

function fail(c: Context, e: unknown) {
  if (isEngineError(e)) return c.json({ error: e.message }, (e.status >= 400 && e.status < 500 ? e.status : 400) as 400);
  console.error(`[engine] ${String((e as any)?.stack || e)}`);
  return c.json({ error: String((e as any)?.message || e) }, 500);
}

const wrap = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c);
  } catch (e) {
    return fail(c, e);
  }
};

async function evaluateOwn() {
  const mod = await import("../mailboxes/service");
  return mod.evaluateAll({ push: false, scope: "own" });
}

const UNSUB_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f4f4f2;color:#111;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.card{background:#fff;border:1px solid #e3e3df;border-radius:14px;padding:36px;max-width:420px;text-align:center}</style></head>
<body><div class="card"><h2>You're unsubscribed</h2><p>You won't receive further emails from us.</p></div></body></html>`;

export async function register(app: Hono) {
  await ensureEngineSchema();
  const base = "/api/v2/engine";

  /* ------------------------------ public ------------------------------ */
  app.get(CALLBACK_PATH, async (c) => {
    const r = await finishOAuth({
      state: c.req.query("state"),
      code: c.req.query("code"),
      error: c.req.query("error"),
      error_description: c.req.query("error_description"),
    });
    if (r.ok && process.env.V2_WORKERS !== "0") {
      // Run the first checks straight away instead of waiting for the next tick.
      setTimeout(() => {
        refreshStaleDomains()
          .then(() => evaluateOwn())
          .then(() => planTests())
          .catch((e) => console.error(`[engine] after sign-in: ${String(e?.message || e)}`));
      }, 300);
    }
    return c.html(callbackPage(r));
  });
  app.get("/api/u/:token", async (c) => {
    await unsubscribeToken(c.req.param("token")).catch((e) => console.error(`[engine] unsubscribe: ${String(e?.message || e)}`));
    return c.html(UNSUB_PAGE);
  });
  app.post("/api/u/:token", async (c) => {
    await unsubscribeToken(c.req.param("token")).catch((e) => console.error(`[engine] unsubscribe: ${String(e?.message || e)}`));
    return c.body(null, 200);
  });

  /* ------------------------------ status ------------------------------ */
  app.get(
    `${base}/status`,
    wrap(async (c) => {
      const own = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM mailboxes WHERE provider IN ('google','microsoft')`))[0]?.n) || 0;
      return c.json({
        secretWarning: engineSecretWarning(),
        callbackPath: CALLBACK_PATH,
        publicBase: await publicBase(),
        connections: await listConnections(),
        seeds: await listSeeds(),
        ownMailboxes: own,
      });
    })
  );

  /* ---------------------------- connections ---------------------------- */
  app.get(`${base}/connections`, wrap(async (c) => c.json({ connections: await listConnections() })));
  app.post(`${base}/connections`, wrap(async (c) => c.json({ connections: await saveConnection(await c.req.json().catch(() => ({}))) })));
  app.put(`${base}/connections/:id`, wrap(async (c) => c.json({ connections: await saveConnection({ ...(await c.req.json().catch(() => ({}))), id: c.req.param("id") }) })));
  app.delete(`${base}/connections/:id`, wrap(async (c) => c.json({ connections: await deleteConnection(c.req.param("id")) })));

  app.post(
    `${base}/oauth/start`,
    wrap(async (c) => {
      const b = await c.req.json().catch(() => ({}));
      return c.json(
        await startOAuth({
          connectionId: String(b.connectionId || ""),
          purpose: b.purpose === "seed" ? "seed" : "mailbox",
          redirectBase: String(b.redirectBase || ""),
          loginHint: b.loginHint ? String(b.loginHint) : null,
          mailboxId: b.mailboxId ? String(b.mailboxId) : null,
        })
      );
    })
  );

  /* ----------------------------- mailboxes ----------------------------- */
  app.post(`${base}/mailboxes/:id/test`, wrap(async (c) => c.json(await testMailbox(c.req.param("id")))));
  app.delete(`${base}/mailboxes/:id`, wrap(async (c) => c.json(await removeOwnMailbox(c.req.param("id")))));
  app.post(
    `${base}/mailboxes/:id/tests/run`,
    wrap(async (c) => {
      const n = await runTestsNow(c.req.param("id"));
      setTimeout(() => queueTick().catch(() => {}), 35_000);
      return c.json({ scheduled: n });
    })
  );

  /* ------------------------------ domains ------------------------------ */
  app.get(`${base}/domains/:domain`, wrap(async (c) => c.json(await domainSetup(c.req.param("domain")))));
  app.post(
    `${base}/domains/:domain/check`,
    wrap(async (c) => {
      await refreshDomain(c.req.param("domain"), { force: true });
      await evaluateOwn();
      return c.json(await domainSetup(c.req.param("domain")));
    })
  );

  /* ------------------------------- seeds ------------------------------- */
  app.get(`${base}/seeds`, wrap(async (c) => c.json({ seeds: await listSeeds() })));
  app.post(`${base}/seeds/imap`, wrap(async (c) => c.json({ seeds: await addImapSeed(await c.req.json().catch(() => ({}))) })));
  app.patch(`${base}/seeds/:id`, wrap(async (c) => c.json({ seeds: await updateSeed(c.req.param("id"), await c.req.json().catch(() => ({}))) })));
  app.delete(`${base}/seeds/:id`, wrap(async (c) => c.json({ seeds: await deleteSeed(c.req.param("id")) })));
  app.post(`${base}/seeds/:id/test`, wrap(async (c) => c.json(await testSeed(c.req.param("id")))));

  /* ------------------------ tests / queue / test ------------------------ */
  app.get(
    `${base}/placement`,
    wrap(async (c) => c.json(await placementGrid(Math.min(30, Math.max(1, Number(c.req.query("days")) || 7)), c.req.query("mailboxId") || undefined)))
  );
  app.get(`${base}/experiment`, wrap(async (c) => c.json(await experimentView())));
  app.get(`${base}/queue/today`, wrap(async (c) => c.json({ items: await sendingToday(c.req.query("campaignId") || undefined) })));
  app.post(
    `${base}/run`,
    wrap(async (c) => {
      const read = await readAll();
      const checked = await checkDue();
      const planned = await planTests();
      const sent = await queueTick();
      return c.json({ read, checked, planned, sent });
    })
  );
}

/* ------------------------------- workers ------------------------------- */

let started = false;
const guard = (name: string, fn: () => Promise<unknown>) => {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[engine] ${name}: ${String((e as any)?.message || e)}`);
    } finally {
      busy = false;
    }
  };
};

async function hasOwn(): Promise<boolean> {
  return Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM mailboxes WHERE provider IN ('google','microsoft')`))[0]?.n) > 0;
}

export function start() {
  if (started) return;
  started = true;
  const queue = guard("queue", async () => (await hasOwn()) && queueTick());
  const read = guard("read", async () => {
    if (!(await hasOwn())) return;
    await readAll();
    await checkDue();
  });
  const plan = guard("plan", async () => (await hasOwn()) && planTests());
  const checks = guard("checks", async () => {
    if (!(await hasOwn())) return;
    await refreshStaleDomains();
    await evaluateOwn();
    await cleanupTests();
  });
  setTimeout(() => {
    checks();
    plan();
  }, 15_000);
  setInterval(queue, 30_000);
  setInterval(read, 2 * 60_000);
  setInterval(plan, 5 * 60_000);
  setInterval(checks, 10 * 60_000);
  console.log("[engine] workers started (queue 30s · read 2m · tests 5m · checks 10m)");
}
