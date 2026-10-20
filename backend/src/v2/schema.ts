// Outreach v2 schema — the AI lead engine, the Instantly mailbox pool and the
// reply inbox. Same portable-SQL rules as db.ts: `?` placeholders, ISO-text
// timestamps, booleans as 0/1, JSON stored as TEXT, idempotent migrations.
//
// Ownership (see .same/v2-contracts.md):
//   mailboxes / mailbox_health                 -> v2/mailboxes
//   campaigns / segments / companies / prospects -> v2/campaigns (lead engine)
//   threads / messages                         -> v2/inbox
//   email_verifications, llm_usage, agent_events -> shared foundation
import { q } from "../db";

async function tryQ(sql: string) {
  try {
    await q(sql);
  } catch {
    /* duplicate column / index already exists */
  }
}

export async function ensureV2Schema() {
  /* ------------------------------ mailboxes ------------------------------ */
  // One row per sending mailbox connected to Instantly. `stage` is OUR gate:
  //   warming  -> warmup running, not allowed to send campaign mail yet
  //   ready    -> passed every readiness check, waiting to be added to campaigns
  //   ramping  -> sending, daily limit climbing toward target_limit
  //   active   -> sending at target_limit
  //   paused   -> pulled out (auto: bounce/spam/health drop, or by hand)
  await q(`CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    domain TEXT,
    vendor TEXT NOT NULL DEFAULT 'other',
    first_name TEXT,
    last_name TEXT,
    provider_code INTEGER,
    instantly_status INTEGER,
    warmup_status INTEGER,
    warmup_score REAL,
    warmup_started_at TEXT,
    pre_warmed INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'warming',
    stage_reason TEXT,
    stage_changed_at TEXT,
    daily_limit INTEGER NOT NULL DEFAULT 0,
    target_limit INTEGER NOT NULL DEFAULT 30,
    ramp_start INTEGER NOT NULL DEFAULT 10,
    ramp_step INTEGER NOT NULL DEFAULT 3,
    ramp_started_at TEXT,
    dns_json TEXT,
    checks_json TEXT,
    last_vitals_at TEXT,
    last_synced_at TEXT,
    manual_hold INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  // Daily health snapshot per mailbox (warmup + campaign numbers for that day).
  await q(`CREATE TABLE IF NOT EXISTS mailbox_health (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    day TEXT NOT NULL,
    warmup_sent INTEGER NOT NULL DEFAULT 0,
    warmup_inbox INTEGER NOT NULL DEFAULT 0,
    warmup_spam INTEGER NOT NULL DEFAULT 0,
    warmup_received INTEGER NOT NULL DEFAULT 0,
    inbox_rate REAL,
    health_score REAL,
    campaign_sent INTEGER NOT NULL DEFAULT 0,
    bounced INTEGER NOT NULL DEFAULT 0,
    replies INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (mailbox_id, day)
  )`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_mailbox_health_mb ON mailbox_health(mailbox_id, day)`);

  /* ------------------------------ campaigns ------------------------------ */
  // status: draft | active | paused | archived
  // offer_json:    what we sell (learned from the website, editable)
  // settings_json: CampaignSettings (see v2/types.ts)
  await q(`CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'customer',
    status TEXT NOT NULL DEFAULT 'draft',
    website TEXT,
    offer_json TEXT,
    settings_json TEXT,
    instantly_campaign_id TEXT,
    instantly_status INTEGER,
    last_error TEXT,
    stats_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  // Target segments (ICP slices) per campaign. status: active | scaling | working | paused
  await q(`CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    industries_json TEXT,
    countries_json TEXT,
    company_size TEXT,
    titles_json TEXT,
    queries_json TEXT,
    fit_score INTEGER,
    why TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    enabled INTEGER NOT NULL DEFAULT 1,
    cursor INTEGER NOT NULL DEFAULT 0,
    exhausted INTEGER NOT NULL DEFAULT 0,
    found INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    replies INTEGER NOT NULL DEFAULT 0,
    positive INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_segments_campaign ON segments(campaign_id)`);

  // Company knowledge, shared across campaigns (research is never repeated
  // within research_ttl days).
  await q(`CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    domain TEXT UNIQUE,
    name TEXT,
    website TEXT,
    country TEXT,
    city TEXT,
    industry TEXT,
    description TEXT,
    size_hint TEXT,
    phone TEXT,
    linkedin_url TEXT,
    emails_json TEXT,
    people_json TEXT,
    research_json TEXT,
    researched_at TEXT,
    research_status TEXT,
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  // One prospect = one person at one company, inside one campaign.
  // stage: found | researched | contact_found | verified | written | queued |
  //        sent | replied | interested | meeting | won | lost |
  //        unsubscribed | bounced | skipped | failed
  await q(`CREATE TABLE IF NOT EXISTS prospects (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    segment_id TEXT,
    company_id TEXT,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT,
    title TEXT,
    linkedin_url TEXT,
    email TEXT,
    email_status TEXT,
    email_source TEXT,
    verify_json TEXT,
    fit_score INTEGER,
    fit_reason TEXT,
    language TEXT,
    stage TEXT NOT NULL DEFAULT 'found',
    stage_reason TEXT,
    email_json TEXT,
    instantly_lead_id TEXT,
    mailbox_email TEXT,
    interest TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_action_at TEXT,
    queued_at TEXT,
    sent_at TEXT,
    replied_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_prospects_campaign_stage ON prospects(campaign_id, stage)`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email)`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_prospects_company ON prospects(company_id)`);

  /* -------------------------------- inbox -------------------------------- */
  // status: open | needs_human | handled | closed
  await q(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    instantly_thread_id TEXT UNIQUE,
    prospect_id TEXT,
    campaign_id TEXT,
    lead_email TEXT,
    lead_name TEXT,
    company TEXT,
    eaccount TEXT,
    subject TEXT,
    last_message_at TEXT,
    last_direction TEXT,
    last_preview TEXT,
    unread INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    classification TEXT,
    ai_paused INTEGER NOT NULL DEFAULT 0,
    auto_replies INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_threads_last ON threads(last_message_at)`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_threads_lead ON threads(lead_email)`);

  // direction: in | out. ai_status (inbound): pending | classified | scheduled |
  // replied | drafted | skipped | needs_human | failed
  await q(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    instantly_id TEXT UNIQUE,
    thread_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    eaccount TEXT,
    from_email TEXT,
    to_email TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    preview TEXT,
    sent_at TEXT,
    is_auto_reply INTEGER NOT NULL DEFAULT 0,
    step TEXT,
    classification TEXT,
    confidence REAL,
    ai_summary TEXT,
    ai_status TEXT,
    ai_reason TEXT,
    ai_draft TEXT,
    reply_due_at TEXT,
    sent_by TEXT,
    created_at TEXT NOT NULL
  )`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sent_at)`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_messages_ai ON messages(ai_status, reply_due_at)`);

  /* ------------------------------ shared ------------------------------ */
  await q(`CREATE TABLE IF NOT EXISTS email_verifications (
    email TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    source TEXT,
    detail_json TEXT,
    checked_at TEXT NOT NULL
  )`);

  await q(`CREATE TABLE IF NOT EXISTS llm_usage (
    day TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider, model)
  )`);

  // Human-readable activity feed: what the agent did and why.
  await q(`CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    ref_type TEXT,
    ref_id TEXT,
    campaign_id TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at)`);
}
