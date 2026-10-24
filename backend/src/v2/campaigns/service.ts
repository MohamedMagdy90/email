// Campaigns service — views, CRUD, review actions, the pipeline pass and the
// background worker. Pipeline steps live in their own files; this file wires
// them together with budgets, retries and plain-English reasons.
import { q, nowIso } from "../../db";
import { logEvent, parseJson, todayUtc, uid, type AgentEvent } from "../events";
import { aiStatus, budgetRemaining, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { getAgentSettings } from "../agent-settings";
import { verifierConfigured, splitName } from "../verify";
import { instantlyConfigured, patchCampaign } from "../instantly";
import { cleanEmail, isValidEmail } from "../../crawler/validate";
import { learnOffer } from "./offer";
import { proposeSegments } from "./icp";
import { addCompany, discoverForSegment } from "./discover";
import { researchCompany, researchIsFresh } from "./research";
import { findContact } from "./contact";
import { scoreProspect, verifyProspect } from "./qualify";
import { writableWithoutAi, writeEmails, WriterRejected } from "./writer";
import { campaignCountry, instantlyPayload, pushApproved, queuedToday, sendableMailboxes, setInstantlyRunning, syncCampaign } from "./sender";
import { ensureSequenceTables, sequenceFor } from "../sequences/store";
import { discoveryOrder, getRules } from "../targeting/learning";
import {
  defaultMarket,
  effectiveTargeting,
  generateQueries,
  marketOf,
  normCountries,
  segmentTargeting,
  sizeLabel,
  type EffectiveTargeting,
  type TargetMarket,
} from "../targeting/market";
import { checkCompany, personAllowed, type SkipRule } from "../targeting/check";
import { INDUSTRY_BY_ID } from "../targeting/taxonomy";
import {
  CampaignError,
  CONTACTED_STAGES,
  DEFAULT_SETTINGS,
  PROSPECT_SELECT,
  STAGE_GROUPS,
  STAGES,
  emptyFunnel,
  prospectRowView,
  researchJson,
  sanitizeOffer,
  sanitizeSegmentInput,
  sanitizeSettings,
  segmentView,
  str,
  type CampaignKind,
  type CampaignSettings,
  type CampaignStatsT,
  type Funnel,
  type Offer,
  type ProspectEmails,
  type Row,
  type SegmentInput,
} from "./types";

const LOCK_STALE_MS = 10 * 60 * 1000;
const BACKOFF_MIN = [15, 60, 360];
const SYNC_EVERY_MS = 30 * 60 * 1000;
const lastSync = new Map<string, number>();

/* ------------------------------- loading ------------------------------ */

async function row(id: string): Promise<Row> {
  const c = (await q(`SELECT * FROM campaigns WHERE id = ?`, [id]))[0];
  if (!c) throw new CampaignError("Campaign not found", 404);
  return c;
}

const settingsOf = (c: Row): CampaignSettings => sanitizeSettings(parseJson(c.settings_json, {}), DEFAULT_SETTINGS);
const offerOf = (c: Row): Offer | null => {
  const o = parseJson<any>(c.offer_json, null);
  return o ? sanitizeOffer(o) : null;
};

function statsOf(c: Row): CampaignStatsT | null {
  const s = parseJson<any>(c.stats_json, null);
  if (!s || !s.updatedAt) return null;
  return { sent: Number(s.sent) || 0, opened: s.opened == null ? null : Number(s.opened), replies: Number(s.replies) || 0, positive: Number(s.positive) || 0, bounced: Number(s.bounced) || 0, updatedAt: s.updatedAt };
}

async function funnels(campaignId?: string): Promise<Map<string, Funnel>> {
  const rows = await q(
    `SELECT campaign_id, stage, CAST(count(*) AS INTEGER) AS n FROM prospects ${campaignId ? "WHERE campaign_id = ?" : ""} GROUP BY campaign_id, stage`,
    campaignId ? [campaignId] : []
  );
  const map = new Map<string, Funnel>();
  for (const r of rows) {
    const f = map.get(r.campaign_id) || emptyFunnel();
    if ((STAGES as string[]).includes(r.stage)) f[r.stage as keyof Funnel] = Number(r.n) as never;
    f.total += Number(r.n) || 0;
    map.set(r.campaign_id, f);
  }
  return map;
}

export async function readiness() {
  const ai = await aiStatus();
  const sendable = await sendableMailboxes();
  let total = 0;
  try {
    total = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM mailboxes WHERE missing_since IS NULL`))[0]?.n) || 0;
  } catch {
    total = 0;
  }
  return {
    ai: ai.configured,
    aiSearch: ai.canSearch,
    instantly: await instantlyConfigured(),
    mailboxes: { total, sending: sendable.length, dailyCapacity: sendable.reduce((n, m) => n + m.dailyLimit, 0) },
    verifier: await verifierConfigured(),
    budgetRemaining: await budgetRemaining(),
  };
}
type Readiness = Awaited<ReturnType<typeof readiness>>;

function summary(c: Row, funnel: Funnel, segments: number) {
  return {
    id: String(c.id),
    name: String(c.name),
    kind: (c.kind === "partner" ? "partner" : "customer") as CampaignKind,
    status: (["draft", "active", "paused", "archived"].includes(c.status) ? c.status : "draft") as "draft" | "active" | "paused" | "archived",
    website: String(c.website || ""),
    segments,
    funnel,
    instantly: { id: c.instantly_campaign_id || null, status: c.instantly_status == null ? null : Number(c.instantly_status) },
    stats: statsOf(c),
    lastError: c.last_error || null,
    createdAt: String(c.created_at),
    updatedAt: String(c.updated_at),
  };
}

export async function listCampaigns() {
  const rows = await q(`SELECT * FROM campaigns WHERE status <> 'archived' ORDER BY created_at DESC`);
  const f = await funnels();
  const segs = await q(`SELECT campaign_id, CAST(count(*) AS INTEGER) AS n FROM segments WHERE enabled = 1 GROUP BY campaign_id`);
  const segMap = new Map(segs.map((s) => [s.campaign_id, Number(s.n) || 0]));
  return { campaigns: rows.map((c) => summary(c, f.get(c.id) || emptyFunnel(), segMap.get(c.id) || 0)), readiness: await readiness() };
}

function blockersFor(c: Row, settings: CampaignSettings, offer: Offer | null, segs: Row[], funnel: Funnel, r: Readiness, allowGuesses: boolean): string[] {
  const out: string[] = [];
  const enabled = segs.filter((s) => Number(s.enabled) === 1);
  if (!offer) out.push("Add the offer first: learn it from the website (Offer tab) or fill it in.");
  if (!enabled.length) out.push("Add at least one ideal-customer segment so the agent knows who to look for.");
  else {
    const empty = enabled.filter((s) => !parseJson<string[]>(s.queries_json, []).length);
    if (empty.length) out.push(`${empty.map((s) => `"${s.name}"`).join(", ")} ${empty.length === 1 ? "has" : "have"} no searches yet: pick an industry in Targeting, or add searches by hand.`);
    else if (enabled.every((s) => Number(s.exhausted) === 1)) out.push("Every segment has run all of its searches. Add cities or industries in Targeting, or suggest more segments, to find new companies.");
  }
  if (c.status === "paused") out.push("Paused: nothing is researched, written or sent until you resume.");
  if (!r.ai) out.push("No AI key: companies get a basic read only, and nothing is scored or written. Connect Gemini, Groq or OpenRouter in the Agent tab.");
  else if (!r.aiSearch) out.push("No Gemini key: companies are found with the free web search (slow and often rate-limited) and decision makers come only from company websites.");
  if (r.ai && r.budgetRemaining <= 0) out.push("Today's AI budget is used up; the agent carries on tomorrow.");
  if (!r.verifier && !allowGuesses) out.push("Guessed addresses wait for the email verifier. Connect No2Bounce in the Agent tab, or allow unverified guesses in the agent's sending rules.");
  if (settings.reviewFirst && funnel.written > 0) out.push(`${funnel.written} email${funnel.written === 1 ? "" : "s"} waiting for your review.`);
  if (funnel.approved > 0 && !r.instantly) out.push("Approved emails are waiting: connect Instantly in the Agent tab to start sending.");
  else if (funnel.approved > 0 && r.mailboxes.sending === 0) out.push("Approved emails are waiting for a sending mailbox: mailboxes are still warming up (Mailboxes tab).");
  else if (funnel.approved > 0 && c.status !== "active") out.push("Approved emails go to Instantly once the campaign is started.");
  return out;
}

export async function campaignDetail(id: string) {
  const c = await row(id);
  const settings = settingsOf(c);
  const offer = offerOf(c);
  const segs = await q(`SELECT * FROM segments WHERE campaign_id = ? ORDER BY created_at`, [id]);
  const funnel = (await funnels(id)).get(id) || emptyFunnel();
  const r = await readiness();
  const agent = await getAgentSettings();
  const day = `${todayUtc()}T00:00:00.000Z`;
  const cnt = async (sql: string, params: any[]) => Number((await q(sql, params))[0]?.n) || 0;
  const today = {
    discovered: await cnt(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND created_at >= ?`, [id, day]),
    researched: await cnt(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects p JOIN companies co ON co.id = p.company_id WHERE p.campaign_id = ? AND co.researched_at >= ?`, [id, day]),
    written: await cnt(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND written_at >= ?`, [id, day]),
    queued: await queuedToday(id),
    queueLimit: Math.min(settings.dailyNewLeads, r.mailboxes.dailyCapacity),
  };
  const working = !!c.working_at && Date.now() - Date.parse(String(c.working_at)) < LOCK_STALE_MS;
  const market = marketOf(c);
  return {
    ...summary(c, funnel, segs.filter((s) => Number(s.enabled) === 1).length),
    offer,
    settings,
    market,
    segmentList: segs.map((s) => segmentView(s, market)),
    readiness: r,
    blockers: blockersFor(c, settings, offer, segs, funnel, r, agent.sending.allowUnverifiedGuesses),
    today,
    working,
    reviewCount: funnel.written,
  };
}

/* -------------------------------- CRUD -------------------------------- */

export async function createCampaign(body: any) {
  const name = str(body?.name, 120) || "New campaign";
  const kind: CampaignKind = body?.kind === "partner" ? "partner" : "customer";
  const website = str(body?.website, 300);
  const id = uid();
  const now = nowIso();
  await ensureSequenceTables(); // (runs the one-time migration before this campaign exists)
  await q(`INSERT INTO campaigns (id, name, kind, status, website, settings_json, targeting_json, created_at, updated_at) VALUES (?,?,?,'draft',?,?,?,?,?)`, [
    id,
    name,
    kind,
    website || null,
    JSON.stringify(DEFAULT_SETTINGS),
    JSON.stringify(defaultMarket(kind)),
    now,
    now,
  ]);
  await logEvent("campaign", `Created the campaign "${name}".`, { campaignId: id });
  await sequenceFor(id); // starts from the starter sequence for its kind
  return campaignDetail(id);
}

const OFFER_FIELDS = ["product", "oneLiner", "valueProps", "proof", "differentiators", "pricing", "regions", "idealCustomers", "competitors"] as const;

export async function updateCampaign(id: string, body: any) {
  const c = await row(id);
  const sets: string[] = [];
  const vals: any[] = [];
  if (body?.name !== undefined) {
    const name = str(body.name, 120);
    if (!name) throw new CampaignError("The campaign needs a name");
    sets.push("name = ?");
    vals.push(name);
  }
  if (body?.kind !== undefined) {
    sets.push("kind = ?");
    vals.push(body.kind === "partner" ? "partner" : "customer");
  }
  if (body?.website !== undefined) {
    sets.push("website = ?");
    vals.push(str(body.website, 300) || null);
  }
  if (body?.offer !== undefined) {
    const prev = offerOf(c);
    const next = sanitizeOffer(body.offer);
    const changed = !prev || OFFER_FIELDS.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
    next.source = changed ? "manual" : prev!.source;
    next.learnedAt = prev?.learnedAt || null;
    next.pages = prev?.pages || [];
    sets.push("offer_json = ?");
    vals.push(JSON.stringify(next));
  }
  let settingsChanged: CampaignSettings | null = null;
  if (body?.settings !== undefined) {
    const cur = settingsOf(c);
    settingsChanged = sanitizeSettings({ ...cur, ...(body.settings || {}) }, cur);
    sets.push("settings_json = ?");
    vals.push(JSON.stringify(settingsChanged));
  }
  if (!sets.length) return campaignDetail(id);
  sets.push("updated_at = ?");
  vals.push(nowIso(), id);
  await q(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`, vals);
  // Keep the Instantly campaign's schedule and sequence in step with the settings.
  if (settingsChanged && c.instantly_campaign_id && (await instantlyConfigured())) {
    try {
      const fresh = await row(id);
      const country = await campaignCountry(id);
      const p = instantlyPayload(fresh, settingsChanged, country, await sendableMailboxes(), (await sequenceFor(id)).steps);
      await patchCampaign(String(c.instantly_campaign_id), { campaign_schedule: p.campaign_schedule, sequences: p.sequences });
    } catch (e: any) {
      await logEvent("send", `Couldn't update the Instantly campaign's schedule: ${String(e?.message || e).slice(0, 200)}`, { level: "warn", campaignId: id });
    }
  }
  return campaignDetail(id);
}

export async function removeCampaign(id: string) {
  const c = await row(id);
  if (c.status === "draft" && !c.instantly_campaign_id) {
    await q(`DELETE FROM prospects WHERE campaign_id = ?`, [id]);
    await q(`DELETE FROM segments WHERE campaign_id = ?`, [id]);
    try {
      await q(`DELETE FROM sequence_versions WHERE sequence_id IN (SELECT id FROM sequences WHERE campaign_id = ?)`, [id]);
      await q(`DELETE FROM sequences WHERE campaign_id = ?`, [id]);
    } catch {
      /* sequences not migrated */
    }
    await q(`DELETE FROM campaigns WHERE id = ?`, [id]);
    return { ok: true as const, deleted: true };
  }
  await setInstantlyRunning(c, false);
  await q(`UPDATE campaigns SET status = 'archived', updated_at = ? WHERE id = ?`, [nowIso(), id]);
  await logEvent("campaign", `Archived the campaign "${c.name}".`, { campaignId: id });
  return { ok: true as const, deleted: false };
}

export async function learnCampaignOffer(id: string, website?: string) {
  const c = await row(id);
  const r = await learnOffer(c.kind === "partner" ? "partner" : "customer", str(website, 300) || c.website || "");
  await q(`UPDATE campaigns SET offer_json = ?, website = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(r.offer), r.website, nowIso(), id]);
  await logEvent("campaign", r.offer.source === "ai" ? `Learned the offer from ${r.website}.` : `Filled in the offer from the knowledge base. ${r.warning || ""}`.trim(), { campaignId: id, level: r.warning ? "warn" : "success" });
  return { campaign: await campaignDetail(id), warning: r.warning };
}

/* ------------------------------ segments ------------------------------ */

const kindOf = (c: Row): CampaignKind => (c.kind === "partner" ? "partner" : "customer");

/** Industry labels for display: the picked industries + any custom ones. */
function industryLabels(ids: string[], custom: string[] = []): string[] {
  const out = ids.map((i) => INDUSTRY_BY_ID.get(i)?.label || i);
  for (const c of custom) if (!out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
  return out;
}

/** Queries for a segment row whose searches are automatic (from the market + its fields). */
export function autoQueries(c: Row, market: TargetMarket, segRow: Row): string[] {
  return generateQueries(effectiveTargeting(market, kindOf(c), segRow));
}

async function insertSegment(c: Row, s: SegmentInput) {
  const market = marketOf(c);
  const id = uid();
  const now = nowIso();
  const industryIds = s.industryIds || [];
  const custom = (s.industries || []).filter((l) => !industryIds.some((i) => INDUSTRY_BY_ID.get(i)?.label.toLowerCase() === l.toLowerCase()));
  // Automatic searches unless the segment came with hand-written ones and no industry.
  const queriesAuto = s.queriesAuto ?? (industryIds.length > 0 || !(s.queries || []).length);
  const sizeBands = s.sizeBands ?? null;
  const row: Row = {
    id,
    campaign_id: c.id,
    name: s.name || "Untitled segment",
    description: s.description || "",
    industries_json: JSON.stringify(industryLabels(industryIds, custom)),
    countries_json: JSON.stringify(normCountries(s.countries || []).filter((x) => market.countries.includes(x))),
    company_size: s.companySize || (sizeBands || s.minBranches ? sizeLabel(sizeBands || market.sizeBands, s.minBranches ?? null) : ""),
    titles_json: JSON.stringify(s.titles || []),
    fit_score: s.fitScore ?? null,
    why: s.why || "",
    enabled: s.enabled === false ? 0 : 1,
    industry_ids_json: JSON.stringify(industryIds),
    cities_json: JSON.stringify(s.cities || {}),
    size_json: sizeBands || s.minBranches ? JSON.stringify({ bands: sizeBands || market.sizeBands, minBranches: s.minBranches ?? null }) : null,
    titles_override: (s.titlesOverride ?? (s.titles || []).length > 0) ? 1 : 0,
    signals_json: JSON.stringify(s.signals || { must: [], mustNot: [] }),
    queries_auto: queriesAuto ? 1 : 0,
  };
  row.queries_json = JSON.stringify(queriesAuto ? autoQueries(c, market, row) : s.queries || []);
  await q(
    `INSERT INTO segments (id, campaign_id, name, description, industries_json, countries_json, company_size, titles_json, queries_json, fit_score, why, status, enabled,
                           industry_ids_json, cities_json, size_json, titles_override, signals_json, queries_auto, searched_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?,?,?,?,?,?, '[]', ?, ?)`,
    [
      id,
      c.id,
      row.name,
      row.description,
      row.industries_json,
      row.countries_json,
      row.company_size,
      row.titles_json,
      row.queries_json,
      row.fit_score,
      row.why,
      row.enabled,
      row.industry_ids_json,
      row.cities_json,
      row.size_json,
      row.titles_override,
      row.signals_json,
      row.queries_auto,
      now,
      now,
    ]
  );
  return segmentView((await q(`SELECT * FROM segments WHERE id = ?`, [id]))[0], market);
}

export async function proposeCampaignSegments(id: string, count: number) {
  const c = await row(id);
  const existing = (await q(`SELECT name FROM segments WHERE campaign_id = ?`, [id])).map((r) => String(r.name));
  const r = await proposeSegments({ kind: kindOf(c), offer: offerOf(c), count, existing, market: marketOf(c) });
  const segments = [];
  for (const s of r.segments) segments.push(await insertSegment(c, s));
  if (segments.length) await logEvent("campaign", `Added ${segments.length} suggested segment(s): ${segments.map((s) => s.name).join("; ")}.`, { campaignId: id });
  return { segments, warning: r.warning };
}

export async function addSegment(id: string, body: any) {
  const c = await row(id);
  const s = sanitizeSegmentInput(body);
  if (!s.name) throw new CampaignError("Give the segment a name");
  return { segment: await insertSegment(c, s) };
}

export async function updateSegment(id: string, sid: string, body: any) {
  const cur = (await q(`SELECT * FROM segments WHERE id = ? AND campaign_id = ?`, [sid, id]))[0];
  if (!cur) throw new CampaignError("Segment not found", 404);
  const c = await row(id);
  const market = marketOf(c);
  const s = sanitizeSegmentInput(body);
  const next: Row = { ...cur };
  if (s.name !== undefined) next.name = s.name || cur.name;
  if (s.description !== undefined) next.description = s.description;
  if (s.fitScore !== undefined) next.fit_score = s.fitScore;
  if (s.why !== undefined) next.why = s.why;
  if (s.enabled !== undefined) next.enabled = s.enabled ? 1 : 0;
  if (s.titles !== undefined) next.titles_json = JSON.stringify(s.titles);
  if (s.titlesOverride !== undefined) next.titles_override = s.titlesOverride ? 1 : 0;
  else if (s.titles !== undefined) next.titles_override = s.titles.length ? 1 : 0;
  if (s.countries !== undefined) next.countries_json = JSON.stringify(normCountries(s.countries).filter((x) => market.countries.includes(x)));
  if (s.cities !== undefined) next.cities_json = JSON.stringify(s.cities);
  if (s.signals !== undefined) next.signals_json = JSON.stringify(s.signals);
  if (s.industryIds !== undefined || s.industries !== undefined) {
    const ids = s.industryIds ?? segmentTargeting(cur).industryIds;
    const labelsIn = s.industries ?? parseJson<string[]>(cur.industries_json, []);
    const custom = labelsIn.filter((l) => !ids.some((i) => INDUSTRY_BY_ID.get(i)?.label.toLowerCase() === l.toLowerCase()) && ![...INDUSTRY_BY_ID.values()].some((x) => x.label.toLowerCase() === l.toLowerCase()));
    next.industry_ids_json = JSON.stringify(ids);
    next.industries_json = JSON.stringify(industryLabels(ids, custom));
  }
  if (s.sizeBands !== undefined || s.minBranches !== undefined) {
    const prev = segmentTargeting(cur);
    const sb = s.sizeBands !== undefined ? s.sizeBands : prev.sizeBands;
    const mb = s.minBranches !== undefined ? s.minBranches : prev.minBranches;
    next.size_json = (sb && sb.length) || mb ? JSON.stringify({ bands: sb && sb.length ? sb : market.sizeBands, minBranches: mb ?? null }) : null;
    next.company_size = (sb && sb.length) || mb ? sizeLabel(sb && sb.length ? sb : market.sizeBands, mb ?? null) : "";
  } else if (s.companySize !== undefined) next.company_size = s.companySize;
  // Searches: hand-written ones switch automatic off; otherwise automatic ones follow the fields.
  if (s.queriesAuto !== undefined) next.queries_auto = s.queriesAuto ? 1 : 0;
  else if (s.queries !== undefined) next.queries_auto = 0;
  if (Number(next.queries_auto) === 1) next.queries_json = JSON.stringify(autoQueries(c, market, next));
  else if (s.queries !== undefined) next.queries_json = JSON.stringify(s.queries);
  if (next.queries_json !== cur.queries_json || next.countries_json !== cur.countries_json) next.exhausted = 0;

  const cols = ["name", "description", "fit_score", "why", "enabled", "titles_json", "titles_override", "countries_json", "cities_json", "signals_json", "industry_ids_json", "industries_json", "size_json", "company_size", "queries_auto", "queries_json", "exhausted"];
  const changed = cols.filter((k) => next[k] !== cur[k]);
  if (changed.length) {
    await q(`UPDATE segments SET ${changed.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...changed.map((k) => next[k]), nowIso(), sid]);
  }
  return { segment: segmentView((await q(`SELECT * FROM segments WHERE id = ?`, [sid]))[0], market) };
}

export async function deleteSegment(id: string, sid: string) {
  const cur = (await q(`SELECT id FROM segments WHERE id = ? AND campaign_id = ?`, [sid, id]))[0];
  if (!cur) throw new CampaignError("Segment not found", 404);
  await q(`UPDATE prospects SET segment_id = NULL WHERE segment_id = ?`, [sid]);
  await q(`DELETE FROM segments WHERE id = ?`, [sid]);
  return { ok: true as const };
}

/* ---------------------------- start / pause --------------------------- */

export async function startCampaign(id: string) {
  const c = await row(id);
  const missing: string[] = [];
  if (!offerOf(c)) missing.push("the offer (learn it from the website or fill it in)");
  const enabled = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM segments WHERE campaign_id = ? AND enabled = 1`, [id]))[0]?.n) || 0;
  if (!enabled) missing.push("at least one enabled segment");
  if (missing.length) throw new CampaignError(`Before starting, add ${missing.join(" and ")}.`);
  await q(`UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?`, [nowIso(), id]);
  await setInstantlyRunning(c, true);
  await logEvent("campaign", `Started "${c.name}". The agent now finds, researches and writes on its own.`, { campaignId: id, level: "success" });
  if (timer) setTimeout(() => tick().catch(() => {}), 1500); // only when the worker runs (not with V2_WORKERS=0)
  return campaignDetail(id);
}

export async function pauseCampaign(id: string) {
  const c = await row(id);
  await q(`UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?`, [nowIso(), id]);
  await setInstantlyRunning(c, false);
  await logEvent("campaign", `Paused "${c.name}".`, { campaignId: id });
  return campaignDetail(id);
}

/* ------------------------------ prospects ----------------------------- */

export async function listProspects(id: string, p: { stage?: string; segment?: string; q?: string; limit?: number; offset?: number }) {
  await row(id);
  const where = ["p.campaign_id = ?"];
  const params: any[] = [id];
  const stage = String(p.stage || "all");
  if (STAGE_GROUPS[stage]) {
    where.push(`p.stage IN (${STAGE_GROUPS[stage].map(() => "?").join(",")})`);
    params.push(...STAGE_GROUPS[stage]);
  } else if ((STAGES as string[]).includes(stage)) {
    where.push("p.stage = ?");
    params.push(stage);
  }
  if (p.segment) {
    where.push("p.segment_id = ?");
    params.push(p.segment);
  }
  const search = String(p.q || "").trim().toLowerCase();
  if (search) {
    where.push("(lower(co.name) LIKE ? OR lower(co.domain) LIKE ? OR lower(p.full_name) LIKE ? OR lower(p.email) LIKE ?)");
    const like = `%${search.replace(/[%_]/g, "")}%`;
    params.push(like, like, like, like);
  }
  const limit = Math.max(1, Math.min(200, Number(p.limit) || 50));
  const offset = Math.max(0, Number(p.offset) || 0);
  const order = stage === "review" || stage === "written" ? "p.written_at ASC, p.created_at ASC" : "p.updated_at DESC, p.id DESC";
  const rows = await q(`${PROSPECT_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params);
  const total = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects p LEFT JOIN companies co ON co.id = p.company_id WHERE ${where.join(" AND ")}`, params))[0]?.n) || 0;
  return { prospects: rows.map(prospectRowView), total, funnel: (await funnels(id)).get(id) || emptyFunnel() };
}

async function prospectRow(id: string, pid: string): Promise<Row> {
  const r = (await q(`${PROSPECT_SELECT} WHERE p.id = ? AND p.campaign_id = ?`, [pid, id]))[0];
  if (!r) throw new CampaignError("Lead not found", 404);
  return r;
}

export async function prospectDetail(id: string, pid: string) {
  const r = await prospectRow(id, pid);
  const rj = researchJson(r.co_research_json);
  const events = (await q(`SELECT * FROM agent_events WHERE ref_type = 'prospect' AND ref_id = ? ORDER BY created_at DESC LIMIT 30`, [pid])) as AgentEvent[];
  return {
    ...prospectRowView(r),
    research: {
      description: r.co_description || null,
      sizeHint: r.co_size_hint || null,
      phone: r.co_phone || null,
      linkedinUrl: r.co_linkedin_url || null,
      hooks: rj.hooks,
      people: rj.people,
      emailsOnSite: rj.emailsOnSite,
      researchedAt: r.co_researched_at || null,
      researchStatus: (["ok", "partial", "blocked", "failed"].includes(r.co_research_status) ? r.co_research_status : null) as "ok" | "partial" | "blocked" | "failed" | null,
      sources: rj.sources,
    },
    verify: parseJson(r.verify_json, null),
    emails: parseJson<ProspectEmails | null>(r.email_json, null),
    events,
  };
}

async function setStage(p: Row, stage: string, reason: string, extra: Record<string, any> = {}) {
  const now = nowIso();
  const cols = Object.keys(extra);
  await q(
    `UPDATE prospects SET stage = ?, stage_reason = ?, stage_changed_at = ?, updated_at = ?${cols.map((k) => `, ${k} = ?`).join("")} WHERE id = ?`,
    [stage, reason.slice(0, 500), now, now, ...cols.map((k) => extra[k]), p.id]
  );
}

async function skipProspect(p: Row, reason: string, rule: SkipRule | null = null, from?: string) {
  await setStage(p, "skipped", reason, { skipped_from: from || p.stage, next_action_at: null, skip_rule: rule });
  await logEvent("campaign", `Skipped ${p.email || p.co_domain || "a lead"}: ${reason}`, { campaignId: p.campaign_id, refType: "prospect", refId: p.id });
}

async function holdProspect(p: Row, reason: string, hours: number) {
  const now = nowIso();
  await q(`UPDATE prospects SET stage_reason = ?, next_action_at = ?, updated_at = ? WHERE id = ?`, [reason.slice(0, 500), new Date(Date.now() + hours * 3600000).toISOString(), now, p.id]);
}

async function failStep(p: Row, err: unknown) {
  const msg = String((err as any)?.message || err).slice(0, 400);
  const attempts = (Number(p.attempts) || 0) + 1;
  const now = nowIso();
  if (attempts >= 3) {
    await q(`UPDATE prospects SET stage = 'failed', skipped_from = ?, attempts = ?, last_error = ?, stage_reason = ?, stage_changed_at = ?, updated_at = ?, next_action_at = NULL WHERE id = ?`, [p.stage, attempts, msg, `Gave up after 3 tries: ${msg}`, now, now, p.id]);
    await logEvent("campaign", `Gave up on ${p.email || p.co_domain || "a lead"} after 3 tries: ${msg}`, { level: "warn", campaignId: p.campaign_id, refType: "prospect", refId: p.id });
  } else {
    const next = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60000).toISOString();
    await q(`UPDATE prospects SET attempts = ?, last_error = ?, next_action_at = ?, updated_at = ? WHERE id = ?`, [attempts, msg, next, now, p.id]);
  }
}

export async function approveProspects(id: string, body: any) {
  await row(id);
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 1000) : [];
  if (!body?.all && !ids.length) return { approved: 0 };
  const now = nowIso();
  const filter = body?.all ? "" : ` AND id IN (${ids.map(() => "?").join(",")})`;
  const rows = await q(`UPDATE prospects SET stage = 'approved', approved_at = ?, stage_reason = 'Approved, waiting to go to Instantly', stage_changed_at = ?, updated_at = ? WHERE campaign_id = ? AND stage = 'written'${filter} RETURNING id`, [now, now, now, id, ...(body?.all ? [] : ids)]);
  if (rows.length) await logEvent("campaign", `Approved ${rows.length} email${rows.length === 1 ? "" : "s"}.`, { campaignId: id, level: "success" });
  return { approved: rows.length };
}

export async function skipProspects(id: string, body: any) {
  await row(id);
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 1000) : [];
  const reason = str(body?.reason, 200);
  let skipped = 0;
  for (const pid of ids) {
    const p = (await q(`SELECT * FROM prospects WHERE id = ? AND campaign_id = ?`, [pid, id]))[0];
    if (!p || p.stage === "skipped" || (CONTACTED_STAGES as string[]).includes(p.stage) || ["unsubscribed", "bounced"].includes(p.stage)) continue;
    await setStage(p, "skipped", reason ? `Skipped by hand: ${reason}` : "Skipped by hand", { skipped_from: p.stage, next_action_at: null, skip_rule: null });
    skipped++;
  }
  return { skipped };
}

export async function restoreProspects(id: string, body: any) {
  await row(id);
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 1000) : [];
  let restored = 0;
  for (const pid of ids) {
    const p = (await q(`SELECT * FROM prospects WHERE id = ? AND campaign_id = ?`, [pid, id]))[0];
    if (!p || !["skipped", "failed"].includes(p.stage)) continue;
    const back = (STAGES as string[]).includes(p.skipped_from) && !["skipped", "failed"].includes(p.skipped_from) ? p.skipped_from : "found";
    await setStage(p, back, "Put back by hand", { skipped_from: null, skip_rule: null, attempts: 0, last_error: null, next_action_at: null });
    restored++;
  }
  return { restored };
}

const EDITABLE_COPY = ["verified", "written", "approved"];

export async function updateProspect(id: string, pid: string, body: any) {
  const p = await prospectRow(id, pid);
  const now = nowIso();
  if (Array.isArray(body?.steps)) {
    if (!EDITABLE_COPY.includes(p.stage)) throw new CampaignError("This email has already gone to Instantly and can't be edited here.");
    const c = await row(id);
    const settings = settingsOf(c);
    const seq = await sequenceFor(id);
    const prev = parseJson<ProspectEmails | null>(p.email_json, null);
    // Steps not sent in the edit keep their previous copy.
    const given = seq.steps.map((_, i) => body.steps[i] ?? prev?.steps?.[i]).filter(Boolean);
    const steps = given.map((s: any, i: number) => ({
      subject: i === 0 || seq.steps[i]?.newThread ? str(s?.subject, 120) : "",
      body: String(s?.body || "").replace(/\r/g, "").trim().slice(0, 4000),
      delayDays: i === 0 ? 0 : seq.steps[i]?.delayDays || 3,
    }));
    if (!steps.length || !steps[0].subject || steps.some((s: any) => !s.body)) throw new CampaignError("Every email needs a body, and the first one needs a subject.");
    if (steps.length < seq.steps.length) throw new CampaignError(`The sequence has ${seq.steps.length} steps; write all ${seq.steps.length} emails.`);
    const emails: ProspectEmails = { steps, language: prev?.language || "en", source: "edited", writtenAt: prev?.writtenAt || now, warnings: [], sequenceVersion: seq.version };
    await q(`UPDATE prospects SET email_json = ?, sequence_id = ?, sequence_version = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(emails), seq.id, seq.version, now, pid]);
    if (p.stage === "verified") await setStage(p, settings.reviewFirst ? "written" : "approved", "Written by hand", settings.reviewFirst ? { written_at: now } : { written_at: now, approved_at: now });
  }
  if (body?.fullName !== undefined || body?.title !== undefined) {
    const full = body.fullName !== undefined ? str(body.fullName, 100) : p.full_name;
    const { first, last } = splitName(full || "");
    await q(`UPDATE prospects SET full_name = ?, first_name = ?, last_name = ?, title = ?, updated_at = ? WHERE id = ?`, [full || null, first || null, last || null, body.title !== undefined ? str(body.title, 120) || null : p.title, now, pid]);
  }
  if (body?.email !== undefined) {
    if ((CONTACTED_STAGES as string[]).includes(p.stage)) throw new CampaignError("This lead has already gone to Instantly; its address can't change here.");
    const e = cleanEmail(String(body.email || ""));
    if (!e || !isValidEmail(e)) throw new CampaignError("That isn't a valid email address.");
    if (e !== String(p.email || "").toLowerCase()) {
      await q(`UPDATE prospects SET email = ?, email_source = 'manual', email_status = NULL, verify_json = NULL, catch_all = 0, updated_at = ? WHERE id = ?`, [e, now, pid]);
      const fresh = (await q(`SELECT * FROM prospects WHERE id = ?`, [pid]))[0];
      await setStage(fresh, "contact_found", "Address changed by hand; checking it again", { next_action_at: null, attempts: 0 });
    }
  }
  return prospectDetail(id, pid);
}

export async function rewriteProspect(id: string, pid: string, instruction?: string) {
  const p = await prospectRow(id, pid);
  if (!EDITABLE_COPY.includes(p.stage)) throw new CampaignError("Only leads that haven't gone to Instantly yet can be rewritten.");
  if (!(await aiStatus()).configured) throw new CampaignError("Rewriting needs an AI key. Connect one in the Agent tab.");
  const c = await row(id);
  const settings = settingsOf(c);
  const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0] || { domain: p.co_domain };
  const seg = p.segment_id ? (await q(`SELECT * FROM segments WHERE id = ?`, [p.segment_id]))[0] : null;
  const seq = await sequenceFor(id);
  try {
    const emails = await writeEmails({
      prospect: p,
      company: co,
      research: researchJson(co.research_json),
      segment: seg,
      offer: offerOf(c),
      settings,
      agent: await getAgentSettings(),
      steps: seq.steps,
      sequenceLanguage: seq.language,
      sequenceVersion: seq.version,
      instruction: str(instruction, 400) || undefined,
      previous: parseJson(p.email_json, null),
    });
    const now = nowIso();
    await q(`UPDATE prospects SET email_json = ?, sequence_id = ?, sequence_version = ?, written_at = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(emails), seq.id, seq.version, now, now, pid]);
    if (p.stage !== "written" && settings.reviewFirst) await setStage(p, "written", "Rewritten, waiting for review", { approved_at: null });
    else if (p.stage === "verified") await setStage(p, "approved", "Written and approved (review is off)", { approved_at: now });
  } catch (e: any) {
    if (e instanceof LlmBudgetExceeded) throw new CampaignError("Today's AI budget is used up. Try again tomorrow or raise the budget in the Agent tab.");
    if (e instanceof LlmUnavailable) throw new CampaignError("No AI provider answered. Check the keys in the Agent tab.");
    if (e instanceof WriterRejected) throw new CampaignError(`The rewrite didn't pass the checks: ${e.message}. Try a different instruction.`);
    throw e;
  }
  return prospectDetail(id, pid);
}

export async function addCompanies(id: string, body: any) {
  const c = await row(id);
  const settings = settingsOf(c);
  const segId = body?.segmentId ? String(body.segmentId) : null;
  if (segId && !(await q(`SELECT id FROM segments WHERE id = ? AND campaign_id = ?`, [segId, id]))[0]) throw new CampaignError("Segment not found", 404);
  const list: string[] = (Array.isArray(body?.domains) ? body.domains : String(body?.domains || "").split(/[\n,\s]+/)).map((d: any) => String(d).trim()).filter(Boolean).slice(0, 200);
  if (!list.length) throw new CampaignError("Paste at least one website or domain.");
  let added = 0;
  const skipped: { domain: string; reason: string }[] = [];
  for (const d of list) {
    const r = await addCompany(id, segId, { website: d }, settings, "manual", "Added by hand");
    if (r.added) added++;
    else skipped.push({ domain: r.domain || d, reason: r.reason || "Skipped" });
  }
  if (added) await logEvent("campaign", `Added ${added} compan${added === 1 ? "y" : "ies"} by hand.`, { campaignId: id });
  return { added, skipped };
}

/* ------------------------- writes from the Leads tab ------------------------- */
// The Leads tab works across campaigns, but every change to a lead goes
// through here so the stage rules live in one place.

/** Stages a lead can be in before anything reached Instantly. */
const PRE_INSTANTLY = ["found", "researched", "contact_found", "verified", "written", "approved", "skipped", "failed"];

async function ownRows(id: string, ids: string[]): Promise<Row[]> {
  const list = ids.map(String).slice(0, 5000);
  if (!list.length) return [];
  const out: Row[] = [];
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    out.push(...(await q(`SELECT * FROM prospects WHERE campaign_id = ? AND id IN (${part.map(() => "?").join(",")})`, [id, ...part])));
  }
  return out;
}

const RESET_COPY = { fit_score: null, fit_reason: null, email_json: null, written_at: null, approved_at: null, skip_rule: null, skipped_from: null, target_penalty: 0, target_notes: null, attempts: 0, last_error: null, next_action_at: null };

/** Research the company again (fresh read), then run the lead through the pipeline from the start. */
export async function reresearchProspects(id: string, ids: string[]) {
  await row(id);
  let done = 0;
  let skipped = 0;
  const companies = new Set<string>();
  for (const p of await ownRows(id, ids)) {
    if (!PRE_INSTANTLY.includes(p.stage) || p.instantly_lead_id) {
      skipped++;
      continue;
    }
    if (p.company_id) companies.add(String(p.company_id));
    await setStage(p, "found", "Research again, asked by hand", RESET_COPY);
    done++;
  }
  for (const co of companies) await q(`UPDATE companies SET researched_at = NULL, updated_at = ? WHERE id = ?`, [nowIso(), co]);
  if (done) await logEvent("campaign", `Sent ${done} lead${done === 1 ? "" : "s"} back to research.`, { campaignId: id });
  return { done, skipped };
}

/** Check the address again (the cached verdict is dropped). Written copy is kept. */
export async function reverifyProspects(id: string, ids: string[]) {
  await row(id);
  let done = 0;
  let skipped = 0;
  for (const p of await ownRows(id, ids)) {
    if (!p.email || !PRE_INSTANTLY.includes(p.stage) || p.instantly_lead_id) {
      skipped++;
      continue;
    }
    await q(`DELETE FROM email_verifications WHERE email = ?`, [String(p.email).toLowerCase()]);
    await setStage(p, "contact_found", "Checking the address again, asked by hand", { verify_json: null, email_status: null, catch_all: 0, skip_rule: null, skipped_from: null, attempts: 0, last_error: null, next_action_at: null });
    done++;
  }
  if (done) await logEvent("verify", `Re-checking ${done} address${done === 1 ? "" : "es"}.`, { campaignId: id });
  return { done, skipped };
}

/** Move leads to another campaign. Only before they reached Instantly; they restart there. */
export async function moveProspects(id: string, ids: string[], toId: string, segmentId?: string | null) {
  const from = await row(id);
  const to = await row(toId);
  if (to.status === "archived") throw new CampaignError("That campaign is archived.");
  if (toId === id) return { done: 0, skipped: ids.length, reasons: ["Already in that campaign"] };
  const seg = segmentId ? (await q(`SELECT id FROM segments WHERE id = ? AND campaign_id = ?`, [segmentId, toId]))[0] : null;
  let done = 0;
  let skipped = 0;
  const reasons = new Set<string>();
  for (const p of await ownRows(id, ids)) {
    if (!PRE_INSTANTLY.includes(p.stage) || p.instantly_lead_id) {
      skipped++;
      reasons.add("Already in Instantly");
      continue;
    }
    if (p.company_id && (await q(`SELECT id FROM prospects WHERE campaign_id = ? AND company_id = ? LIMIT 1`, [toId, p.company_id]))[0]) {
      skipped++;
      reasons.add("The company is already in that campaign");
      continue;
    }
    const now = nowIso();
    await q(
      `UPDATE prospects SET campaign_id = ?, segment_id = ?, stage = 'found', stage_reason = ?, fit_score = NULL, fit_reason = NULL, email_json = NULL, written_at = NULL, approved_at = NULL,
              skip_rule = NULL, skipped_from = NULL, target_penalty = 0, target_notes = NULL, attempts = 0, last_error = NULL, next_action_at = NULL, sequence_id = NULL, sequence_version = NULL,
              stage_changed_at = ?, updated_at = ? WHERE id = ?`,
      [toId, seg ? seg.id : null, `Moved from "${from.name}"`, now, now, p.id]
    );
    await logEvent("campaign", `Moved ${p.email || "a lead"} to "${to.name}".`, { campaignId: id, refType: "prospect", refId: p.id });
    done++;
  }
  if (done) await logEvent("campaign", `${done} lead${done === 1 ? "" : "s"} moved in from "${from.name}".`, { campaignId: toId });
  return { done, skipped, reasons: [...reasons] };
}

/** The human override of the Inbox's read: replied / interested / meeting / won / lost. */
export const OUTCOME_OVERRIDES: Record<string, { interest: string | null; instantly: number | null; label: string }> = {
  replied: { interest: null, instantly: null, label: "Replied" },
  interested: { interest: "interested", instantly: 1, label: "Interested" },
  meeting: { interest: "meeting", instantly: 2, label: "Meeting" },
  won: { interest: "won", instantly: 4, label: "Won" },
  lost: { interest: "not_interested", instantly: -3, label: "Lost" },
};
const OVERRIDABLE_FROM = ["queued", "sent", "replied", "interested", "meeting", "won", "lost"];

export async function setStageByHand(pid: string, stage: string, note?: string) {
  const p = (await q(`SELECT p.*, c.instantly_campaign_id AS c_instantly FROM prospects p LEFT JOIN campaigns c ON c.id = p.campaign_id WHERE p.id = ?`, [pid]))[0];
  if (!p) throw new CampaignError("Lead not found", 404);
  const o = OUTCOME_OVERRIDES[stage];
  if (!o) throw new CampaignError("A lead can be moved to Replied, Interested, Meeting, Won or Lost.");
  if (!OVERRIDABLE_FROM.includes(p.stage)) throw new CampaignError("Only leads that were emailed can be moved on the pipeline.");
  if (p.stage === stage) return { ok: true as const, instantly: "unchanged" as const };
  const reason = `Moved to ${o.label} by hand${note ? `: ${str(note, 300)}` : ""}`;
  await setStage(p, stage, reason, { interest: o.interest ?? p.interest ?? null, replied_at: p.replied_at || nowIso() });
  let instantly: "updated" | "skipped" | "failed" = "skipped";
  if (o.instantly !== null && p.email && p.c_instantly && (await instantlyConfigured())) {
    try {
      const { updateInterest } = await import("../instantly");
      await updateInterest(String(p.email), o.instantly, String(p.c_instantly));
      instantly = "updated";
    } catch (e: any) {
      instantly = "failed";
      await logEvent("campaign", `Couldn't update the lead's status in Instantly: ${String(e?.message || e).slice(0, 160)}`, { level: "warn", campaignId: p.campaign_id, refType: "prospect", refId: pid });
    }
  }
  await logEvent("campaign", `${p.email || "A lead"} moved from ${p.stage} to ${o.label} by hand${note ? ` (${str(note, 120)})` : ""}.`, { campaignId: p.campaign_id, refType: "prospect", refId: pid });
  // Segment reply / positive counters follow the stages.
  if (p.segment_id) {
    await q(
      `UPDATE segments SET
         replies = (SELECT CAST(count(*) AS INTEGER) FROM prospects x WHERE x.segment_id = segments.id AND x.stage IN ('replied','interested','meeting','won','lost','unsubscribed')),
         positive = (SELECT CAST(count(*) AS INTEGER) FROM prospects x WHERE x.segment_id = segments.id AND x.stage IN ('interested','meeting','won'))
       WHERE id = ?`,
      [p.segment_id]
    );
  }
  return { ok: true as const, instantly };
}

export async function setProspectNotes(pid: string, notes: string) {
  const p = (await q(`SELECT id FROM prospects WHERE id = ?`, [pid]))[0];
  if (!p) throw new CampaignError("Lead not found", 404);
  await q(`UPDATE prospects SET notes = ?, updated_at = ? WHERE id = ?`, [String(notes || "").slice(0, 4000) || null, nowIso(), pid]);
  return { ok: true as const };
}

/** Skip every not-yet-contacted lead at these domains / addresses (after they joined the do-not-contact list). */
export async function skipForExclusion(values: { kind: "domain" | "email"; value: string }[], reason: string) {
  let skipped = 0;
  for (const v of values) {
    const rows =
      v.kind === "email"
        ? await q(`SELECT * FROM prospects WHERE lower(email) = ?`, [v.value])
        : await q(`SELECT p.* FROM prospects p JOIN companies co ON co.id = p.company_id WHERE co.domain = ? OR co.domain LIKE ?`, [v.value, `%.${v.value}`]);
    for (const p of rows) {
      if (!["found", "researched", "contact_found", "verified", "written", "approved"].includes(p.stage)) continue;
      await setStage(p, "skipped", reason, { skipped_from: p.stage, next_action_at: null, skip_rule: null });
      skipped++;
    }
  }
  return skipped;
}

/* ---------------------------- pipeline pass ---------------------------- */

export interface RunResult {
  discovered: number;
  researched: number;
  contacted: number;
  verified: number;
  scored: number;
  written: number;
  queued: number;
  notes: string[];
}

const isAiStop = (e: unknown) => e instanceof LlmBudgetExceeded || e instanceof LlmUnavailable;

async function due(campaignId: string, stage: string, limit: number, extra = ""): Promise<Row[]> {
  return q(
    `SELECT p.*, co.domain AS co_domain FROM prospects p LEFT JOIN companies co ON co.id = p.company_id
      WHERE p.campaign_id = ? AND p.stage = ? AND (p.next_action_at IS NULL OR p.next_action_at <= ?) ${extra}
      ORDER BY p.created_at LIMIT ${limit}`,
    [campaignId, stage, nowIso()]
  );
}

/** One pass of the pipeline for one campaign. Never throws for per-lead problems. */
export async function runPass(id: string, opts: { budgetMs?: number; manual?: boolean } = {}): Promise<RunResult> {
  const res: RunResult = { discovered: 0, researched: 0, contacted: 0, verified: 0, scored: 0, written: 0, queued: 0, notes: [] };
  const lockedAt = nowIso();
  const got = await q(`UPDATE campaigns SET working_at = ? WHERE id = ? AND (working_at IS NULL OR working_at < ?) RETURNING id`, [lockedAt, id, new Date(Date.now() - LOCK_STALE_MS).toISOString()]);
  if (!got.length) {
    await row(id);
    res.notes.push("The agent is already working on this campaign; the results show up in a moment.");
    return res;
  }
  const deadline = Date.now() + (opts.budgetMs ?? 55000);
  const timeLeft = () => Date.now() < deadline;
  try {
    const c = await row(id);
    const settings = settingsOf(c);
    const offer = offerOf(c);
    const agent = await getAgentSettings();
    const ai = await aiStatus();
    let aiOk = ai.configured && (await budgetRemaining()) > 0;
    const stopAi = (e: unknown) => {
      if (!aiOk) return;
      aiOk = false;
      res.notes.push(e instanceof LlmBudgetExceeded ? "Today's AI budget is used up; AI steps continue tomorrow." : "No AI provider answered; AI steps were skipped this time.");
    };
    if (!ai.configured) res.notes.push("No AI key: research is basic and nothing is scored or written yet.");
    const segRows = await q(`SELECT * FROM segments WHERE campaign_id = ? AND enabled = 1 ORDER BY updated_at`, [id]);
    const segById = new Map(segRows.map((s) => [String(s.id), s]));
    const allSegs = await q(`SELECT * FROM segments WHERE campaign_id = ?`, [id]);
    for (const s of allSegs) segById.set(String(s.id), s);

    // Targeting: the market narrowed by each segment (cached per pass).
    const market = marketOf(c);
    const kind = kindOf(c);
    const effCache = new Map<string, EffectiveTargeting>();
    const effFor = (segmentId: unknown): EffectiveTargeting => {
      const key = segmentId ? String(segmentId) : "";
      let e = effCache.get(key);
      if (!e) {
        e = effectiveTargeting(market, kind, key ? segById.get(key) || null : null);
        effCache.set(key, e);
      }
      return e;
    };
    const roleOk = (eff: EffectiveTargeting) => (eff.roleAddresses === "inherit" ? agent.sending.allowRoleAddresses : eff.roleAddresses === "allow");

    // 1. Discover while the pre-write backlog is small.
    const backlog = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage IN ('found','researched','contact_found','verified') AND (next_action_at IS NULL OR next_action_at <= ?)`, [id, nowIso()]))[0]?.n) || 0;
    if (backlog < settings.dailyNewLeads * 3) {
      let searches = 0;
      // Quota split (learning loop): the segment furthest below its share of today's finds goes first.
      const foundToday = new Map<string, number>(
        (await q(`SELECT segment_id, CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND created_at >= ? AND segment_id IS NOT NULL GROUP BY segment_id`, [id, `${todayUtc()}T00:00:00.000Z`])).map((r) => [String(r.segment_id), Number(r.n) || 0])
      );
      const ordered = discoveryOrder(segRows.filter((s) => Number(s.exhausted) !== 1), foundToday, await getRules());
      for (const seg of ordered) {
        if (res.discovered >= 10 || searches >= 2 || !timeLeft()) break;
        const r = await discoverForSegment(id, seg, settings, { max: 10 - res.discovered, maxSearches: 2 - searches, canSearch: ai.canSearch, aiOk, eff: effFor(seg.id) });
        res.discovered += r.added;
        searches += r.searches;
        res.notes.push(...r.notes);
        if (r.aiStopped) aiOk = false;
      }
      if (!segRows.length) res.notes.push("No enabled segment, so no new companies are searched.");
    }

    // 2. Research.
    const researchedToday = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects p JOIN companies co ON co.id = p.company_id WHERE p.campaign_id = ? AND co.researched_at >= ?`, [id, `${todayUtc()}T00:00:00.000Z`]))[0]?.n) || 0;
    const researchBudget = Math.max(0, Math.min(4, settings.researchPerDay - researchedToday));
    if (!researchBudget) res.notes.push(`Today's research limit (${settings.researchPerDay}) is reached.`);
    let offTarget = 0;
    for (const p of await due(id, "found", researchBudget)) {
      if (!timeLeft()) break;
      try {
        const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0];
        if (!co) {
          await skipProspect(p, "The company record is missing");
          continue;
        }
        let note: string;
        if (researchIsFresh(co, aiOk)) {
          note = `Research reused from ${String(co.researched_at).slice(0, 10)}.`;
        } else {
          let out;
          try {
            out = await researchCompany(co, { ai: aiOk });
          } catch (e) {
            if (!isAiStop(e)) throw e;
            stopAi(e);
            out = await researchCompany(co, { ai: false });
          }
          note = out.note;
          await logEvent("research", out.note, { campaignId: id, refType: "prospect", refId: p.id });
        }
        res.researched++;
        // Target check on the facts, before any person search, score or email.
        const fresh = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0] || co;
        const t = checkCompany(fresh, effFor(p.segment_id));
        if (!t.ok) {
          await skipProspect(p, t.reason, t.rule, "researched");
          offTarget++;
          continue;
        }
        await setStage(p, "researched", t.notes.length ? `${note} ${t.notes.join("; ")}.` : note, {
          attempts: 0,
          last_error: null,
          target_penalty: t.penalty,
          target_notes: t.notes.join("; ") || null,
        });
      } catch (e) {
        await failStep(p, e);
      }
    }
    if (offTarget) res.notes.push(`${offTarget} researched compan${offTarget === 1 ? "y was" : "ies were"} outside the target and skipped (see Leads, Skipped).`);

    // 3. Decision maker + candidate address.
    for (const p of await due(id, "researched", 4)) {
      if (!timeLeft()) break;
      try {
        // Imported people keep the person and address from the file; only the title rules apply.
        if (p.email && p.email_source === "import") {
          const allowed = personAllowed(p.title, effFor(p.segment_id));
          if (!allowed.ok) await skipProspect(p, `Imported person passed over: ${allowed.reason}`);
          else {
            await setStage(p, "contact_found", "Imported from a file; checking the address", { attempts: 0, last_error: null, next_action_at: null });
            res.contacted++;
          }
          continue;
        }
        const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0];
        const eff = effFor(p.segment_id);
        const titles = eff.titles;
        const allowPerson = (title: string) => personAllowed(title, eff);
        let r;
        try {
          r = await findContact(co, researchJson(co.research_json), titles, { canSearch: ai.canSearch, aiOk, allowRole: roleOk(eff), allowPerson });
        } catch (e) {
          if (!isAiStop(e)) throw e;
          stopAi(e);
          r = await findContact(co, researchJson(co.research_json), titles, { canSearch: false, aiOk: false, allowRole: roleOk(eff), allowPerson });
        }
        if (r.ok && r.email) {
          await setStage(p, "contact_found", r.reason, {
            first_name: r.person?.first || null,
            last_name: r.person?.last || null,
            full_name: r.person?.fullName || null,
            title: r.person?.title || null,
            linkedin_url: r.person?.linkedin || null,
            email: r.email.toLowerCase(),
            email_source: r.emailSource || "pattern",
            email_status: r.emailStatus || null,
            attempts: 0,
            last_error: null,
            next_action_at: null,
          });
          await logEvent("contact", r.reason, { campaignId: id, refType: "prospect", refId: p.id });
          res.contacted++;
        } else if (r.hold) {
          await holdProspect(p, r.reason, 24);
        } else {
          await skipProspect(p, r.reason);
        }
      } catch (e) {
        await failStep(p, e);
      }
    }

    // 4. Verify + suppression.
    for (const p of await due(id, "contact_found", 8)) {
      if (!timeLeft()) break;
      try {
        const v = await verifyProspect(p, { ...agent.sending, allowRoleAddresses: roleOk(effFor(p.segment_id)) });
        if (v.verdict === "ok") {
          await setStage(p, "verified", v.reason, { verify_json: JSON.stringify(v.result), email_status: v.result.status, catch_all: v.catchAll ? 1 : 0, attempts: 0, last_error: null, next_action_at: null });
          res.verified++;
        } else if (v.verdict === "hold") {
          await q(`UPDATE prospects SET verify_json = ?, email_status = ? WHERE id = ?`, [JSON.stringify(v.result), v.result.status, p.id]);
          await holdProspect(p, v.reason, 12);
        } else {
          await q(`UPDATE prospects SET verify_json = ?, email_status = ? WHERE id = ?`, [JSON.stringify(v.result), v.result.status, p.id]);
          await skipProspect(p, v.reason);
        }
      } catch (e) {
        await failStep(p, e);
      }
    }

    // 5. Score (AI).
    if (aiOk) {
      for (const p of await due(id, "verified", 6, "AND p.fit_score IS NULL")) {
        if (!timeLeft() || !aiOk) break;
        try {
          const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0];
          const seg = p.segment_id ? segById.get(String(p.segment_id)) || null : null;
          const eff = effFor(p.segment_id);
          const threshold = eff.minFitScore ?? settings.minFitScore ?? agent.sending.minFitScore;
          const raw = await scoreProspect(p, co, researchJson(co.research_json), seg, offer, eff);
          // "Prefer" targeting rules (size, keywords) lower the score instead of skipping.
          const penalty = Number(p.target_penalty) || 0;
          const s = penalty ? { score: Math.max(0, raw.score - penalty), reason: `${raw.reason} (${raw.score} − ${penalty}: ${p.target_notes || "outside the preferred target"})` } : raw;
          await q(`UPDATE prospects SET fit_score = ?, fit_reason = ?, updated_at = ? WHERE id = ?`, [s.score, s.reason, nowIso(), p.id]);
          res.scored++;
          if (s.score < threshold) await skipProspect({ ...p, stage: "verified" }, `Fit ${s.score} is below ${threshold}: ${s.reason}`);
        } catch (e) {
          if (isAiStop(e)) stopAi(e);
          else await failStep(p, e);
        }
      }
    }

    // 6. Write (AI, following the campaign's sequence). Leads that already have copy (edited by hand) skip the writer.
    const seq = await sequenceFor(id);
    const ready = await due(id, "verified", 3, "AND p.fit_score IS NOT NULL");
    for (const p of ready) {
      if (!timeLeft()) break;
      const now = nowIso();
      if (p.email_json) {
        await setStage(p, settings.reviewFirst ? "written" : "approved", settings.reviewFirst ? "Waiting for review" : "Approved (review is off)", settings.reviewFirst ? { written_at: now } : { written_at: now, approved_at: now });
        res.written++;
        continue;
      }
      if (!aiOk && !writableWithoutAi(seq.steps)) break;
      try {
        const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0];
        const seg = p.segment_id ? segById.get(String(p.segment_id)) || null : null;
        const emails = await writeEmails({ prospect: p, company: co, research: researchJson(co.research_json), segment: seg, offer, settings, agent, steps: seq.steps, sequenceLanguage: seq.language, sequenceVersion: seq.version });
        const base = { email_json: JSON.stringify(emails), sequence_id: seq.id, sequence_version: seq.version, written_at: now, attempts: 0, last_error: null };
        const extra = settings.reviewFirst ? base : { ...base, approved_at: now };
        await setStage(p, settings.reviewFirst ? "written" : "approved", settings.reviewFirst ? "Written, waiting for your review" : "Written and approved (review is off)", extra);
        await logEvent("write", `Wrote ${emails.steps.length} email(s) for ${p.full_name || p.email} at ${co.name || co.domain}${emails.warnings.length ? ` (${emails.warnings.join(" ")})` : ""}.`, { campaignId: id, refType: "prospect", refId: p.id });
        res.written++;
      } catch (e) {
        if (isAiStop(e)) {
          stopAi(e);
          break;
        }
        await failStep(p, e);
      }
    }
    if (!aiOk) {
      const waiting = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'verified'`, [id]))[0]?.n) || 0;
      if (waiting) res.notes.push(`${waiting} verified lead(s) are waiting for the AI to score and write their emails.`);
    }

    // 7. Push + sync (active campaigns only; drafts never send).
    if (c.status === "active") {
      const fresh = await row(id);
      const pushed = await pushApproved(fresh, settings);
      res.queued = pushed.queued;
      res.notes.push(...pushed.notes);
      if (fresh.instantly_campaign_id && Date.now() - (lastSync.get(id) || 0) > SYNC_EVERY_MS) {
        lastSync.set(id, Date.now());
        await syncCampaign(await row(id)).catch((e) => res.notes.push(`Couldn't sync with Instantly: ${String(e?.message || e).slice(0, 160)}`));
      }
    } else if (opts.manual && c.status === "draft") {
      res.notes.push("This campaign is a draft: nothing is sent until you start it.");
    }
    const did = res.discovered + res.researched + res.contacted + res.verified + res.written + res.queued;
    if (did && !opts.manual) await logEvent("campaign", `Pass done: ${res.discovered} found, ${res.researched} researched, ${res.contacted} contacts, ${res.verified} verified, ${res.written} written, ${res.queued} queued.`, { campaignId: id });
    return res;
  } finally {
    await q(`UPDATE campaigns SET working_at = NULL, last_run_at = ? WHERE id = ?`, [nowIso(), id]).catch(() => {});
  }
}

export async function runNow(id: string) {
  const ran = await runPass(id, { manual: true, budgetMs: 55000 });
  return { campaign: await campaignDetail(id), ran };
}

/* -------------------------------- worker ------------------------------ */

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const next = (await q(`SELECT id FROM campaigns WHERE status = 'active' ORDER BY COALESCE(last_run_at, '') LIMIT 1`))[0];
    if (next) await runPass(String(next.id), { budgetMs: 50000 });
  } catch (e: any) {
    console.error(`[campaigns] worker: ${String(e?.stack || e)}`);
  } finally {
    ticking = false;
  }
}

export function startCampaignWorker() {
  if (timer) return;
  timer = setInterval(() => tick().catch(() => {}), 60_000);
  setTimeout(() => tick().catch(() => {}), 20_000);
  console.log("[campaigns] worker started (every 60s)");
}
