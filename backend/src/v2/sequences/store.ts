// Sequences storage — one active sequence per campaign (campaigns.sequence_id),
// every saved change is a new version (sequence_versions), and leads keep the
// version they were written with (prospects.sequence_version).
// Imported by the campaign engine (writer / sender) and the sequences routes.
import { nowIso, q } from "../../db";
import { logEvent, parseJson, uid } from "../events";
import { DEFAULT_SETTINGS, sanitizeSettings, type Row } from "../campaigns/types";
import { cloneSteps, sanitizeSequence, sanitizeStep, starterFor, stepsFromSettings, type SequenceDef, type SequenceLanguage, type SequenceStep } from "./model";

export interface StoredSequence extends SequenceDef {
  id: string;
  campaignId: string;
  version: number;
  updatedAt: string;
}

let ready: Promise<void> | null = null;

export function ensureSequenceTables(): Promise<void> {
  if (!ready)
    ready = (async () => {
      await q(`CREATE TABLE IF NOT EXISTS sequences (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        name TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'auto',
        steps_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await q(`CREATE TABLE IF NOT EXISTS sequence_versions (
        sequence_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        language TEXT NOT NULL DEFAULT 'auto',
        steps_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (sequence_id, version)
      )`);
      try {
        await q(`CREATE INDEX IF NOT EXISTS idx_sequences_campaign ON sequences(campaign_id)`);
      } catch {
        /* ignore */
      }
      await migrateCampaigns();
    })().catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}

function view(r: Row): StoredSequence {
  const steps = parseJson<any[]>(r.steps_json, []).map((x, i) => sanitizeStep(x, i));
  return {
    id: String(r.id),
    campaignId: String(r.campaign_id),
    name: String(r.name || "Sequence"),
    language: (["auto", "en", "ar"].includes(r.language) ? r.language : "auto") as SequenceLanguage,
    steps: steps.length ? steps : stepsFromSettings(2, [3, 4]),
    version: Number(r.version) || 1,
    updatedAt: String(r.updated_at),
  };
}

async function insertSequence(campaignId: string, def: SequenceDef, note: string): Promise<StoredSequence> {
  const id = uid();
  const now = nowIso();
  const steps = JSON.stringify(def.steps);
  await q(`INSERT INTO sequences (id, campaign_id, name, language, steps_json, version, status, created_at, updated_at) VALUES (?,?,?,?,?, 1, 'active', ?, ?)`, [id, campaignId, def.name, def.language, steps, now, now]);
  await q(`INSERT INTO sequence_versions (sequence_id, version, language, steps_json, created_at) VALUES (?, 1, ?, ?, ?)`, [id, def.language, steps, now]);
  await q(`UPDATE campaigns SET sequence_id = ? WHERE id = ?`, [id, campaignId]);
  await logEvent("campaign", note, { campaignId });
  return view((await q(`SELECT * FROM sequences WHERE id = ?`, [id]))[0]);
}

/**
 * Campaigns created before sequences existed get one built from their old
 * follow-up settings and the writer's old rules — nothing changes until
 * someone edits it.
 */
async function migrateCampaigns() {
  for (const c of await q(`SELECT id, kind, name, settings_json FROM campaigns WHERE sequence_id IS NULL`)) {
    const s = sanitizeSettings(parseJson(c.settings_json, {}), DEFAULT_SETTINGS);
    await insertSequence(String(c.id), { name: `${c.name} sequence`, language: s.language, steps: stepsFromSettings(s.followUps, s.followUpDelays) }, "Built the campaign's sequence from its follow-up settings.");
  }
}

/** The campaign's active sequence; created from the starter for its kind when missing. */
export async function sequenceFor(campaignId: string): Promise<StoredSequence> {
  await ensureSequenceTables();
  const c = (await q(`SELECT id, name, kind, sequence_id, settings_json FROM campaigns WHERE id = ?`, [campaignId]))[0];
  if (!c) throw new Error("Campaign not found");
  if (c.sequence_id) {
    const r = (await q(`SELECT * FROM sequences WHERE id = ?`, [c.sequence_id]))[0];
    if (r) return view(r);
  }
  const starter = starterFor(c.kind === "partner" ? "partner" : "customer");
  return insertSequence(campaignId, { name: `${c.name} sequence`, language: starter.language, steps: cloneSteps(starter.steps) }, `Started the sequence from "${starter.name}".`);
}

/** A specific version (for leads written with an older one). */
export async function sequenceVersion(sequenceId: string, version: number): Promise<SequenceStep[] | null> {
  const r = (await q(`SELECT steps_json FROM sequence_versions WHERE sequence_id = ? AND version = ?`, [sequenceId, version]))[0];
  return r ? parseJson<any[]>(r.steps_json, []).map((x, i) => sanitizeStep(x, i)) : null;
}

export async function versionsOf(sequenceId: string) {
  return (await q(`SELECT version, steps_json, created_at FROM sequence_versions WHERE sequence_id = ? ORDER BY version DESC LIMIT 20`, [sequenceId])).map((r) => ({
    version: Number(r.version),
    steps: parseJson<any[]>(r.steps_json, []).length,
    createdAt: String(r.created_at),
  }));
}

/** The parts of a sequence Instantly sees: how many steps, which start a thread, the delays. */
export function shapeOf(steps: SequenceStep[]): string {
  return steps.map((s, i) => `${i === 0 ? 0 : s.delayDays}:${i === 0 || s.newThread ? "t" : "r"}`).join("|");
}

/** Save from the editor. A change to the steps creates a new version. */
export async function saveSequence(campaignId: string, raw: any): Promise<{ sequence: StoredSequence; changed: boolean; shapeChanged: boolean }> {
  const cur = await sequenceFor(campaignId);
  const next = sanitizeSequence(raw, cur);
  const stepsChanged = JSON.stringify(next.steps) !== JSON.stringify(cur.steps) || next.language !== cur.language;
  const now = nowIso();
  if (!stepsChanged) {
    if (next.name !== cur.name) await q(`UPDATE sequences SET name = ?, updated_at = ? WHERE id = ?`, [next.name, now, cur.id]);
    return { sequence: { ...cur, name: next.name }, changed: false, shapeChanged: false };
  }
  const version = cur.version + 1;
  const steps = JSON.stringify(next.steps);
  await q(`UPDATE sequences SET name = ?, language = ?, steps_json = ?, version = ?, updated_at = ? WHERE id = ?`, [next.name, next.language, steps, version, now, cur.id]);
  await q(`INSERT INTO sequence_versions (sequence_id, version, language, steps_json, created_at) VALUES (?,?,?,?,?) ON CONFLICT (sequence_id, version) DO NOTHING`, [cur.id, version, next.language, steps, now]);
  await logEvent("campaign", `Saved version ${version} of the sequence (${next.steps.length} step${next.steps.length === 1 ? "" : "s"}).`, { campaignId });
  return { sequence: view((await q(`SELECT * FROM sequences WHERE id = ?`, [cur.id]))[0]), changed: true, shapeChanged: shapeOf(next.steps) !== shapeOf(cur.steps) };
}
