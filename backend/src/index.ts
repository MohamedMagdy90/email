import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import {
  q, ensureSchema, getSetting, setSetting, nowIso,
  recordCrawledDomain, getKnownDomains, getContactEmails,
  getCategories, setCategories,
} from "./db";
import { createJob, getJob, log, type Job } from "./jobs";
import { crawlMany, type CrawlOptions } from "./crawler";
import { registrableDomain, hostOf } from "./crawler/urls";
import { sendEmail, getResendKey } from "./resend";
import { renderTemplate, wrapHtml } from "./template";
import { findLeads, geocodeSuggest, LEAD_CATEGORIES } from "./leads";
import { searchCompanies } from "./search";
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

const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

/* ------------------------------- Auth ------------------------------- */
// Public endpoints (also hit by email recipients, so they must NOT require a token).
const PUBLIC_API = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/status",
  "/api/auth/setup",
  "/api/open",
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

/* ----------------------------- Contacts ----------------------------- */

app.get("/api/contacts", async (c) => {
  const status = c.req.query("status");
  const search = c.req.query("q");
  const category = c.req.query("category");
  const limit = Math.min(Number(c.req.query("limit") || 500), 2000);
  const offset = Number(c.req.query("offset") || 0);

  const where: string[] = [];
  const params: any[] = [];
  if (status && status !== "all") { where.push(`status = ?`); params.push(status); }
  if (category && category !== "all") {
    if (category === "__none__") where.push(`(category IS NULL OR category = '')`);
    else { where.push(`category = ?`); params.push(category); }
  }
  if (search) { const like = `%${search.toLowerCase()}%`; where.push(`(lower(email) LIKE ? OR lower(company) LIKE ?)`); params.push(like, like); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await q(`SELECT * FROM contacts ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const counts = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM contacts GROUP BY status`);
  const total = await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts`);
  return c.json({ contacts: rows, counts, total: total[0]?.n ?? 0 });
});

app.post("/api/contacts", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const email = String(b.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return c.json({ error: "valid email required" }, 400);
  const rows = await q(
    `INSERT INTO contacts (id,email,company,country,industry,category,role_based,source,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,'new',?) ON CONFLICT (email) DO NOTHING RETURNING *`,
    [uid(), email, b.company || null, b.country || null, b.industry || null, b.category || null, b.role_based ? 1 : 0, b.source || "manual", nowIso()]
  );
  if (!rows.length) return c.json({ error: "duplicate", duplicate: true }, 409);
  return c.json({ contact: rows[0] });
});

// Bulk add contacts. `upsert:true` updates existing rows (company/country/
// industry/category) while PRESERVING their status — used by CSV re-import so a
// contact you've already emailed keeps its "sent" status. Default (crawler /
// discovery) skips existing rows.
app.post("/api/contacts/bulk", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const items: any[] = Array.isArray(b.contacts) ? b.contacts : [];
  const upsert = b.upsert === true;
  let added = 0, updated = 0, skipped = 0;
  for (const it of items) {
    const email = String(it.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) { skipped++; continue; }

    const ins = await q(
      `INSERT INTO contacts (id,email,company,country,industry,category,role_based,source,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,'new',?) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [uid(), email, it.company || null, it.country || null, it.industry || null, it.category || null, it.role_based ? 1 : 0, it.source || "import", nowIso()]
    );
    if (ins.length) { added++; continue; }

    if (!upsert) { skipped++; continue; }

    // Existing row: update only provided, non-empty descriptive fields. Never
    // touches status, id, created_at, or source.
    const sets: string[] = [];
    const vals: any[] = [];
    for (const field of ["company", "country", "industry", "category"] as const) {
      const v = it[field];
      if (v !== undefined && v !== null && String(v).trim() !== "") { sets.push(`${field} = ?`); vals.push(String(v).trim()); }
    }
    if (sets.length) {
      await q(`UPDATE contacts SET ${sets.join(", ")} WHERE email = ?`, [...vals, email]);
      updated++;
    } else {
      skipped++;
    }
  }
  return c.json({ added, updated, skipped });
});

app.put("/api/contacts/:id", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const id = c.req.param("id");
  const existing = (await q(`SELECT * FROM contacts WHERE id=?`, [id]))[0];
  if (!existing) return c.json({ error: "not found" }, 404);
  const email = b.email != null ? String(b.email).trim().toLowerCase() : existing.email;
  if (!email || !email.includes("@")) return c.json({ error: "valid email required" }, 400);
  if (email !== existing.email) {
    const dup = await q(`SELECT id FROM contacts WHERE email=? AND id<>?`, [email, id]);
    if (dup.length) return c.json({ error: "duplicate", duplicate: true }, 409);
  }
  const status = ["new", "sent", "unsubscribed", "bounced"].includes(b.status) ? b.status : existing.status;
  const rows = await q(
    `UPDATE contacts SET email=?, company=?, country=?, industry=?, category=?, status=? WHERE id=? RETURNING *`,
    [
      email,
      b.company !== undefined ? b.company || null : existing.company,
      b.country !== undefined ? b.country || null : existing.country,
      b.industry !== undefined ? b.industry || null : existing.industry,
      b.category !== undefined ? b.category || null : existing.category,
      status,
      id,
    ]
  );
  return c.json({ contact: rows[0] });
});

/* ---------------------------- Categories ---------------------------- */

app.get("/api/categories", async (c) => c.json({ categories: await getCategories() }));

app.post("/api/categories", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!Array.isArray(b.categories)) return c.json({ error: "categories array required" }, 400);
  await setCategories(b.categories.map((x: any) => String(x)));
  return c.json({ categories: await getCategories() });
});

app.post("/api/contacts/delete", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(b.ids) ? b.ids : [];
  if (!ids.length) return c.json({ deleted: 0 });
  const ph = ids.map(() => "?").join(",");
  await q(`DELETE FROM contacts WHERE id IN (${ph})`, ids);
  return c.json({ deleted: ids.length });
});

app.get("/api/contacts/export", async (c) => {
  const status = c.req.query("status");
  const search = c.req.query("q");
  const category = c.req.query("category");
  const where: string[] = [];
  const params: any[] = [];
  if (status && status !== "all") { where.push(`status = ?`); params.push(status); }
  if (category && category !== "all") {
    if (category === "__none__") where.push(`(category IS NULL OR category = '')`);
    else { where.push(`category = ?`); params.push(category); }
  }
  if (search) { const like = `%${search.toLowerCase()}%`; where.push(`(lower(email) LIKE ? OR lower(company) LIKE ?)`); params.push(like, like); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // `email` first and `category` early so it's easy to edit and re-import.
  const rows = await q(`SELECT email,company,country,industry,category,role_based,status,source,created_at FROM contacts ${clause} ORDER BY created_at DESC`, params);
  const header = ["email", "company", "country", "industry", "category", "role_based", "status", "source", "created_at"];
  const csv = [header.join(",")].concat(rows.map((r) => header.map((h) => csvCell(r[h])).join(","))).join("\n");
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="contacts.csv"` },
  });
});

/* ----------------------------- Templates ---------------------------- */

app.get("/api/templates", async (c) => {
  return c.json({ templates: await q(`SELECT * FROM templates ORDER BY created_at DESC`) });
});

app.post("/api/templates", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.name || !b.subject || !b.body) return c.json({ error: "name, subject, body required" }, 400);
  const type = b.type === "partner" ? "partner" : "customer";
  const rows = await q(
    `INSERT INTO templates (id,type,name,subject,body,created_at) VALUES (?,?,?,?,?,?) RETURNING *`,
    [uid(), type, b.name, b.subject, b.body, nowIso()]
  );
  return c.json({ template: rows[0] });
});

app.put("/api/templates/:id", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const type = b.type === "partner" ? "partner" : "customer";
  const rows = await q(
    `UPDATE templates SET type=?, name=?, subject=?, body=? WHERE id=? RETURNING *`,
    [type, b.name, b.subject, b.body, c.req.param("id")]
  );
  if (!rows.length) return c.json({ error: "not found" }, 404);
  return c.json({ template: rows[0] });
});

app.delete("/api/templates/:id", async (c) => {
  await q(`DELETE FROM templates WHERE id=?`, [c.req.param("id")]);
  return c.json({ ok: true });
});

/* ------------------------------ Domains ----------------------------- */

app.get("/api/domains", async (c) => {
  return c.json({ domains: await q(`SELECT * FROM domains ORDER BY created_at`) });
});

app.post("/api/domains", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const domain = normalizeDomain(b.domain);
  const fromEmail = resolveFromEmail(b.from_email, domain);
  if (!domain) return c.json({ error: "Domain is required" }, 400);
  if (!isEmail(fromEmail)) return c.json({ error: `From email must be a full address like no-reply@${domain}` }, 400);
  const rows = await q(
    `INSERT INTO domains (id,domain,from_name,from_email,daily_cap,active,created_at) VALUES (?,?,?,?,?,1,?) RETURNING *`,
    [uid(), domain, String(b.from_name || "DNA Outreach").trim(), fromEmail, Number(b.daily_cap) || 40, nowIso()]
  );
  return c.json({ domain: rows[0] });
});

app.put("/api/domains/:id", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const domain = normalizeDomain(b.domain);
  const fromEmail = resolveFromEmail(b.from_email, domain);
  if (!domain) return c.json({ error: "Domain is required" }, 400);
  if (!isEmail(fromEmail)) return c.json({ error: `From email must be a full address like no-reply@${domain}` }, 400);
  const rows = await q(
    `UPDATE domains SET domain=?, from_name=?, from_email=?, daily_cap=?, active=? WHERE id=? RETURNING *`,
    [domain, String(b.from_name || "DNA Outreach").trim(), fromEmail, Number(b.daily_cap) || 40, b.active !== false ? 1 : 0, c.req.param("id")]
  );
  if (!rows.length) return c.json({ error: "not found" }, 404);
  return c.json({ domain: rows[0] });
});

app.delete("/api/domains/:id", async (c) => {
  await q(`DELETE FROM domains WHERE id=?`, [c.req.param("id")]);
  return c.json({ ok: true });
});

app.post("/api/domains/reset-counts", async (c) => {
  await q(`UPDATE domains SET sent_today = 0`);
  return c.json({ ok: true });
});

/* ------------------------------ Settings ---------------------------- */

app.get("/api/settings", async (c) => {
  const key = await getResendKey();
  const appUrl = (await getSetting("app_url")) || process.env.APP_URL || "";
  const replyTo = (await getSetting("reply_to")) || "";
  return c.json({ resendConfigured: !!key, appUrl, replyTo });
});

app.post("/api/settings", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.resend_api_key === "string" && b.resend_api_key.trim()) await setSetting("resend_api_key", b.resend_api_key.trim());
  if (typeof b.app_url === "string") await setSetting("app_url", b.app_url.trim());
  if (typeof b.reply_to === "string") await setSetting("reply_to", b.reply_to.trim());
  return c.json({ ok: true });
});

// Send a real test email to verify Resend + domain are wired up correctly.
app.post("/api/settings/test-email", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const to = String(b.to || "").trim().toLowerCase();
  if (!to || !to.includes("@")) return c.json({ error: "A valid destination email is required" }, 400);

  const key = await getResendKey();
  if (!key) return c.json({ error: "No Resend API key set. Add one above and save first." }, 400);

  const domains = await q(`SELECT * FROM domains WHERE active=1 ORDER BY created_at`);
  const domain = domains[0];
  let from = "DNA Outreach <onboarding@resend.dev>";
  if (domain) {
    const r = buildFrom(domain);
    if ("error" in r) return c.json({ error: r.error }, 400);
    from = r.from;
  }

  const replyTo = (await getSetting("reply_to")) || "";
  const html = wrapHtml(
    `<p style="font-family:Arial,Helvetica,sans-serif">This is a test email from your DNA Outreach app.</p>
     <p style="font-family:Arial,Helvetica,sans-serif">If you're reading this, Resend is connected and your sending domain works. You're ready to run real campaigns.</p>`,
    "#",
    ""
  );
  const result = await sendEmail({ from, to, subject: "DNA Outreach — test email", html, replyTo: replyTo || undefined });
  if (!result.ok) return c.json({ error: result.error || "Send failed" }, 502);
  return c.json({ ok: true, from });
});

/* ------------------------------- Crawl ------------------------------ */

app.post("/api/crawl", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const rawUrls: string[] = (Array.isArray(b.urls) ? b.urls : String(b.urls || "").split(/[\n,]/))
    .map((u: string) => u.trim())
    .filter(Boolean);
  if (!rawUrls.length) return c.json({ error: "provide at least one URL" }, 400);

  const skipKnown = b.skipKnown !== false; // default ON
  const recrawlDays = clamp(Number(b.recrawlDays) || 60, 1, 365);

  // ---- Dedup pass: drop targets we've already handled ---------------------
  // 1) domains crawled within the freshness window (crawl ledger)
  // 2) domains we already have a contact for (no need to re-find)
  const sinceIso = new Date(Date.now() - recrawlDays * 86400000).toISOString();
  const knownDomains = skipKnown ? await getKnownDomains(sinceIso) : new Map<string, string>();
  const contactDomains = new Set<string>();
  if (skipKnown) {
    for (const email of await getContactEmails()) {
      const d = registrableDomain((email.split("@")[1] || ""));
      if (d) contactDomains.add(d);
    }
  }

  const urls: string[] = [];
  const skipped: { url: string; domain: string; reason: string; lastCrawledAt?: string }[] = [];
  const seenSeed = new Set<string>();
  for (const u of rawUrls) {
    const domain = registrableDomain(hostOf(/^https?:\/\//i.test(u) ? u : "https://" + u));
    if (!domain) { urls.push(u); continue; }
    if (seenSeed.has(domain)) { skipped.push({ url: u, domain, reason: "duplicate" }); continue; }
    seenSeed.add(domain);
    if (skipKnown && contactDomains.has(domain)) { skipped.push({ url: u, domain, reason: "in_contacts" }); continue; }
    if (skipKnown && knownDomains.has(domain)) { skipped.push({ url: u, domain, reason: "crawled", lastCrawledAt: knownDomains.get(domain) }); continue; }
    urls.push(u);
  }

  const keywords: string[] = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || "").split(","))
    .map((k: string) => k.trim())
    .filter(Boolean)
    .slice(0, 12);

  const options: CrawlOptions = {
    maxPages: clamp(Number(b.maxPages) || 25, 1, 60),
    maxDepth: clamp(Number(b.maxDepth) || 2, 0, 3),
    respectRobots: b.respectRobots !== false,
    checkMx: b.checkMx !== false,
    guessInbox: b.guessInbox === true,
    useSitemap: b.useSitemap !== false,
    keywords,
    requireKeyword: b.requireKeyword === true && keywords.length > 0,
    concurrency: clamp(Number(b.concurrency) || 3, 1, 6),
  };

  const job = createJob("crawl", urls.length);
  job.result = { sites: [], emails: [], skipped };

  if (skipped.length) {
    log(job, { level: "info", msg: `Skipped ${skipped.length} already-known site(s). Scanning ${urls.length} new site(s).` });
  }
  if (!urls.length) {
    job.status = "done";
    job.progress = 1;
    log(job, { level: "info", msg: "Nothing new to crawl — every target was already known." });
    return c.json({ jobId: job.id });
  }

  (async () => {
    try {
      await crawlMany(urls, options, (p) => {
        if (p.type === "site-done") {
          job.processed = p.done;
          job.progress = p.total ? p.done / p.total : 1;
          job.result.sites.push(p.result);
          for (const e of p.result.emails) job.result.emails.push(e);
          log(job, { level: "info", msg: `${p.result.site}: ${p.result.emails.length} email(s) [${p.result.status}]` });
          // Remember this domain so we never waste a crawl on it again.
          const dom = registrableDomain(hostOf(p.result.seed || p.result.site));
          if (dom) recordCrawledDomain(dom, p.result.status, p.result.emails.length, p.result.pagesCrawled).catch(() => {});
        } else if (p.type === "site-start") {
          log(job, { level: "info", msg: `Crawling ${p.seed} ...` });
        } else if (p.type === "page" && p.found > 0) {
          log(job, { level: "hit", msg: `+${p.found} on ${shorten(p.url)}` });
        }
      });
      const map = new Map<string, any>();
      for (const e of job.result.emails) if (!map.has(e.email)) map.set(e.email, e);
      job.result.emails = [...map.values()];
      job.status = "done";
      job.progress = 1;
    } catch (e: any) {
      job.status = "error";
      job.error = String(e?.message || e);
    }
  })();

  return c.json({ jobId: job.id });
});

app.get("/api/crawl/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "job not found" }, 404);
  return c.json(serializeJob(job));
});

/* -------------------------------- Send ------------------------------ */

app.post("/api/send", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const templateId = String(b.templateId || "");
  const contactIds: string[] = Array.isArray(b.contactIds) ? b.contactIds : [];
  const perMinute = clamp(Number(b.perMinute) || 20, 1, 120);
  if (!templateId) return c.json({ error: "templateId required" }, 400);
  if (!contactIds.length) return c.json({ error: "select at least one contact" }, 400);

  const job = createJob("send", contactIds.length);
  job.result = { sent: 0, failed: 0, skipped: 0 };

  (async () => {
    try {
      await runSendJob(job, templateId, contactIds, perMinute);
      // Don't override an error status that runSendJob set intentionally.
      if (job.status === "running") { job.status = "done"; job.progress = 1; }
    } catch (e: any) {
      job.status = "error";
      job.error = String(e?.message || e);
    }
  })();

  return c.json({ jobId: job.id });
});

app.get("/api/send/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "job not found" }, 404);
  return c.json(serializeJob(job));
});

async function runSendJob(job: Job, templateId: string, contactIds: string[], perMinute: number) {
  const tpl = (await q(`SELECT * FROM templates WHERE id=?`, [templateId]))[0];
  if (!tpl) { job.status = "error"; job.error = "template not found"; return; }

  const activeDomains = await q(`SELECT * FROM domains WHERE active=1 ORDER BY created_at`);
  const appUrl = ((await getSetting("app_url")) || process.env.APP_URL || "").replace(/\/+$/, "");
  const replyTo = (await getSetting("reply_to")) || "";
  const dryRun = !(await getResendKey());
  if (dryRun) log(job, { level: "warn", msg: "No Resend key set — running in DRY-RUN (nothing is actually sent)." });

  // Validate each active domain's sender up front so a misconfigured "From email"
  // gives a clear, actionable error instead of a cryptic Resend rejection per email.
  const domains: any[] = [];
  for (const d of activeDomains) {
    const r = buildFrom(d);
    if ("error" in r) log(job, { level: "warn", msg: r.error });
    else { d.__from = r.from; domains.push(d); }
  }
  if (!dryRun && activeDomains.length && !domains.length) {
    job.status = "error";
    job.error = "Every active sending domain has an invalid \"From email\". Fix it in Settings → Sending domains (use a full address like outreach@yourdomain.com), then try again.";
    log(job, { level: "fail", msg: job.error });
    return;
  }
  if (!activeDomains.length) log(job, { level: "warn", msg: "No sending domains configured — using Resend's test sender (onboarding@resend.dev)." });
  if (!dryRun && !appUrl) log(job, { level: "warn", msg: "App URL not set in Settings — unsubscribe & open-tracking links will not work. Add it before real sends." });

  const delayMs = dryRun ? 120 : Math.round(60000 / perMinute);
  let di = 0;

  for (const cid of contactIds) {
    if (job.status === "error") break;
    const contact = (await q(`SELECT * FROM contacts WHERE id=?`, [cid]))[0];
    if (!contact) { job.result.skipped++; job.processed++; continue; }
    if (contact.status === "unsubscribed" || contact.status === "bounced") {
      job.result.skipped++;
      job.processed++;
      job.progress = job.total ? job.processed / job.total : 1;
      log(job, { level: "skip", msg: `Skipped ${contact.email} (${contact.status})` });
      continue;
    }

    let domain: any = null;
    if (domains.length) {
      for (let k = 0; k < domains.length; k++) {
        const cand = domains[(di + k) % domains.length];
        if (cand.sent_today < cand.daily_cap) { domain = cand; di = (di + k + 1) % domains.length; break; }
      }
      if (!domain) { log(job, { level: "warn", msg: "All domains hit their daily cap — stopping." }); break; }
    }

    const from = domain ? domain.__from : "DNA Outreach <onboarding@resend.dev>";
    const subject = renderTemplate(tpl.subject, contact);
    const sendId = uid();
    const unsub = appUrl ? `${appUrl}/api/unsubscribe?c=${contact.id}` : "";
    const pixel = appUrl ? `${appUrl}/api/open?s=${sendId}` : "";
    const html = wrapHtml(renderTemplate(tpl.body, contact), unsub, pixel);

    const result = await sendEmail({
      from, to: contact.email, subject, html,
      replyTo: replyTo || undefined,
      headers: unsub
        ? { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
        : undefined,
    });

    const status = result.ok ? (result.dryRun ? "sent (dry-run)" : "sent") : "failed";
    await q(
      `INSERT INTO sends (id,contact_id,contact_email,template_id,domain_id,subject,status,error,sent_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sendId, contact.id, contact.email, tpl.id, domain?.id ?? null, subject, status, result.error ?? null, nowIso(), nowIso()]
    );

    if (result.ok) {
      job.result.sent++;
      await q(`UPDATE contacts SET status='sent' WHERE id=? AND status='new'`, [contact.id]);
      if (domain) { await q(`UPDATE domains SET sent_today = sent_today + 1 WHERE id=?`, [domain.id]); domain.sent_today++; }
      log(job, { level: "sent", msg: `${status} → ${contact.email}` });
    } else {
      job.result.failed++;
      log(job, { level: "fail", msg: `failed → ${contact.email}: ${result.error}` });
    }

    job.processed++;
    job.progress = job.total ? job.processed / job.total : 1;
    if (job.processed < job.total) await sleep(delayMs);
  }
}

/* --------------------------- Tracking / opt-out --------------------- */

const PIXEL = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (ch) => ch.charCodeAt(0));

app.get("/api/open", async (c) => {
  const s = c.req.query("s");
  if (s) await q(`UPDATE sends SET opened=1 WHERE id=?`, [s]).catch(() => {});
  return new Response(PIXEL, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" } });
});

app.get("/api/unsubscribe", async (c) => {
  const id = c.req.query("c");
  if (id) await q(`UPDATE contacts SET status='unsubscribed' WHERE id=?`, [id]).catch(() => {});
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
  <style>body{font-family:Arial,Helvetica,sans-serif;background:#f2eee6;color:#0b0b0b;display:flex;height:100vh;margin:0;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #e3dcce;border-radius:16px;padding:40px;max-width:420px;text-align:center}</style></head>
  <body><div class="card"><h2>You're unsubscribed</h2><p>You won't receive further emails from us. Sorry to see you go.</p></div></body></html>`);
});

/* ---------------------------- Lead Finder --------------------------- */

app.get("/api/leads/categories", (c) => c.json({ categories: Object.keys(LEAD_CATEGORIES) }));

// Location autocomplete for the searchable place picker.
app.get("/api/leads/geocode", async (c) => {
  const q = String(c.req.query("q") || "").trim();
  if (q.length < 2) return c.json({ places: [] });
  try {
    return c.json({ places: await geocodeSuggest(q, 6) });
  } catch {
    return c.json({ places: [] });
  }
});

// Annotate discovered companies with what we already know, so the operator can
// see what's new BEFORE spending a crawl:
//  - inContacts: we already hold an email from this domain (or this exact email)
//  - crawled:    we've already scanned this domain (crawl ledger, any time)
async function annotateCompanies(companies: any[]) {
  const contactDomains = new Set<string>();
  const contactEmails = new Set<string>();
  for (const email of await getContactEmails()) {
    contactEmails.add(email);
    const d = registrableDomain(email.split("@")[1] || "");
    if (d) contactDomains.add(d);
  }
  const everCrawled = await getKnownDomains("0000-01-01T00:00:00.000Z");

  const annotated = companies.map((co) => {
    const domain = co.website ? registrableDomain(hostOf(co.website)) : "";
    const emailDomain = co.email ? registrableDomain(co.email.split("@")[1] || "") : "";
    const inContacts =
      (!!co.email && contactEmails.has(String(co.email).toLowerCase())) ||
      (!!domain && contactDomains.has(domain)) ||
      (!!emailDomain && contactDomains.has(emailDomain));
    const crawled = !!domain && everCrawled.has(domain);
    return { ...co, domain, inContacts, crawled };
  });
  const newCount = annotated.filter((a) => !a.inContacts && !a.crawled).length;
  return { companies: annotated, summary: { total: annotated.length, new: newCount } };
}

app.post("/api/leads/find", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const location = String(b.location || "").trim();
  const category = String(b.category || "Companies (general)");
  const limit = clamp(Number(b.limit) || 40, 5, 120);
  const place = b.place && typeof b.place === "object" ? b.place : undefined;
  if (!location && !place) return c.json({ error: "location required" }, 400);
  try {
    const companies = await findLeads(location, category, limit, place);
    return c.json(await annotateCompanies(companies));
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// Tier-one keyword search: find companies by what their website says.
app.post("/api/leads/search", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const keywords = String(b.keywords || "").trim();
  const location = String(b.location || "").trim();
  const limit = clamp(Number(b.limit) || 30, 5, 80);
  if (!keywords) return c.json({ error: "Enter keywords to search for (e.g. \"auto partner\")." }, 400);
  try {
    const companies = await searchCompanies(keywords, location, limit);
    return c.json(await annotateCompanies(companies));
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// Report which of the given URLs are already known (for the "Paste websites" flow).
app.post("/api/crawl/check", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const urls: string[] = (Array.isArray(b.urls) ? b.urls : String(b.urls || "").split(/[\n,]/))
    .map((u: string) => u.trim())
    .filter(Boolean);
  const recrawlDays = clamp(Number(b.recrawlDays) || 60, 1, 365);
  const sinceIso = new Date(Date.now() - recrawlDays * 86400000).toISOString();
  const known = await getKnownDomains(sinceIso);
  const contactDomains = new Set<string>();
  for (const email of await getContactEmails()) {
    const d = registrableDomain(email.split("@")[1] || "");
    if (d) contactDomains.add(d);
  }
  let inContacts = 0, crawled = 0, fresh = 0;
  const seen = new Set<string>();
  for (const u of urls) {
    const domain = registrableDomain(hostOf(/^https?:\/\//i.test(u) ? u : "https://" + u));
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    if (contactDomains.has(domain)) inContacts++;
    else if (known.has(domain)) crawled++;
    else fresh++;
  }
  return c.json({ total: seen.size, inContacts, crawled, fresh });
});

/* ------------------------------ History ----------------------------- */

app.get("/api/history", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || 200), 1000);
  const rows = await q(
    `SELECT s.*, c.company AS company FROM sends s
     LEFT JOIN contacts c ON c.id = s.contact_id
     ORDER BY s.created_at DESC LIMIT ?`,
    [limit]
  );
  return c.json({ sends: rows });
});

app.get("/api/history/export", async (c) => {
  const rows = await q(
    `SELECT s.contact_email, c.company AS company, s.subject, s.status, s.opened, s.error, s.created_at
     FROM sends s LEFT JOIN contacts c ON c.id = s.contact_id
     ORDER BY s.created_at DESC`
  );
  const header = ["contact_email", "company", "subject", "status", "opened", "error", "created_at"];
  const csv = [header.join(",")]
    .concat(rows.map((r) => header.map((h) => csvCell(h === "opened" ? (r[h] ? "yes" : "no") : r[h])).join(",")))
    .join("\n");
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="send-history.csv"` },
  });
});

app.get("/api/stats", async (c) => {
  const contacts = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM contacts GROUP BY status`);
  const sends = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM sends GROUP BY status`);
  const opens = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends WHERE opened=1`))[0]?.n ?? 0;
  const totalContacts = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts`))[0]?.n ?? 0;
  const totalSends = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends`))[0]?.n ?? 0;
  return c.json({ contacts, sends, opens, totalContacts, totalSends });
});

app.get("/api/overview", async (c) => {
  const contacts = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM contacts GROUP BY status`);
  const sends = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM sends GROUP BY status`);
  const opens = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends WHERE opened=1`))[0]?.n ?? 0;
  const totalContacts = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts`))[0]?.n ?? 0;
  const totalSends = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends`))[0]?.n ?? 0;

  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  const recent = await q(`SELECT created_at FROM sends WHERE created_at > ?`, [cutoff]);
  const bucket: Record<string, number> = {};
  for (const r of recent) { const d = String(r.created_at).slice(0, 10); bucket[d] = (bucket[d] || 0) + 1; }
  const daily = Object.entries(bucket).map(([d, n]) => ({ d, n })).sort((a, b) => (a.d < b.d ? -1 : 1));

  return c.json({ contacts, sends, opens, totalContacts, totalSends, daily });
});

/* ------------------------------ Helpers ----------------------------- */

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function shorten(u: string) { try { const x = new URL(u); return x.hostname + x.pathname; } catch { return u; } }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isEmail(s: string) { return EMAIL_RE.test(String(s || "").trim()); }

// Clean a domain input: strip protocol, path, and leading www.
function normalizeDomain(s: string) {
  return String(s || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").toLowerCase();
}

// Resolve a From email: if the user typed only a mailbox ("no-reply"), attach the domain.
function resolveFromEmail(input: string, domain: string) {
  let v = String(input || "").trim();
  if (v && !v.includes("@") && domain) v = `${v}@${domain}`;
  return v.toLowerCase();
}

// Build an RFC-5322-safe "Name <email>" sender from a domain row.
// Returns { from } on success or { error } with a clear, actionable message.
function buildFrom(domain: any): { from: string } | { error: string } {
  const email = String(domain?.from_email || "").trim();
  if (!isEmail(email)) {
    return {
      error:
        `Sending domain "${domain?.domain || "?"}" has an invalid "From email" (${email ? `"${email}"` : "empty"}). ` +
        `It must be a full address like outreach@yourdomain.com. Fix it in Settings → Sending domains.`,
    };
  }
  let name = String(domain?.from_name || "").trim();
  if (!name) return { from: email };
  // Quote the display name when it contains characters that would break the header.
  if (/[",:;<>@\\]/.test(name)) name = `"${name.replace(/["\\]/g, "").trim()}"`;
  return { from: `${name} <${email}>` };
}

function csvCell(v: any): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function serializeJob(job: Job) {
  return {
    id: job.id, type: job.type, status: job.status, progress: job.progress,
    total: job.total, processed: job.processed, logs: job.logs.slice(-120),
    result: job.result, error: job.error,
  };
}

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

export default { port, fetch: app.fetch };
