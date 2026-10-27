// Inbox tests: every connected mailbox sends one realistic email a day to each
// test inbox (seed). We then look in the seed: inbox, other tab, spam, or
// never arrived. Seeds never open, reply or move anything — no fake
// engagement — so the result stays an honest picture of the filters.
import { q, nowIso } from "../../db";
import { parseJson, todayUtc, uid } from "../events";
import { getAgentSettings } from "../agent-settings";
import { localParts, zonedTime, randomBetween } from "../schedule";
import { decryptSecret, randomToken } from "./crypto";
import { withAccess } from "./access";
import { imapFind } from "./imap";
import { isEngineError, type FoundMessage } from "./types";
import type { PlacementSummary } from "../mailboxes/policy";

/** Tests go out in Gulf business hours. */
const TEST_TZ = "Asia/Riyadh";
const TEST_HOURS: [number, number] = [9, 16];
/** Minutes after sending to look for it: found -> final; not found after the last look = missing. */
const CHECK_AFTER_MIN = [10, 30, 120];
export const BUSINESS_SEEDS = new Set(["workspace", "m365"]);
const PASS = new Set(["inbox", "other_tab", "other"]);

let clock = () => new Date();
export function setPlacementClock(fn: (() => Date) | null) {
  clock = fn || (() => new Date());
}

function testTime(now: Date): Date {
  const p = localParts(now, TEST_TZ);
  const start = zonedTime(p.year, p.month, p.day, TEST_HOURS[0], 0, TEST_TZ).getTime();
  const end = zonedTime(p.year, p.month, p.day, TEST_HOURS[1], 0, TEST_TZ).getTime();
  const t = now.getTime();
  if (t < start) return new Date(randomBetween(start, end));
  if (t < end) return new Date(randomBetween(t, end));
  return new Date(randomBetween(t, t + 30 * 60_000)); // late joiners still get today's data
}

const SAMPLES = [
  { company: "Al Noor Trading", first: "Khalid", hook: "opened a second warehouse in Dammam this year" },
  { company: "Gulf Star Logistics", first: "Sara", hook: "added cold-chain trucks to the fleet" },
  { company: "Rawabi Contracting", first: "Omar", hook: "is running three sites at once in Riyadh" },
  { company: "Sahara Foods", first: "Lina", hook: "started supplying two new supermarket chains" },
];

/** A realistic first email: a recent one the agent wrote, else a built-in sample in the same style. */
async function testContent(): Promise<{ subject: string; body: string }> {
  try {
    const rows = await q(`SELECT email_json FROM prospects WHERE email_json IS NOT NULL ORDER BY written_at DESC LIMIT 15`);
    const pick = rows[Math.floor(Math.random() * rows.length)];
    const e = parseJson<any>(pick?.email_json, null);
    const s = e?.steps?.[0];
    if (s?.subject && s?.body) return { subject: String(s.subject), body: String(s.body) };
  } catch {
    /* campaigns not migrated */
  }
  const a = await getAgentSettings().catch(() => null);
  const x = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
  const product = a?.companyName || "DNA ERP";
  const sign = a?.signature?.trim() || [a?.senderName, product].filter(Boolean).join("\n") || product;
  return {
    subject: `${x.company.split(" ").slice(-1)[0]} and month-end`,
    body: `Hi ${x.first},\n\nI saw ${x.company} ${x.hook}. At that stage stock, invoicing and VAT often start living in different places, and month-end takes longer every quarter.\n\n${product} keeps inventory, sales and VAT-ready accounting in one system, built for Gulf companies at exactly that point.\n\nWorth a short call next week to see if it fits?\n\n${sign}`,
  };
}

/** Create today's tests that don't exist yet. Returns how many were added. */
export async function planTests(): Promise<number> {
  const now = clock();
  const day = todayUtc(now);
  const mailboxes = await q(
    `SELECT id, email, domain FROM mailboxes WHERE provider IN ('google','microsoft') AND COALESCE(auth_status,'ok') = 'ok' AND missing_since IS NULL AND stage <> 'paused'`
  );
  const seeds = await q(`SELECT id, email FROM seed_inboxes WHERE enabled = 1 AND status = 'ok'`);
  if (!mailboxes.length || !seeds.length) return 0;
  const have = new Set((await q(`SELECT mailbox_id, seed_id FROM placement_tests WHERE day = ?`, [day])).map((r) => `${r.mailbox_id}|${r.seed_id}`));
  let added = 0;
  for (const mb of mailboxes) {
    for (const s of seeds) {
      if (have.has(`${mb.id}|${s.id}`)) continue;
      if (String(s.email).split("@")[1] === String(mb.domain)) continue;
      const at = testTime(now).toISOString();
      const id = uid();
      const created = await q(
        `INSERT INTO placement_tests (id, mailbox_id, seed_id, day, scheduled_for, result, created_at) VALUES (?,?,?,?,?,'pending',?)
         ON CONFLICT (mailbox_id, seed_id, day) DO NOTHING RETURNING id`,
        [id, mb.id, s.id, day, at, nowIso()]
      );
      if (!created.length) continue;
      const c = await testContent();
      const outboxId = uid();
      await q(
        `INSERT INTO outbox (id, kind, test_id, mailbox_id, to_email, subject, body_text, unsub_token, scheduled_for, status, created_at, updated_at)
         VALUES (?,'test',?,?,?,?,?,?,?,'scheduled',?,?)`,
        [outboxId, id, mb.id, s.email, c.subject, c.body, randomToken(16), at, nowIso(), nowIso()]
      );
      await q(`UPDATE placement_tests SET outbox_id = ? WHERE id = ?`, [outboxId, id]);
      added++;
    }
  }
  return added;
}

/** The queue calls this after a test email went out. */
export async function testSent(testId: string, messageId: string, at: string) {
  await q(`UPDATE placement_tests SET sent_at = ?, message_id = ?, next_check_at = ? WHERE id = ?`, [at, messageId, new Date(Date.parse(at) + CHECK_AFTER_MIN[0] * 60_000).toISOString(), testId]);
}

export async function testFailed(testId: string, error: string) {
  await q(`UPDATE placement_tests SET result = 'failed', error = ?, checked_at = ? WHERE id = ?`, [error.slice(0, 300), nowIso(), testId]);
}

async function findInSeed(seed: any, messageId: string): Promise<FoundMessage> {
  if (seed.access === "imap") {
    return imapFind({ host: seed.imap_host, port: Number(seed.imap_port) || 993, user: seed.imap_user || seed.email, pass: await decryptSecret(seed.imap_pass_enc) }, messageId);
  }
  return withAccess({ table: "seed_inboxes", id: seed.id }, (a, p) => p.findByMessageId(a, messageId));
}

/** Look for sent tests in their seeds. Returns how many reached a final result. */
export async function checkDue(): Promise<number> {
  const now = clock();
  const due = await q(
    `SELECT t.*, s.access, s.email AS seed_email, s.imap_host, s.imap_port, s.imap_user, s.imap_pass_enc, s.status AS seed_status
       FROM placement_tests t JOIN seed_inboxes s ON s.id = t.seed_id
      WHERE t.result = 'pending' AND t.sent_at IS NOT NULL AND t.next_check_at <= ? ORDER BY t.next_check_at LIMIT 25`,
    [now.toISOString()]
  );
  let final = 0;
  for (const t of due) {
    const checks = Number(t.checks || 0) + 1;
    try {
      const f = await findInSeed({ ...t, id: t.seed_id }, String(t.message_id));
      if (f.found) {
        const result = f.folder === "spam" ? "spam" : f.folder === "other_tab" ? "other_tab" : f.folder === "inbox" ? "inbox" : "other";
        await q(`UPDATE placement_tests SET result = ?, folder = ?, seed_ref = ?, checks = ?, checked_at = ?, error = NULL WHERE id = ?`, [result, f.folder, f.ref, checks, now.toISOString(), t.id]);
        final++;
      } else if (checks >= CHECK_AFTER_MIN.length) {
        await q(`UPDATE placement_tests SET result = 'missing', checks = ?, checked_at = ? WHERE id = ?`, [checks, now.toISOString(), t.id]);
        final++;
      } else {
        await q(`UPDATE placement_tests SET checks = ?, next_check_at = ? WHERE id = ?`, [checks, new Date(Date.parse(t.sent_at) + CHECK_AFTER_MIN[checks] * 60_000).toISOString(), t.id]);
      }
      await q(`UPDATE seed_inboxes SET last_checked_at = ? WHERE id = ?`, [now.toISOString(), t.seed_id]);
    } catch (e) {
      const msg = isEngineError(e) ? e.message : String((e as any)?.message || e);
      if (checks >= 5 || (isEngineError(e) && e.code === "auth")) await testFailed(t.id, `Couldn't look in ${t.seed_email}: ${msg}`);
      else await q(`UPDATE placement_tests SET checks = ?, next_check_at = ?, error = ? WHERE id = ?`, [checks, new Date(now.getTime() + 10 * 60_000).toISOString(), msg.slice(0, 300), t.id]);
    }
  }
  return final;
}

/** Move week-old test emails to the seed's trash, so seeds stay clean. */
export async function cleanupTests(): Promise<number> {
  const old = new Date(clock().getTime() - 7 * 86_400_000).toISOString();
  const rows = await q(
    `SELECT t.id, t.seed_id, t.seed_ref FROM placement_tests t JOIN seed_inboxes s ON s.id = t.seed_id
      WHERE t.seed_ref IS NOT NULL AND t.trashed = 0 AND t.created_at < ? AND s.access <> 'imap' AND s.status = 'ok' LIMIT 20`,
    [old]
  );
  let n = 0;
  for (const r of rows) {
    try {
      await withAccess({ table: "seed_inboxes", id: r.seed_id }, (a, p) => p.trash(a, String(r.seed_ref)));
    } catch {
      /* already gone, or the seed is unreachable: don't retry forever */
    }
    await q(`UPDATE placement_tests SET trashed = 1 WHERE id = ?`, [r.id]);
    n++;
  }
  return n;
}

/* --------------------------------- results --------------------------------- */

const addDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function placementSummaries(today: string, mailboxId?: string): Promise<Map<string, PlacementSummary>> {
  const from = addDay(today, -6);
  const rows = await q(
    `SELECT t.mailbox_id, t.day, t.result, t.checked_at, s.provider FROM placement_tests t JOIN seed_inboxes s ON s.id = t.seed_id
      WHERE t.day >= ? AND t.result NOT IN ('pending','failed') ${mailboxId ? "AND t.mailbox_id = ?" : ""} ORDER BY t.checked_at`,
    mailboxId ? [from, mailboxId] : [from]
  );
  const out = new Map<string, PlacementSummary>();
  const from3 = addDay(today, -2);
  const by = new Map<string, any[]>();
  for (const r of rows) by.set(String(r.mailbox_id), [...(by.get(String(r.mailbox_id)) || []), r]);
  for (const [id, list] of by) {
    let w3 = 0;
    let p3 = 0;
    let tests3 = 0;
    let pass3 = 0;
    const days: PlacementSummary["byDay"] = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDay(today, -i);
      const mine = list.filter((r) => r.day === d);
      let w = 0;
      let p = 0;
      for (const r of mine) {
        const wt = BUSINESS_SEEDS.has(String(r.provider)) ? 2 : 1;
        w += wt;
        if (PASS.has(String(r.result))) p += wt;
      }
      days.push({
        day: d,
        tests: mine.length,
        pass: mine.filter((r) => PASS.has(String(r.result))).length,
        spam: mine.filter((r) => r.result === "spam").length,
        missing: mine.filter((r) => r.result === "missing").length,
        rate: w ? Math.round((p / w) * 1000) / 10 : null,
      });
      if (d >= from3) {
        w3 += w;
        p3 += p;
        tests3 += mine.length;
        pass3 += mine.filter((r) => PASS.has(String(r.result))).length;
      }
    }
    const m365 = list.filter((r) => r.provider === "m365").sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)));
    out.set(id, {
      tests3d: tests3,
      pass3d: pass3,
      rate3d: w3 ? Math.round((p3 / w3) * 1000) / 10 : null,
      m365Last: m365.slice(0, 3).map((r) => String(r.result)),
      byDay: days,
      lastAt: list.length ? String(list[list.length - 1].checked_at || "") || null : null,
    });
  }
  return out;
}

/** Grid for the screen: mailbox × seed × day. */
export async function placementGrid(days = 7, mailboxId?: string) {
  const today = todayUtc(clock());
  const from = addDay(today, -(days - 1));
  const seeds = await q(`SELECT id, email, provider, enabled, status FROM seed_inboxes ORDER BY created_at`);
  const tests = await q(
    `SELECT id, mailbox_id, seed_id, day, result, folder, scheduled_for, sent_at, checked_at, error FROM placement_tests WHERE day >= ? ${mailboxId ? "AND mailbox_id = ?" : ""} ORDER BY day`,
    mailboxId ? [from, mailboxId] : [from]
  );
  return {
    days: Array.from({ length: days }, (_, i) => addDay(today, i - (days - 1))),
    seeds: seeds.map((s) => ({ id: String(s.id), email: String(s.email), provider: String(s.provider), enabled: Number(s.enabled) === 1, status: String(s.status) })),
    tests: tests.map((t) => ({
      id: String(t.id),
      mailboxId: String(t.mailbox_id),
      seedId: String(t.seed_id),
      day: String(t.day),
      result: String(t.result),
      folder: t.folder || null,
      scheduledFor: t.scheduled_for || null,
      sentAt: t.sent_at || null,
      checkedAt: t.checked_at || null,
      error: t.error || null,
    })),
  };
}

/** "Run a test now" for one mailbox: today's missing tests are created to go out in the next minutes. */
export async function runTestsNow(mailboxId: string): Promise<number> {
  const day = todayUtc(clock());
  const pending = await q(`SELECT id, outbox_id FROM placement_tests WHERE mailbox_id = ? AND day = ? AND result = 'pending' AND sent_at IS NULL`, [mailboxId, day]);
  const soon = new Date(clock().getTime() + 30_000).toISOString();
  for (const t of pending) {
    await q(`UPDATE placement_tests SET scheduled_for = ? WHERE id = ?`, [soon, t.id]);
    if (t.outbox_id) await q(`UPDATE outbox SET scheduled_for = ? WHERE id = ? AND status = 'scheduled'`, [soon, t.outbox_id]);
  }
  const added = await planTests();
  if (added) {
    await q(`UPDATE outbox SET scheduled_for = ? WHERE kind = 'test' AND mailbox_id = ? AND status = 'scheduled' AND scheduled_for > ?`, [soon, mailboxId, soon]);
  }
  return pending.length + added;
}
