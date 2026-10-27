// Own sending engine — tables and columns. Idempotent; runs at mount.
//
//   mail_connections  OAuth apps (Google / Microsoft) the mailboxes sign in through
//   outbox            every email we send: campaign steps, replies, inbox tests
//   seed_inboxes      test inboxes we own, used to see where our mail lands
//   placement_tests   one test email: mailbox -> seed, and where it landed
//   oauth_states      short-lived sign-in states (the callback is public)
import { q } from "../../db";

const tryQ = async (sql: string) => {
  try {
    await q(sql);
  } catch {
    /* already there */
  }
};

let done: Promise<void> | null = null;

export function ensureEngineSchema(): Promise<void> {
  if (!done) done = run().catch((e) => {
    done = null;
    throw e;
  });
  return done;
}

async function run() {
  await q(`CREATE TABLE IF NOT EXISTS mail_connections (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  await q(`CREATE TABLE IF NOT EXISTS seed_inboxes (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    provider TEXT NOT NULL,
    access TEXT NOT NULL,
    connection_id TEXT,
    token_enc TEXT,
    imap_host TEXT,
    imap_port INTEGER,
    imap_user TEXT,
    imap_pass_enc TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ok',
    last_error TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  await q(`CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    campaign_id TEXT,
    prospect_id TEXT,
    thread_id TEXT,
    test_id TEXT,
    mailbox_id TEXT,
    step INTEGER,
    to_email TEXT NOT NULL,
    to_name TEXT,
    subject TEXT,
    body_text TEXT,
    message_id TEXT,
    in_reply_to TEXT,
    references_hdr TEXT,
    provider_message_id TEXT,
    provider_thread_id TEXT,
    unsub_token TEXT,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    status_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // A campaign step can exist only once per lead (cancelled / soft-bounced rows don't count).
  await tryQ(`CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_step ON outbox(prospect_id, step) WHERE kind = 'campaign' AND status NOT IN ('cancelled','soft_bounced')`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, scheduled_for)`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_outbox_mailbox ON outbox(mailbox_id, sent_at)`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_outbox_msgid ON outbox(message_id)`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_outbox_prospect ON outbox(prospect_id)`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_outbox_unsub ON outbox(unsub_token)`);

  await q(`CREATE TABLE IF NOT EXISTS placement_tests (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    seed_id TEXT NOT NULL,
    outbox_id TEXT,
    message_id TEXT,
    day TEXT NOT NULL,
    scheduled_for TEXT,
    sent_at TEXT,
    checks INTEGER NOT NULL DEFAULT 0,
    next_check_at TEXT,
    result TEXT NOT NULL DEFAULT 'pending',
    folder TEXT,
    seed_ref TEXT,
    trashed INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (mailbox_id, seed_id, day)
  )`);
  await tryQ(`CREATE INDEX IF NOT EXISTS idx_placement_due ON placement_tests(result, next_check_at)`);

  await q(`CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  // Mailboxes: own-engine fields (Instantly-synced rows keep provider = 'instantly').
  for (const sql of [
    "ALTER TABLE mailboxes ADD COLUMN provider TEXT NOT NULL DEFAULT 'instantly'",
    "ALTER TABLE mailboxes ADD COLUMN connection_id TEXT",
    "ALTER TABLE mailboxes ADD COLUMN token_enc TEXT",
    "ALTER TABLE mailboxes ADD COLUMN auth_status TEXT",
    "ALTER TABLE mailboxes ADD COLUMN auth_error TEXT",
    "ALTER TABLE mailboxes ADD COLUMN read_cursor TEXT",
    "ALTER TABLE mailboxes ADD COLUMN last_read_at TEXT",
    "ALTER TABLE mailboxes ADD COLUMN warmup_mode TEXT NOT NULL DEFAULT 'off'",
    "ALTER TABLE mailboxes ADD COLUMN experiment_group TEXT",
    "ALTER TABLE mailboxes ADD COLUMN domain_registered_at TEXT",
    "ALTER TABLE mailboxes ADD COLUMN domain_checked_at TEXT",
    "ALTER TABLE mailboxes ADD COLUMN sender_name TEXT",
    "ALTER TABLE mailboxes ADD COLUMN connected_at TEXT",
    "ALTER TABLE mailboxes ADD COLUMN last_send_at TEXT",
    "ALTER TABLE mailboxes ADD COLUMN next_send_at TEXT",
    "ALTER TABLE mailboxes ADD COLUMN target_custom INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE mailboxes ADD COLUMN missing_since TEXT",
  ]) {
    await tryQ(sql);
  }

  // Inbox threads / messages: who sent it and the RFC Message-ID (threading).
  await tryQ("ALTER TABLE messages ADD COLUMN message_id_header TEXT");
  await tryQ("ALTER TABLE threads ADD COLUMN mailbox_id TEXT");
  await tryQ("CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id_header)");

  // Campaigns: which engine sends new leads.
  await tryQ("ALTER TABLE campaigns ADD COLUMN engine TEXT NOT NULL DEFAULT 'instantly'");
}
