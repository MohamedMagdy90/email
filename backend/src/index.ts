import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { q, ensureSchema } from "./db";
import { mountV2, startV2Workers } from "./v2";
import { instantlyConfigured, blockEntry } from "./v2/instantly";
import {
  seedAuthFromEnv,
  verifyCredentials,
  createToken,
  verifyToken,
  isAuthConfigured,
  getUsername,
  setCredentials,
} from "./auth";

await ensureSchema();
await seedAuthFromEnv();

const app = new Hono();
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

/* ------------------------------- Auth ------------------------------- */
// Public endpoints (the last two are hit by email recipients, so they must NOT
// require a token).
const PUBLIC_API = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/status",
  "/api/auth/setup",
  "/api/click",
  "/api/unsubscribe",
]);

// Gate every /api/* route except the public ones above.
app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  if (PUBLIC_API.has(c.req.path)) return next();
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!(await verifyToken(token))) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

app.post("/api/auth/login", async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  if (!username || !password) return c.json({ error: "Missing username or password" }, 400);
  const ok = await verifyCredentials(String(username), String(password));
  if (!ok) return c.json({ error: "Invalid username or password" }, 401);
  const token = await createToken(String(username));
  return c.json({ token, username });
});

// Public: does this instance have login credentials yet? (drives first-run setup)
app.get("/api/auth/status", async (c) => {
  return c.json({ configured: await isAuthConfigured() });
});

// Public first-run: create the very first credentials. Refuses once configured.
app.post("/api/auth/setup", async (c) => {
  if (await isAuthConfigured()) return c.json({ error: "Already configured" }, 403);
  const { username, password } = await c.req.json().catch(() => ({}));
  const u = String(username || "").trim();
  const p = String(password || "");
  if (u.length < 3) return c.json({ error: "Username must be at least 3 characters" }, 400);
  if (p.length < 6) return c.json({ error: "Password must be at least 6 characters" }, 400);
  await setCredentials(u, p);
  const token = await createToken(u);
  return c.json({ token, username: u });
});

// Reaching here means the middleware already validated the token.
app.get("/api/auth/me", async (c) => c.json({ ok: true, username: await getUsername() }));

// Protected: change username and/or password (requires the current password).
app.post("/api/account", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const currentPassword = String(b.currentPassword || "");
  const username = (await getUsername()) || "";
  if (!(await verifyCredentials(username, currentPassword))) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }
  const newUsername = String(b.username || username).trim();
  const newPassword = String(b.newPassword || "");
  if (newUsername.length < 3) return c.json({ error: "Username must be at least 3 characters" }, 400);
  if (newPassword && newPassword.length < 6) {
    return c.json({ error: "New password must be at least 6 characters" }, 400);
  }
  await setCredentials(newUsername, newPassword || currentPassword);
  const token = await createToken(newUsername);
  return c.json({ ok: true, token, username: newUsername });
});

/* ------------------- Links in emails already sent ------------------- */
// The old Resend console is gone, but the emails it sent are still in people's
// inboxes. Their unsubscribe link (and the one-click List-Unsubscribe POST that
// Gmail and Outlook make) must keep working, and their links must still open.
// Nothing else from the old console is served. Its tables stay, untouched.

async function legacyUnsubscribe(contactId: string | undefined) {
  if (!contactId) return;
  try {
    const row = (await q(`SELECT email FROM contacts WHERE id = ?`, [contactId]))[0];
    await q(`UPDATE contacts SET status = 'unsubscribed' WHERE id = ?`, [contactId]);
    // Carry the opt-out into the new engine so no campaign emails them again.
    const email = String(row?.email || "").trim().toLowerCase();
    if (email && (await instantlyConfigured())) {
      await blockEntry(email).catch((e) => console.error(`[unsubscribe] Instantly block failed: ${String(e?.message || e)}`));
    }
  } catch (e: any) {
    console.error(`[unsubscribe] ${String(e?.message || e)}`);
  }
}

const UNSUBSCRIBED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f2eee6;color:#0b0b0b;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.card{background:#fff;border:1px solid #e3dcce;border-radius:16px;padding:40px;max-width:420px;text-align:center}</style></head>
<body><div class="card"><h2>You're unsubscribed</h2><p>You won't receive further emails from us. Sorry to see you go.</p></div></body></html>`;

app.get("/api/unsubscribe", async (c) => {
  await legacyUnsubscribe(c.req.query("c"));
  return c.html(UNSUBSCRIBED_PAGE);
});

// RFC 8058 one-click unsubscribe: the mail client POSTs to the same URL.
app.post("/api/unsubscribe", async (c) => {
  await legacyUnsubscribe(c.req.query("c"));
  return c.body(null, 200);
});

// Link redirect. Only for sends that really exist, and only to http(s), so it
// can't be used as an open redirect.
app.get("/api/click", async (c) => {
  const s = c.req.query("s") || "";
  const raw = c.req.query("u") || "";
  let target = "";
  try {
    target = decodeURIComponent(raw);
  } catch {
    target = raw;
  }
  if (s && /^https?:\/\//i.test(target)) {
    const known = (await q(`SELECT id FROM sends WHERE id = ?`, [s]).catch(() => []))[0];
    if (known) return c.redirect(target, 302);
  }
  return c.text("This link is no longer available.", 404);
});

/* ---------------------- Outreach v2 (AI agent) ---------------------- */
// Mailbox pool (Instantly), AI lead engine + campaigns, reply inbox. Mounted
// BEFORE the static catch-all below so /api/v2/* never falls through to it.
await mountV2(app);
startV2Workers();

// Anything else under /api (including the old console's routes) is gone.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

/* ------------------ Static frontend (single-process) ---------------- */
// Serves the built frontend (frontend/dist) so the whole app can run as one
// server on one port. In the split deploy (Netlify + Railway) this simply
// no-ops because dist isn't present on the API host.

const DIST = process.env.FRONTEND_DIST || "../frontend/dist";
app.use("/*", serveStatic({ root: DIST }));
app.get("*", serveStatic({ path: `${DIST}/index.html` }));

/* ------------------------------- Boot ------------------------------- */

const port = Number(process.env.PORT) || 3001;
console.log(`[dna-outreach] API listening on :${port}`);

// idleTimeout raised so long-running requests aren't cut off (max 255s in Bun).
export default { port, idleTimeout: 120, fetch: app.fetch };
