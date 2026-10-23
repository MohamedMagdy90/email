// Targeting feature module, loaded by v2/index.ts after campaigns.
//   /api/v2/targeting/taxonomy                         industries, countries + cities, size bands, presets
//   /api/v2/campaigns/:id/targeting  (GET, PUT)         the target market of one campaign
//   /api/v2/campaigns/:id/targeting/recheck  (POST)     dry run / apply against the leads already found
//   /api/v2/campaigns/:id/targeting/queries  (POST)     the searches a draft segment would run
//   /api/v2/campaigns/:id/segments/:sid/queries/regenerate, /preview  (POST)
//   /api/v2/targeting/exclusions  (GET, POST), /:id (DELETE), /export (GET, csv)
import type { Context, Hono } from "hono";
import { CampaignError } from "../campaigns/types";
import { ensureTargeting } from "./schema";
import {
  addExclusions,
  exclusionsCsv,
  getMarket,
  listExclusions,
  previewQueries,
  previewSegment,
  recheck,
  regenerateQueries,
  removeExclusion,
  saveMarket,
  taxonomyView,
} from "./service";
import { applySteer, applySuggestions, duplicateSegment, segmentDetail, setStatusByHand, steer, targetingResults } from "./results";
import { getRules, saveRules } from "./learning";

function fail(c: Context, e: unknown) {
  if (e instanceof CampaignError) return c.json({ error: e.message }, e.status as 400);
  console.error(`[targeting] ${String((e as any)?.stack || e)}`);
  return c.json({ error: String((e as any)?.message || e) }, 500);
}

const body = async (c: Context) => c.req.json().catch(() => ({}));

export async function register(app: Hono) {
  await ensureTargeting();
  const h = (fn: (c: Context) => Promise<unknown> | unknown) => async (c: Context) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      return fail(c, e);
    }
  };
  const t = "/api/v2/targeting";
  const camp = "/api/v2/campaigns/:id";

  app.get(`${t}/taxonomy`, h(() => taxonomyView()));

  app.get(`${camp}/targeting`, h((c) => getMarket(c.req.param("id"))));
  app.put(`${camp}/targeting`, h(async (c) => saveMarket(c.req.param("id"), await body(c))));
  app.post(`${camp}/targeting/recheck`, h(async (c) => recheck(c.req.param("id"), await body(c))));
  app.post(`${camp}/targeting/queries`, h(async (c) => previewQueries(c.req.param("id"), await body(c))));
  app.post(`${camp}/segments/:sid/queries/regenerate`, h((c) => regenerateQueries(c.req.param("id"), c.req.param("sid"))));
  app.post(`${camp}/segments/:sid/preview`, h((c) => previewSegment(c.req.param("id"), c.req.param("sid"))));

  // Results + learning loop + steer by chat (Phase 9).
  app.get(t, h((c) => targetingResults(c.req.query("campaign") || undefined)));
  app.get(`${t}/rules`, h(() => getRules()));
  app.put(`${t}/rules`, h(async (c) => saveRules(await body(c))));
  app.post(`${t}/suggestions/apply`, h(async (c) => applySuggestions(await body(c))));
  app.get(`${t}/segments/:sid`, h((c) => segmentDetail(c.req.param("sid"))));
  app.post(`${t}/segments/:sid/duplicate`, h(async (c) => duplicateSegment(c.req.param("sid"), await body(c))));
  app.post(`${t}/segments/:sid/status`, h(async (c) => setStatusByHand(c.req.param("sid"), await body(c))));
  app.post(`${t}/steer`, h(async (c) => steer(await body(c))));
  app.post(`${t}/steer/apply`, h(async (c) => applySteer(await body(c))));

  app.get(`${t}/exclusions/export`, async (c) => {
    try {
      return c.body(await exclusionsCsv(), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="do-not-contact.csv"' });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get(`${t}/exclusions`, h((c) => listExclusions({ q: c.req.query("q"), limit: Number(c.req.query("limit")) || undefined, offset: Number(c.req.query("offset")) || undefined })));
  app.post(`${t}/exclusions`, h(async (c) => addExclusions(await body(c))));
  app.delete(`${t}/exclusions/:eid`, h((c) => removeExclusion(c.req.param("eid"))));
}
