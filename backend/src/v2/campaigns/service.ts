// Campaigns service — views, CRUD, review actions, the pipeline pass and the
// background worker. Pipeline steps live in their own files; this file wires
// them together with budgets, retries and plain-English reasons.
import { q, nowIso } from "../../db";
import { logEvent, parseJson, todayUtc, uid, type AgentEvent } from "../events";
import { aiStatus, budgetRemaining, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { getAgentSettings } from "../agent-settings";
import { getReacherConfig, splitName } from "../verify";
import { instantlyConfigured, patchCampaign } from "../instantly";
import { cleanEmail, isValidEmail } from "../../crawler/validate";
import { learnOffer } from "./offer";
import { proposeSegments } from "./icp";
import { addCompany, discoverForSegment } from "./discover";
import { researchCompany, researchIsFresh } from "./research";
import { findContact } from "./contact";
import { scoreProspect, verifyProspect } from "./qualify";
import { writeEmails, WriterRejected } from "./writer";
import { instantlyPayload, pushApproved, queuedToday, sendableMailboxes, setInstantlyRunning, syncCampaign } from "./sender";
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
    reacher: !!(await getReacherConfig()),
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
  else if (enabled.every((s) => Number(s.exhausted) === 1)) out.push("Every segment has run all of its searches. Add search queries or suggest more segments to find new companies.");
  if (c.status === "paused") out.push("Paused: nothing is researched, written or sent until you resume.");
  if (!r.ai) out.push("No AI key: companies get a basic read only, and nothing is scored or written. Connect Gemini, Groq or OpenRouter in the Agent tab.");
  else if (!r.aiSearch) out.push("No Gemini key: companies are found with the free web search (slow and often rate-limited) and decision makers come only from company websites.");
  if (r.ai && r.budgetRemaining <= 0) out.push("Today's AI budget is used up; the agent carries on tomorrow.");
  if (!r.reacher && !allowGuesses) out.push("Guessed addresses wait for the email verifier. Connect Reacher in the Agent tab, or allow unverified guesses in the agent's sending rules.");
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
  return {
    ...summary(c, funnel, segs.filter((s) => Number(s.enabled) === 1).length),
    offer,
    settings,
    segmentList: segs.map(segmentView),
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
  await q(`INSERT INTO campaigns (id, name, kind, status, website, settings_json, created_at, updated_at) VALUES (?,?,?,'draft',?,?,?,?)`, [id, name, kind, website || null, JSON.stringify(DEFAULT_SETTINGS), now, now]);
  await logEvent("campaign", `Created the campaign "${name}".`, { campaignId: id });
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
      const country = parseJson<string[]>((await q(`SELECT countries_json FROM segments WHERE campaign_id = ? AND enabled = 1 ORDER BY created_at LIMIT 1`, [id]))[0]?.countries_json, [])[0] || null;
      const p = instantlyPayload(fresh, settingsChanged, country, await sendableMailboxes());
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

async function insertSegment(campaignId: string, s: SegmentInput) {
  const id = uid();
  const now = nowIso();
  await q(
    `INSERT INTO segments (id, campaign_id, name, description, industries_json, countries_json, company_size, titles_json, queries_json, fit_score, why, status, enabled, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?)`,
    [id, campaignId, s.name || "Untitled segment", s.description || "", JSON.stringify(s.industries || []), JSON.stringify(s.countries || []), s.companySize || "", JSON.stringify(s.titles || []), JSON.stringify(s.queries || []), s.fitScore ?? null, s.why || "", s.enabled === false ? 0 : 1, now, now]
  );
  return segmentView((await q(`SELECT * FROM segments WHERE id = ?`, [id]))[0]);
}

export async function proposeCampaignSegments(id: string, count: number) {
  const c = await row(id);
  const existing = (await q(`SELECT name FROM segments WHERE campaign_id = ?`, [id])).map((r) => String(r.name));
  const r = await proposeSegments({ kind: c.kind === "partner" ? "partner" : "customer", offer: offerOf(c), count, existing });
  const segments = [];
  for (const s of r.segments) segments.push(await insertSegment(id, s));
  if (segments.length) await logEvent("campaign", `Added ${segments.length} suggested segment(s): ${segments.map((s) => s.name).join("; ")}.`, { campaignId: id });
  return { segments, warning: r.warning };
}

export async function addSegment(id: string, body: any) {
  await row(id);
  const s = sanitizeSegmentInput(body);
  if (!s.name) throw new CampaignError("Give the segment a name");
  return { segment: await insertSegment(id, s) };
}

export async function updateSegment(id: string, sid: string, body: any) {
  const cur = (await q(`SELECT * FROM segments WHERE id = ? AND campaign_id = ?`, [sid, id]))[0];
  if (!cur) throw new CampaignError("Segment not found", 404);
  const s = sanitizeSegmentInput(body);
  const map: [keyof SegmentInput, string, (v: any) => any][] = [
    ["name", "name", (v) => v || cur.name],
    ["description", "description", (v) => v],
    ["industries", "industries_json", (v) => JSON.stringify(v)],
    ["countries", "countries_json", (v) => JSON.stringify(v)],
    ["companySize", "company_size", (v) => v],
    ["titles", "titles_json", (v) => JSON.stringify(v)],
    ["queries", "queries_json", (v) => JSON.stringify(v)],
    ["fitScore", "fit_score", (v) => v],
    ["why", "why", (v) => v],
    ["enabled", "enabled", (v) => (v ? 1 : 0)],
  ];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, col, fn] of map) {
    if (s[k] === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(fn(s[k]));
  }
  // New searches or countries restart the walk.
  if ((s.queries && JSON.stringify(s.queries) !== cur.queries_json) || (s.countries && JSON.stringify(s.countries) !== cur.countries_json)) sets.push("cursor = 0", "exhausted = 0");
  if (sets.length) {
    sets.push("updated_at = ?");
    vals.push(nowIso(), sid);
    await q(`UPDATE segments SET ${sets.join(", ")} WHERE id = ?`, vals);
  }
  return { segment: segmentView((await q(`SELECT * FROM segments WHERE id = ?`, [sid]))[0]) };
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

async function skipProspect(p: Row, reason: string) {
  await setStage(p, "skipped", reason, { skipped_from: p.stage, next_action_at: null });
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
    await setStage(p, "skipped", reason ? `Skipped by hand: ${reason}` : "Skipped by hand", { skipped_from: p.stage, next_action_at: null });
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
    await setStage(p, back, "Put back by hand", { skipped_from: null, attempts: 0, last_error: null, next_action_at: null });
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
    const prev = parseJson<ProspectEmails | null>(p.email_json, null);
    const steps = body.steps.slice(0, 3).map((s: any, i: number) => ({ subject: i === 0 ? str(s?.subject, 120) : "", body: String(s?.body || "").replace(/\r/g, "").trim().slice(0, 4000), delayDays: i === 0 ? 0 : settings.followUpDelays[i - 1] || 3 }));
    if (!steps.length || !steps[0].subject || steps.some((s: any) => !s.body)) throw new CampaignError("Every email needs a body, and the first one needs a subject.");
    const emails: ProspectEmails = { steps, language: prev?.language || "en", source: "edited", writtenAt: prev?.writtenAt || now, warnings: [] };
    await q(`UPDATE prospects SET email_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(emails), now, pid]);
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
  try {
    const emails = await writeEmails({ prospect: p, company: co, research: researchJson(co.research_json), segment: seg, offer: offerOf(c), settings, agent: await getAgentSettings(), instruction: str(instruction, 400) || undefined, previous: parseJson(p.email_json, null) });
    const now = nowIso();
    await q(`UPDATE prospects SET email_json = ?, written_at = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(emails), now, now, pid]);
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

    // 1. Discover while the pre-write backlog is small.
    const backlog = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage IN ('found','researched','contact_found','verified') AND (next_action_at IS NULL OR next_action_at <= ?)`, [id, nowIso()]))[0]?.n) || 0;
    if (backlog < settings.dailyNewLeads * 3) {
      let searches = 0;
      for (const seg of segRows.filter((s) => Number(s.exhausted) !== 1)) {
        if (res.discovered >= 10 || searches >= 2 || !timeLeft()) break;
        const r = await discoverForSegment(id, seg, settings, { max: 10 - res.discovered, maxSearches: 2 - searches, canSearch: ai.canSearch, aiOk });
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
    for (const p of await due(id, "found", researchBudget)) {
      if (!timeLeft()) break;
      try {
        const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0];
        if (!co) {
          await skipProspect(p, "The company record is missing");
          continue;
        }
        if (researchIsFresh(co, aiOk)) {
          await setStage(p, "researched", `Research reused from ${String(co.researched_at).slice(0, 10)}`, { attempts: 0, last_error: null });
          res.researched++;
          continue;
        }
        let out;
        try {
          out = await researchCompany(co, { ai: aiOk });
        } catch (e) {
          if (!isAiStop(e)) throw e;
          stopAi(e);
          out = await researchCompany(co, { ai: false });
        }
        await setStage(p, "researched", out.note, { attempts: 0, last_error: null });
        await logEvent("research", out.note, { campaignId: id, refType: "prospect", refId: p.id });
        res.researched++;
      } catch (e) {
        await failStep(p, e);
      }
    }

    // 3. Decision maker + candidate address.
    for (const p of await due(id, "researched", 4)) {
      if (!timeLeft()) break;
      try {
        const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0];
        const seg = p.segment_id ? segById.get(String(p.segment_id)) : null;
        const titles = parseJson<string[]>(seg?.titles_json, []);
        let r;
        try {
          r = await findContact(co, researchJson(co.research_json), titles, { canSearch: ai.canSearch, aiOk, allowRole: agent.sending.allowRoleAddresses });
        } catch (e) {
          if (!isAiStop(e)) throw e;
          stopAi(e);
          r = await findContact(co, researchJson(co.research_json), titles, { canSearch: false, aiOk: false, allowRole: agent.sending.allowRoleAddresses });
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
        const v = await verifyProspect(p, agent.sending);
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
      const threshold = settings.minFitScore ?? agent.sending.minFitScore;
      for (const p of await due(id, "verified", 6, "AND p.fit_score IS NULL")) {
        if (!timeLeft() || !aiOk) break;
        try {
          const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0];
          const seg = p.segment_id ? segById.get(String(p.segment_id)) || null : null;
          const s = await scoreProspect(p, co, researchJson(co.research_json), seg, offer);
          await q(`UPDATE prospects SET fit_score = ?, fit_reason = ?, updated_at = ? WHERE id = ?`, [s.score, s.reason, nowIso(), p.id]);
          res.scored++;
          if (s.score < threshold) await skipProspect({ ...p, stage: "verified" }, `Fit ${s.score} is below ${threshold}: ${s.reason}`);
        } catch (e) {
          if (isAiStop(e)) stopAi(e);
          else await failStep(p, e);
        }
      }
    }

    // 6. Write (AI). Leads that already have copy (edited by hand) skip the writer.
    const ready = await due(id, "verified", 3, "AND p.fit_score IS NOT NULL");
    for (const p of ready) {
      if (!timeLeft()) break;
      const now = nowIso();
      if (p.email_json) {
        await setStage(p, settings.reviewFirst ? "written" : "approved", settings.reviewFirst ? "Waiting for review" : "Approved (review is off)", settings.reviewFirst ? { written_at: now } : { written_at: now, approved_at: now });
        res.written++;
        continue;
      }
      if (!aiOk) break;
      try {
        const co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0];
        const seg = p.segment_id ? segById.get(String(p.segment_id)) || null : null;
        const emails = await writeEmails({ prospect: p, company: co, research: researchJson(co.research_json), segment: seg, offer, settings, agent });
        const extra = settings.reviewFirst ? { email_json: JSON.stringify(emails), written_at: now, attempts: 0, last_error: null } : { email_json: JSON.stringify(emails), written_at: now, approved_at: now, attempts: 0, last_error: null };
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
