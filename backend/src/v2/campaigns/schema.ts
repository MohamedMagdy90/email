// Columns the lead engine needs on top of v2/schema.ts. Idempotent: a
// duplicate-column error just means it already ran.
import { q } from "../../db";
import { ensureTargeting } from "../targeting/schema";

const ALTERS = [
  `ALTER TABLE prospects ADD COLUMN written_at TEXT`,
  `ALTER TABLE prospects ADD COLUMN approved_at TEXT`,
  `ALTER TABLE prospects ADD COLUMN stage_changed_at TEXT`,
  `ALTER TABLE prospects ADD COLUMN skipped_from TEXT`,
  `ALTER TABLE prospects ADD COLUMN catch_all INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE companies ADD COLUMN language TEXT`,
  `ALTER TABLE campaigns ADD COLUMN working_at TEXT`,
  `ALTER TABLE campaigns ADD COLUMN last_run_at TEXT`,
  // Leads (Phase 6): where the lead came from, and the user's own notes.
  `ALTER TABLE prospects ADD COLUMN lead_source TEXT`,
  `ALTER TABLE prospects ADD COLUMN notes TEXT`,
  // Sequences (Phase 7): the copy's sequence + version, and progress through it in Instantly.
  `ALTER TABLE campaigns ADD COLUMN sequence_id TEXT`,
  `ALTER TABLE prospects ADD COLUMN sequence_id TEXT`,
  `ALTER TABLE prospects ADD COLUMN sequence_version INTEGER`,
  `ALTER TABLE prospects ADD COLUMN variant TEXT`,
  `ALTER TABLE prospects ADD COLUMN last_step INTEGER`,
  `ALTER TABLE prospects ADD COLUMN last_step_at TEXT`,
  `ALTER TABLE prospects ADD COLUMN replied_step INTEGER`,
  // Learning loop (Phase 9): a status change waiting for "Apply".
  `ALTER TABLE segments ADD COLUMN suggested_status TEXT`,
  `ALTER TABLE segments ADD COLUMN suggested_reason TEXT`,
  `ALTER TABLE segments ADD COLUMN suggested_at TEXT`,
  `ALTER TABLE segments ADD COLUMN status_reason TEXT`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_prospects_next ON prospects(campaign_id, stage, next_action_at)`,
  `CREATE INDEX IF NOT EXISTS idx_prospects_stage_updated ON prospects(stage, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_prospects_segment ON prospects(segment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_companies_country ON companies(country)`,
];

export async function ensureCampaignColumns() {
  for (const sql of ALTERS) {
    try {
      await q(sql);
    } catch {
      /* already there */
    }
  }
  for (const sql of INDEXES) {
    try {
      await q(sql);
    } catch {
      /* ignore */
    }
  }
  // Structured targeting (market, segment fields, skip rules, do-not-contact) + migration.
  await ensureTargeting();
}
