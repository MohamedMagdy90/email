// Targeting results (Phase 9, plan §8.4.5 + §8.4.7): what's working. The
// offers side by side, every segment with its numbers and its learning-loop
// status (and the suggestion waiting for Apply), a segment's search log and
// companies, duplicating a segment into another campaign, and steering the
// targeting by chat — the AI proposes changes to the STRUCTURED fields, the
// user ticks and applies them. Nothing is applied on its own.
import { q } from "../../db";
import { parseJson, uid } from "../events";
import { aiStatus, llm, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { normalizeCity, normalizeCountry } from "../../country";
import { CampaignError, PROSPECT_SELECT, prospectRowView, sanitizeOffer, segmentView, type Row } from "../campaigns/types";
import { addSegment, updateSegment } from "../campaigns/service";
import { addExclusions, recheck, saveMarket } from "./service";
import { marketOf, segmentTargeting, type TargetMarket } from "./market";
import { INDUSTRIES, INDUSTRY_BY_ID, SIZE_BANDS } from "./taxonomy";
import { SKIP_RULE_LABEL } from "./check";
import { evaluate, getRules, loopStatusOf, quotaWeights, segmentStats, setSegmentStatus, type LoopStatus } from "./learning";

async function campaignRow(id: string): Promise<Row> {
  const c = (await q(`SELECT * FROM campaigns WHERE id = ?`, [id]))[0];
  if (!c) throw new CampaignError("Campaign not found", 404);
  return c;
}
async function segmentRow(sid: string): Promise<Row> {
  const s = (await q(`SELECT * FROM segments WHERE id = ?`, [sid]))[0];
  if (!s) throw new CampaignError("Segment not found", 404);
  return s;
}

/* ------------------------------- the board ------------------------------- */

export async function targetingResults(campaign?: string) {
  const campaigns = campaign ? [await campaignRow(campaign)] : await q(`SELECT * FROM campaigns WHERE status <> 'archived' ORDER BY created_at DESC`);
  const rules = await getRules();
  const segRows = campaigns.length ? await q(`SELECT * FROM segments WHERE campaign_id IN (${campaigns.map(() => "?").join(",")}) ORDER BY created_at`, campaigns.map((c) => c.id)) : [];
  const stats = await segmentStats(segRows.map((s) => String(s.id)));
  const byCampaign = new Map(campaigns.map((c) => [String(c.id), c]));
  const weights = new Map<string, number>();
  for (const c of campaigns) for (const [k, v] of quotaWeights(segRows.filter((s) => s.campaign_id === c.id && Number(s.enabled) === 1), rules)) weights.set(k, v);
  return {
    rules,
    offers: campaigns.map((c) => {
      const o = parseJson<any>(c.offer_json, null);
      return { campaignId: String(c.id), campaignName: String(c.name), kind: c.kind === "partner" ? "partner" : "customer", website: c.website || null, offer: o ? sanitizeOffer(o) : null };
    }),
    segments: segRows.map((s) => {
      const c = byCampaign.get(String(s.campaign_id))!;
      const view = segmentView(s, marketOf(c));
      const st = stats.get(String(s.id))!;
      return {
        ...view,
        campaignName: String(c.name),
        campaignKind: c.kind === "partner" ? "partner" : "customer",
        loopStatus: loopStatusOf(s) as LoopStatus,
        statusReason: s.status_reason || null,
        suggestion: s.suggested_status ? { status: String(s.suggested_status) as LoopStatus, reason: String(s.suggested_reason || ""), at: String(s.suggested_at || "") } : null,
        verdict: evaluate(st, rules).reason,
        stats: { ...st, quotaShare: Number(s.enabled) === 1 ? Math.round((weights.get(String(s.id)) || 0) * 1000) / 10 : 0, searchesLeft: Math.max(0, view.searchesTotal - view.searchesDone) },
      };
    }),
  };
}

export async function segmentDetail(sid: string) {
  const s = await segmentRow(sid);
  const c = await campaignRow(String(s.campaign_id));
  const rules = await getRules();
  const st = (await segmentStats([sid])).get(sid)!;
  const searches = (await q(`SELECT * FROM segment_searches WHERE segment_id = ? ORDER BY ran_at DESC LIMIT 100`, [sid])).map((r) => {
    const rj = parseJson<any>(r.rejected_json, {}) || {};
    return {
      id: String(r.id),
      query: String(r.query),
      country: r.country || null,
      via: r.via === "gemini" ? "gemini" : "search",
      ranAt: String(r.ran_at),
      results: Number(r.results) || 0,
      added: Number(r.added) || 0,
      rejected: Object.entries(rj.byRule || {}).map(([rule, n]) => ({ rule, label: SKIP_RULE_LABEL[rule as keyof typeof SKIP_RULE_LABEL] || (rule === "duplicate" ? "Already in the campaign" : rule === "excluded" ? "Do not contact" : "Not a company site"), count: Number(n) || 0 })),
      examples: Array.isArray(rj.examples) ? rj.examples.slice(0, 6) : [],
    };
  });
  const companies = (await q(`${PROSPECT_SELECT} WHERE p.segment_id = ? ORDER BY p.updated_at DESC LIMIT 100`, [sid])).map(prospectRowView);
  return {
    segment: { ...segmentView(s, marketOf(c)), loopStatus: loopStatusOf(s), statusReason: s.status_reason || null, suggestion: s.suggested_status ? { status: String(s.suggested_status), reason: String(s.suggested_reason || "") } : null },
    campaign: { id: String(c.id), name: String(c.name), kind: c.kind === "partner" ? "partner" : "customer" },
    stats: st,
    verdict: evaluate(st, rules).reason,
    searches,
    companies,
  };
}

/* ------------------------------- actions -------------------------------- */

export async function duplicateSegment(sid: string, body: any) {
  const s = await segmentRow(sid);
  const to = await campaignRow(String(body?.campaignId || s.campaign_id));
  if (to.status === "archived") throw new CampaignError("That campaign is archived.");
  const t = segmentTargeting(s);
  const input: Record<string, any> = {
    name: to.id === s.campaign_id ? `${s.name} (copy)` : String(s.name),
    description: s.description || "",
    industryIds: t.industryIds,
    industries: parseJson<string[]>(s.industries_json, []),
    countries: t.countries,
    cities: t.cities,
    sizeBands: t.sizeBands,
    minBranches: t.minBranches,
    titlesOverride: t.titlesOverride,
    titles: t.titles,
    signals: t.signals,
    queriesAuto: t.queriesAuto,
    fitScore: s.fit_score ?? null,
    why: s.why || "",
  };
  if (!t.queriesAuto) input.queries = parseJson<string[]>(s.queries_json, []);
  const r = await addSegment(String(to.id), input);
  return { segment: r.segment, campaignId: String(to.id) };
}

/** Apply (or dismiss) the learning loop's suggestions. */
export async function applySuggestions(body: any) {
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 200) : [];
  let applied = 0;
  let dismissed = 0;
  for (const id of ids) {
    const s = (await q(`SELECT * FROM segments WHERE id = ?`, [id]))[0];
    if (!s?.suggested_status) continue;
    if (body?.dismiss === true) {
      await q(`UPDATE segments SET suggested_status = NULL, suggested_reason = NULL, suggested_at = NULL WHERE id = ?`, [id]);
      dismissed++;
    } else {
      await setSegmentStatus(s, s.suggested_status as LoopStatus, String(s.suggested_reason || "Suggested by the learning loop"), "user");
      applied++;
    }
  }
  return { applied, dismissed };
}

export async function setStatusByHand(sid: string, body: any) {
  const s = await segmentRow(sid);
  const status = String(body?.status || "") as LoopStatus;
  if (!["testing", "working", "scaling", "paused"].includes(status)) throw new CampaignError("Pick Testing, Working, Scaling or Paused.");
  await setSegmentStatus(s, status, typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "Set by hand.", "user");
  return { ok: true as const };
}

/* ----------------------------- steer by chat ----------------------------- */

const MARKET_LISTS = ["countries", "excludeCities", "sizeBands", "excludeIndustries", "mustKeywords", "mustNotKeywords", "titles", "excludeTitles"] as const;
const MARKET_SCALARS = ["minBranches", "minFitScore", "language", "sizeMode"] as const;
const SEGMENT_FIELDS = ["industryIds", "titles", "mustKeywords", "mustNotKeywords", "cities", "enabled"] as const;
type MarketList = (typeof MARKET_LISTS)[number];
type MarketScalar = (typeof MARKET_SCALARS)[number];
type SegmentField = (typeof SEGMENT_FIELDS)[number];
type Op = "add" | "remove" | "set";

export type SteerChange =
  | { id: string; kind: "market"; field: MarketList | MarketScalar | "cities"; op: Op; value: any; label: string }
  | { id: string; kind: "segment"; segmentId: string; segmentName: string; field: SegmentField; op: Op; value: any; label: string }
  | { id: string; kind: "exclusion"; value: string[]; label: string }
  | { id: string; kind: "new_segment"; value: { name: string; industryIds: string[]; why: string }; label: string };

const FIELD_LABEL: Record<string, string> = {
  countries: "countries",
  excludeCities: "excluded cities",
  sizeBands: "company size",
  excludeIndustries: "excluded industries",
  mustKeywords: "must mention",
  mustNotKeywords: "must not mention",
  titles: "people to contact",
  excludeTitles: "never contact",
  minBranches: "minimum branches",
  minFitScore: "minimum fit score",
  language: "website language",
  sizeMode: "size rule",
  cities: "cities",
  industryIds: "industries",
  enabled: "on / off",
};
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
const industryLabel = (id: string) => INDUSTRY_BY_ID.get(id)?.label || id;

function cleanList(field: string, values: string[]): string[] {
  if (field === "countries") return [...new Set(values.map((c) => normalizeCountry(c)).filter(Boolean) as string[])];
  if (field === "excludeCities") return [...new Set(values.map((c) => normalizeCity(c) || c))];
  if (field === "sizeBands") return values.filter((b) => (SIZE_BANDS as readonly string[]).includes(b));
  if (field === "excludeIndustries" || field === "industryIds") return values.filter((id) => INDUSTRY_BY_ID.has(id));
  return values.map((v) => v.slice(0, 80));
}

/** Validate the AI's proposals against what exists; anything unknown is dropped. */
export function validateChanges(raw: unknown, market: TargetMarket, segs: Row[]): SteerChange[] {
  const out: SteerChange[] = [];
  const list = Array.isArray(raw) ? raw.slice(0, 20) : [];
  for (const ch of list) {
    if (!ch || typeof ch !== "object") continue;
    const op: Op = ["add", "remove", "set"].includes(ch.op) ? ch.op : "set";
    if (ch.kind === "market") {
      if ((MARKET_LISTS as readonly string[]).includes(ch.field)) {
        const values = cleanList(ch.field, listOf(ch.value));
        if (!values.length) continue;
        const shown = ch.field === "excludeIndustries" ? values.map(industryLabel) : values;
        out.push({ id: uid(), kind: "market", field: ch.field, op, value: values, label: `Market · ${FIELD_LABEL[ch.field]}: ${op === "remove" ? "remove" : op === "add" ? "add" : "set to"} ${shown.join(", ")}` });
      } else if (ch.field === "cities") {
        const src = ch.value && typeof ch.value === "object" && !Array.isArray(ch.value) ? ch.value : {};
        const value: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(src)) {
          const country = normalizeCountry(k);
          if (!country || !market.countries.includes(country)) continue;
          const cities = listOf(v).map((c) => normalizeCity(c, country) || c);
          if (cities.length) value[country] = cities;
        }
        if (!Object.keys(value).length) continue;
        out.push({ id: uid(), kind: "market", field: "cities", op, value, label: `Market · cities: ${op === "remove" ? "remove" : op === "add" ? "add" : "only"} ${Object.entries(value).map(([c, l]) => `${l.join(", ")} (${c})`).join("; ")}` });
      } else if ((MARKET_SCALARS as readonly string[]).includes(ch.field)) {
        let v: any = ch.value;
        if (ch.field === "minBranches" || ch.field === "minFitScore") v = v === null || v === "" ? null : Math.max(0, Math.min(ch.field === "minFitScore" ? 100 : 1000, Math.round(Number(v))));
        if (ch.field === "language" && !["any", "ar", "en"].includes(v)) continue;
        if (ch.field === "sizeMode" && !["prefer", "strict"].includes(v)) continue;
        if (Number.isNaN(v)) continue;
        out.push({ id: uid(), kind: "market", field: ch.field, op: "set", value: v, label: `Market · ${FIELD_LABEL[ch.field]}: ${v === null ? "none" : v}` });
      }
    } else if (ch.kind === "segment") {
      const seg = segs.find((s) => s.id === ch.segmentId);
      if (!seg || !(SEGMENT_FIELDS as readonly string[]).includes(ch.field)) continue;
      let value: any;
      if (ch.field === "enabled") value = !!ch.value;
      else if (ch.field === "cities") {
        const src = ch.value && typeof ch.value === "object" && !Array.isArray(ch.value) ? ch.value : {};
        value = {};
        for (const [k, v] of Object.entries(src)) {
          const country = normalizeCountry(k);
          if (country && market.countries.includes(country)) value[country] = listOf(v).map((c) => normalizeCity(c, country) || c);
        }
        if (!Object.keys(value).length) continue;
      } else {
        value = cleanList(ch.field, listOf(ch.value));
        if (!value.length) continue;
      }
      const shown = ch.field === "enabled" ? (value ? "turn on" : "turn off") : ch.field === "industryIds" ? value.map(industryLabel).join(", ") : ch.field === "cities" ? Object.entries(value).map(([c, l]: any) => `${l.join(", ")} (${c})`).join("; ") : value.join(", ");
      out.push({ id: uid(), kind: "segment", segmentId: String(seg.id), segmentName: String(seg.name), field: ch.field, op, value, label: `"${seg.name}" · ${FIELD_LABEL[ch.field]}: ${ch.field === "enabled" ? "" : op === "remove" ? "remove " : op === "add" ? "add " : "set to "}${shown}` });
    } else if (ch.kind === "exclusion") {
      const values = listOf(ch.value).map((v) => v.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter((v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$|^[a-z0-9.-]+\.[a-z]{2,}$/.test(v));
      if (!values.length) continue;
      out.push({ id: uid(), kind: "exclusion", value: values, label: `Never contact: ${values.join(", ")}` });
    } else if (ch.kind === "new_segment") {
      const v = ch.value && typeof ch.value === "object" ? ch.value : {};
      const name = String(v.name || "").trim().slice(0, 120);
      const industryIds = cleanList("industryIds", listOf(v.industryIds));
      if (!name || !industryIds.length) continue;
      out.push({ id: uid(), kind: "new_segment", value: { name, industryIds, why: String(v.why || "").slice(0, 400) }, label: `New segment "${name}" (${industryIds.map(industryLabel).join(", ")})` });
    }
  }
  return out;
}

export async function steer(body: any) {
  const c = await campaignRow(String(body?.campaignId || ""));
  const message = String(body?.message || "").trim().slice(0, 1000);
  if (!message) throw new CampaignError("Say what to change, e.g. \"Focus on distributors with 3+ branches in Riyadh, skip pharmacies\".");
  if (!(await aiStatus()).configured) throw new CampaignError("Steering by chat needs an AI key. Connect Gemini, Groq or OpenRouter in the Agent tab, or change the targeting by hand below.");
  const market = marketOf(c);
  const segs = await q(`SELECT * FROM segments WHERE campaign_id = ? ORDER BY created_at`, [c.id]);
  const prompt = [
    "You help a salesperson adjust the targeting of a cold-email campaign. Turn their message into a short list of changes to the STRUCTURED fields below. Change only what they asked for.",
    "",
    `CAMPAIGN: ${c.name} (${c.kind === "partner" ? "finding partners" : "finding customers"})`,
    "MARKET (current):",
    JSON.stringify({ countries: market.countries, cities: market.cities, excludeCities: market.excludeCities, sizeBands: market.sizeBands, minBranches: market.minBranches, sizeMode: market.sizeMode, excludeIndustries: market.excludeIndustries, mustKeywords: market.mustKeywords, mustNotKeywords: market.mustNotKeywords, language: market.language, titles: market.titles, excludeTitles: market.excludeTitles, minFitScore: market.minFitScore }),
    "SEGMENTS (current):",
    JSON.stringify(segs.map((s) => ({ id: s.id, name: s.name, enabled: Number(s.enabled) === 1, ...(({ industryIds, cities, titles, signals }) => ({ industryIds, cities, titles, mustKeywords: signals.must, mustNotKeywords: signals.mustNot }))(segmentTargeting(s)) }))),
    "INDUSTRY IDS you may use:",
    INDUSTRIES.map((i) => `${i.id} (${i.label})`).join("; "),
    `SIZE BANDS: ${SIZE_BANDS.join(", ")}`,
    "",
    `THEIR MESSAGE: ${message}`,
    "",
    'Return JSON: {"summary": one sentence saying what you\'ll change, "changes": [ ... ]}. Each change is one of:',
    '{"kind":"market","field": one of countries|cities|excludeCities|sizeBands|excludeIndustries|mustKeywords|mustNotKeywords|titles|excludeTitles|minBranches|minFitScore|language|sizeMode, "op": "add"|"remove"|"set", "value": ...}  (cities value: {"Saudi Arabia": ["Riyadh"]})',
    '{"kind":"segment","segmentId": an id above, "field": one of industryIds|titles|mustKeywords|mustNotKeywords|cities|enabled, "op": "add"|"remove"|"set", "value": ...}',
    '{"kind":"exclusion","value": ["domain.com", "person@domain.com"]}',
    '{"kind":"new_segment","value": {"name": string, "industryIds": [ids], "why": string}}',
    "Use only the ids and bands listed. If nothing in the message maps to these fields, return an empty list and say so in the summary.",
  ].join("\n");
  let data: any;
  try {
    data = (await llm<any>({ tier: "smart", json: true, task: "targeting:steer", temperature: 0.2, prompt })).data || {};
  } catch (e) {
    if (e instanceof LlmBudgetExceeded) throw new CampaignError("Today's AI budget is used up. Try again tomorrow, or change the targeting by hand.");
    if (e instanceof LlmUnavailable) throw new CampaignError("No AI provider answered. Check the keys in the Agent tab.");
    throw e;
  }
  const changes = validateChanges(data.changes, market, segs);
  return { summary: typeof data.summary === "string" ? data.summary.slice(0, 400) : changes.length ? "Here's what I'd change." : "I couldn't map that to the targeting fields.", changes };
}

function applyList(cur: string[], op: Op, values: string[]): string[] {
  if (op === "set") return values;
  if (op === "remove") return cur.filter((x) => !values.some((v) => v.toLowerCase() === x.toLowerCase()));
  return [...cur, ...values.filter((v) => !cur.some((x) => x.toLowerCase() === v.toLowerCase()))];
}
function applyCities(cur: Record<string, string[]>, op: Op, value: Record<string, string[]>): Record<string, string[]> {
  const next: Record<string, string[]> = op === "set" ? {} : { ...cur };
  for (const [country, list] of Object.entries(value)) next[country] = applyList(op === "set" ? [] : next[country] || [], op === "set" ? "set" : op, list);
  for (const k of Object.keys(next)) if (!next[k].length) delete next[k];
  return next;
}

/** Apply the changes the user ticked, then dry-run the re-check of the leads already found. */
export async function applySteer(body: any) {
  const c = await campaignRow(String(body?.campaignId || ""));
  const market = marketOf(c);
  const segs = await q(`SELECT * FROM segments WHERE campaign_id = ?`, [c.id]);
  const changes = validateChanges(body?.changes, market, segs);
  if (!changes.length) throw new CampaignError("Nothing to apply.");
  let next: any = { ...market };
  let marketChanged = false;
  const notes: string[] = [];
  for (const ch of changes) {
    if (ch.kind === "market") {
      marketChanged = true;
      if (ch.field === "cities") next.cities = applyCities(next.cities, ch.op, ch.value);
      else if ((MARKET_LISTS as readonly string[]).includes(ch.field)) next[ch.field] = applyList(next[ch.field] || [], ch.op, ch.value);
      else next[ch.field] = ch.value;
    }
  }
  if (marketChanged) await saveMarket(String(c.id), { market: next });
  for (const ch of changes) {
    if (ch.kind === "segment") {
      const seg = (await q(`SELECT * FROM segments WHERE id = ?`, [ch.segmentId]))[0];
      if (!seg) continue;
      const t = segmentTargeting(seg);
      if (ch.field === "enabled") await updateSegment(String(c.id), ch.segmentId, { enabled: ch.value });
      else if (ch.field === "industryIds") await updateSegment(String(c.id), ch.segmentId, { industryIds: applyList(t.industryIds, ch.op, ch.value) });
      else if (ch.field === "titles") await updateSegment(String(c.id), ch.segmentId, { titles: applyList(t.titlesOverride ? t.titles : market.titles, ch.op, ch.value), titlesOverride: true });
      else if (ch.field === "cities") await updateSegment(String(c.id), ch.segmentId, { cities: applyCities(t.cities, ch.op, ch.value) });
      else if (ch.field === "mustKeywords") await updateSegment(String(c.id), ch.segmentId, { signals: { must: applyList(t.signals.must, ch.op, ch.value), mustNot: t.signals.mustNot } });
      else if (ch.field === "mustNotKeywords") await updateSegment(String(c.id), ch.segmentId, { signals: { must: t.signals.must, mustNot: applyList(t.signals.mustNot, ch.op, ch.value) } });
    } else if (ch.kind === "exclusion") {
      const r = await addExclusions({ entries: ch.value, reason: "Steered by chat", source: "manual" });
      notes.push(`${r.added} added to do-not-contact.`);
    } else if (ch.kind === "new_segment") {
      await addSegment(String(c.id), { name: ch.value.name, industryIds: ch.value.industryIds, why: ch.value.why });
      notes.push(`Added the segment "${ch.value.name}".`);
    }
  }
  const check = await recheck(String(c.id), { apply: false });
  return { applied: changes.length, notes, recheck: check };
}
