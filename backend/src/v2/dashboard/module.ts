// Dashboard feature module (Phase 8).
//   GET  /api/v2/dashboard?range=7|30|90&campaign=   everything the home screen shows (cached 60 s)
//   POST /api/v2/dashboard/pause-all | resume-all     one click pauses every running campaign (and its Instantly campaign)
//   PUT  /api/v2/dashboard/cost                       {monthlyCost} for "cost per hot lead"
import type { Context, Hono } from "hono";
import { CampaignError } from "../campaigns/types";
import { ensureDailyTable } from "./daily";
import { dashboard, pauseAll, resumeAll, setMonthlyCost } from "./service";

function fail(c: Context, e: unknown) {
  if (e instanceof CampaignError) return c.json({ error: e.message }, e.status as 400);
  console.error(`[dashboard] ${String((e as any)?.stack || e)}`);
  return c.json({ error: String((e as any)?.message || e) }, 500);
}

export async function register(app: Hono) {
  await ensureDailyTable();
  const h = (fn: (c: Context) => Promise<unknown>) => async (c: Context) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      return fail(c, e);
    }
  };
  app.get("/api/v2/dashboard", h((c) => dashboard({ range: c.req.query("range"), campaign: c.req.query("campaign") })));
  app.post("/api/v2/dashboard/pause-all", h(() => pauseAll()));
  app.post("/api/v2/dashboard/resume-all", h(() => resumeAll()));
  app.put("/api/v2/dashboard/cost", h(async (c) => setMonthlyCost((await c.req.json().catch(() => ({}))).monthlyCost)));
}
