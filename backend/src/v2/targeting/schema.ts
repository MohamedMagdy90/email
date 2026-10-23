// Targeting columns + the global do-not-contact table, and a one-time
// migration of campaigns / segments created before structured targeting.
// Idempotent; called by both the campaigns and the targeting module.
import { q } from "../../db";
import { parseJson } from "../events";
import { normalizeCountry } from "../../country";
import { classifyIndustry, INDUSTRY_BY_ID } from "./taxonomy";
import { defaultMarket, planFor, planKey } from "./market";

const ALTERS = [
  `ALTER TABLE campaigns ADD COLUMN targeting_json TEXT`,
  `ALTER TABLE segments ADD COLUMN industry_ids_json TEXT`,
  `ALTER TABLE segments ADD COLUMN cities_json TEXT`,
  `ALTER TABLE segments ADD COLUMN size_json TEXT`,
  `ALTER TABLE segments ADD COLUMN titles_override INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE segments ADD COLUMN signals_json TEXT`,
  `ALTER TABLE segments ADD COLUMN queries_auto INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE segments ADD COLUMN searched_json TEXT`,
  `ALTER TABLE companies ADD COLUMN site_text TEXT`,
  `ALTER TABLE companies ADD COLUMN size_band TEXT`,
  `ALTER TABLE companies ADD COLUMN industry_id TEXT`,
  `ALTER TABLE prospects ADD COLUMN skip_rule TEXT`,
  `ALTER TABLE prospects ADD COLUMN target_penalty INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE prospects ADD COLUMN target_notes TEXT`,
];

let ready: Promise<void> | null = null;

export function ensureTargeting(): Promise<void> {
  if (!ready) ready = run().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

async function run() {
  for (const sql of ALTERS) {
    try {
      await q(sql);
    } catch {
      /* already there */
    }
  }
  await q(`CREATE TABLE IF NOT EXISTS exclusions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    reason TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    UNIQUE (kind, value)
  )`);
  // The search log: every query a segment ran, what came back, what was added and why the rest wasn't.
  await q(`CREATE TABLE IF NOT EXISTS segment_searches (
    id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL,
    campaign_id TEXT,
    query TEXT NOT NULL,
    country TEXT,
    via TEXT,
    ran_at TEXT NOT NULL,
    results INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    rejected_json TEXT
  )`);
  for (const sql of [`CREATE INDEX IF NOT EXISTS idx_prospects_skip_rule ON prospects(campaign_id, skip_rule)`, `CREATE INDEX IF NOT EXISTS idx_segment_searches_seg ON segment_searches(segment_id, ran_at)`]) {
    try {
      await q(sql);
    } catch {
      /* ignore */
    }
  }
  await migrate();
}

/** The plan discovery used before structured targeting (to keep each segment's progress). */
function legacyPlan(queries: string[], countries: string[]) {
  const plan: { query: string; country: string }[] = [];
  for (const query of queries) {
    const mentions = countries.find((c) => query.toLowerCase().includes(c.toLowerCase()));
    if (mentions || !countries.length || /riyadh|jeddah|dammam|dubai|sharjah|abu dhabi|doha|kuwait|manama|muscat|cairo|amman/i.test(query)) {
      plan.push({ query, country: mentions || countries[0] || "" });
    } else for (const country of countries) plan.push({ query, country });
  }
  return plan;
}

/** Exposed for tests; normally runs once inside ensureTargeting(). */
export async function migrateTargeting() {
  await migrate();
}

async function migrate() {
  // Segments first: industry ids from the free-text labels, normalised countries,
  // hand-written queries stay hand-written, and the searches already run are remembered.
  for (const s of await q(`SELECT * FROM segments WHERE industry_ids_json IS NULL`)) {
    const labels = parseJson<string[]>(s.industries_json, []);
    const ids: string[] = [];
    for (const label of labels) {
      const c = classifyIndustry({ aiIndustry: label });
      const ind = c.id ? INDUSTRY_BY_ID.get(c.id) : null;
      if (ind && ind.kind !== "exclude" && !ids.includes(ind.id)) ids.push(ind.id);
    }
    const rawCountries = parseJson<string[]>(s.countries_json, []);
    const countries = [...new Set(rawCountries.map((c) => normalizeCountry(c) || c))];
    const queries = parseJson<string[]>(s.queries_json, []);
    const cursor = Number(s.cursor) || 0;
    const old = legacyPlan(queries, rawCountries);
    const searched = new Set<string>();
    const doneByQuery = new Map<string, boolean>();
    old.forEach((p, i) => doneByQuery.set(p.query, (doneByQuery.get(p.query) ?? true) && i < cursor));
    for (const p of planFor(queries, countries)) if (doneByQuery.get(p.query)) searched.add(planKey(p));
    const titles = parseJson<string[]>(s.titles_json, []);
    await q(
      `UPDATE segments SET industry_ids_json = ?, countries_json = ?, cities_json = ?, titles_override = ?, signals_json = ?, queries_auto = 0, searched_json = ? WHERE id = ?`,
      [JSON.stringify(ids), JSON.stringify(countries), "{}", titles.length ? 1 : 0, JSON.stringify({ must: [], mustNot: [] }), JSON.stringify([...searched]), s.id]
    );
  }

  // Campaigns: a market from the countries their segments already target.
  for (const c of await q(`SELECT * FROM campaigns WHERE targeting_json IS NULL`)) {
    const kind = c.kind === "partner" ? "partner" : "customer";
    const market = defaultMarket(kind);
    const segs = await q(`SELECT countries_json FROM segments WHERE campaign_id = ?`, [c.id]);
    const countries: string[] = [];
    for (const s of segs) for (const x of parseJson<string[]>(s.countries_json, [])) if (!countries.includes(x)) countries.push(x);
    if (countries.length) market.countries = countries;
    const settings = parseJson<any>(c.settings_json, {}) || {};
    if (settings.minFitScore != null && Number.isFinite(Number(settings.minFitScore))) market.minFitScore = Number(settings.minFitScore);
    await q(`UPDATE campaigns SET targeting_json = ? WHERE id = ?`, [JSON.stringify(market), c.id]);
  }
}
