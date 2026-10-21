// Campaigns feature module, loaded by v2/index.ts.
//   register(app)  routes under /api/v2/campaigns (token-gated by the global /api/* middleware)
//   start()        the lead-engine worker (one campaign pass every 60 s)
import type { Context, Hono } from "hono";
import { ensureCampaignColumns } from "./schema";
import { CampaignError } from "./types";
import {
  addCompanies,
  addSegment,
  approveProspects,
  campaignDetail,
  createCampaign,
  deleteSegment,
  learnCampaignOffer,
  listCampaigns,
  listProspects,
  pauseCampaign,
  proposeCampaignSegments,
  prospectDetail,
  removeCampaign,
  restoreProspects,
  rewriteProspect,
  runNow,
  skipProspects,
  startCampaign,
  startCampaignWorker,
  updateCampaign,
  updateProspect,
  updateSegment,
} from "./service";

function fail(c: Context, e: unknown) {
  if (e instanceof CampaignError) return c.json({ error: e.message }, e.status as 400);
  console.error(`[campaigns] ${String((e as any)?.stack || e)}`);
  return c.json({ error: String((e as any)?.message || e) }, 500);
}

const body = async (c: Context) => c.req.json().catch(() => ({}));

export async function register(app: Hono) {
  await ensureCampaignColumns();
  const b = "/api/v2/campaigns";
  const h = (fn: (c: Context) => Promise<unknown>) => async (c: Context) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      return fail(c, e);
    }
  };

  app.get(b, h(() => listCampaigns()));
  app.post(b, h(async (c) => ({ campaign: (await createCampaign(await body(c))) })));
  app.get(`${b}/:id`, h(async (c) => ({ campaign: await campaignDetail(c.req.param("id")) })));
  app.put(`${b}/:id`, h(async (c) => ({ campaign: await updateCampaign(c.req.param("id"), await body(c)) })));
  app.delete(`${b}/:id`, h((c) => removeCampaign(c.req.param("id"))));

  app.post(`${b}/:id/offer/learn`, h(async (c) => learnCampaignOffer(c.req.param("id"), (await body(c)).website)));
  app.post(`${b}/:id/segments/propose`, h(async (c) => proposeCampaignSegments(c.req.param("id"), Number((await body(c)).count) || 4)));
  app.post(`${b}/:id/segments`, h(async (c) => addSegment(c.req.param("id"), await body(c))));
  app.put(`${b}/:id/segments/:sid`, h(async (c) => updateSegment(c.req.param("id"), c.req.param("sid"), await body(c))));
  app.delete(`${b}/:id/segments/:sid`, h((c) => deleteSegment(c.req.param("id"), c.req.param("sid"))));

  app.post(`${b}/:id/start`, h(async (c) => ({ campaign: await startCampaign(c.req.param("id")) })));
  app.post(`${b}/:id/pause`, h(async (c) => ({ campaign: await pauseCampaign(c.req.param("id")) })));
  app.post(`${b}/:id/run`, h((c) => runNow(c.req.param("id"))));

  app.get(
    `${b}/:id/prospects`,
    h((c) =>
      listProspects(c.req.param("id"), {
        stage: c.req.query("stage") || undefined,
        segment: c.req.query("segment") || undefined,
        q: c.req.query("q") || undefined,
        limit: Number(c.req.query("limit")) || undefined,
        offset: Number(c.req.query("offset")) || undefined,
      })
    )
  );
  // Static paths before /:pid so "approve" is never read as a lead id.
  app.post(`${b}/:id/prospects/approve`, h(async (c) => approveProspects(c.req.param("id"), await body(c))));
  app.post(`${b}/:id/prospects/skip`, h(async (c) => skipProspects(c.req.param("id"), await body(c))));
  app.post(`${b}/:id/prospects/restore`, h(async (c) => restoreProspects(c.req.param("id"), await body(c))));
  app.get(`${b}/:id/prospects/:pid`, h(async (c) => ({ prospect: await prospectDetail(c.req.param("id"), c.req.param("pid")) })));
  app.put(`${b}/:id/prospects/:pid`, h(async (c) => ({ prospect: await updateProspect(c.req.param("id"), c.req.param("pid"), await body(c)) })));
  app.post(`${b}/:id/prospects/:pid/rewrite`, h(async (c) => ({ prospect: await rewriteProspect(c.req.param("id"), c.req.param("pid"), (await body(c)).instruction) })));
  app.post(`${b}/:id/companies`, h(async (c) => addCompanies(c.req.param("id"), await body(c))));
}

export function start() {
  startCampaignWorker();
}
