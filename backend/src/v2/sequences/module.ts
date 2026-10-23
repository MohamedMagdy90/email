// Sequences feature module (Phase 7), loaded by v2/index.ts after campaigns.
//   GET  /api/v2/sequences?campaign=                       every campaign's sequence + counts
//   GET  /api/v2/sequences/templates                       starter library, angles, variables
//   GET|PUT /api/v2/campaigns/:id/sequence                 one campaign's sequence (+ versions, preview leads)
//   POST /api/v2/campaigns/:id/sequence/preview            {prospectId?, sequence?} -> the emails, not saved
//   POST /api/v2/campaigns/:id/sequence/rewrite-unsent     {all?} -> back to the writer
//   GET  /api/v2/campaigns/:id/sequence/stats              per-step sent / replies / drop-off
import type { Context, Hono } from "hono";
import { CampaignError } from "../campaigns/types";
import { ensureSequenceTables } from "./store";
import { getSequence, listSequences, previewSequence, putSequence, rewriteUnsent, sequenceStats, templates } from "./service";

function fail(c: Context, e: unknown) {
  if (e instanceof CampaignError) return c.json({ error: e.message }, e.status as 400);
  if (e instanceof Error && e.message === "Campaign not found") return c.json({ error: e.message }, 404);
  console.error(`[sequences] ${String((e as any)?.stack || e)}`);
  return c.json({ error: String((e as any)?.message || e) }, 500);
}

const body = async (c: Context) => c.req.json().catch(() => ({}));

export async function register(app: Hono) {
  await ensureSequenceTables();
  const h = (fn: (c: Context) => Promise<unknown> | unknown) => async (c: Context) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      return fail(c, e);
    }
  };
  app.get("/api/v2/sequences/templates", h(() => templates()));
  app.get("/api/v2/sequences", h((c) => listSequences(c.req.query("campaign") || undefined)));
  const b = "/api/v2/campaigns/:id/sequence";
  app.get(b, h((c) => getSequence(c.req.param("id"))));
  app.put(b, h(async (c) => putSequence(c.req.param("id"), await body(c))));
  app.post(`${b}/preview`, h(async (c) => previewSequence(c.req.param("id"), await body(c))));
  app.post(`${b}/rewrite-unsent`, h(async (c) => rewriteUnsent(c.req.param("id"), await body(c))));
  app.get(`${b}/stats`, h((c) => sequenceStats(c.req.param("id"))));
}
