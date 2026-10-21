# Campaigns — the AI lead engine (workstream C) — BINDING SPEC

Read first: `.same/v2-contracts.md` (safety rules §0, shared foundation §1, design system §2 — all still apply),
`.same/outreach-v2-plan.md` §2 (the pipeline idea), `.same/ref/instantly-api-notes.md` (campaigns, leads,
"Extra details" at the end). The API contract is `frontend/src/lib/v2/campaigns.ts` — types AND routes.
Backend responses must match those types exactly; the screen consumes only that file.

Product idea (Explee workflow): the user gives a website; the agent learns the offer, proposes ideal-customer
segments, then runs on its own: finds companies, researches them, finds the decision maker, finds and verifies
the address, scores the fit, writes a short personal first email + follow-ups, and (after review, by default)
pushes the lead into an Instantly campaign that sends from the warmed mailbox pool. Replies are handled by the
Inbox workstream (already built) — Campaigns never writes threads/messages.

The engine must be useful BEFORE everything is connected: warmup takes 2-3 weeks, so research + writing should
build up a reviewed queue while mailboxes warm. Each stage that cannot run says why (CampaignDetail.blockers).

---------------------------------------------------------------------------
## 1. Ownership
- Backend agent: `backend/src/v2/campaigns/**` only. Shared files READ-ONLY, except small ADDITIVE exports if
  unavoidable (report them). `v2/index.ts` already loads `./campaigns/module` dynamically.
- Frontend agent: `frontend/src/screens/Campaigns.tsx` (+ optional `frontend/src/screens/campaigns/*.tsx`
  sub-components) and `campaigns`-prefixed CSS appended to `frontend/src/index.css` if needed (prefix `cp-`).
  `frontend/src/lib/v2/campaigns.ts` is the contract — do not change shapes; if something is truly missing,
  add an OPTIONAL field and report it.
- Integrator (lead): everything else, final wiring, review, push.

## 2. Backend layout (`backend/src/v2/campaigns/`)
```
AS BUILT (2026-10-21):
types.ts        types, defaults, sanitizers, PROSPECT_SELECT, row -> view mappers, CampaignError
schema.ts       ensureCampaignColumns(): idempotent ALTERs (see §3)
suppression.ts  suppressionReason(email, campaignId, prospectId?), domainBlockReason(), ownDomains(), domainOf()
web.ts          fetchPage() (direct + reader/proxy fallback), pageText(), pickLinks(), titleOf(), detectLanguage()
offer.ts        learnOffer(kind, website) + fallbackOffer()
icp.ts          proposeSegments({kind, offer, count, existing}) + per-kind defaults
discover.ts     addCompany() (shared with manual add) + discoverForSegment() + segmentPlan()
research.ts     researchCompany(company, {ai}) + researchIsFresh() (90-day reuse)
contact.ts      findContact() (person + candidate address), pickPerson(), titleRank()
qualify.ts      verifyProspect() (policy + suppression; hold for verifier) + scoreProspect()
writer.ts       writeEmails() + checkEmails() guardrails + WriterRejected
sender.ts       instantlyPayload(), ensureInstantlyCampaign(), pushApproved(), setInstantlyRunning(), syncCampaign()
service.ts      views, readiness/blockers, CRUD, segments, review actions, runPass(), runNow(), worker
module.ts       register(app) routes under /api/v2/campaigns, start() worker
Test: .same-test/cp-test.ts (gitignored) — 47 checks, in-process against the real app.
```

## 3. Data (tables already exist in v2/schema.ts: campaigns, segments, companies, prospects)
Add idempotently in `ensureCampaignColumns()` (`try { await q("ALTER TABLE ... ADD COLUMN ...") } catch {}`):
- prospects: `written_at TEXT`, `approved_at TEXT`, `stage_changed_at TEXT`, `skipped_from TEXT` (stage it
  left, for restore), `catch_all INTEGER NOT NULL DEFAULT 0`
- companies: `language TEXT` (site language: en | ar | mixed)
- campaigns: `working_at TEXT` (lock/heartbeat), `last_run_at TEXT`
Portable SQL only (SQLite locally, Postgres in prod): `?` placeholders, no `now()`, ISO text timestamps,
booleans 0/1, JSON as TEXT, `ON CONFLICT ... DO UPDATE`, `CAST(count(*) AS INTEGER)`.
`settings_json` holds CampaignSettings (merge with defaults on read), `offer_json` holds Offer,
`stats_json` holds CampaignStats, `email_json` holds ProspectEmails, `verify_json` holds VerifyResult.
companies.research_json holds `{ hooks, people, emailsOnSite, sources, summary? }`; description / size_hint /
phone / linkedin_url / city / country / industry live in their columns.
Prospect = one person at one company in one campaign. Discovery creates the prospect with only company_id
(stage `found`); the person fields are filled by contact.ts. ONE prospect per company per campaign.

## 4. Pipeline rules
Every stage change: set `stage`, `stage_reason` (plain English), `stage_changed_at`, `updated_at`; log
meaningful actions with `logEvent(kind="campaign", message, {campaignId, refType:"prospect", refId})`.
Failures: `attempts++`, `last_error`, `next_action_at` = backoff (15 min, 1 h, 6 h); after 3 attempts -> `failed`.
Never throw out of the worker; catch per prospect.

1. **Offer** — fetch website home + up to 4 pages that look like about/product/features/pricing/industries
   (use `crawler/fetcher.ts` `fetchWithRetry(url, 2, 15000, await getProxyConfig(), await getReaderKey())`,
   `crawler/urls.ts` `extractLinks`/`scoreLink`), strip to text, AI (smart, json) -> Offer. No AI:
   source "fallback" built from `getAgentSettings().knowledgeBase` + companyName + website, plus a `warning`.
   Default website = campaign.website || agent settings website.
2. **Segments** — AI (smart, json) proposes `count` segments from the offer + kind: industries, countries
   (default Gulf: Saudi Arabia, UAE, Qatar, Kuwait, Bahrain, Oman unless the offer says otherwise), size,
   decision-maker titles in priority order, 6-10 concrete web-search queries (e.g. "food distribution company
   Riyadh"), fitScore, why. No AI: deterministic defaults — customer: trading & distribution / manufacturing /
   retail chains / contracting in KSA+UAE+Qatar; partner: accounting & audit firms / IT resellers & VARs /
   ERP consultancies / regional distributors (35% / 15% Makers program). Proposals are inserted as segments
   (enabled = true) and returned.
3. **Discover** (needs an enabled segment) — walk `segments.queries_json` x countries with `segments.cursor`;
   set `exhausted` when done. With Gemini (`aiStatus().canSearch`): `llm({search:true, json:true, tier:"smart"})`
   asking for real companies (name, website) matching the query; else `search.ts` `searchRaw(query, country)`
   (free, rate-limited — expect empty results; that's fine). Normalize to registrable domain
   (`crawler/urls.ts` `registrableDomain`, `hostOf`). Drop: directories/social/junk (`crawler/profiles.ts`
   `isDirectoryHost`, `isProfileHost`, `isJunkHost`), excluded domains, own domains, domains already a
   prospect in THIS campaign. Upsert `companies` by domain (source "gemini" | "search" | "manual"), insert
   prospect stage `found`. Increment `segments.found`.
4. **Research** (budget: settings.researchPerDay) — reuse if `companies.researched_at` < 90 days. Fetch home +
   up to 4 best pages (about / team / leadership / contact / management; Arabic paths too), extract emails
   (`crawler/extract.ts` `extractEmails`, `crawler/validate.ts` `cleanEmail`/`isValidEmail`/`isRole`),
   AI (smart, json) -> name, description (1-2 sentences, factual), industry, size_hint, city, country,
   people [{name, title}], hooks (2-4 SPECIFIC observations usable in an opener: projects, branches, hiring,
   new products, certifications — no generic praise), linkedin company URL if on the page, site language.
   No AI: heuristic (title/meta description, emails, phone) and research_status "partial". Blocked/unreadable
   site: research_status "blocked", still continue (contact step may use search). Stage -> `researched`.
5. **Contact** — choose the decision maker from people by the segment's titles (then owner / founder / CEO /
   managing director / general manager / CFO / finance manager / IT manager / operations director). If none
   and Gemini search is available: llm({search:true}) for `site:linkedin.com/in "<company>" <titles>` style
   question -> {name, title, linkedinUrl} (NEVER fetch linkedin.com). Address: `findEmail({fullName, domain,
   publishedEmail: a published address that matches the person, knownPeopleEmails})`. No person: a published
   role address (info@/sales@) only if `getAgentSettings().sending.allowRoleAddresses`, email_source "role";
   else `skipped` ("No decision maker found"). Stage -> `contact_found`.
6. **Verify** — `verifyEmail(email)`. Policy (`getAgentSettings().sending`): valid -> ok; catch_all -> ok, mark
   `catch_all=1` (the share cap is enforced at push time); unknown -> ok only if `allowUnverifiedGuesses`
   (published addresses with MX count as ok); risky/invalid -> `skipped` with reason. Then
   **suppression** (§5) -> `skipped` with reason. Stage -> `verified`.
7. **Score** — AI (fast, json) 0-100 fit vs segment + offer + research with a one-sentence reason. Threshold =
   settings.minFitScore ?? agent sending.minFitScore. Below -> `skipped` ("Fit 42 is below 60: ...").
   No AI: score null, do not skip (writing waits for AI anyway).
8. **Write** (needs AI) — see §6. Stage -> `written` (`written_at`). If reviewFirst=false, go straight to
   `approved` (`approved_at`).
9. **Push** (only when campaign.status = active, Instantly configured, ≥1 sendable mailbox) — §7.
10. **Sync** — every ~30 min per active campaign: Instantly lead status -> `sent` (when contacted), campaign
    analytics -> stats_json, segment sent counters. Reply outcomes are written by the Inbox workstream
    (prospects.stage replied|interested|meeting|unsubscribed|bounced|lost).

Budgets per pass (worker or /run), per campaign: discover ≤ 10 companies (only while the pre-write backlog
— found..verified — is below 3 x dailyNewLeads), research ≤ 4, contact ≤ 4, verify ≤ 8, score ≤ 6, write ≤ 3,
push up to today's remaining queue limit. `/run` is time-boxed (~60 s) and returns RunResult with notes.
Respect `budgetRemaining()`; on `LlmBudgetExceeded`/`LlmUnavailable` stop AI steps for this pass and add a
note/blocker — never mark prospects failed because AI is missing.

Worker: `start()` -> every 60 s, pick active campaigns round-robin, one at a time (`campaigns.working_at`
lock, stale after 10 min), run a pass. Drafts and paused campaigns are never processed by the worker
(drafts can be run by hand with /run, which never pushes to Instantly). Idempotent start, catches everything.

## 5. Suppression (MUST — never contact these)
`suppressionReason(email, campaignId): Promise<string | null>` checks, lower-cased:
- old console: `contacts.status IN ('unsubscribed','bounced')` for that email (table may not exist -> ignore)
  -> "Unsubscribed in the old console" / "Bounced in the old console"
- any campaign: prospects with that email and stage in (unsubscribed, bounced) or interest in
  (complaint, legal, unsubscribe) -> reason
- another campaign contacted this email in the last 90 days (stage queued/sent/replied/interested/meeting/
  won/lost) -> "Already contacted by <campaign name>"
- inbox: a thread for this email with classification unsubscribe/complaint/legal -> reason
Domain-level: settings.excludeDomains, own domains (dna.systems, registrable domain of agent settings website,
domains of every row in `mailboxes`) -> dropped at discovery.
Re-check suppression right before pushing to Instantly (state can change while a lead waits in review).
Instantly's own block list (filled by the Inbox + legacy unsubscribe) is a second safety net, not the first.

## 6. Writer
Prompt = `voicePrompt(settings)` + offer + company research (description, hooks) + person (name, title) +
segment why + language. Output JSON `{ steps: [{subject, body}] }`, 1 + followUps steps.
Email 1: subject 2-5 words, lower-case-ish, no clickbait; body: greeting with first name, ONE specific
observation from the research, ONE relevant outcome the offer gives a company like theirs, ONE short question
as the call to action; ≤ 90 words (respect tone length); NO links, NO images, NO attachments talk, no
"I hope this email finds you well". Follow-ups: subject "" (keeps the thread), 30-60 words, new angle each
(proof point / quick question / polite close-the-loop), no guilt-tripping. Sign-off: senderName (+ signature
text if set; booking link allowed only in follow-ups). Arabic when language resolves to "ar" (Modern Standard
Arabic, formal, no transliteration).
Guardrails `checkEmails()`: remove links from email 1 (warning); reject placeholders (`[`, `{{`, `<name>`,
"Company Name"); reject "as an AI", "I hope this email finds you well"; reject numbers/claims/discounts not in
offer/knowledge base when obvious (percentages, "x customers"); trim to length; empty/garbled -> retry once,
then `failed` with the reason. Store warnings in ProspectEmails.warnings.

## 7. Instantly push (sender.ts)
- One Instantly campaign per campaign, created lazily on first push: name `"<name> · DNA"`;
  sequences[0].steps: step 1 `{subject:"{{subject_1}}", body:"{{body_1}}", delay: 0}`, step 2
  `{subject:"", body:"{{body_2}}", delay: followUpDelays[0], delay_unit:"days"}`, step 3 similarly with
  `{{body_3}}` (only as many steps as followUps); schedule `{name:"Work hours", timing: sendWindow,
  days: workDaysForCountry(country), timezone: timezoneForCountry(country)}` where country = first segment's
  first country; `email_list` = getSendableMailboxes() emails (import via
  `await import("../mailboxes/service").catch(() => null)`); `daily_limit` = sum of their dailyLimit;
  `text_only: true, first_email_text_only: true, link_tracking: false, open_tracking: false,
  stop_on_reply: true, stop_on_auto_reply: false, stop_for_company: true, insert_unsubscribe_header: true,
  prioritize_new_leads: false, allow_risky_contacts: false, match_lead_esp: false`.
  Save `campaigns.instantly_campaign_id`; activate it when our campaign is active; pause it when paused/archived.
  Each push tick: if the sendable mailbox set changed, `patchCampaign(id, {email_list, daily_limit})`.
- Push = prospects in `approved` (oldest first), re-check suppression, max per day = min(dailyNewLeads,
  capacity) minus already queued today; catch-all leads ≤ maxCatchAllShare of today's pushes.
  `addLeads(id, leads)` (≤1000) with `email, first_name, last_name, company_name, job_title, website,
  custom_variables: { subject_1, body_1, body_2?, body_3? }` (plain text with `\n` -> `<br/>`).
  Map `created_leads` back -> `instantly_lead_id`, stage `queued`, `queued_at`. `in_blocklist`/skipped ->
  stage `skipped` with reason. No sendable mailbox -> leave `approved`, blocker "Waiting for a sending
  mailbox: mailboxes are still warming up."
- InstantlyError: keep the prospects approved, set campaigns.last_error, log a warn event.

## 8. Routes (all under the global token gate) — exactly the client in lib/v2/campaigns.ts
`GET /api/v2/campaigns`, `POST /api/v2/campaigns`, `GET|PUT|DELETE /api/v2/campaigns/:id`,
`POST /:id/offer/learn`, `POST /:id/segments/propose`, `POST /:id/segments`, `PUT|DELETE /:id/segments/:sid`,
`POST /:id/start` (400 + plain error if no offer or no enabled segment; AI/Instantly NOT required to start —
they show up as blockers), `POST /:id/pause`, `POST /:id/run`, `GET /:id/prospects` (stage = a stage or a
StageGroup, segment, q over company/domain/name/email, limit ≤ 200, offset), `GET|PUT /:id/prospects/:pid`,
`POST /:id/prospects/:pid/rewrite`, `POST /:id/prospects/approve` (ids or all — only `written`),
`POST /:id/prospects/skip`, `POST /:id/prospects/restore` (back to `skipped_from`, attempts 0),
`POST /:id/companies` (manual domains -> companies + prospects `found`, same filters as discovery).
Errors: `{ error: "plain English" }` with 400/404; unexpected -> 500 and console.error.
Campaign activity uses the existing `GET /api/v2/events?campaignId=`.

## 9. Tests (backend agent) — prove it before reporting
Standalone scripts only: `SQLITE_PATH=/tmp/campaigns-<n>.sqlite V2_WORKERS=0 bun <script>`. Never call real
paid services or real Instantly. Mock AI with `setLlmMock()`; fake Instantly and the web by wrapping
`globalThis.fetch` (route api.instantly.ai and the target sites / r.jina.ai to canned responses).
Cover at least: offer learn (AI + fallback), propose segments (AI + fallback), discovery dedupe + exclusions,
research reuse, contact choice + role-address policy, verify policy incl. catch-all share, suppression (old
console unsubscribed + bounced, other campaign within 90 days, inbox unsubscribe), score threshold, writer
guardrails (link in email 1 stripped, placeholder rejected), review approve/skip/restore, push with no
mailbox (held) and with mailboxes (Instantly payload shape: text_only, no tracking, schedule tz/days,
custom variables, `<br/>`), blocklist -> skipped, pause -> Instantly pause, every HTTP route via a
server on a spare port with its own SQLITE_PATH. Run the core suite on SQLite AND Postgres via PGlite
(`bunx`/temporary install in /tmp only — never add it to package.json). Both tsc clean. Delete temp scripts.

## 10. Frontend (frontend agent)
Design system: `.same/v2-contracts.md` §2 (tokens, `.hb` tiles, `.mono-label`, `Badge`, quiet selected
controls, dashed empty states, `PageHeader` exactly once, 390 px, dark + light). Look at `Mailboxes.tsx` and
`Inbox.tsx` for the house style (cards, tiles, side panels, setup steps) and reuse `lib/ui.tsx`.
Screens inside Campaigns.tsx:
- **List** (no campaign open): readiness strip (AI key · Gemini search · Instantly · sending mailboxes ·
  verifier) with "Connect" links to the Agent / Mailboxes tabs (`dna-tab` event); campaign cards with status,
  kind, segments, a compact funnel (found -> verified -> written -> sent -> replies), review count, last
  error; "New campaign". Empty state explains the workflow in 4 steps with one action.
- **New campaign wizard** (modal or full view): 1 Name + kind (Customers / Partners) + website -> create;
  2 Offer: "Learn from website" -> editable fields (oneLiner, valueProps, proof, differentiators, pricing,
  regions, idealCustomers, competitors) + source badge + warning; 3 Ideal customers: "Suggest segments" ->
  cards (name, why, fit, industries, countries, size, titles, queries) editable, enable toggle, add by hand;
  4 Rules: reviewFirst, dailyNewLeads, followUps + delays, language, send window, excludeDomains,
  researchPerDay, minFitScore; 5 Launch: checklist from readiness + blockers, "Start campaign" (and "Run one
  pass now" to preview results while still a draft).
- **Campaign view**: header (name, status, kind, Start/Pause, Run now, more: archive); funnel strip of `.hb`
  tiles (Found, Researched, Contact found, Verified, Written/Review, Queued, Sent, Replies) clickable as
  filters; blockers banner (what waits and the one action that unblocks it); today strip (researched /
  written / queued of queueLimit); tabs:
  - Review (default when reviewCount > 0): list of written emails, each with company, person, fit, the
    emails (subject + body, follow-ups collapsible), warnings; actions Approve, Edit (inline), Rewrite
    (optional instruction), Skip; bulk "Approve all".
  - Leads: table (company + domain, person + title, email + status chip, fit, stage chip, segment, updated),
    stage-group filter, segment filter, search, pagination; row opens a side panel (ProspectDetail: research
    description/hooks/people/sources, address + verification checks, fit reason, emails, events, actions:
    skip / restore / edit person & address).
  - Segments: cards with found/sent/replies/positive, enable toggle, edit, delete, "Suggest more", add by
    hand, "Add companies" (paste domains).
  - Offer: editable offer + "Re-learn from website".
  - Settings: CampaignSettings form, save.
  - Activity: `v2.events({campaignId})` feed.
- Poll the open campaign every ~15 s while `working` or status active (pause when document.hidden).
- All copy plain and specific; every blocked state says why and the one action that fixes it.
Verify: frontend tsc + `vite build` clean. If you can, screenshot via headless Chromium against the running
dev server (http://localhost:5173, login with backend/.env values — never print them); otherwise say so.
