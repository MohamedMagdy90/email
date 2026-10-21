// Who must never be emailed. Checked when an address is verified and again
// right before a lead is pushed to Instantly (things change while a lead waits
// in review). Instantly's own block list is the second safety net, not the first.
import { q } from "../../db";
import { getAgentSettings } from "../agent-settings";
import { registrableDomain, hostOf } from "../../crawler/urls";
import { CONTACTED_STAGES, type CampaignSettings } from "./types";

const CONTACT_WINDOW_DAYS = 90;
const HARD_INTEREST = ["complaint", "legal", "unsubscribe"];
const HARD_CLASSES = ["unsubscribe", "complaint", "legal"];

export function domainOf(input: string | null | undefined): string | null {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  try {
    const host = raw.includes("@") ? raw.split("@").pop()! : hostOf(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    const d = registrableDomain(host.replace(/^www\./, ""));
    return d && d.includes(".") ? d : null;
  } catch {
    return null;
  }
}

let ownCache: { at: number; set: Set<string> } | null = null;

/** Our own domains: dna.systems, the agent's website, every sending mailbox domain. */
export async function ownDomains(): Promise<Set<string>> {
  if (ownCache && Date.now() - ownCache.at < 60_000) return ownCache.set;
  const set = new Set<string>(["dna.systems"]);
  try {
    const a = await getAgentSettings();
    const d = domainOf(a.website);
    if (d) set.add(d);
  } catch {
    /* defaults */
  }
  try {
    for (const r of await q(`SELECT email, domain FROM mailboxes`)) {
      const d = domainOf(r.domain || r.email);
      if (d) set.add(d);
    }
  } catch {
    /* mailboxes not migrated */
  }
  ownCache = { at: Date.now(), set };
  return set;
}

/** Why a company domain may not be contacted at all, or null. */
export async function domainBlockReason(domain: string, settings: CampaignSettings): Promise<string | null> {
  const d = domain.toLowerCase();
  if ((await ownDomains()).has(d)) return "That's one of our own domains";
  if (settings.excludeDomains.some((x) => d === x || d.endsWith(`.${x}`))) return "On this campaign's do-not-contact list";
  return null;
}

/** Why this address must not be emailed by this campaign, or null when it's fine. */
export async function suppressionReason(email: string, campaignId: string, prospectId?: string): Promise<string | null> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return "No address";

  // 1. The old Resend console: people who unsubscribed or bounced there.
  try {
    const old = (await q(`SELECT status FROM contacts WHERE lower(email) = ? LIMIT 1`, [e]))[0];
    if (old?.status === "unsubscribed") return "Unsubscribed in the old console";
    if (old?.status === "bounced") return "Bounced in the old console";
  } catch {
    /* no classic tables on this database */
  }

  // 2. Any campaign: opted out, bounced, complained, or already emailed recently.
  const rows = await q(
    `SELECT p.id, p.campaign_id, p.stage, p.interest, p.queued_at, p.sent_at, p.updated_at, c.name AS campaign_name
       FROM prospects p LEFT JOIN campaigns c ON c.id = p.campaign_id
      WHERE lower(p.email) = ?`,
    [e]
  );
  const cutoff = new Date(Date.now() - CONTACT_WINDOW_DAYS * 86400000).toISOString();
  for (const r of rows) {
    if (prospectId && r.id === prospectId) continue;
    if (r.stage === "unsubscribed") return "Unsubscribed from an earlier campaign";
    if (r.stage === "bounced") return "Bounced in an earlier campaign";
    if (HARD_INTEREST.includes(String(r.interest || ""))) return `Marked "${r.interest}" in an earlier conversation`;
  }
  for (const r of rows) {
    if (prospectId && r.id === prospectId) continue;
    if (r.campaign_id === campaignId) continue;
    const when = String(r.sent_at || r.queued_at || r.updated_at || "");
    if (CONTACTED_STAGES.includes(r.stage) && when >= cutoff) return `Already contacted by "${r.campaign_name || "another campaign"}" in the last ${CONTACT_WINDOW_DAYS} days`;
  }

  // 3. The inbox: a reply classified as unsubscribe / complaint / legal.
  try {
    const t = (await q(`SELECT classification FROM threads WHERE lower(lead_email) = ? AND classification IN (?, ?, ?) LIMIT 1`, [e, ...HARD_CLASSES]))[0];
    if (t) return `Replied "${t.classification}" in the inbox`;
  } catch {
    /* inbox not migrated */
  }
  return null;
}
