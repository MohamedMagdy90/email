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
import { crawlDirectoryMany, type DirectoryOptions } from "./crawler/directory";
import { parsePdf } from "./crawler/pdf";
import { enrichCompany } from "./enrich";
import {
  fetchViaProxy, fetchViaReader, parseReaderKeys, readerKeyHealth, maskReaderKey,
  getTransportStats, archiveHealth, type ScrapeProvider,
} from "./crawler/fetcher";
import { registrableDomain, hostOf } from "./crawler/urls";
import { cleanEmail, isValidEmail } from "./crawler/validate";
import { sendEmail, getResendKey } from "./resend";
import { renderTemplate, wrapHtml } from "./template";
import { runSendJob, buildFrom, isEmail } from "./send";
import { discoveredWhere, approveLeads, NO_COUNTRY } from "./pool";
import {
  startAutomationWorker,
  getAutomationStatus,
  setAutomationConfig,
  startAutomationRun,
} from "./automation";
import { setSchedule, type CountryRule } from "./schedule";
import {
  startFollowUpWorker,
  getFollowUpStatus,
  setFollowUpConfig,
  startFollowUpRun,
  MAX_STEPS,
} from "./followup";
import { findLeads, geocodeSuggest, LEAD_CATEGORIES } from "./leads";
import { backfillCountries } from "./country";
import { searchCompanies, searchEngineHealth } from "./search";
import { SCRAPE_PROVIDERS, getProxyConfig, getReaderKey } from "./config";
import {
  startDiscoveryWorker,
  getDiscoveryStatus,
  setBotEnabled,
  setAutoEnrich,
  runSourceNow,
  initialCursor,
  reEnrichBlocked,
  stopSource,
  rejectDiplomaticLeads,
  rejectAggregatorLeads,
  rejectContentLeads,
  repairEscapedEmails,
  repairPageTitleNames,
  sweepNonProspectLeads,
  STALE_AFTER_RUNS,
  STALE_OFF_AFTER_RUNS,
} from "./discovery";
import { repairLeadNames, countBadNames } from "./repair";
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
startDiscoveryWorker(); // always-on company discovery (browser-independent)
startAutomationWorker(); // auto-approve a full pool → auto-send (browser-independent)
startFollowUpWorker(); // retry ladder — nobody gets one email and silence

// Give every lead and contact one canonical country. Rows saved before the
// country was resolved properly are blank (the source's Country box was left
// empty) or hold a full address instead of a country — both are repaired from
// the domain and phone number. Idempotent and set-based, so it's safe to run on
// every boot; kept off the critical path so it never delays serving.
backfillCountries(q, (m) => console.log(`[country] ${m}`))
  .then((r) => {
    if (r.leads || r.contacts) console.log(`[country] backfill done — ${r.leads} lead(s), ${r.contacts} contact(s)`);
  })
  .catch((e) => console.error(`[country] backfill failed: ${String(e?.message || e)}`));

// Embassies and consulates harvested before they were excluded. Moved to
// Rejected, not deleted, so the change is visible and reversible.
rejectDiplomaticLeads().catch((e) => console.error(`[cleanup] ${String(e?.message || e)}`));
// Same for directories, job boards and classifieds saved as if they were
// companies. They sit behind Cloudflare, so they were also monopolising the
// crawl queue with retries that could never succeed.
rejectAggregatorLeads().catch((e) => console.error(`[cleanup] ${String(e?.message || e)}`));
// And the haul from the old head-term queries: company-formation agencies,
// regulators, and articles ABOUT companies ("Company Setup in Qatar").
rejectContentLeads().catch((e) => console.error(`[cleanup] ${String(e?.message || e)}`));
// Addresses mangled by JSON escapes ("u003einfo@…") are unmailable — unmangle them.
repairEscapedEmails().catch((e) => console.error(`[cleanup] ${String(e?.message || e)}`));
// And rewrite company names that are really page headlines ("FCCSA - Home").
repairPageTitleNames().catch((e) => console.error(`[cleanup] ${String(e?.message || e)}`));

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

/**
 * Health, and — deliberately — which BUILD is answering.
 *
 * Every other `/api/*` path sits behind the auth middleware, which returns 401
 * for a route that does not exist just as readily as for one that does. That
 * makes "did my deploy actually land?" unanswerable from outside: probing a
 * newly-added endpoint returns 401 either way. Railway injects the commit it
 * built, so the honest answer is simply to publish it here.
 *
 * Nothing secret: the repo is public and this is a bare commit SHA.
 */
const BUILD_REV =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ||
  process.env.SOURCE_COMMIT?.slice(0, 7) ||
  process.env.GIT_COMMIT?.slice(0, 7) ||
  "dev";
app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now(), rev: BUILD_REV }));

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
  // Normalise first: pasted addresses arrive wrapped in markup ("<a@b.com>"),
  // with a mailto: scheme, or with URL-encoded padding.
  const email = cleanEmail(String(b.email || "")) || "";
  if (!email || !isValidEmail(email)) return c.json({ error: "valid email required" }, 400);
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
    const email = cleanEmail(String(it.email || "")) || "";
    if (!email || !isValidEmail(email)) { skipped++; continue; }

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
    reader: {
      // Free crawler is always on; a key just raises the free rate limit.
      configured: !!(await getSetting("jina_api_key")),
      fromEnv: !!process.env.JINA_API_KEY,
      // The pool, one entry per key. Keys are added and removed individually,
      // so the UI never has to show or re-send one that is already stored —
      // and each is listed only as a masked fingerprint.
      keys: readerKeyHealth(parseReaderKeys((await getSetting("jina_api_key")) || process.env.JINA_API_KEY || "")),
      savedKeys: parseReaderKeys((await getSetting("jina_api_key")) || process.env.JINA_API_KEY || "").length,
    },
    // Where the crawler's pages ACTUALLY came from since this process booted.
    // Without it, "is the reader still doing all the work?" was unanswerable —
    // and that question is the whole point of the free tiers.
    transports: {
      pages: getTransportStats(),
      archives: archiveHealth(),
      searchEngines: searchEngineHealth(),
    },
  });
});

/* ----------------------- Reader key pool (add/remove) ------------------- */
// Deliberately append/remove rather than "save the whole field". The single
// text box replaced everything it held, and because it was a password input
// that cleared itself, adding a second key silently destroyed the first.

app.post("/api/settings/reader-key", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const incoming = parseReaderKeys(String(b.key || ""));
  if (!incoming.length) return c.json({ error: "Paste a key first." }, 400);

  const existing = parseReaderKeys((await getSetting("jina_api_key")) || "");
  const merged = [...existing];
  let added = 0;
  let duplicates = 0;
  for (const k of incoming) {
    if (merged.includes(k)) { duplicates++; continue; }
    merged.push(k);
    added++;
  }
  await setSetting("jina_api_key", merged.join(","));
  return c.json({ ok: true, added, duplicates, total: merged.length });
});

app.delete("/api/settings/reader-key", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const masked = String(b.masked || "");
  if (!masked) return c.json({ error: "Which key?" }, 400);
  const existing = parseReaderKeys((await getSetting("jina_api_key")) || "");
  const kept = existing.filter((k) => maskReaderKey(k) !== masked);
  if (kept.length === existing.length) return c.json({ error: "That key is no longer saved." }, 404);
  await setSetting("jina_api_key", kept.join(","));
  return c.json({ ok: true, total: kept.length });
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
  // Free reader (Jina) — optional key raises the free rate limit.
  if (typeof b.jina_api_key === "string" && b.jina_api_key.trim()) await setSetting("jina_api_key", b.jina_api_key.trim());
  if (b.jina_api_key === "") await setSetting("jina_api_key", ""); // explicit clear
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

// Validate the FREE Jina Reader (and any saved key) by rendering a JS-heavy page.
app.post("/api/settings/test-reader", async (c) => {
  const key = await getReaderKey();
  const r = await fetchViaReader("https://example.com", 45000, key).catch((e) => ({ ok: false, status: 0, html: "", error: String(e?.message || e) } as any));
  if (r.ok && r.html) return c.json({ ok: true, keyed: !!key, bytes: r.html.length });
  return c.json({ error: r.error || `Reader request failed (HTTP ${r.status}).`, keyed: !!key }, 502);
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
  // The PDF enrichment mode carries `rows`, not `urls`, so it's exempt here.
  if (b.mode !== "enrich" && !rawUrls.length) return c.json({ error: "provide at least one URL" }, 400);

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
          job.result.sites.push({ seed: r.seed, site: r.site, status: r.status, listingPages: r.listingPages, detailPages: r.listingsRead, found: r.contacts.length, note: r.note });
          log(job, { level: "info", msg: `${r.site}: ${r.contacts.length} lead(s) from ${r.listingsRead} listing(s) across ${r.listingPages} page(s) [${r.status}]` });
          if (r.note) {
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
    const readerKey = await getReaderKey();
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
      readerKey,
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

            // Full pipeline: search "<name> <country>" → best site → crawl for
            // email; fall back to social/directory profiles (Facebook, Talabat…)
            // to recover the real website + email; then domain-guessing.
            const r = await enrichCompany(
              {
                company: row.company,
                category: row.category,
                phone: row.phone,
                phoneMobile: row.phoneMobile,
                email: row.email,
                website: row.website,
              },
              country || "",
              { crawlOpts, proxy, readerKey, useProfiles: b.useProfiles !== false, guessDomains: b.guessDomains !== false }
            ).catch(() => null);

            const email = r?.email || null;
            const website = r?.website || "";
            const domain = r?.domain || (website ? registrableDomain(hostOf(website)) || "" : "");

            out[my] = {
              name: row.company,
              email,
              phone: r?.phone || null,
              phoneMobile: !!r?.phoneMobile,
              role_based: !!r?.role_based,
              category: row.category || null,
              detailUrl: website,
              domain,
              source: r?.source || null, // pdf | site | social | guess
              via: r?.via || null, // e.g. "facebook.com" when recovered from a profile
              confidence: r?.confidence || null, // verified | likely | guess
              inContacts: !!(email && known.has(email.toLowerCase())),
            };
            done++;
            job.processed = done;
            job.progress = Math.min(0.99, done / list.length);

            // Human-readable status: where the email/website came from.
            let msg: string;
            if (email) {
              const tag =
                r?.source === "social" ? ` (via ${r.via})` :
                r?.source === "guess" ? " (guessed domain)" :
                r?.source === "pdf" ? " (from PDF)" : "";
              msg = `${row.company}: ${email}${tag}`;
            } else if (website) {
              msg = `${row.company}: site found (${domain}), no email`;
            } else {
              msg = `${row.company}: no website found`;
            }
            log(job, { level: email ? "hit" : "info", msg });
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
  const readerKey = await getReaderKey();
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
    readerKey,
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
  // One template, or several that rotate across the recipients.
  const templateIds: string[] = (Array.isArray(b.templateIds) ? b.templateIds : [b.templateId])
    .map((x: any) => String(x || "").trim())
    .filter(Boolean);
  let contactIds: string[] = Array.isArray(b.contactIds) ? b.contactIds : [];
  const perMinute = clamp(Number(b.perMinute) || 20, 1, 120);
  if (!templateIds.length) return c.json({ error: "templateId required" }, 400);

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
      await runSendJob(job, templateIds, contactIds, perMinute);
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

// The send pipeline (domain rotation, caps, pacing, tracking links, the sends
// ledger) lives in ./send so the manual sender and the automation are the
// same code path.

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
  const limit = clamp(Number(b.limit) || 40, 5, 500);
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

/* --------------------------- Discovery bot -------------------------- */
// A server-side worker that continuously discovers companies into a reviewable
// pool (discovered_leads). It runs while the process is up — no browser needed.

// Live status: bot on/off, source counts, and the review-pool breakdown.
app.get("/api/discovery/status", async (c) => c.json(await getDiscoveryStatus()));

// Flip the global bot switch and/or the "auto-find emails" behaviour.
app.post("/api/discovery/toggle", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.enabled === "boolean") await setBotEnabled(b.enabled);
  if (typeof b.autoEnrich === "boolean") await setAutoEnrich(b.autoEnrich);
  return c.json(await getDiscoveryStatus());
});

// Re-attempt the leads whose email couldn't be read because their site blocked
// the crawler (Cloudflare) or the free reader was rate-limited — recovers the
// historical "no email" pool, especially after adding a Jina key / scraping proxy.
app.post("/api/discovery/re-enrich", async (c) => {
  const r = await reEnrichBlocked();
  return c.json(r);
});
// ---- Purge leads that could never have been prospects ----
// The same sweep that runs at boot, on demand. Needed because the rules that
// decide "this was never a company" get tighter over time — most recently after
// a search engine spent a while answering a different question than the one it
// was asked — and the rows filed under the old rules are still sitting in the
// queue costing a full crawl each to disprove.
app.post("/api/discovery/purge-junk", async (c) => {
  const swept = await sweepNonProspectLeads();
  return c.json({ swept });
});
// ---- Repair company names saved by the old (broken) directory harvester ----
// It used to store the card's tel: link as the company name. This re-reads the
// directory sources and writes the real names back. Runs as a job because a
// full re-walk takes minutes.
app.get("/api/discovery/bad-names", async (c) => c.json(await countBadNames()));
app.post("/api/discovery/repair-names", async (c) => {
  const job = createJob("crawl");
  job.result = { mode: "repair" };
  log(job, { level: "info", msg: "Checking every saved company name…" });
  (async () => {
    try {
      const r = await repairLeadNames((msg) => log(job, { level: msg.startsWith("  ✓") ? "hit" : "info", msg }));
      job.result = { mode: "repair", ...r };
      job.total = r.badLeads + r.badContacts;
      job.processed = r.fixedLeads + r.fixedContacts;
      job.progress = 1;
      for (const n of r.notes) log(job, { level: "warn", msg: n });
      job.status = "done";
    } catch (e: any) {
      job.status = "error";
      job.error = String(e?.message || e);
      log(job, { level: "error", msg: job.error });
    }
  })();
  return c.json({ jobId: job.id });
});

// ---- Sources (the location+industry "watchers" the bot cycles through) ----

app.get("/api/discovery/sources", async (c) => {
  // Archived sources are kept out of the way but never deleted: they keep their
  // walk position, their stats and every lead they ever found, and can be
  // restored later exactly where they left off.
  const archived = c.req.query("archived") === "1";
  const sources = await q(
    `SELECT * FROM discovery_sources WHERE archived=? ORDER BY ${archived ? "archived_at DESC, created_at DESC" : "created_at DESC"}`,
    [archived ? 1 : 0]
  );
  const archivedCount = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE archived=1`))[0]?.n ?? 0;
  // How many LIVE sources have run themselves dry (see STALE_AFTER_RUNS). Sent
  // with every list so the tab can flag them without a second request, and so
  // the count is identical to the one the Overview shows.
  const staleCount = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE archived=0 AND barren_runs >= ?`,
    [STALE_AFTER_RUNS]
  ))[0]?.n ?? 0;
  return c.json({ sources, archivedCount, staleCount, staleAfterRuns: STALE_AFTER_RUNS, staleOffAfterRuns: STALE_OFF_AFTER_RUNS });
});

app.post("/api/discovery/sources", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const type = b.type === "directory" ? "directory" : b.type === "search" ? "search" : "osm";
  const category = String(b.category || "Companies (general)").trim();
  const interval = clamp(Number(b.intervalMinutes) || 360, 15, 100000);
  const enabled = b.enabled === false ? 0 : 1;
  // Who this source is hunting. Every lead it files inherits the tag, and the
  // automation runs a separate lane per audience — so a partner directory can
  // never be emailed the customer pitch.
  const audience = String(b.audience || "").trim().toLowerCase() === "partner" ? "partner" : "customer";

  // Web-search source: runs free-text searches (industry × the country and its
  // cities), pages through the results, and streams every company site into the
  // pool. This is the source that scales to thousands (OSM tops out in hundreds).
  if (type === "search") {
    const location = String(b.location || "").trim();
    const keywords = String(b.keywords || "").trim();
    if (!location && !keywords) return c.json({ error: "Enter a country/city and/or some keywords to search for" }, 400);
    const limit = clamp(Number(b.limit) || 100, 20, 300);
    // Also walk Common Crawl's index of the country's own ccTLD. Default OFF:
    // it reaches far more of a country than the keyword queries can, but a
    // ccTLD lists every HOST in a country rather than every business, so it
    // needs a deliberate "yes" and it needs the category filter to have
    // something to bite on.
    const sweep = b.sweepCountry === true ? 1 : 0;
    const rows = await q(
      `INSERT INTO discovery_sources
        (id,type,location,keywords,category,audience,limit_n,interval_minutes,enabled,cursor,sweep_country,next_run_at,created_at)
       VALUES (?, 'search', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING *`,
      [uid(), location, keywords || null, category, audience, limit, interval, enabled, sweep, nowIso(), nowIso()]
    );
    return c.json({ source: rows[0] });
  }

  // Directory source: walks a business-directory URL page-by-page, forever.
  if (type === "directory") {
    let url = String(b.url || b.base_url || "").trim();
    if (!url) return c.json({ error: "Directory URL is required" }, 400);
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try { new URL(url); } catch { return c.json({ error: "Enter a valid directory URL" }, 400); }
    const country = String(b.location || b.country || "").trim(); // for phone parsing + label
    const limit = clamp(Number(b.limit) || 100, 20, 300); // leads per batch
    const rows = await q(
      `INSERT INTO discovery_sources
        (id,type,base_url,cursor,exhausted,location,place_json,category,audience,limit_n,interval_minutes,enabled,next_run_at,created_at)
       VALUES (?, 'directory', ?, ?, 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [uid(), url, initialCursor(url), country, category, audience, limit, interval, enabled, nowIso(), nowIso()]
    );
    return c.json({ source: rows[0] });
  }

  // OSM area source.
  const location = String(b.location || "").trim();
  if (!location) return c.json({ error: "Location is required" }, 400);
  const limit = clamp(Number(b.limit) || 40, 5, 500);
  const placeJson = b.place && typeof b.place === "object" ? JSON.stringify(b.place) : null;
  const rows = await q(
    `INSERT INTO discovery_sources
      (id,type,location,place_json,category,audience,limit_n,interval_minutes,enabled,next_run_at,created_at)
     VALUES (?, 'osm', ?,?,?,?,?,?,?,?,?) RETURNING *`,
    [uid(), location, placeJson, category, audience, limit, interval, enabled, nowIso(), nowIso()]
  );
  return c.json({ source: rows[0] });
});

app.put("/api/discovery/sources/:id", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const id = c.req.param("id");
  const existing = (await q(`SELECT * FROM discovery_sources WHERE id=?`, [id]))[0];
  if (!existing) return c.json({ error: "not found" }, 404);
  const location = b.location != null ? String(b.location).trim() : existing.location;
  const category = b.category != null ? String(b.category).trim() : existing.category;
  const keywords = b.keywords != null ? String(b.keywords).trim() : existing.keywords;
  // Re-tagging a source only changes what it files FROM NOW ON — leads it has
  // already put in the pool keep the tag they were found under, which is right:
  // they were found by a search aimed at that audience.
  const audience =
    b.audience != null
      ? (String(b.audience).trim().toLowerCase() === "partner" ? "partner" : "customer")
      : (existing.audience || "customer");
  const limit = b.limit != null ? clamp(Number(b.limit), 5, 500) : existing.limit_n;
  const interval = b.intervalMinutes != null ? clamp(Number(b.intervalMinutes), 15, 100000) : existing.interval_minutes;
  const enabled = typeof b.enabled === "boolean" ? (b.enabled ? 1 : 0) : existing.enabled;
  const placeJson =
    b.place !== undefined ? (b.place && typeof b.place === "object" ? JSON.stringify(b.place) : null) : existing.place_json;

  // For directory sources: a URL change restarts the walk; re-enabling resumes it.
  let baseUrl = existing.base_url;
  let cursor = existing.cursor;
  let exhausted = existing.exhausted;
  let emptyStreak = existing.empty_streak;
  // Re-aiming a source is how you "replace" it, so it earns a clean slate on the
  // stale counter: judging the new URL / keywords / area by the old one's dry
  // runs would flag it the moment it was fixed. Merely pausing, renaming or
  // re-scheduling it changes nothing about what it can find, so those don't.
  let barrenRuns = Number(existing.barren_runs) || 0;
  const reAimed =
    (b.url != null || b.base_url != null || b.keywords != null || b.location != null ||
     b.category != null || b.place !== undefined || b.sweepCountry != null);
  if (existing.type === "directory") {
    if (b.url != null || b.base_url != null) {
      let url = String(b.url ?? b.base_url ?? "").trim();
      if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
      if (url && url !== existing.base_url) { baseUrl = url; cursor = initialCursor(url); exhausted = 0; emptyStreak = 0; }
    }
    if (enabled && !existing.enabled) { exhausted = 0; emptyStreak = 0; } // re-enable ⇒ resume
  } else if (existing.type === "search") {
    // Changing what/where we search restarts the query plan from the top.
    // Toggling the country sweep counts as a change too: it alters the LENGTH
    // of the plan, and a cursor pointing into a plan that grew or shrank under
    // it resumes at the wrong step.
    const changed =
      (b.keywords != null && String(b.keywords).trim() !== String(existing.keywords || "")) ||
      (b.location != null && String(b.location).trim() !== String(existing.location || "")) ||
      (b.category != null && String(b.category).trim() !== String(existing.category || "")) ||
      (b.sweepCountry != null && (b.sweepCountry ? 1 : 0) !== Number(existing.sweep_country ?? 0));
    if (changed) { cursor = 1; exhausted = 0; emptyStreak = 0; }
    if (enabled && !existing.enabled) { exhausted = 0; emptyStreak = 0; } // re-enable ⇒ resume
  }

  // Switching a source OFF must stop the batch it's running right now, not just
  // stop scheduling the next one.
  if (!enabled && existing.enabled) stopSource(id);

  const sweepCountry =
    b.sweepCountry != null ? (b.sweepCountry ? 1 : 0) : Number(existing.sweep_country ?? 0);
  const changedAim =
    reAimed &&
    (String(baseUrl || "") !== String(existing.base_url || "") ||
     String(keywords || "") !== String(existing.keywords || "") ||
     location !== existing.location ||
     category !== existing.category ||
     String(placeJson || "") !== String(existing.place_json || "") ||
     sweepCountry !== Number(existing.sweep_country ?? 0));
  // Switching a source back on BY HAND is the other clean slate. Without it the
  // bot would run it once, see the same dry result, and switch it straight off
  // again — which reads as the toggle being broken. Turning it on is an explicit
  // "try again", so it gets a full set of runs to prove itself, and it re-flags
  // at STALE_AFTER_RUNS if it can't. Only a real 0 → 1 transition counts, so
  // saving an already-on source doesn't quietly wipe its history.
  const switchedOnByHand = typeof b.enabled === "boolean" && b.enabled && !Number(existing.enabled);
  if (changedAim || switchedOnByHand) barrenRuns = 0;
  const autoOff = changedAim || switchedOnByHand ? 0 : Number(existing.auto_off) || 0;
  const rows = await q(
    `UPDATE discovery_sources
       SET location=?, place_json=?, category=?, audience=?, keywords=?, limit_n=?, interval_minutes=?, enabled=?, base_url=?, cursor=?, exhausted=?, empty_streak=?, sweep_country=?, barren_runs=?, auto_off=?
     WHERE id=? RETURNING *`,
    [location, placeJson, category, audience, keywords || null, limit, interval, enabled, baseUrl, cursor, exhausted, emptyStreak, sweepCountry, barrenRuns, autoOff, id]
  );
  return c.json({ source: rows[0] });
});

app.delete("/api/discovery/sources/:id", async (c) => {
  const id = c.req.param("id");
  // Tell any batch already in flight to stop BEFORE the row disappears. Without
  // this, deleting a running source left it crawling for minutes and still
  // filing leads — it genuinely stayed active after you deleted it.
  stopSource(id);
  await q(`DELETE FROM discovery_sources WHERE id=?`, [id]);
  return c.json({ ok: true });
});

// ---- Archive / restore ----
// Archiving retires a source WITHOUT losing anything: the bot stops scheduling
// it, it disappears from the active list and every count, but its walk position,
// stats and all the leads it found stay exactly as they were. Restoring puts it
// back on the very page it stopped at.
app.post("/api/discovery/sources/:id/archive", async (c) => {
  const id = c.req.param("id");
  stopSource(id); // halt an in-flight batch too, not just future scheduling
  const rows = await q(
    `UPDATE discovery_sources SET archived=1, archived_at=?, last_status=NULL, next_run_at=NULL WHERE id=? RETURNING *`,
    [nowIso(), id]
  );
  if (!rows.length) return c.json({ error: "Source not found" }, 404);
  return c.json({ source: rows[0] });
});

app.post("/api/discovery/sources/:id/unarchive", async (c) => {
  const id = c.req.param("id");
  // Comes back due immediately so a restored source picks straight up.
  const rows = await q(
    `UPDATE discovery_sources SET archived=0, archived_at=NULL, next_run_at=? WHERE id=? RETURNING *`,
    [nowIso(), id]
  );
  if (!rows.length) return c.json({ error: "Source not found" }, 404);
  return c.json({ source: rows[0] });
});

// Run one source immediately (works even when the bot is paused). Fire-and-
// forget: a directory batch can take longer than the HTTP idle timeout, and the
// UI polls status to show progress + results as they stream in.
app.post("/api/discovery/sources/:id/run", async (c) => {
  const id = c.req.param("id");
  const exists = (await q(`SELECT id, archived FROM discovery_sources WHERE id=?`, [id]))[0];
  if (!exists) return c.json({ error: "Source not found" }, 404);
  if (Number(exists.archived) === 1) return c.json({ error: "This source is archived — restore it first." }, 400);
  runSourceNow(id).catch(() => {});
  return c.json({ started: true });
});

// ---- The review pool ----

// `discoveredWhere` / `approveLeads` / `NO_COUNTRY` / `ROLE_RE` live in ./pool,
// so the buttons below and the automation approve through ONE path.

app.get("/api/discovery/leads", async (c) => {
  const status = c.req.query("status") || "pending";
  const search = c.req.query("q");
  const country = c.req.query("country");
  // customer | partner | "" (both). Applied server-side so every bulk button
  // acts on exactly the rows on screen.
  const audience = c.req.query("audience");
  const hasEmail = c.req.query("hasEmail") === "1";
  const limit = clamp(Number(c.req.query("limit") || 100), 1, 500);
  const { clause, params } = discoveredWhere({ status, q: search, hasEmail, country, audience });
  const leads = await q(
    `SELECT * FROM discovered_leads ${clause} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit]
  );
  const counts = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM discovered_leads GROUP BY status`);
  const filteredTotal = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads ${clause}`, params))[0]?.n ?? 0;
  // How many leads in the CURRENT tab + country + audience + search are
  // approvable — that is exactly what the "Approve all" button will act on.
  const ap = discoveredWhere({ status: "pending", q: search, hasEmail: true, country, audience });
  const approvableTotal = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads ${ap.clause}`, ap.params))[0]?.n ?? 0;
  // How the whole tab splits between the two pitches, so the filter can show
  // real counts rather than making you click to find out.
  const aw = discoveredWhere({ status, q: search, hasEmail, country });
  const audienceRows = await q(
    `SELECT CASE WHEN lower(COALESCE(audience,'customer')) = 'partner' THEN 'partner' ELSE 'customer' END AS audience,
            CAST(count(*) AS INTEGER) AS n
       FROM discovered_leads ${aw.clause}
      GROUP BY CASE WHEN lower(COALESCE(audience,'customer')) = 'partner' THEN 'partner' ELSE 'customer' END`,
    aw.params
  );
  // Every country present in this tab, with counts, so the filter lists real
  // options for the WHOLE pool — not just the page that happens to be loaded.
  const cw = discoveredWhere({ status, audience });
  const countries = await q(
    `SELECT COALESCE(NULLIF(country, ''), '${NO_COUNTRY}') AS country, CAST(count(*) AS INTEGER) AS n
       FROM discovered_leads ${cw.clause}
      GROUP BY COALESCE(NULLIF(country, ''), '${NO_COUNTRY}')
      ORDER BY n DESC`,
    cw.params
  );
  // Where the leads in this exact view stand. Without this, a pool of 1,387 that
  // shows 107 "with email only" looks like the bot found 107 — when it actually
  // found 1,387 and is still turning the rest into email addresses.
  const bw = discoveredWhere({ status, q: search, country, audience });
  const b = (await q(
    `SELECT
        CAST(SUM(CASE WHEN email IS NOT NULL AND email <> '' THEN 1 ELSE 0 END) AS INTEGER) AS withEmail,
        CAST(SUM(CASE WHEN (email IS NULL OR email = '') AND website IS NOT NULL AND website <> '' AND enriched = 0 THEN 1 ELSE 0 END) AS INTEGER) AS crawling,
        CAST(SUM(CASE WHEN (email IS NULL OR email = '') AND (website IS NULL OR website = '') AND enriched = 0 THEN 1 ELSE 0 END) AS INTEGER) AS queued,
        CAST(SUM(CASE WHEN (email IS NULL OR email = '') AND enriched = 1 THEN 1 ELSE 0 END) AS INTEGER) AS noEmail
       FROM discovered_leads ${bw.clause}`,
    bw.params
  ))[0] || {};
  const breakdown = {
    withEmail: Number(b.withEmail) || 0,   // ready to approve
    crawling: Number(b.crawling) || 0,     // has a site, being crawled for the address
    queued: Number(b.queued) || 0,         // no site yet — we'll search the web for one
    noEmail: Number(b.noEmail) || 0,       // looked everywhere, none published
  };
  return c.json({ leads, counts, filteredTotal, approvableTotal, countries, breakdown, audiences: audienceRows });
});

// Approve leads → create Contacts (only ones with an email) and mark 'approved'.
// Accepts an explicit id list, or every matching pending lead (`all:true`).
// Each new contact is filed under the audience of the lead it came from, so the
// customer / partner split survives approval.
app.post("/api/discovery/leads/approve", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await approveLeads({
    ids: Array.isArray(b.ids) ? b.ids : undefined,
    all: b.all === true,
    q: b.q,
    filterCountry: b.filterCountry,
    filterAudience: b.filterAudience ?? b.audience,
    category: b.category,
    country: b.country,
  });
  return c.json({ added: r.added, skipped: r.skipped });
});

// Reject leads (dismiss from the pool) — by ids or every matching pending lead.
app.post("/api/discovery/leads/reject", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b.all === true) {
    const { clause, params } = discoveredWhere({ status: "pending", q: b.q, country: b.filterCountry, audience: b.filterAudience ?? b.audience });
    const before = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads ${clause}`, params))[0]?.n ?? 0;
    await q(`UPDATE discovered_leads SET status='rejected' ${clause}`, params);
    return c.json({ rejected: before });
  }
  const ids: string[] = Array.isArray(b.ids) ? b.ids : [];
  if (!ids.length) return c.json({ rejected: 0 });
  const ph = ids.map(() => "?").join(",");
  await q(`UPDATE discovered_leads SET status='rejected' WHERE id IN (${ph})`, ids);
  return c.json({ rejected: ids.length });
});

// Permanently delete pool rows — by ids or every row matching a filter.
app.post("/api/discovery/leads/delete", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b.all === true) {
    const { clause, params } = discoveredWhere({ status: b.status, q: b.q, country: b.filterCountry, audience: b.filterAudience ?? b.audience });
    const before = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads ${clause}`, params))[0]?.n ?? 0;
    await q(`DELETE FROM discovered_leads ${clause}`, params);
    return c.json({ deleted: before });
  }
  const ids: string[] = Array.isArray(b.ids) ? b.ids : [];
  if (!ids.length) return c.json({ deleted: 0 });
  const ph = ids.map(() => "?").join(",");
  await q(`DELETE FROM discovered_leads WHERE id IN (${ph})`, ids);
  return c.json({ deleted: ids.length });
});

/* ----------------------------- Automation --------------------------- */
// Hands-free outreach: when the review pool holds N leads that have an email,
// approve that batch into Contacts and email them with the chosen template(s).
// Config + live status + the run ledger come back in one call so the Settings
// screen renders the whole panel from a single poll.

app.get("/api/automation", async (c) => c.json(await getAutomationStatus()));

app.post("/api/automation", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  // One lane's worth of settings. Anything absent is left exactly as it is, so
  // the UI can save a single field of a single lane without touching the other.
  const lane = (v: any) => {
    if (!v || typeof v !== "object") return undefined;
    return {
      enabled: typeof v.enabled === "boolean" ? v.enabled : undefined,
      threshold: v.threshold != null ? Number(v.threshold) : undefined,
      templateIds: Array.isArray(v.templateIds) ? v.templateIds.map((x: any) => String(x)) : undefined,
      templateMode: v.templateMode === "split" ? "split" as const : v.templateMode === "rotate" ? "rotate" as const : undefined,
      category: typeof v.category === "string" ? v.category : undefined,
      country: typeof v.country === "string" ? v.country : undefined,
    };
  };
  await setAutomationConfig({
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
    customer: lane(b.customer),
    partner: lane(b.partner),
    perMinute: b.perMinute != null ? Number(b.perMinute) : undefined,
    dailyLimit: b.dailyLimit != null ? Number(b.dailyLimit) : undefined,
    cooldownMinutes: b.cooldownMinutes != null ? Number(b.cooldownMinutes) : undefined,
    requireResend: typeof b.requireResend === "boolean" ? b.requireResend : undefined,
  });
  // The sending windows ride along on the same save, so the Automation card is
  // still one screen with one Save button.
  if (b.schedule && typeof b.schedule === "object") {
    const s = b.schedule;
    const win = (v: any) =>
      v && typeof v === "object"
        ? {
            start: v.start != null ? Number(v.start) : undefined,
            end: v.end != null ? Number(v.end) : undefined,
            days: Array.isArray(v.days) ? v.days.map((d: any) => Number(d)) : undefined,
          }
        : undefined;
    // A country posted as null means "go back to the default window".
    let countries: Record<string, CountryRule | null> | undefined;
    if (s.countries && typeof s.countries === "object") {
      countries = {};
      for (const [k, v] of Object.entries<any>(s.countries)) {
        if (v === null) { countries[k] = null; continue; }
        if (!v || typeof v !== "object") continue;
        countries[k] = {
          ...win(v),
          timezone: typeof v.timezone === "string" ? v.timezone : undefined,
          paused: v.paused === true,
        };
      }
    }
    await setSchedule({
      enabled: typeof s.enabled === "boolean" ? s.enabled : undefined,
      window: win(s.window),
      countries,
      fallbackTimezone: typeof s.fallbackTimezone === "string" ? s.fallbackTimezone : undefined,
      sendUnknown: typeof s.sendUnknown === "boolean" ? s.sendUnknown : undefined,
    });
  }
  return c.json(await getAutomationStatus());
});

// Run one lane right now — ignores the trigger count and the cooldown (that's
// the point of a manual run) but still respects every safety check: a template
// must be chosen, Resend must be connected, and the daily ceiling still applies.
app.post("/api/automation/run", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await startAutomationRun("manual", String(b.audience || "customer"));
  if (!r.started) return c.json({ error: r.error || r.note || "Nothing to do right now" }, 400);
  return c.json({ ...r, status: await getAutomationStatus() });
});

/* ---------------------------- Follow-up ladder ---------------------- */
// Retries: a contact who never opened gets a different email a few hours later,
// and a contact who opened but never clicked gets another angle — up to a hard
// ceiling of 3 emails per sequence. Config + who's due + the ledger come back in
// one call so the Settings card renders from a single poll.

// Normalise a ladder posted by the UI: exactly MAX_STEPS rungs, numbers as
// numbers, ids as strings. The engine clamps the values again on save.
function parseLadder(input: any): { templateId: string; delayHours: number }[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: { templateId: string; delayHours: number }[] = [];
  for (let i = 0; i < MAX_STEPS; i++) {
    const s = input[i] || {};
    out.push({ templateId: String(s.templateId || ""), delayHours: Number(s.delayHours) || 0 });
  }
  return out;
}

// One audience's pair of ladders. Absent branches are left exactly as they are,
// so saving the partner lane can never touch the customer lane — which is the
// bug this shape exists to make impossible.
function parseLane(input: any) {
  if (!input || typeof input !== "object") return undefined;
  const noOpen = parseLadder(input.noOpen);
  const noClick = parseLadder(input.noClick);
  if (!noOpen && !noClick) return undefined;
  return { noOpen, noClick };
}

app.get("/api/followup", async (c) => c.json(await getFollowUpStatus()));

app.post("/api/followup", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  await setFollowUpConfig({
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
    maxEmails: b.maxEmails != null ? Number(b.maxEmails) : undefined,
    customer: parseLane(b.customer),
    partner: parseLane(b.partner),
    // Legacy flat payload (an older frontend) → the customer lane.
    noOpen: b.customer ? undefined : parseLadder(b.noOpen),
    noClick: b.customer ? undefined : parseLadder(b.noClick),
    perMinute: b.perMinute != null ? Number(b.perMinute) : undefined,
    dailyLimit: b.dailyLimit != null ? Number(b.dailyLimit) : undefined,
    batchSize: b.batchSize != null ? Number(b.batchSize) : undefined,
    lookbackDays: b.lookbackDays != null ? Number(b.lookbackDays) : undefined,
    requireResend: typeof b.requireResend === "boolean" ? b.requireResend : undefined,
  });
  return c.json(await getFollowUpStatus());
});

// Send everything that is due right now, without waiting for the next tick.
// It can't "skip ahead" — a retry that isn't due yet is still not due.
app.post("/api/followup/run", async (c) => {
  const r = await startFollowUpRun("manual");
  if (!r.started) return c.json({ error: r.error || r.note || "Nothing is due right now" }, 400);
  return c.json({ ...r, status: await getFollowUpStatus() });
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

  // ---- Emails sent, day by day -------------------------------------------
  // THE SERIES IS BUILT HERE, COMPLETE, INCLUDING THE EMPTY DAYS. It used to
  // return only the days that had rows and leave the browser to line them up
  // against a locally-computed calendar — which quietly dropped a bucket
  // whenever the viewer's clock sat on the other side of midnight UTC from the
  // server's.
  //
  // Two more corrections while we're here:
  //  · it counted EVERY row in `sends`, including failures and still-queued
  //    rows, so the chart disagreed with the "Emails sent" card above it,
  //    which only counts `sent*`;
  //  · it bucketed on `created_at` (when the row was queued), so a send queued
  //    before midnight and delivered after it landed on the wrong day.
  const DAYS = 14;
  const now = new Date();
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (DAYS - 1) * 86400000;
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const series = new Map<string, { d: string; n: number; sent: number; failed: number; opens: number; clicks: number }>();
  for (let i = 0; i < DAYS; i++) {
    const d = dayKey(startMs + i * 86400000);
    series.set(d, { d, n: 0, sent: 0, failed: 0, opens: 0, clicks: 0 });
  }
  const recent = await q(
    `SELECT COALESCE(sent_at, created_at) AS t, status, opened, click_count
       FROM sends
      WHERE COALESCE(sent_at, created_at) >= ?`,
    [new Date(startMs).toISOString()]
  );
  for (const r of recent) {
    const bucket = series.get(String(r.t ?? "").slice(0, 10));
    if (!bucket) continue;
    const status = String(r.status || "");
    if (status.startsWith("sent")) {
      bucket.sent++;
      bucket.n++; // `n` = what the chart plots, kept for older clients
      if (Number(r.opened) === 1) bucket.opens++;
      if (Number(r.click_count) > 0) bucket.clicks++;
    } else if (status === "failed" || status === "bounced") {
      bucket.failed++;
    }
  }
  const daily = [...series.values()];

  // ---- Sources that have stopped producing --------------------------------
  // Surfaced here so the number you act on ("replace these") is visible from
  // the front page, not only inside the Discovery tab.
  const staleRows = await q(
    `SELECT id, type, location, base_url, keywords, category, audience, runs, total_found,
            barren_runs, last_found_at, last_run_at, enabled, auto_off
       FROM discovery_sources
      WHERE archived=0 AND barren_runs >= ?
      ORDER BY barren_runs DESC, last_run_at DESC`,
    [STALE_AFTER_RUNS]
  );
  const sourceCounts = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS total,
            CAST(sum(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS INTEGER) AS active
       FROM discovery_sources WHERE archived=0`
  ))[0] || {};

  return c.json({
    contacts, sends, opens, clicks, totalContacts, totalSends,
    daily,
    windowDays: DAYS,
    sources: {
      total: Number(sourceCounts.total) || 0,
      active: Number(sourceCounts.active) || 0,
      stale: staleRows.length,
      staleAfterRuns: STALE_AFTER_RUNS,
      staleOffAfterRuns: STALE_OFF_AFTER_RUNS,
      staleList: staleRows.slice(0, 8),
    },
  });
});

/* ------------------------------ Helpers ----------------------------- */

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function shorten(u: string) { try { const x = new URL(u); return x.hostname + x.pathname; } catch { return u; } }

// `isEmail` / `buildFrom` live in ./send — the send pipeline owns them, so the
// manual sender, the test email and the automation agree on a valid sender.

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

// idleTimeout raised so long-running requests aren't cut off (max 255s in Bun).
export default { port, idleTimeout: 120, fetch: app.fetch };
