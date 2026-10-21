// Columns the lead engine needs on top of v2/schema.ts. Idempotent: a
// duplicate-column error just means it already ran.
import { q } from "../../db";

const ALTERS = [
  `ALTER TABLE prospects ADD COLUMN written_at TEXT`,
  `ALTER TABLE prospects ADD COLUMN approved_at TEXT`,
  `ALTER TABLE prospects ADD COLUMN stage_changed_at TEXT`,
  `ALTER TABLE prospects ADD COLUMN skipped_from TEXT`,
  `ALTER TABLE prospects ADD COLUMN catch_all INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE companies ADD COLUMN language TEXT`,
  `ALTER TABLE campaigns ADD COLUMN working_at TEXT`,
  `ALTER TABLE campaigns ADD COLUMN last_run_at TEXT`,
];

export async function ensureCampaignColumns() {
  for (const sql of ALTERS) {
    try {
      await q(sql);
    } catch {
      /* already there */
    }
  }
  try {
    await q(`CREATE INDEX IF NOT EXISTS idx_prospects_next ON prospects(campaign_id, stage, next_action_at)`);
  } catch {
    /* ignore */
  }
}
