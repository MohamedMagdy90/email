import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import {
  q, ensureSchema, getSetting, setSetting, nowIso,
  recordCrawledDomain, getKnownDomains, getContactEmails,
  getCategories, setCategories,
} from "./db";
import { createJob, getJob, log, type Job } from "./jobs";
import { crawlMany, crawlSite, type CrawlOptions } from "./crawler";
import { crawlDirectoryMany, type DirectoryOptions } from "./crawler/directory";
import { parsePdf } from "./crawler/pdf";
import { resolveWebsite } from "./enrich";
import { fetchViaProxy, type ProxyConfig, type ScrapeProvider } from "./crawler/fetcher";
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

const SCRAPE_PROVIDERS: ScrapeProvider[] = ["scrapingbee", "scraperapi", "zenrows"];

// Assemble the scraping-proxy config from settings, or undefined when disabled.
async function getProxyConfig(): Promise<ProxyConfig | undefined> {
  const provider = (await getSetting("scrape_provider")) as ScrapeProvider | null;
  const apiKey = await getSetting("scrape_api_key");
  if (!provider || !SCRAPE_PROVIDERS.includes(provider) || !apiKey) return undefined;
  const mode = (await getSetting("scrape_mode")) === "always" ? "always" : "blocked";
  const premium = (await getSetting("scrape_premium")) !== "0"; // default ON (needed for Cloudflare)
  return { provider, apiKey, mode, premium, renderJs: true };
}

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

/* ------------------------------- Auth ------------------------------- */
// Public endpoints (also hit by email recipients, so they must NOT require a token).
const PUBLIC_API = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/status",
  "/api/auth/setup",
  "/api/open",
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

/* ----------------------------- Contacts ----------------------------- */

// Shared, portable WHERE builder used by list / export / bulk-by-filter so the
// exact same filter can be re-applied server-side (e.g. "delete all matching").
function contactWhere(opts: { status?: string | null; q?: string | null; category?: string | null }) {
  const where: string[] = [];
  const params: any[] = [];
  const status = opts.status;
  const search = opts.q;
  const category = opts.category;
  if (status && status !== "all") { where.push(`status = ?`); params.push(status); }
  if (category && category !== "all") {
    if (category === "__none__") where.push(`(category IS NULL OR category = '')`);
    else { where.push(`category = ?`); params.push(category); }
  }
  if (search) {
    const like = `%${String(search).toLowerCase()}%`;
    where.push(`(lower(email) LIKE ? OR lower(company) LIKE ?)`);
    params.push(like, like);
  }
  return { where, params, clause: where.length ? `WHERE ${where.join(" AND ")}` : "" };
}

// Opaque keyset cursor: (created_at, id). Keyset paging stays fast at any depth,
// unlike OFFSET which walks + discards every skipped row.
function encodeCursor(created_at: string, id: string) {
  return Buffer.from(`${created_at}~${id}`).toString("base64url");
}
function decodeCursor(s?: string | null): { created_at: string; id: string } | null {
  if (!s) return null;
  try {
    const raw = Buffer.from(String(s), "base64url").toString("utf8");
    const i = raw.indexOf("~");
    if (i < 0) return null;
    return { created_at: raw.slice(0, i), id: raw.slice(i + 1) };
  } catch { return null; }
}

app.get("/api/contacts", async (c) => {
  const status = c.req.query("status");
  const search = c.req.query("q");
  const category = c.req.query("category");
  const limit = clamp(Number(c.req.query("limit") || 50), 1, 200);
  const cursor = decodeCursor(c.req.query("cursor"));

  const { where, params, clause } = contactWhere({ status, q: search, category });

  // Keyset page: everything strictly "after" the cursor in (created_at DESC, id DESC).
  const pageWhere = [...where];
  const pageParams = [...params];
  if (cursor) {
    pageWhere.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
    pageParams.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  const pageClause = pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : "";

  // Fetch one extra row to detect whether a next page exists. Engagement
  // (opens/clicks) is rolled up per-contact from `sends` via a LEFT JOIN — the
  // aggregate's column names don't clash with `contacts`, so the shared filter
  // (bare column names) still resolves correctly.
  const rows = await q(
    `SELECT c.*,
            e.open_count AS open_count,
            e.first_opened_at AS first_opened_at,
            e.last_opened_at AS last_opened_at,
            e.click_count AS click_count,
            e.last_clicked_at AS last_clicked_at
       FROM contacts c
       LEFT JOIN (
         SELECT contact_id,
                CAST(SUM(open_count) AS INTEGER)  AS open_count,
                MIN(first_opened_at)              AS first_opened_at,
                MAX(last_opened_at)               AS last_opened_at,
                CAST(SUM(click_count) AS INTEGER) AS click_count,
                MAX(last_clicked_at)              AS last_clicked_at
           FROM sends
          WHERE contact_id IS NOT NULL
          GROUP BY contact_id
       ) e ON e.contact_id = c.id
       ${pageClause}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`,
    [...pageParams, limit + 1]
  );
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    nextCursor = encodeCursor(String(last.created_at), String(last.id));
    rows.length = limit; // trim the probe row
  }

  const filteredTotalRow = await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts ${clause}`, params);
  const counts = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM contacts GROUP BY status`);
  const total = await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts`);
  return c.json({
    contacts: rows,
    counts,
    total: total[0]?.n ?? 0,
    filteredTotal: filteredTotalRow[0]?.n ?? 0,
    nextCursor,
  });
});

app.post("/api/contacts", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const email = String(b.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return c.json({ error: "valid email required" }, 400);
  const rows = await q(
    `INSERT INTO contacts (id,email,company,country,industry,category,phone,role_based,source,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'new',?) ON CONFLICT (email) DO NOTHING RETURNING *`,
    [uid(), email, b.company || null, b.country || null, b.industry || null, b.category || null, b.phone || null, b.role_based ? 1 : 0, b.source || "manual", nowIso()]
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
      `INSERT INTO contacts (id,email,company,country,industry,category,phone,role_based,source,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,'new',?) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [uid(), email, it.company || null, it.country || null, it.industry || null, it.category || null, it.phone || null, it.role_based ? 1 : 0, it.source || "import", nowIso()]
    );
    if (ins.length) { added++; continue; }

    if (!upsert) { skipped++; continue; }

    // Existing row: update only provided, non-empty descriptive fields. Never
    // touches status, id, created_at, or source.
    const sets: string[] = [];
    const vals: any[] = [];
    for (const field of ["company", "country", "industry", "category", "phone"] as const) {
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
    `UPDATE contacts SET email=?, company=?, country=?, industry=?, category=?, phone=?, status=? WHERE id=? RETURNING *`,
    [
      email,
      b.company !== undefined ? b.company || null : existing.company,
      b.country !== undefined ? b.country || null : existing.country,
      b.industry !== undefined ? b.industry || null : existing.industry,
      b.category !== undefined ? b.category || null : existing.category,
      b.phone !== undefined ? b.phone || null : existing.phone,
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

// Delete either an explicit set of ids, or EVERY row matching a filter
// (`all:true` + the same status/q/category used by the list). The filter path
// lets "select all N matching" delete thousands without shipping ids around.
app.post("/api/contacts/delete", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b.all === true) {
    const { clause, params } = contactWhere({ status: b.status, q: b.q, category: b.category });
    const before = await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts ${clause}`, params);
    await q(`DELETE FROM contacts ${clause}`, params);
    return c.json({ deleted: before[0]?.n ?? 0 });
  }
  const ids: string[] = Array.isArray(b.ids) ? b.ids : [];
  if (!ids.length) return c.json({ deleted: 0 });
  const ph = ids.map(() => "?").join(",");
  await q(`DELETE FROM contacts WHERE id IN (${ph})`, ids);
  return c.json({ deleted: ids.length });
});

// Set (or clear) the category on a set of ids, or on EVERY row matching a
// filter (`all:true`). An empty `value` clears the category.
app.post("/api/contacts/set-category", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const value = String(b.value ?? "").trim() || null;
  if (b.all === true) {
    const { clause, params } = contactWhere({ status: b.status, q: b.q, category: b.category });
    const before = await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts ${clause}`, params);
    await q(`UPDATE contacts SET category = ? ${clause}`, [value, ...params]);
    return c.json({ updated: before[0]?.n ?? 0 });
  }
  const ids: string[] = Array.isArray(b.ids) ? b.ids : [];
  if (!ids.length) return c.json({ updated: 0 });
  const ph = ids.map(() => "?").join(",");
  await q(`UPDATE contacts SET category = ? WHERE id IN (${ph})`, [value, ...ids]);
  return c.json({ updated: ids.length });
});

app.get("/api/contacts/export", async (c) => {
  const { clause, params } = contactWhere({
    status: c.req.query("status"),
    q: c.req.query("q"),
    category: c.req.query("category"),
  });
  // `email` first and `category`/`phone` early so it's easy to edit and re-import.
  const rows = await q(`SELECT email,company,country,industry,category,phone,role_based,status,source,created_at FROM contacts ${clause} ORDER BY created_at DESC`, params);
  const header = ["email", "company", "country", "industry", "category", "phone", "role_based", "status", "source", "created_at"];
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
  const scrapeKey = await getSetting("scrape_api_key");
  return c.json({
    resendConfigured: !!key,
    appUrl,
    replyTo,
    scrape: {
      configured: !!scrapeKey,
      provider: (await getSetting("scrape_provider")) || "",
      mode: (await getSetting("scrape_mode")) === "always" ? "always" : "blocked",
      premium: (await getSetting("scrape_premium")) !== "0",
    },
  });
});

app.post("/api/settings", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.resend_api_key === "string" && b.resend_api_key.trim()) await setSetting("resend_api_key", b.resend_api_key.trim());
  if (typeof b.app_url === "string") await setSetting("app_url", b.app_url.trim());
  if (typeof b.reply_to === "string") await setSetting("reply_to", b.reply_to.trim());
  // Scraping proxy
  if (typeof b.scrape_provider === "string") await setSetting("scrape_provider", SCRAPE_PROVIDERS.includes(b.scrape_provider as ScrapeProvider) ? b.scrape_provider : "");
  if (typeof b.scrape_api_key === "string" && b.scrape_api_key.trim()) await setSetting("scrape_api_key", b.scrape_api_key.trim());
  if (b.scrape_api_key === "") await setSetting("scrape_api_key", ""); // explicit clear
  if (typeof b.scrape_mode === "string") await setSetting("scrape_mode", b.scrape_mode === "always" ? "always" : "blocked");
  if (typeof b.scrape_premium === "boolean") await setSetting("scrape_premium", b.scrape_premium ? "1" : "0");
  return c.json({ ok: true });
});

// Validate the scraping proxy by fetching a known Cloudflare-protected page
// through it. Reports whether the challenge was solved.
app.post("/api/settings/test-scrape", async (c) => {
  const cfg = await getProxyConfig();
  if (!cfg) return c.json({ error: "Save a scraping provider and API key first." }, 400);
  const target = "https://nowsecure.nl"; // small, reliably Cloudflare-protected test page
  const r = await fetchViaProxy(target, cfg, 75000);
  if (r.ok) return c.json({ ok: true, provider: cfg.provider, via: r.via, bytes: r.html.length });
  if (r.blocked) return c.json({ error: `Proxy could not solve the challenge (${r.blockReason}). Enable premium/stealth mode, then retry.` }, 502);
  return c.json({ error: r.error || `Proxy request failed (HTTP ${r.status}).` }, 502);
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

  // ---- Directory harvest mode ------------------------------------------
  // Paste a business-directory URL; walk its pages, open every listing, and
  // extract company + email + phone. Different result shape (contacts, not
  // per-domain emails), so it's handled separately from the per-company crawl.
  if (b.mode === "directory") {
    const proxy = await getProxyConfig();
    const dirOptions: DirectoryOptions = {
      maxPages: clamp(Number(b.maxPages) || 20, 1, 100),
      maxDetails: clamp(Number(b.maxDetails) || 300, 1, 2000),
      concurrency: proxy ? clamp(Number(b.concurrency) || 3, 1, 5) : clamp(Number(b.concurrency) || 5, 1, 8),
      respectRobots: b.respectRobots !== false,
      checkMx: b.checkMx !== false,
      defaultCountry: String(b.defaultCountry || "").trim() || undefined,
      proxy,
    };
    const job = createJob("crawl", rawUrls.length);
    job.result = { mode: "directory", contacts: [], sites: [] };
    log(job, { level: "info", msg: `Harvesting ${rawUrls.length} director${rawUrls.length === 1 ? "y" : "ies"}…${proxy ? ` · scraping proxy: ${proxy.provider} (${proxy.mode})` : ""}` });

    (async () => {
      try {
        const known = new Set(await getContactEmails());
        const results = await crawlDirectoryMany(rawUrls, dirOptions, (p) => {
          if ((p.type === "phase" || p.type === "page") && p.msg) log(job, { level: "info", msg: p.msg });
          else if (p.type === "detail") {
            if (p.detailTotal) job.progress = Math.min(0.98, (p.detailPages || 0) / p.detailTotal);
            log(job, { level: "hit", msg: `opened ${p.detailPages}/${p.detailTotal} · ${p.contacts} lead(s)` });
          }
        });
        const seen = new Set<string>();
        const contacts: any[] = [];
        for (const r of results) {
          job.result.sites.push({ seed: r.seed, site: r.site, status: r.status, listingPages: r.listingPages, detailPages: r.detailPages, found: r.contacts.length, note: r.note });
          log(job, { level: "info", msg: `${r.site}: ${r.contacts.length} lead(s) from ${r.detailPages} page(s) [${r.status}]` });
          if (r.note && (r.status === "blocked" || r.status === "empty" || r.status === "error")) {
            log(job, { level: r.status === "blocked" ? "warn" : "info", msg: `↳ ${r.note}` });
          }
          for (const co of r.contacts) {
            const dk = String(co.email || co.phone || co.detailUrl).toLowerCase();
            if (seen.has(dk)) continue;
            seen.add(dk);
            contacts.push({ ...co, inContacts: !!(co.email && known.has(co.email.toLowerCase())) });
          }
        }
        job.result.contacts = contacts;
        job.processed = job.total;
        job.status = "done";
        job.progress = 1;
        log(job, { level: "info", msg: `Done — ${contacts.length} unique lead(s) harvested.` });
      } catch (e: any) {
        job.status = "error";
        job.error = String(e?.message || e);
      }
    })();

    return c.json({ jobId: job.id });
  }

  // ---- PDF enrichment mode ---------------------------------------------
  // Take rows parsed from a directory PDF ({ company, phone, category, … }),
  // resolve each company's website, then crawl it for an email. Same result
  // shape as the directory harvest so the frontend reuses the leads table.
  if (b.mode === "enrich") {
    const proxy = await getProxyConfig();
    const rawRows: any[] = Array.isArray(b.rows) ? b.rows : [];
    const list = rawRows
      .map((r) => ({
        company: String(r.company || "").trim(),
        category: r.category ? String(r.category).trim() : undefined,
        phone: r.phone ? String(r.phone).trim() : undefined,
        phoneMobile: !!r.phoneMobile,
        email: r.email ? String(r.email).trim().toLowerCase() : undefined,
        website: r.website ? String(r.website).trim() : undefined,
      }))
      .filter((r) => r.company)
      .slice(0, clamp(Number(b.maxRows) || 100, 1, 20000));
    if (!list.length) return c.json({ error: "No companies to enrich" }, 400);

    const country = String(b.defaultCountry || "").trim() || undefined;
    const crawlOpts: CrawlOptions = {
      maxPages: 8,
      maxDepth: 1,
      respectRobots: b.respectRobots !== false,
      checkMx: b.checkMx !== false,
      guessInbox: b.guessInbox !== false, // default ON — the whole point is to get an email
      useSitemap: true,
      defaultCountry: country,
      concurrency: 1,
      proxy,
    };

    const job = createJob("crawl", list.length);
    job.result = { mode: "enrich", contacts: [], sites: [] };
    log(job, { level: "info", msg: `Enriching ${list.length} compan${list.length === 1 ? "y" : "ies"} from PDF…${proxy ? ` · scraping proxy: ${proxy.provider}` : ""}` });

    (async () => {
      try {
        const known = new Set(await getContactEmails());
        const out: any[] = new Array(list.length);
        let done = 0;
        let idx = 0;
        const concurrency = proxy ? 2 : 3;

        async function worker() {
          while (idx < list.length) {
            const my = idx++;
            const row = list[my];
            let website = row.website
              ? (/^https?:\/\//i.test(row.website) ? row.website : "https://" + row.website)
              : "";
            let domain = website ? registrableDomain(hostOf(website)) || "" : "";
            let email = row.email;
            let phone = row.phone;
            let phoneMobile = row.phoneMobile;
            let role_based = email ? /^(info|sales|contact|support|admin|office|enquir|inquir|general|mail|hello)/i.test(email) : false;

            // 1) Find the website if the PDF didn't already have one.
            if (!website) {
              const r = await resolveWebsite(row.company, country || "").catch(() => null);
              if (r) { website = /^https?:\/\//i.test(r.website) ? r.website : "https://" + r.website; domain = r.domain; }
            }

            // 2) Crawl the site for an email (unless the PDF already had one).
            if (!email && website) {
              const site = await crawlSite(website, crawlOpts).catch(() => null);
              if (site && site.emails.length) {
                const best = site.emails[0];
                email = best.email;
                role_based = best.role_based;
                domain = best.domain || domain;
                if (!phone && site.phone) { phone = site.phone; phoneMobile = !!site.phoneMobile; }
              }
            }
            if (website && !domain) domain = registrableDomain(hostOf(website)) || "";

            out[my] = {
              name: row.company,
              email: email || null,
              phone: phone || null,
              phoneMobile: !!phoneMobile,
              role_based,
              category: row.category || null,
              detailUrl: website || "",
              domain,
              inContacts: !!(email && known.has(email.toLowerCase())),
            };
            done++;
            job.processed = done;
            job.progress = Math.min(0.99, done / list.length);
            log(job, {
              level: email ? "hit" : "info",
              msg: `${row.company}: ${email ? email : website ? "site found, no email" : "no website found"}`,
            });
          }
        }

        await Promise.all(Array.from({ length: concurrency }, worker));
        const contacts = out.filter(Boolean);
        job.result.contacts = contacts;
        job.status = "done";
        job.progress = 1;
        job.processed = list.length;
        const withEmail = contacts.filter((x) => x.email).length;
        log(job, { level: "info", msg: `Done — ${withEmail}/${contacts.length} compan${contacts.length === 1 ? "y" : "ies"} got an email.` });
      } catch (e: any) {
        job.status = "error";
        job.error = String(e?.message || e);
      }
    })();

    return c.json({ jobId: job.id });
  }

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

  const proxy = await getProxyConfig();
  const options: CrawlOptions = {
    maxPages: clamp(Number(b.maxPages) || 25, 1, 60),
    maxDepth: clamp(Number(b.maxDepth) || 2, 0, 3),
    respectRobots: b.respectRobots !== false,
    checkMx: b.checkMx !== false,
    guessInbox: b.guessInbox === true,
    useSitemap: b.useSitemap !== false,
    keywords,
    requireKeyword: b.requireKeyword === true && keywords.length > 0,
    defaultCountry: String(b.defaultCountry || "").trim() || undefined,
    concurrency: proxy ? clamp(Number(b.concurrency) || 2, 1, 4) : clamp(Number(b.concurrency) || 3, 1, 6),
    proxy,
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

/* ----------------------------- PDF import --------------------------- */
// Upload a business-directory PDF; extract structured rows (company, category,
// phone, and any inline email/website). The rows are then handed to /api/crawl
// with mode:"enrich" to find the missing websites + emails.
app.post("/api/import/pdf", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Upload a PDF file." }, 400);
  }
  const file = form.get("file");
  const country = String(form.get("country") || "").trim();
  if (!(file instanceof File)) return c.json({ error: "Attach a PDF file (field \"file\")." }, 400);
  if (file.size > 50 * 1024 * 1024) {
    return c.json(
      {
        error:
          "PDF is too large (max 50 MB). A text directory is usually small — a 170 MB+ file is image-heavy and will overload the server. " +
          "Please split it into smaller parts (or use \"Reduce File Size\" / export as text) and upload each part.",
      },
      413
    );
  }

  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const { rows, pages, textChars, lineCount, sampleLines } = await parsePdf(buf, country || undefined);
    let reason: string | undefined;
    if (!rows.length) {
      // near-empty text layer ⇒ the PDF is scanned images (needs OCR);
      // otherwise we read text but couldn't recognise the listing layout.
      reason = textChars < 200 ? "scanned" : "no_listings";
      console.log(`[import/pdf] 0 rows · pages=${pages} chars=${textChars} lines=${lineCount} · sample:`);
      for (const l of sampleLines.slice(0, 30)) console.log("   | " + l);
    }
    return c.json({ rows, pages, count: rows.length, textChars, lineCount, reason, sample: sampleLines });
  } catch (e: any) {
    return c.json({ error: "Could not read this PDF — " + String(e?.message || e) }, 400);
  }
});

/* -------------------------------- Send ------------------------------ */

app.post("/api/send", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const templateId = String(b.templateId || "");
  let contactIds: string[] = Array.isArray(b.contactIds) ? b.contactIds : [];
  const perMinute = clamp(Number(b.perMinute) || 20, 1, 120);
  if (!templateId) return c.json({ error: "templateId required" }, 400);

  // "Send to all matching" — resolve recipients server-side from the same filter
  // the recipient list uses, so you can target 100k+ without shipping every id.
  // Always excludes unsubscribed/bounced (they'd only be skipped anyway).
  if (b.all === true) {
    const { where, params } = contactWhere({ status: b.status, category: b.category });
    const conds = [...where, `status NOT IN ('unsubscribed','bounced')`];
    const rows = await q(
      `SELECT id FROM contacts WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 200000`,
      params
    );
    contactIds = rows.map((r) => String(r.id));
  }

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
    const clickBase = appUrl ? `${appUrl}/api/click?s=${sendId}` : "";
    const html = wrapHtml(renderTemplate(tpl.body, contact), unsub, pixel, clickBase);

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
  if (s) {
    const now = nowIso();
    await q(
      `UPDATE sends
         SET opened = 1,
             open_count = open_count + 1,
             first_opened_at = COALESCE(first_opened_at, ?),
             last_opened_at = ?
       WHERE id = ?`,
      [now, now, s]
    ).catch(() => {});
  }
  return new Response(PIXEL, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" } });
});

// Click tracker: records the click (a click also proves an open), then 302s to
// the real URL. Only http(s) targets are honoured to avoid open-redirect abuse.
app.get("/api/click", async (c) => {
  const s = c.req.query("s");
  const raw = c.req.query("u") || "";
  let target = "";
  try { target = decodeURIComponent(raw); } catch { target = raw; }
  const safe = /^https?:\/\//i.test(target) ? target : "";

  // Only record a click when we're actually redirecting to a legitimate target,
  // so tampered/unsafe links (e.g. javascript:) don't inflate the metric.
  if (s && safe) {
    const now = nowIso();
    await q(
      `UPDATE sends
         SET click_count = click_count + 1,
             first_clicked_at = COALESCE(first_clicked_at, ?),
             last_clicked_at = ?,
             opened = 1,
             open_count = CASE WHEN open_count = 0 THEN 1 ELSE open_count END,
             first_opened_at = COALESCE(first_opened_at, ?),
             last_opened_at = COALESCE(last_opened_at, ?)
       WHERE id = ?`,
      [now, now, now, now, s]
    ).catch(() => {});
  }

  if (safe) return c.redirect(safe, 302);
  return c.text("This link is no longer available.", 400);
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
    `SELECT s.contact_email, c.company AS company, s.subject, s.status, s.opened,
            s.open_count, s.first_opened_at, s.last_opened_at,
            s.click_count, s.first_clicked_at, s.last_clicked_at,
            s.error, s.created_at
     FROM sends s LEFT JOIN contacts c ON c.id = s.contact_id
     ORDER BY s.created_at DESC`
  );
  const header = [
    "contact_email", "company", "subject", "status", "opened",
    "open_count", "first_opened_at", "last_opened_at",
    "click_count", "first_clicked_at", "last_clicked_at",
    "error", "created_at",
  ];
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
  const clicks = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends WHERE click_count>0`))[0]?.n ?? 0;
  const totalContacts = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts`))[0]?.n ?? 0;
  const totalSends = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends`))[0]?.n ?? 0;
  return c.json({ contacts, sends, opens, clicks, totalContacts, totalSends });
});

app.get("/api/overview", async (c) => {
  const contacts = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM contacts GROUP BY status`);
  const sends = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM sends GROUP BY status`);
  const opens = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends WHERE opened=1`))[0]?.n ?? 0;
  const clicks = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends WHERE click_count>0`))[0]?.n ?? 0;
  const totalContacts = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts`))[0]?.n ?? 0;
  const totalSends = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM sends`))[0]?.n ?? 0;

  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  const recent = await q(`SELECT created_at FROM sends WHERE created_at > ?`, [cutoff]);
  const bucket: Record<string, number> = {};
  for (const r of recent) { const d = String(r.created_at).slice(0, 10); bucket[d] = (bucket[d] || 0) + 1; }
  const daily = Object.entries(bucket).map(([d, n]) => ({ d, n })).sort((a, b) => (a.d < b.d ? -1 : 1));

  return c.json({ contacts, sends, opens, clicks, totalContacts, totalSends, daily });
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
