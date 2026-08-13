// The send pipeline — one implementation, used by the manual Send screen AND by
// the automation. Domain rotation, daily caps, pacing, unsubscribe/tracking
// links and the sends ledger all live here.

import { q, getSetting, nowIso } from "./db";
import { log, type Job } from "./jobs";
import { sendEmail, getResendKey } from "./resend";
import { renderTemplate, wrapHtml } from "./template";

const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(s: string) { return EMAIL_RE.test(String(s || "").trim()); }

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
  if (/[",:;<>@\\]/.test(name)) name = `"${name.replace(/["\\]/g, "").trim()}"`;
  return { from: `${name} <${email}>` };
}

// Send `templateIds` to `contactIds`, pacing at `perMinute`.
// More than one template = they rotate per recipient, which varies the content
// of a batch (better for deliverability than 500 identical emails).
export async function runSendJob(job: Job, templateIds: string[], contactIds: string[], perMinute: number) {
  const ids = [...new Set(templateIds.filter(Boolean))];
  const tpls: any[] = [];
  for (const tid of ids) {
    const t = (await q(`SELECT * FROM templates WHERE id=?`, [tid]))[0];
    if (t) tpls.push(t);
  }
  if (!tpls.length) { job.status = "error"; job.error = "template not found"; return; }
  if (tpls.length > 1) log(job, { level: "info", msg: `Rotating ${tpls.length} templates across recipients.` });

  const activeDomains = await q(`SELECT * FROM domains WHERE active=1 ORDER BY created_at`);
  const appUrl = ((await getSetting("app_url")) || process.env.APP_URL || "").replace(/\/+$/, "");
  const replyTo = (await getSetting("reply_to")) || "";
  const dryRun = !(await getResendKey());
  if (dryRun) log(job, { level: "warn", msg: "No Resend key set — running in DRY-RUN (nothing is actually sent)." });

  // Validate each active domain's sender up front so a misconfigured "From email"
  // gives a clear, actionable error instead of a cryptic Resend rejection per email.
  const domains: any[] = [];
  for (const d of activeDomains) {
    const r = buildFrom(d);
    if ("error" in r) log(job, { level: "warn", msg: r.error });
    else { d.__from = r.from; domains.push(d); }
  }
  if (!dryRun && activeDomains.length && !domains.length) {
    job.status = "error";
    job.error = "Every active sending domain has an invalid \"From email\". Fix it in Settings → Sending domains (use a full address like outreach@yourdomain.com), then try again.";
    log(job, { level: "fail", msg: job.error });
    return;
  }
  if (!activeDomains.length) log(job, { level: "warn", msg: "No sending domains configured — using Resend's test sender (onboarding@resend.dev)." });
  if (!dryRun && !appUrl) log(job, { level: "warn", msg: "App URL not set in Settings — unsubscribe & open-tracking links will not work. Add it before real sends." });

  const delayMs = dryRun ? 120 : Math.round(60000 / perMinute);
  let di = 0;
  let ti = 0;

  for (const cid of contactIds) {
    if (job.status === "error") break;
    const contact = (await q(`SELECT * FROM contacts WHERE id=?`, [cid]))[0];
    if (!contact) { job.result.skipped++; job.processed++; continue; }
    if (contact.status === "unsubscribed" || contact.status === "bounced") {
      job.result.skipped++;
      job.processed++;
      job.progress = job.total ? job.processed / job.total : 1;
      log(job, { level: "skip", msg: `Skipped ${contact.email} (${contact.status})` });
      continue;
    }

    let domain: any = null;
    if (domains.length) {
      for (let k = 0; k < domains.length; k++) {
        const cand = domains[(di + k) % domains.length];
        if (cand.sent_today < cand.daily_cap) { domain = cand; di = (di + k + 1) % domains.length; break; }
      }
      if (!domain) { log(job, { level: "warn", msg: "All domains hit their daily cap — stopping." }); break; }
    }

    const tpl = tpls[ti % tpls.length];
    ti++;
    const from = domain ? domain.__from : "DNA Outreach <onboarding@resend.dev>";
    const subject = renderTemplate(tpl.subject, contact);
    const sendId = uid();
    const unsub = appUrl ? `${appUrl}/api/unsubscribe?c=${contact.id}` : "";
    const pixel = appUrl ? `${appUrl}/api/open?s=${sendId}` : "";
    const clickBase = appUrl ? `${appUrl}/api/click?s=${sendId}` : "";
    const html = wrapHtml(renderTemplate(tpl.body, contact), unsub, pixel, clickBase);

    const result = await sendEmail({
      from, to: contact.email, subject, html,
      replyTo: replyTo || undefined,
      headers: unsub
        ? { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
        : undefined,
    });

    const status = result.ok ? (result.dryRun ? "sent (dry-run)" : "sent") : "failed";
    await q(
      `INSERT INTO sends (id,contact_id,contact_email,template_id,domain_id,subject,status,error,sent_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sendId, contact.id, contact.email, tpl.id, domain?.id ?? null, subject, status, result.error ?? null, nowIso(), nowIso()]
    );

    if (result.ok) {
      job.result.sent++;
      await q(`UPDATE contacts SET status='sent' WHERE id=? AND status='new'`, [contact.id]);
      if (domain) { await q(`UPDATE domains SET sent_today = sent_today + 1 WHERE id=?`, [domain.id]); domain.sent_today++; }
      log(job, { level: "sent", msg: `${status} → ${contact.email}` });
    } else {
      job.result.failed++;
      log(job, { level: "fail", msg: `failed → ${contact.email}: ${result.error}` });
    }

    job.processed++;
    job.progress = job.total ? job.processed / job.total : 1;
    if (job.processed < job.total) await sleep(delayMs);
  }
}
