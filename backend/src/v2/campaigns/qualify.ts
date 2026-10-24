// Steps 6-7 — verify the address against the sending policy and the
// suppression rules, then score the fit with AI.
import { verifierConfigured, verifyEmail, type VerifyResult } from "../verify";
import { llm } from "../llm";
import type { SendingPolicy } from "../agent-settings";
import { suppressionReason } from "./suppression";
import { offerText, type Offer, type ResearchJson, type Row } from "./types";
import { describeTargeting, type EffectiveTargeting } from "../targeting/market";

export interface VerifyOutcome {
  verdict: "ok" | "skip" | "hold";
  reason: string;
  result: VerifyResult;
  catchAll: boolean;
}

export async function verifyProspect(p: Row, policy: SendingPolicy): Promise<VerifyOutcome> {
  const email = String(p.email || "").toLowerCase();
  const v = await verifyEmail(email);
  const why = v.reasons.length ? ` (${v.reasons.slice(0, 2).join("; ")})` : "";
  const base = { result: v, catchAll: v.status === "catch_all" };
  if (v.status === "invalid") return { ...base, verdict: "skip", reason: `${email} doesn't exist${why}` };
  if (v.status === "risky") return { ...base, verdict: "skip", reason: `${email} is risky to send to${why}` };
  if (v.checks.role && p.email_source !== "role" && !policy.allowRoleAddresses) return { ...base, verdict: "skip", reason: `${email} is a shared role address, and role addresses are switched off in the Agent settings` };
  if (v.checks.role && p.email_source === "role" && !policy.allowRoleAddresses) return { ...base, verdict: "skip", reason: "Role addresses are switched off in the Agent settings" };
  if (v.status === "unknown") {
    const published = (p.email_source === "published" || p.email_source === "role" || p.email_source === "manual") && v.checks.mx;
    if (!published && !policy.allowUnverifiedGuesses) {
      if (!(await verifierConfigured())) {
        return { ...base, verdict: "hold", reason: `${email} is a guess from the name pattern and can't be checked until the email verifier (No2Bounce) is connected in the Agent tab, or unverified guesses are allowed` };
      }
      // Connected, but it gave no answer this time (credits, token, timeout):
      // wait and ask again rather than dropping the person.
      if (v.source === "builtin") {
        return { ...base, verdict: "hold", reason: `${email} couldn't be checked right now (${v.reasons[v.reasons.length - 1] || "verifier unavailable"}); it is tried again on a later pass` };
      }
      return { ...base, verdict: "skip", reason: `The mail server wouldn't confirm ${email}, and unverified guesses are switched off` };
    }
  }
  const suppressed = await suppressionReason(email, String(p.campaign_id), String(p.id));
  if (suppressed) return { ...base, verdict: "skip", reason: `Not contacting ${email}: ${suppressed}` };
  const label = v.status === "valid" ? "verified" : v.status === "catch_all" ? "accepted (the domain accepts every address)" : "accepted (published on the site)";
  return { ...base, verdict: "ok", reason: `${email} ${label}` };
}

/** AI errors propagate so the pass can stop AI work. */
export async function scoreProspect(p: Row, company: Row, research: ResearchJson, seg: Row | null, offer: Offer | null, eff?: EffectiveTargeting | null): Promise<{ score: number; reason: string }> {
  const target = eff
    ? `Target: ${seg ? `${seg.name}${seg.description ? ` — ${seg.description}` : ""}. ` : ""}${describeTargeting(eff)}`
    : seg
      ? `Target segment: ${seg.name} — ${seg.description || ""} Industries: ${seg.industries_json || "[]"}. Countries: ${seg.countries_json || "[]"}. Size: ${seg.company_size || "any"}.`
      : "";
  const r = await llm<any>({
    tier: "fast",
    json: true,
    task: `campaign:score:${company.domain}`,
    temperature: 0,
    system: "You score how well a company fits a B2B offer and target segment, strictly and honestly. 80+ means a clear fit, 60-79 plausible, below 60 weak or wrong.",
    prompt: [
      "Offer:",
      offerText(offer) || "(cloud ERP for SMEs in the Gulf)",
      target,
      `Company: ${company.name || company.domain} (${company.domain}). ${company.description || ""} Industry: ${company.industry || "unknown"}. Size: ${company.size_hint || "unknown"}. Location: ${[company.city, company.country].filter(Boolean).join(", ") || "unknown"}.`,
      research.hooks.length ? `Facts: ${research.hooks.join("; ")}` : "",
      `Contact: ${p.full_name || "role address"}${p.title ? `, ${p.title}` : ""}.`,
      'Return JSON: {"score": number 0-100, "reason": string (one sentence)}',
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const score = Math.max(0, Math.min(100, Math.round(Number(r.data?.score))));
  if (!Number.isFinite(score)) throw new Error("The AI didn't return a score");
  return { score, reason: String(r.data?.reason || "").trim().slice(0, 300) || "No reason given" };
}
