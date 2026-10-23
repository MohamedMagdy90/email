// Sequences service (Phase 7) — what the Sequences tab and the campaign's
// Sequence tab call: the overview across campaigns, one campaign's sequence
// with its versions, saving (Instantly is patched when the shape changes),
// a live preview on a real lead, "rewrite unsent leads", the starter library
// and the per-step numbers.
import { q, nowIso } from "../../db";
import { logEvent, parseJson } from "../events";
import { aiStatus, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { getAgentSettings } from "../agent-settings";
import { SAMPLE_PROSPECT } from "../agent-preview";
import * as inst from "../instantly";
import { CampaignError, DEFAULT_SETTINGS, researchJson, sanitizeOffer, sanitizeSettings, type ProspectEmails, type Row } from "../campaigns/types";
import { writableWithoutAi, writeEmails, WriterRejected } from "../campaigns/writer";
import { instantlySteps } from "../campaigns/sender";
import { ANGLE_INSTRUCTIONS, ANGLES, MAX_STEPS, SequenceInvalid, STARTERS, VARIABLES, sanitizeSequence } from "./model";
import { saveSequence, sequenceFor, shapeOf, versionsOf } from "./store";

async function campaignRow(id: string): Promise<Row> {
  const c = (await q(`SELECT * FROM campaigns WHERE id = ?`, [id]))[0];
  if (!c) throw new CampaignError("Campaign not found", 404);
  return c;
}

const IN_INSTANTLY = "p.instantly_lead_id IS NOT NULL AND p.stage IN ('queued','sent','replied','interested','meeting','won','lost','bounced','unsubscribed')";

async function counts(campaignId: string, version: number) {
  const n = async (where: string, params: any[] = []) => Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects p WHERE p.campaign_id = ? AND ${where}`, [campaignId, ...params]))[0]?.n) || 0;
  return {
    unsent: await n("p.stage IN ('written','approved') AND p.instantly_lead_id IS NULL"),
    stale: await n("p.stage IN ('written','approved') AND p.instantly_lead_id IS NULL AND (p.sequence_version IS NULL OR p.sequence_version <> ?)", [version]),
    inInstantly: await n(IN_INSTANTLY),
    active: await n("p.instantly_lead_id IS NOT NULL AND p.stage IN ('queued','sent')"),
  };
}

/* -------------------------------- overview ------------------------------- */

export async function listSequences(campaign?: string) {
  const rows = campaign ? await q(`SELECT * FROM campaigns WHERE id = ?`, [campaign]) : await q(`SELECT * FROM campaigns WHERE status <> 'archived' ORDER BY created_at DESC`);
  const out = [];
  for (const c of rows) {
    const s = await sequenceFor(String(c.id));
    const replies = await q(`SELECT replied_step, CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND replied_step IS NOT NULL GROUP BY replied_step`, [c.id]);
    out.push({
      campaign: { id: String(c.id), name: String(c.name), kind: c.kind === "partner" ? "partner" : "customer", status: String(c.status) },
      sequence: s,
      ...(await counts(String(c.id), s.version)),
      repliesByStep: Object.fromEntries(replies.map((r) => [Number(r.replied_step), Number(r.n) || 0])),
    });
  }
  return { sequences: out };
}

/* --------------------------------- detail -------------------------------- */

export async function getSequence(campaignId: string) {
  const c = await campaignRow(campaignId);
  const s = await sequenceFor(campaignId);
  const agent = await getAgentSettings();
  const leads = await q(
    `SELECT p.id, p.full_name, p.title, p.stage, co.name AS co_name, co.domain AS co_domain FROM prospects p LEFT JOIN companies co ON co.id = p.company_id
      WHERE p.campaign_id = ? AND p.stage IN ('verified','written','approved','queued','sent') AND co.researched_at IS NOT NULL
      ORDER BY CASE p.stage WHEN 'written' THEN 0 WHEN 'verified' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, p.updated_at DESC LIMIT 30`,
    [campaignId]
  );
  return {
    campaign: { id: String(c.id), name: String(c.name), kind: c.kind === "partner" ? "partner" : "customer", status: String(c.status), instantly: !!c.instantly_campaign_id },
    sequence: s,
    versions: await versionsOf(s.id),
    ...(await counts(campaignId, s.version)),
    bookingLink: agent.bookingLink || "",
    senderName: agent.senderName || "",
    ai: (await aiStatus()).configured,
    previewLeads: leads.map((r) => ({ id: String(r.id), name: r.full_name || null, title: r.title || null, company: r.co_name || r.co_domain || null, stage: String(r.stage) })),
  };
}

/* ---------------------------------- save --------------------------------- */

export async function putSequence(campaignId: string, body: any) {
  const c = await campaignRow(campaignId);
  const cur = await sequenceFor(campaignId);
  let draft;
  try {
    draft = sanitizeSequence(body?.sequence ?? body, cur);
  } catch (e) {
    if (e instanceof SequenceInvalid) throw new CampaignError(e.message);
    throw e;
  }
  // Leads already in Instantly carry copy for the current steps only: a longer
  // sequence would send them an empty email.
  if (draft.steps.length > cur.steps.length) {
    const active = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects p WHERE p.campaign_id = ? AND p.instantly_lead_id IS NOT NULL AND p.stage IN ('queued','sent')`, [campaignId]))[0]?.n) || 0;
    if (active) {
      throw new CampaignError(
        `${active} lead${active === 1 ? " is" : "s are"} still going through the ${cur.steps.length}-step sequence in Instantly, with copy for ${cur.steps.length} steps only. A longer sequence would send them an empty email. Keep ${cur.steps.length} steps until they finish, or start a new campaign for the longer one.`
      );
    }
  }
  let saved;
  try {
    saved = await saveSequence(campaignId, draft);
  } catch (e) {
    if (e instanceof SequenceInvalid) throw new CampaignError(e.message);
    throw e;
  }
  let instantly: "patched" | "skipped" | "failed" = "skipped";
  if (saved.shapeChanged && c.instantly_campaign_id && (await inst.instantlyConfigured())) {
    try {
      await inst.patchCampaign(String(c.instantly_campaign_id), { sequences: [{ steps: instantlySteps(saved.sequence.steps) }] });
      instantly = "patched";
    } catch (e: any) {
      instantly = "failed";
      await logEvent("send", `Couldn't update the Instantly sequence: ${String(e?.message || e).slice(0, 200)}`, { level: "warn", campaignId });
    }
  }
  return { ...(await getSequence(campaignId)), changed: saved.changed, instantlyUpdate: instantly };
}

/* --------------------------------- preview ------------------------------- */

/** Write the sequence (saved, or a draft from the editor) for one real lead — or the fictional sample. Nothing is saved. */
export async function previewSequence(campaignId: string, body: any) {
  const c = await campaignRow(campaignId);
  const cur = await sequenceFor(campaignId);
  let def;
  try {
    def = body?.sequence ? sanitizeSequence(body.sequence, cur) : cur;
  } catch (e) {
    if (e instanceof SequenceInvalid) throw new CampaignError(e.message);
    throw e;
  }
  const ai = await aiStatus();
  if (!ai.configured && !writableWithoutAi(def.steps)) {
    return { lead: null, emails: [], warnings: [], error: "The preview writes real emails, which needs an AI key. Connect Gemini, Groq or OpenRouter in the Agent tab.", ai: false };
  }
  const settings = sanitizeSettings(parseJson(c.settings_json, {}), DEFAULT_SETTINGS);
  const offerRaw = parseJson<any>(c.offer_json, null);
  const offer = offerRaw ? sanitizeOffer(offerRaw) : null;
  const agent = await getAgentSettings();
  let prospect: Row;
  let company: Row;
  let research;
  let segment: Row | null = null;
  let lead: { id: string | null; name: string | null; company: string | null; sample: boolean };
  const pid = typeof body?.prospectId === "string" ? body.prospectId : "";
  const p = pid ? (await q(`SELECT * FROM prospects WHERE id = ? AND campaign_id = ?`, [pid, campaignId]))[0] : null;
  if (p) {
    prospect = p;
    company = (await q(`SELECT * FROM companies WHERE id = ?`, [p.company_id]))[0] || { domain: "example.com" };
    research = researchJson(company.research_json);
    segment = p.segment_id ? (await q(`SELECT * FROM segments WHERE id = ?`, [p.segment_id]))[0] || null : null;
    lead = { id: String(p.id), name: p.full_name || null, company: company.name || company.domain || null, sample: false };
  } else {
    const sp = SAMPLE_PROSPECT;
    const [first, ...rest] = sp.name.split(" ");
    prospect = { first_name: first, last_name: rest.join(" "), full_name: sp.name, title: sp.title };
    company = { name: sp.company, domain: "gulf-fasteners.example", city: sp.city, country: sp.country, description: sp.research[0], industry: "Industrial supplies distribution", language: "en" };
    research = { hooks: sp.research.slice(1, 3), people: [], emailsOnSite: [], sources: [] };
    lead = { id: null, name: sp.name, company: sp.company, sample: true };
  }
  try {
    const emails = await writeEmails({ prospect, company, research, segment, offer, settings, agent, steps: def.steps, sequenceLanguage: def.language });
    return {
      lead,
      emails: emails.steps.map((s, i) => ({ subject: s.subject, body: s.body, delayDays: s.delayDays, words: s.body.split(/\s+/).filter(Boolean).length, maxWords: def.steps[i].maxWords, kind: def.steps[i].kind })),
      language: emails.language,
      warnings: emails.warnings,
      error: null,
      ai: ai.configured,
    };
  } catch (e: any) {
    if (e instanceof WriterRejected) return { lead, emails: [], warnings: [], error: `The writer couldn't produce copy that passes the checks: ${e.message}. Adjust the step's instructions and try again.`, ai: ai.configured };
    if (e instanceof LlmBudgetExceeded) return { lead, emails: [], warnings: [], error: "Today's AI budget is used up. Try again tomorrow or raise it in the Agent tab.", ai: ai.configured };
    if (e instanceof LlmUnavailable) return { lead, emails: [], warnings: [], error: "No AI provider answered. Check the keys in the Agent tab.", ai: ai.configured };
    throw e;
  }
}

/* ------------------------------ rewrite unsent ---------------------------- */

/** Written / approved leads that haven't reached Instantly go back to the writer. Only those on an older version unless `all`. */
export async function rewriteUnsent(campaignId: string, body: any) {
  await campaignRow(campaignId);
  const s = await sequenceFor(campaignId);
  const all = body?.all === true;
  const rows = await q(
    `SELECT id FROM prospects WHERE campaign_id = ? AND stage IN ('written','approved') AND instantly_lead_id IS NULL ${all ? "" : "AND (sequence_version IS NULL OR sequence_version <> ?)"}`,
    all ? [campaignId] : [campaignId, s.version]
  );
  const now = nowIso();
  for (const r of rows) {
    await q(`UPDATE prospects SET stage = 'verified', email_json = NULL, written_at = NULL, approved_at = NULL, next_action_at = NULL, stage_reason = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [
      `Rewriting with version ${s.version} of the sequence`,
      now,
      now,
      r.id,
    ]);
  }
  if (rows.length) await logEvent("write", `Sent ${rows.length} lead${rows.length === 1 ? "" : "s"} back to the writer for version ${s.version} of the sequence.`, { campaignId });
  return { rewritten: rows.length, version: s.version };
}

/* -------------------------------- templates ------------------------------- */

export function templates() {
  return { templates: STARTERS, angles: ANGLES, angleInstructions: ANGLE_INSTRUCTIONS, variables: VARIABLES, maxSteps: MAX_STEPS };
}

/* ---------------------------------- stats --------------------------------- */

export async function sequenceStats(campaignId: string) {
  const c = await campaignRow(campaignId);
  const s = await sequenceFor(campaignId);
  const total = s.steps.length;
  const steps = s.steps.map((st, i) => ({ step: i + 1, angle: st.angle, kind: st.kind, sent: 0, replies: 0, replyRate: null as number | null, reached: 0, ourReplies: 0, bounced: 0, unsubscribed: 0 }));
  // Ours: how far each contacted lead got, which step it replied to, where it bounced / unsubscribed.
  const rows = await q(
    `SELECT last_step, replied_step, stage, sent_at FROM prospects WHERE campaign_id = ? AND stage IN ('queued','sent','replied','interested','meeting','won','lost','bounced','unsubscribed') AND sent_at IS NOT NULL`,
    [campaignId]
  );
  for (const r of rows) {
    const reached = Math.min(total, Math.max(1, Number(r.last_step) || 1));
    for (let i = 0; i < reached; i++) steps[i].reached++;
    if (r.replied_step != null && Number(r.replied_step) >= 1) steps[Math.min(total, Number(r.replied_step)) - 1].ourReplies++;
    if (r.stage === "bounced") steps[reached - 1].bounced++;
    if (r.stage === "unsubscribed") steps[reached - 1].unsubscribed++;
  }
  let source: "instantly" | "ours" = "ours";
  if (c.instantly_campaign_id && (await inst.instantlyConfigured())) {
    try {
      const a = await inst.campaignStepAnalytics(String(c.instantly_campaign_id));
      const zeroBased = a.some((x) => x.step === "0");
      for (const row of a) {
        if (row.step === null || row.step === undefined) continue;
        const idx = Number(row.step) - (zeroBased ? 0 : 1);
        if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
        steps[idx].sent += Number(row.sent) || 0;
        steps[idx].replies += Number(row.unique_replies ?? row.replies) || 0;
      }
      source = "instantly";
    } catch {
      /* fall back to ours */
    }
  }
  for (const st of steps) {
    if (source === "ours") {
      st.sent = st.reached;
      st.replies = st.ourReplies;
    }
    st.replyRate = st.sent ? Math.round((st.replies / st.sent) * 1000) / 10 : null;
  }
  return { version: s.version, source, contacted: rows.length, steps };
}

export function isStale(p: Row, version: number): boolean {
  const e = parseJson<ProspectEmails | null>(p.email_json, null);
  return !!e && (p.sequence_version == null || Number(p.sequence_version) !== version);
}

export const _internals = { shapeOf };
