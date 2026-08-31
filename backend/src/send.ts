// The send pipeline — one implementation, used by the manual Send screen AND by
// the automation. Domain rotation, daily caps, pacing, unsubscribe/tracking
// links and the sends ledger all live here.

import { q, getSetting, setSetting, nowIso, startOfDayIso } from "./db";
import { log, type Job } from "./jobs";
import { sendEmail, getResendKey } from "./resend";
import { renderTemplate, wrapHtml } from "./template";

const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(s: string) {
  return EMAIL_RE.test(String(s || "").trim());
}

// Build an RFC-5322-safe "Name <email>" sender from a domain row.
// Returns { from } on success or { error } with a clear, actionable message.
export function buildFrom(domain: any): { from: string } | { error: string } {
  const email = String(domain?.from_email || "").trim();
  if (!isEmail(email)) {
    return {
      error:
        `Sending domain "${domain?.domain || "?"}" has an invalid "From email" (${email ? `"${email}"` : "empty"}). ` +
        `It must be a full address like outreach@yourdomain.com. Fix it in Settings → Sending domains.`,
    };
  }

  let name = String(domain?.from_name || "").trim();
  if (!name) return { from: email };

  // Quote the display name when it contains characters that would break the header.
  if (/[",:;<>@\\]/.test(name)) {
    name = `"${name.replace(/["\\]/g, "").trim()}"`;
  }

  return { from: `${name} <${email}>` };
}

/* ------------------------- per-domain daily usage ------------------------ */
// Daily usage is COUNTED FROM THE SENDS LEDGER, not held in a counter column.
//
// `domains.sent_today` used to be that counter, and nothing ever reset it — the
// only thing that could was a human pressing "Reset daily counts" in Settings.
// So every daily cap silently behaved as a lifetime cap, and once the domains
// filled up the sender aborted every batch with "All domains hit their daily
// cap" and never recovered by itself. A COUNT over rows we already write cannot
// drift like that: it rolls over at midnight UTC on its own, it is unaffected by
// restarts or crashes mid-batch, and it stays right if sends are backfilled.

/**
 * Manual-reset marker. "Reset daily counts" has no counter left to zero, so it
 * moves the start of the counting window to now instead — same visible effect,
 * still nothing that can drift out of sync with reality.
 */
const CAP_EPOCH_KEY = "domain_cap_epoch";

/** Start of the window caps are measured over: midnight UTC, or a later manual reset. */
export async function capWindowStart(): Promise<string> {
  const dayStart = startOfDayIso();
  const epoch = (await getSetting(CAP_EPOCH_KEY)) || "";

  // Both are ISO-8601 UTC, so lexicographic order is chronological order.
  return epoch > dayStart ? epoch : dayStart;
}

/** "Reset daily counts" — start counting this window again from right now. */
export async function resetDomainUsage(): Promise<void> {
  await setSetting(CAP_EPOCH_KEY, nowIso());
}

/**
 * How many emails each domain has actually delivered in the current window,
 * keyed by domain id.
 *
 * Only `status = 'sent'` counts: a dry run delivered nothing and a failure never
 * left the building, so neither should burn a domain's daily allowance.
 */
export async function domainUsageToday(): Promise<Map<string, number>> {
  const rows = await q(
    `SELECT domain_id, CAST(COUNT(*) AS INTEGER) AS n
       FROM sends
      WHERE status = 'sent' AND domain_id IS NOT NULL AND sent_at >= ?
      GROUP BY domain_id`,
    [await capWindowStart()]
  );

  const used = new Map<string, number>();
  for (const r of rows) {
    used.set(String(r.domain_id), Number(r.n) || 0);
  }

  return used;
}

/* ---------------------------- rotation cursor ---------------------------- */

/**
 * Id of the domain that sent last.
 *
 * The cursor used to be a local variable, so it restarted at the first domain on
 * every job and after every deploy. A single big batch still interleaved, but
 * this app mostly sends small frequent batches — automation ticks, follow-up
 * passes, one-offs — and every one of those began at domain #1 again, so #1
 * soaked up most of the volume while the last domain in the list barely sent.
 * Parking the cursor in settings makes the rotation continuous across jobs,
 * processes and restarts.
 */
const ROTATION_KEY = "send_rotation_last_domain";

/** One sender in the rotation: a configured domain, or Resend's test sender. */
export interface SendSlot {
  /** `domains.id`, or null for Resend's shared test sender. */
  id: string | null;
  /** Human label for the job log. */
  label: string;
  /** RFC-5322 "Name <email>". */
  from: string;
  /** Daily ceiling. `Infinity` = uncapped. */
  cap: number;
  /** Delivered so far in the current window. */
  used: number;
  /** Epoch ms this slot may send again — its own private clock (see pacing). */
  nextAt: number;
}

/* -------------------- sending capacity (one definition) ------------------ */
//
// THE SENDER'S VIEW OF ITSELF, BUILT ONCE AND READ TWICE.
//
// The automation used to decide how many leads to approve without ever asking
// whether those emails could actually leave the building. So once the domains
// had capped out for the day it kept firing: approving 150 leads an hour,
// draining them from the pool, and recording every one of those runs as "done ·
// sent 0". Two ceilings computed in two places will always drift apart — so the
// batch guard and the sender now read the SAME slots through the same code.

/** The senders available right now, exactly as `runSendPlan` will see them. */
export interface SlotPlan {
  slots: SendSlot[];
  /** One message per active domain whose "From email" is unusable. */
  warnings: string[];
  /** Active domains found, valid or not. */
  activeCount: number;
  /** Active domains exist, but not one of them has a usable sender. */
  allInvalid: boolean;
  /** Nothing usable configured — falling back to Resend's shared test sender. */
  usingTestSender: boolean;
}

export async function buildSendSlots(): Promise<SlotPlan> {
  const activeDomains = await q(
    `SELECT * FROM domains WHERE active=1 ORDER BY created_at`
  );
  const usage = await domainUsageToday();
  const slots: SendSlot[] = [];
  const warnings: string[] = [];

  for (const d of activeDomains) {
    const r = buildFrom(d);
    if ("error" in r) {
      warnings.push(r.error);
      continue;
    }

    const cap = Number(d.daily_cap);
    slots.push({
      id: String(d.id),
      label: String(d.domain || d.id),
      from: r.from,
      cap: cap > 0 ? cap : Infinity,
      used: usage.get(String(d.id)) ?? 0,
      nextAt: 0,
    });
  }

  const allInvalid = activeDomains.length > 0 && slots.length === 0;
  const usingTestSender = slots.length === 0;

  // Nothing usable configured: Resend's shared test sender becomes a single
  // uncapped slot, so the scheduling below has exactly one code path.
  if (usingTestSender) {
    slots.push({
      id: null,
      label: "resend.dev (test sender)",
      from: "DNA Outreach <onboarding@resend.dev>",
      cap: Infinity,
      used: 0,
      nextAt: 0,
    });
  }

  return {
    slots,
    warnings,
    activeCount: activeDomains.length,
    allInvalid,
    usingTestSender,
  };
}

/** How much more mail can go out in the current cap window. */
export interface DomainCapacity {
  /** Emails still deliverable today. `Infinity` = at least one uncapped sender. */
  remaining: number;
  /** Why nothing can go out, when `remaining` is 0. */
  reason: string | null;
  /** Per-sender detail, for the log line and the Settings screen. */
  domains: {
    id: string | null;
    label: string;
    cap: number;
    used: number;
    left: number;
  }[];
  usingTestSender: boolean;
}

/**
 * Ask the sender what it can still deliver BEFORE committing a batch to it.
 *
 * Callers use this to size a batch and to refuse to approve one at all when the
 * answer is zero — approving a lead is destructive (it leaves the pool), so it
 * must never happen speculatively.
 */
export async function domainCapacity(): Promise<DomainCapacity> {
  const dryRun = !(await getResendKey());
  const planned = await buildSendSlots();

  // A real send with no usable sender is a hard stop, not a capacity question.
  // Reported here so a batch is never approved into it.
  if (!dryRun && planned.allInvalid) {
    return {
      remaining: 0,
      reason:
        `Every active sending domain has an invalid "From email". ` +
        `Fix it in Settings → Sending domains (use a full address like outreach@yourdomain.com).`,
      domains: [],
      usingTestSender: false,
    };
  }

  const domains = planned.slots.map((s) => ({
    id: s.id,
    label: s.label,
    cap: s.cap,
    used: s.used,
    left: Math.max(0, s.cap - s.used),
  }));

  // Precisely the arithmetic `pick()` performs below, so the guard and the
  // sender can never disagree about whether a batch can go out.
  const remaining = domains.reduce((n, d) => n + d.left, 0);

  return {
    remaining,
    reason:
      remaining > 0
        ? null
        : "Every sending domain has used its daily cap. Caps roll over at midnight UTC, or use Settings → Reset daily counts.",
    domains,
    usingTestSender: planned.usingTestSender,
  };
}

// One line of a batch: who to email, and with which template.
//
// A campaign hands over the same template (or a rotating set) for everyone, but
// a follow-up pass can't — every contact is on a different rung of the ladder,
// so each row carries its OWN template plus the rung it belongs to, which is
// stored on the send so the next pass can read the sequence back.
export interface SendPlanItem {
  contactId: string;
  templateId: string;
  followupStep?: number; // 0 = original email, 1 / 2 = retries
  followupBranch?: string | null; // 'no_open' | 'no_click'
}

/**
 * What a finished (or abandoned) send plan actually did.
 *
 * `unattempted` is the important one: when the sender stops early — every
 * domain capped mid-batch, the template deleted underneath it — the recipients
 * it never reached are named here so the caller can put their pool rows back.
 * Without it those leads are silently consumed by a run that did nothing.
 */
export interface SendPlanOutcome {
  sent: number;
  failed: number;
  skipped: number;
  /** Contact ids the loop never got to. Empty when the plan ran to the end. */
  unattempted: string[];
  /** Why it stopped early — null when the whole plan was worked through. */
  stopped: string | null;
}

// Send `templateIds` to `contactIds`, pacing at `perMinute` per domain.
// More than one template = they rotate per recipient, which varies the content
// of a batch (better for deliverability than 500 identical emails).
export async function runSendJob(
  job: Job,
  templateIds: string[],
  contactIds: string[],
  perMinute: number
): Promise<SendPlanOutcome> {
  const ids = [...new Set(templateIds.filter(Boolean))];

  if (ids.length > 1) {
    log(job, {
      level: "info",
      msg: `Rotating ${ids.length} templates across recipients.`,
    });
  }

  // Rotation is just a plan where the template advances one recipient at a time.
  const plan: SendPlanItem[] = contactIds.map((contactId, i) => ({
    contactId,
    templateId: ids[i % Math.max(1, ids.length)],
  }));

  return runSendPlan(job, plan, perMinute);
}

// The actual sender: domain rotation, daily caps, pacing, tracking links and the
// sends ledger. Everything that emails anyone goes through here.
export async function runSendPlan(
  job: Job,
  plan: SendPlanItem[],
  perMinute: number
): Promise<SendPlanOutcome> {
  if (!job.result) {
    job.result = { sent: 0, failed: 0, skipped: 0 };
  }

  // Bailing out before the first email means NOTHING in the plan was tried —
  // every recipient is unattempted and the caller can recover all of them.
  const abort = (reason: string): SendPlanOutcome => ({
    sent: Number(job.result.sent || 0),
    failed: Number(job.result.failed || 0),
    skipped: Number(job.result.skipped || 0),
    unattempted: plan.map((p) => p.contactId),
    stopped: reason,
  });

  // Load every distinct template the plan references, once.
  const tplById = new Map<string, any>();
  for (const tid of [
    ...new Set(plan.map((p) => p.templateId).filter(Boolean)),
  ]) {
    const t = (await q(`SELECT * FROM templates WHERE id=?`, [tid]))[0];
    if (t) tplById.set(String(tid), t);
  }

  if (!tplById.size) {
    job.status = "error";
    job.error = "template not found";
    return abort(job.error);
  }

  const appUrl = (
    (await getSetting("app_url")) ||
    process.env.APP_URL ||
    ""
  ).replace(/\/+$/, "");
  const replyTo = (await getSetting("reply_to")) || "";
  const dryRun = !(await getResendKey());

  if (dryRun) {
    log(job, {
      level: "warn",
      msg: "No Resend key set — running in DRY-RUN (nothing is actually sent).",
    });
  }

  // Senders come from the shared builder so this and `domainCapacity()` can
  // never disagree. Each slot opens at the usage the ledger reports for the
  // current window; invalid "From email" addresses are reported once, up front,
  // instead of as a cryptic Resend rejection per email.
  const planned = await buildSendSlots();
  for (const warning of planned.warnings) {
    log(job, { level: "warn", msg: warning });
  }

  if (!dryRun && planned.allInvalid) {
    job.status = "error";
    job.error =
      'Every active sending domain has an invalid "From email". Fix it in Settings → Sending domains (use a full address like outreach@yourdomain.com), then try again.';
    log(job, { level: "fail", msg: job.error });
    return abort(job.error);
  }

  if (!planned.activeCount) {
    log(job, {
      level: "warn",
      msg: "No sending domains configured — using Resend's test sender (onboarding@resend.dev).",
    });
  }

  const slots = planned.slots;

  if (!dryRun && !appUrl) {
    log(job, {
      level: "warn",
      msg: "App URL not set in Settings — unsubscribe & open-tracking links will not work. Add it before real sends.",
    });
  }

  // Resume the rotation where the last job left off by rotating the array so the
  // domain AFTER the one that sent last sits at index 0. An unknown id (domain
  // deleted, or a first-ever run) simply starts at the top.
  if (slots.length > 1) {
    const lastId = (await getSetting(ROTATION_KEY)) || "";
    const at = slots.findIndex((s) => s.id === lastId);

    if (at >= 0) {
      slots.push(...slots.splice(0, (at + 1) % slots.length));
    }
  }

  // PACING IS PER DOMAIN. `perMinute` is the rate a SINGLE domain may sustain, so
  // a batch's throughput is perMinute x (domains still under their cap). It used
  // to be one global delay shared by every domain, which meant a second domain
  // spread your reputation but did not send one extra email per minute — half
  // the reason to buy it. Each slot now keeps its own clock.
  const rate = Math.max(1, Number(perMinute) || 1);
  const spacingMs = dryRun ? 120 : Math.round(60000 / rate);

  if (slots.length > 1) {
    const left = slots.reduce(
      (n, s) => n + Math.max(0, s.cap - s.used),
      0
    );

    log(job, {
      level: "info",
      msg:
        `Rotating across ${slots.length} sending domains (resuming at ${slots[0].label}) · ` +
        `${rate}/min each = up to ${rate * slots.length}/min total · ` +
        `${Number.isFinite(left) ? `${left} left in today's caps` : "no daily cap"}.`,
    });
  }

  // Round-robin: of the domains still under their cap, take whichever is free
  // soonest, ties broken by rotation order. Idle slots all read 0, so the first
  // pass walks the list 1-2-3-1-2-3; once they are pacing, "free soonest" keeps
  // them interleaved and automatically routes around any that cap out.
  const pick = (): SendSlot | null => {
    let best: SendSlot | null = null;

    for (const slot of slots) {
      if (slot.used >= slot.cap) continue;
      if (!best || slot.nextAt < best.nextAt) best = slot;
    }

    return best;
  };

  let stopped: string | null = null;
  let stopIndex = plan.length;

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];

    if (job.status === "error") {
      stopped = job.error || "The send job was aborted.";
      stopIndex = i;
      break;
    }

    const cid = item.contactId;
    const contact = (await q(`SELECT * FROM contacts WHERE id=?`, [cid]))[0];

    if (!contact) {
      job.result.skipped++;
      job.processed++;
      continue;
    }

    if (
      contact.status === "unsubscribed" ||
      contact.status === "bounced"
    ) {
      job.result.skipped++;
      job.processed++;
      job.progress = job.total ? job.processed / job.total : 1;

      log(job, {
        level: "skip",
        msg: `Skipped ${contact.email} (${contact.status})`,
      });
      continue;
    }

    const tpl = tplById.get(String(item.templateId));

    // A plan row whose template was deleted mid-batch is skipped, not fatal —
    // the rest of the batch still goes out.
    if (!tpl) {
      job.result.skipped++;
      job.processed++;
      job.progress = job.total ? job.processed / job.total : 1;

      log(job, {
        level: "skip",
        msg: `Skipped ${contact.email} — its template no longer exists.`,
      });
      continue;
    }

    const slot = pick();

    if (!slot) {
      // STOPPING HERE IS NOT "DONE". The recipients below this point were never
      // tried, and their pool rows have already been marked approved — the
      // caller is told exactly who they are so it can put them back.
      stopped =
        "Every sending domain reached its daily cap. Caps clear on their own at midnight UTC, or use Settings → Reset daily counts.";
      stopIndex = i;

      log(job, {
        level: "warn",
        msg: `${stopped} ${plan.length - i} recipient(s) in this batch were not attempted.`,
      });
      break;
    }

    // Wait until THIS domain is allowed to send again. Every other domain is on
    // its own clock, so N domains genuinely drain the batch N times faster.
    const wait = slot.nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    slot.nextAt = Date.now() + spacingMs;

    const from = slot.from;
    const subject = renderTemplate(tpl.subject, contact);
    const sendId = uid();
    const unsub = appUrl
      ? `${appUrl}/api/unsubscribe?c=${contact.id}`
      : "";
    const pixel = appUrl ? `${appUrl}/api/open?s=${sendId}` : "";
    const clickBase = appUrl ? `${appUrl}/api/click?s=${sendId}` : "";
    const html = wrapHtml(
      renderTemplate(tpl.body, contact),
      unsub,
      pixel,
      clickBase
    );

    const result = await sendEmail({
      from,
      to: contact.email,
      subject,
      html,
      replyTo: replyTo || undefined,
      headers: unsub
        ? {
            "List-Unsubscribe": `<${unsub}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined,
    });

    const status = result.ok
      ? result.dryRun
        ? "sent (dry-run)"
        : "sent"
      : "failed";

    await q(
      `INSERT INTO sends (id,contact_id,contact_email,template_id,domain_id,subject,status,error,followup_step,followup_branch,sent_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        sendId,
        contact.id,
        contact.email,
        tpl.id,
        slot.id,
        subject,
        status,
        result.error ?? null,
        Number(item.followupStep || 0),
        item.followupBranch ?? null,
        nowIso(),
        nowIso(),
      ]
    );

    // Advance the cursor on every attempt, not just successes — a domain that
    // just failed should still hand over to the next one rather than be retried
    // first on the following batch.
    if (slot.id) {
      await setSetting(ROTATION_KEY, slot.id);
    }

    // "· retry 1 (no open)" so a follow-up pass reads as a ladder in the log,
    // not as an unexplained second email to the same address.
    const rung = item.followupStep
      ? ` · retry ${item.followupStep}${
          item.followupBranch === "no_click"
            ? " (opened, no click)"
            : " (no open)"
        }`
      : "";

    if (result.ok) {
      job.result.sent++;
      await q(
        `UPDATE contacts SET status='sent' WHERE id=? AND status='new'`,
        [contact.id]
      );

      // Mirror the ledger in memory so the cap is enforced within this batch too.
      // Dry runs deliver nothing, so they must not consume the allowance.
      if (!result.dryRun) slot.used++;

      log(job, {
        level: "sent",
        msg: `${status} → ${contact.email} · via ${slot.label}${rung}`,
      });
    } else {
      job.result.failed++;

      log(job, {
        level: "fail",
        msg: `failed → ${contact.email} · via ${slot.label}: ${result.error}`,
      });
    }

    job.processed++;
    job.progress = job.total ? job.processed / job.total : 1;
  }

  return {
    sent: Number(job.result.sent || 0),
    failed: Number(job.result.failed || 0),
    skipped: Number(job.result.skipped || 0),
    unattempted: stopped
      ? plan.slice(stopIndex).map((p) => p.contactId)
      : [],
    stopped,
  };
}
