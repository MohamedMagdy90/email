// Leads feature module (Phase 6), loaded by v2/index.ts after campaigns.
//   GET  /api/v2/leads                     people | companies, filters, sort, facets
//   GET  /api/v2/leads/counts              badge numbers (to review, ready, hot)
//   GET|PUT /api/v2/leads/views            saved views + the built-in ones
//   GET  /api/v2/leads/export              CSV of the current filter (or ?ids=)
//   POST /api/v2/leads/bulk                {action, ids | filter}
//   POST /api/v2/leads/import/preview      {csv} -> headers, sample, guessed mapping
//   POST /api/v2/leads/import              {csv, mapping, campaignId, segmentId, enterAt}
//   GET  /api/v2/leads/import/:id          progress / result;  /:id/results  CSV
//   GET  /api/v2/leads/companies/:id       one company, research once + every person
//   GET  /api/v2/leads/:pid                lead detail + thread
//   PUT  /api/v2/leads/:pid/stage          pipeline override {stage, note}
//   PUT  /api/v2/leads/:pid/notes          {notes}
import type { Context, Hono } from "hono";
import { CampaignError } from "../campaigns/types";
import {
  bulk,
  companyDetail,
  ensureLeadTables,
  exportCsv,
  getImport,
  getViews,
  importResultsCsv,
  leadCounts,
  leadDetail,
  listLeads,
  previewImport,
  saveViews,
  setLeadNotes,
  setLeadStage,
  startImport,
} from "./service";

function fail(c: Context, e: unknown) {
  if (e instanceof CampaignError) return c.json({ error: e.message }, e.status as 400);
  console.error(`[leads] ${String((e as any)?.stack || e)}`);
  return c.json({ error: String((e as any)?.message || e) }, 500);
}

const body = async (c: Context) => c.req.json().catch(() => ({}));

export async function register(app: Hono) {
  await ensureLeadTables();
  const h = (fn: (c: Context) => Promise<unknown> | unknown) => async (c: Context) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      return fail(c, e);
    }
  };
  const csv = (fn: (c: Context) => Promise<string>, name: (c: Context) => string) => async (c: Context) => {
    try {
      return c.body(await fn(c), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name(c)}"` });
    } catch (e) {
      return fail(c, e);
    }
  };
  const b = "/api/v2/leads";
  app.get(b, h((c) => listLeads(c.req.query())));
  app.get(`${b}/counts`, h(() => leadCounts()));
  app.get(`${b}/views`, h(() => getViews()));
  app.put(`${b}/views`, h(async (c) => saveViews(await body(c))));
  app.get(`${b}/export`, csv((c) => exportCsv(c.req.query()), () => `leads-${new Date().toISOString().slice(0, 10)}.csv`));
  app.post(`${b}/bulk`, h(async (c) => bulk(await body(c))));
  app.post(`${b}/import/preview`, h(async (c) => previewImport(await body(c))));
  app.post(`${b}/import`, h(async (c) => startImport(await body(c))));
  app.get(`${b}/import/:iid`, h((c) => getImport(c.req.param("iid"))));
  app.get(`${b}/import/:iid/results`, csv((c) => importResultsCsv(c.req.param("iid")), (c) => `import-${c.req.param("iid").slice(0, 8)}.csv`));
  app.get(`${b}/companies/:coid`, h((c) => companyDetail(c.req.param("coid"))));
  app.get(`${b}/:pid`, h(async (c) => ({ lead: await leadDetail(c.req.param("pid")) })));
  app.put(`${b}/:pid/stage`, h(async (c) => setLeadStage(c.req.param("pid"), await body(c))));
  app.put(`${b}/:pid/notes`, h(async (c) => setLeadNotes(c.req.param("pid"), await body(c))));
}
