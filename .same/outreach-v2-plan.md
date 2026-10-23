# DNA Outreach v2 — Reachability + AI Lead Engine (analysis & plan)

Date: 2026-10-20. Inputs: current repo `MohamedMagdy90/email` @ b2a8930,
UI reference `MohamedMagdy90/dna-erp-api` (leads/partner/support console shell),
product reference explee.com.

Revised 2026-10-21 (repo @ 075c581): Phases 0-4 are built. §4-§7 updated and §8 added — the workspace
tabs that were missing: **Dashboard, Leads, Targeting, Sequences**.

---------------------------------------------------------------------------
## 0. Diagnosis — why the current platform lands in spam and gets no results

| # | Cause | Evidence in our code | Impact |
|---|-------|----------------------|--------|
| 1 | Cold mail is sent through **Resend** (a transactional ESP) | `backend/src/resend.ts` | Resend's AUP forbids unsolicited mail; shared ESP infrastructure + bulk pattern = spam/promotions; account can be suspended |
| 2 | **Heavy HTML templates** (logo + mockup images, 5 links, open pixel, click-wrapping) | `.same/customer_html.html` (7.6 KB), `partner_html.html` (14.8 KB) | Classic marketing fingerprint -> Promotions/Spam |
| 3 | Lists are **role addresses** (info@, sales@) from crawlers | `crawler/extract.ts` | Nobody owns info@; low replies, high bounce, spam-trap risk |
| 4 | **No verification** before sending | none | Bounces > 2-3% burn the domain within days |
| 5 | **No warmup / no ramp** on new domains | per-domain daily cap only | Day-1 volume on a cold domain = spam folder |
| 6 | **No personalisation** (merge tags only: company/country) | `template.ts` | Generic copy -> no replies -> negative engagement signals |
| 7 | **Replies are invisible** | no inbound path | No conversations, no follow-up, no learning loop |

Infrastructure constraint found: **Railway Hobby blocks outbound SMTP (25/465/587).**
Sending from our own backend over SMTP needs Railway Pro, or an HTTPS API.

---------------------------------------------------------------------------
## 1. Problem 1 — Reachability (deliverability)

### Target architecture: the "mailbox pool" model (what Explee / Instantly do)
- Cold mail leaves from **real mailboxes** (Google Workspace / Microsoft 365) on
  **secondary domains**, never `dna.systems`, never Resend. Resend stays for transactional only.
- Each mailbox: SPF + DKIM + DMARC, custom tracking domain, 25-40 sends/day max.
- Each prospect is pinned to ONE mailbox for the whole conversation (thread continuity).
- Plain-text first touch, <= 90 words, 0 links, no images, no open pixel.

### Where to get credible, warm mailboxes (integration options)
| Option | What it is | Cost | Integration |
|---|---|---|---|
| **Zapmail / Mailforge / Inframail** | Pre-warmed Google/M365 mailboxes, DNS auto-configured | ~$3-4 / mailbox / month + domains (~$10-12/yr) | SMTP/IMAP creds or OAuth -> connect to the sending engine |
| **Instantly.ai** (recommended engine) | Warmup network (4M+ accounts), sending, inbox rotation, Unibox (replies), API v2 | Growth $37/mo (API v2 incl.), Hypergrowth $97/mo (adds webhooks) | `POST /api/v2/accounts`, `/accounts/warmup/enable`, `/accounts/warmup-analytics`, campaigns, leads w/ custom vars, emails (replies) — all HTTPS, works on Railway Hobby |
| MailReach / Warmy | Warmup + spam-test APIs only | ~$19-25 per mailbox/month | Good for placement tests; expensive as the warmup engine |
| Explee API | Their pool of pre-warmed inboxes, $0.04/email | pay-as-you-go | Public API (search, enrichment, campaigns, inbox) — black box, we don't own the infra |

### Recommendation
**Route A (recommended): our platform = the brain, Instantly = the engine.**
1. Buy 3 secondary domains + 9 pre-warmed mailboxes (Zapmail or Mailforge) ≈ $30/mo.
2. Connect them to Instantly via API, enable warmup via API, keep warmup ON forever.
3. Our platform tracks every mailbox's health daily and **gates usage**:
   - Ready only when: DNS pass (SPF/DKIM/DMARC) AND >= 14 days warming (or pre-warmed flag + 7 days)
     AND warmup inbox-rate >= 95% (7-day) AND not blacklisted AND spam-test pass.
   - Ramp schedule once Ready: 10/day -> +3/day -> cap 30/day (configurable).
   - Auto-pause a mailbox when bounce > 3%, any spam complaint, or inbox-rate < 90%.
4. Capacity: 9 mailboxes x 30/day = **270 emails/day ≈ 5,400/month**. Add mailboxes to scale.

Route B (own engine): Gmail API / Microsoft Graph over HTTPS (no SMTP needed) +
a warmup API. More control, ~2-3x the build, and we still need a warmup network,
which can't be self-built credibly with a handful of mailboxes.

---------------------------------------------------------------------------
## 2. Problem 2 — Lead generation with free AI (replacing crawlers)

### The agent pipeline (Explee-style, built on free tiers)
1. **Learn the offer** — read dna.systems (Jina Reader, free) -> LLM summary: product, value props, proof, competitors.
2. **Build the ICP** — LLM proposes segments (industry x country x size) with fit scores; user approves/edits by chat.
3. **Find companies** — per segment, search queries via **Gemini + Google Search grounding** (free quota),
   Serper (2,500 free) / Brave as fallback, plus our existing OSM source. Dedupe vs DB.
4. **Research each company** — fetch home/about/team/contact pages (Jina) -> LLM extracts JSON:
   name, description, industry, size signals, city/country, **owner / founder / CEO / GM + titles**,
   phones, emails on site, LinkedIn company URL, recent hooks (projects, hiring, news).
5. **Find the decision maker** — LinkedIn profile URL via search (`site:linkedin.com/in "Name" "Company"`)
   — we never scrape LinkedIn itself. Email = pattern candidates (first@, first.last@, f.last@...)
   -> verification; fallback Hunter (free 25-50/mo) / Snov / Apollo for gaps.
6. **Verify** — MX + SMTP-probe via MillionVerifier (~$0.0004/email) or self-hosted Reacher (free).
   Only `valid` goes out; `catch-all` capped at 10% of a send.
7. **Score** — LLM fit score vs ICP; below threshold is parked, not mailed.
8. **Write** — LLM writes a personal first email per lead from the research (1 specific observation,
   1 relevant outcome, 1 question CTA, no links) + 2 threaded follow-ups. EN/AR by country.
9. **Send** through the mailbox pool (Route A), with ramp + caps.
10. **Handle replies** — LLM classifies (interested / question / not-now / referral / unsubscribe / OOO / bounce),
    drafts a grounded answer; auto-handles OOO/unsubscribe, interested -> approve-to-send (or full auto toggle),
    booking link when they say yes.
11. **Learn** — per-segment reply & positive rates -> scale winners, pause losers.

### Free LLM stack (provider-agnostic, OpenAI-compatible client)
- Primary: **Google Gemini 2.5 Flash / Flash-Lite** (AI Studio free key) — JSON mode + Google Search grounding.
- Fallback: **Groq** free tier (~1,000 req/day, very fast) for writing/classifying.
- Third: **OpenRouter** free models.
- Daily budget limiter + per-step caching (never research the same domain twice in 90 days).
- Realistic free throughput: ~100-200 fully researched leads/day — matches 270 sends/day.
- Note: AI Studio free tier may use prompts for training — fine for public company data; switch the
  reply-handling step to a paid key if reply contents are sensitive.

### Monthly cost estimate (Route A)
Mailboxes ~$30 + domains ~$3 + Instantly $37 + verification ~$5 + LLM/search $0 ≈ **$75/month**.
(vs. scraping proxies + crawler time today.)

---------------------------------------------------------------------------
## 3. Replies inside the platform (Inbox)
- New **Inbox** tab in the DNA leads-console layout: list | thread | lead side-panel (company, owner,
  LinkedIn, research, segment, mailbox).
- Ingestion (Route A): poll Instantly `GET /api/v2/emails` every 2-5 min (Growth plan) or
  `reply_received` webhook (Hypergrowth). Match by lead email + thread id; stop the sequence on reply.
- Reply from the platform: through the SAME mailbox, in-thread (`POST /api/v2/emails/reply`).
- AI draft button + classification chip on every inbound message; unread badges like the leads console.

---------------------------------------------------------------------------
## 4. Data model additions
`mailboxes` (provider ids, domain, status, ramp, caps) · `mailbox_health` (daily snapshot: warmup rate,
sent, bounces, spam, blacklist, dns) · `campaigns` (offer, icp, settings, status) · `segments` (fit, stats) ·
`companies` (domain, profile json, research json, researched_at) · `people` (name, title, linkedin,
email, email_status, source, confidence) · `sequences` / `steps` · `messages` (direction, mailbox, thread,
message_id, in_reply_to, subject, body, classification, ai_draft) · `llm_usage` (provider, tokens, day).

As built: `people` became columns on `prospects`; `sequences` / `steps` were NOT built (the copy lives in
`prospects.email_json`, the shape is hard-coded in `campaigns/writer.ts`).
Added by §8 (2026-10-21):
- `sequences` (id, campaign_id, name, language, steps_json, version, status, created_at, updated_at)
- `exclusions` (id, kind domain|email, value, reason, campaign_id NULL = global, source manual|import|auto, created_at)
- `segment_searches` (id, segment_id, query, country, via, ran_at, results, added, rejected_json) — the search log
- `campaign_daily` (day, campaign_id, sent, contacted, new_leads_contacted, replies, replies_auto, bounced,
  unsubscribed, opportunities) — from Instantly's daily campaign analytics
- `prospects` + `sequence_id`, `sequence_version`, `variant`, `last_step`, `last_step_at`, `replied_step`
- `campaigns` + `sequence_id`, `targeting_json` (the target market, §8.4.1)
- `segments` + `industry_ids_json`, `cities_json`, `size_band`, `titles_override` (0/1), `signals_json`
  (must / must-not), `queries_auto` (0/1)
- `companies` + `size_band`, `industry_id`; `prospects` + `skip_rule` (which targeting rule skipped it)
- settings keys `lead_views` (saved Leads filters), `segment_rules` (learning-loop thresholds + mode)

---------------------------------------------------------------------------
## 5. UI — DNA console design (ported from dna-erp-api)
Dark-first palette (`--bg #08090c`, `--surf #0d1015`, accent teal `#00d4aa`), light theme on
`html[data-theme=light]` (same `dnaConsoleTheme` key), sticky brand bar with the DNA ERP lockup +
divider + mark + "Outreach console", underline tabs, 12px cards, uppercase micro-labels, stat tiles,
3-pane inbox, kanban pipeline.
~~Target tabs: Inbox · Campaigns · Leads · Contacts · Mailboxes · Templates · History · KPIs · Settings.~~
Tabs (revised 2026-10-21, full spec in §8):
**Dashboard · Inbox · Leads** | **Campaigns · Targeting · Sequences** | **Mailboxes · Agent**.

---------------------------------------------------------------------------
## 6. Phases
- **Phase 0** — DNA console UI on the existing screens; local env repaired. DONE
- **Phase 1** — Mailboxes + warmup tracking + readiness gate + ramp; plain-text sender; verification;
  stop cold sends through Resend. DONE (848e4f7)
- **Phase 2** — Inbox: reply ingestion, threads, reply-from-platform, unread badges. DONE (974a4b9)
- **Phase 3** — AI lead engine: offer -> ICP -> companies -> people -> verify (Gemini/Groq). DONE (075c581)
- **Phase 4** — AI writer + campaigns + reply classification/auto-drafts. DONE (075c581, eaa1dad).
  Sequences were NOT built as an object — see Phase 6.
- ~~Phase 5 — Learning loop + KPIs~~ -> replaced by Phases 5-8 below (§8 has the detail).

Prerequisite for everything below: production runs the current code. Railway is still serving a build from
before 934c46a (`/api/open` answers 200), and Netlify must be republished only after the backend is live.

Order revised (second pass, 2026-10-21): targeting SETUP moves first — it decides whether the leads are right at
all, and today nothing enforces country / industry / size. The learning loop stays last.

- **Phase 5 — Targeting setup** (§8.4.1-8.4.4, 8.4.6, 8.4.8): target market per campaign, structured segment
  builder, industry list + cities, generated EN/AR searches, the target-check step in the pipeline (skip with
  the rule that failed), re-check dry run, preview sample, global do-not-contact, migration of existing segments.
- **Phase 6 — Leads** (§8.3): one list across campaigns, companies view, pipeline board, filters (incl. "skipped
  by rule"), saved views, bulk actions, CSV import/export, richer lead panel.
- **Phase 7 — Sequences** (§8.5): editable steps, templates, preview on real leads, per-step stats,
  optional A/B. Before the first real send, so the reviewed queue is written with the right sequence.
- **Phase 8 — Dashboard** (§8.2): needs-you, KPIs with trends, funnel, campaign + segment tables,
  capacity, activity. Useful before sending (pipeline, capacity); trends fill in once sends start.
- **Phase 9 — Targeting results + learning loop** (§8.4.5, 8.4.7): segments board, search log, Scaling /
  Working / Testing / Paused, quota split, steer by chat. The loop needs ≥ 50 sends per segment.

## 7. Decisions needed from the user
Answered 2026-10-20:
1. ~~Route A vs Route B~~ -> Route A, Instantly is the engine.
2. ~~Mailbox vendor + count~~ -> 6 mailboxes from Zapmail + Mailforge (6 x 30 = 180 emails/day at full ramp).
3. ~~Gemini key~~ -> comes later; everything degrades gracefully without it.
4. ~~Verification~~ -> self-hosted Reacher.
5. Contact-finder fallback (Hunter free tier vs paid) — still open, not built.
6. ~~Explee~~ -> copy the product workflow only.
7. ~~Auto-reply level~~ -> fully automatic, with tone controls.

Decisions 8-16 ANSWERED 2026-10-21: the user took every recommendation (views over campaign-owned
data · suggest mode · A/B later · one conversation per company · 5,000-row CSV cap, no old-contacts import ·
max 4 steps · market per campaign + segments inside · size "prefer" · default excluded industries as listed).

New, for §8 (recommendation first):
8. Model for the new tabs: **cross-campaign views over what each campaign owns** (recommended — no rewrite of
   the lead engine) vs reusable libraries (one segment or sequence shared by several campaigns).
9. Learning loop: **suggest changes, you press Apply** (recommended to start) vs fully automatic scaling/pausing.
10. A/B variants in Sequences: **later** (recommended — needs ~100 sends per variant to mean anything) vs in v1.
11. One conversation per company across campaigns: **yes** (recommended — the partner campaign skips a company the
    customer campaign is already talking to, and vice versa) vs allowed.
12. CSV import: cap of 5,000 rows per file; and whether to offer a one-time import of the old console's contacts
    (mostly role addresses — see §0 #3).
13. Max steps per sequence: **4** (1 opener + 3 follow-ups, recommended) or more.
14. Targeting levels: **market per campaign + segments inside it** (recommended) vs every segment fully
    self-contained.
15. Size rule default: **prefer** (out-of-band size lowers the fit score, unknown size allowed — recommended,
    because size is guessed from websites) vs **strict** (skip).
16. Default excluded industries: government, education, NGOs, and for customer campaigns ERP / software vendors —
    add or remove any.

---------------------------------------------------------------------------
## 8. Workspace tabs — Dashboard, Leads, Targeting, Sequences (added 2026-10-21)

### 8.0 Why — the gap
Explee's workflow (explee.com, 2026-10-21): learns what you sell -> figures out who buys it (segments with a
fit %) -> finds the exact people -> writes each a personal email -> handles replies, books meetings -> "learns
what works and doubles down" (segments marked Scaling / Working / Paused, with cost per lead). Their FAQ adds:
"every new campaign shows you its lead list before outreach starts", "preview the email template against real
leads before launch", "steer targeting and tone by chatting with the agent", "one click pauses everything",
and CSV upload of your own contacts.

We built the engine for all of that, but the WORKSPACE around it is missing. Everything lives inside one campaign:

| Explee has | What we have (075c581) | Gap |
|---|---|---|
| Dashboard | Funnel tiles inside one campaign. Nothing across campaigns, no trends, no rates. | No home screen, no KPIs, no "what needs me" |
| Leads list | Leads + Review tabs inside each campaign (`campaigns/Leads.tsx`) | No list across campaigns, no companies view, no pipeline board, no import/export, no saved filters |
| Targeting | Offer + segments inside each campaign (wizard steps 2-3, Segments/Offer tabs). Segment country / industry / size are free-text lines; only countries (for searches) and titles do anything — nothing checks a researched company against them. The `scaling` status exists in types but nothing sets it. | No structured setup (country, city, industry, size, people), no filter step that enforces it, no preview, no view across campaigns, no performance per segment, no learning loop, no global do-not-contact, no steering by chat |
| Sequencing | No sequence object. 1 opener + 0-2 follow-ups hard-coded in `writer.ts`; delays in campaign settings; copy written per lead into `prospects.email_json` | Can't see or edit the steps, no templates, no preview before launch, no per-step stats |

The data for most of it already exists: `prospects`, `companies`, `segments`, `threads`/`messages` (with `step`),
`agent_events`, Instantly campaign analytics. Phases 5-8 are mainly views + a few tables, plus one real
refactor (the writer moves from hard-coded rules to a sequence).

Not copied from Explee, on purpose: their 105M-company / 536M-people database (we discover by search, so no TAM or
"filter the database" screens — a segment shows "searches left", not a market size), pay-per-email billing,
their shared mailbox pool (ours is our own, through Instantly).

### 8.1 Navigation
```
Dashboard · Inbox (badge) · Leads (badge: to review) | Campaigns · Targeting · Sequences | Mailboxes · Agent
```
- Default landing tab = Dashboard (today: Inbox).
- Leads, Targeting, Sequences and Dashboard share one **campaign filter** in the title row ("All campaigns" or
  one campaign), remembered per browser. Campaigns stays the control room for ONE campaign and embeds the same
  components with the filter preset (one component, two places — no duplicate screens).
- Under 860 px the tab bar scrolls sideways, like the Agent tiles.
- Model (decision 8): segments, offer and sequence stay OWNED by a campaign; the new tabs are cross-campaign views
  with "duplicate into another campaign". No rewrite of the lead engine.

### 8.2 Dashboard — "is it working, and what needs me?"
Title row: range (7 / 30 / 90 days) · campaign filter · **Pause everything** / Resume (pauses every active
campaign + its Instantly campaign; one click, confirm).

1. **Needs you** (hidden when empty) — cards that open the right place: N emails to review -> Leads/To review;
   N replies need a human -> Inbox; N mailboxes paused or failing -> Mailboxes; blockers ("No AI key", "AI budget
   used up", "Approved emails waiting for a mailbox") with the one action that fixes each.
2. **KPI tiles** (`.hb`, delta vs previous period + 14-day sparkline): Sent · Reply rate · Hot leads (positive
   replies) · Meetings · Bounce rate · New leads found. Optional: Cost per hot lead = monthly running cost (a
   setting, default $75 from §2) / hot leads in the range — Explee's headline metric.
3. **Funnel** across campaigns: found -> researched -> contact -> verified -> written -> approved -> sent ->
   replied -> interested -> meeting -> won, with drop-off between steps; every bar opens Leads filtered.
4. **Trend chart**: daily sent / replies / hot leads / bounces (from `campaign_daily`).
5. **Campaigns table**: status, sent, reply %, hot leads, bounce %, today queued / limit, last error.
   **Segments leaderboard**: Scaling / Working / Testing / Paused, contacted, reply %, positive %, AI calls per
   written lead.
6. **Capacity + budget**: mailboxes sending / warming (+ first ready date), emails possible today vs used,
   AI calls used today. **Activity**: latest `agent_events`, all kinds.

Before the first send: the dashboard shows pipeline, review queue, capacity and a "first emails go out when…"
line (warmup ETA from Mailboxes) instead of empty charts.

Definitions (shown in tooltips, same everywhere): reply rate = unique human replies / leads contacted (Instantly
`reply_count_unique` / `contacted_count`, auto-replies excluded); hot lead = prospect in interested / meeting /
won; bounce rate = bounced / contacted.

Data: our DB (funnel, stages, events, mailboxes) + Instantly `GET /api/v2/campaigns/analytics/daily` (listed in
the Instantly docs, not yet in `.same/ref/instantly-api-notes.md` — add it) synced into `campaign_daily` every
30 min by the campaign sync, 31-day backfill on first sync.
API: `GET /api/v2/dashboard?range=30&campaign=` -> `{ needsYou[], kpis{key:{value, prev, series[]}}, funnel,
trend[], campaigns[], segments[], capacity, ai, events[] }` — one call, cached 60 s. `POST /api/v2/dashboard/pause-all`,
`/resume-all`.

### 8.3 Leads — every person the agent found, in one place
Three views (quiet segmented control): **People** (default) · **Companies** · **Pipeline**.

- **People table**: person + title (+ LinkedIn), company + domain, country / city, campaign, segment, email +
  verification chip, fit, stage chip + reason, mailbox, last activity, **next step** ("Follow-up 2 on 28 Oct").
  Sortable, column picker, 50 per page.
- **Filters** (bar + "more filters" drawer, counts on each value): campaign, segment, stage / stage group, country,
  industry, fit range, email status, source (gemini / search / manual / import), replied, interest, mailbox,
  found / sent date range, search. **Saved views** (`lead_views` setting) + built-ins: To review · Ready to send ·
  In sequence · Replied · Hot · Bounced or unsubscribed · Skipped (grouped by reason, so "why did we drop 40%?"
  has an answer).
- **Bulk actions** on a selection or on "all N matching": approve, skip, put back, re-research, re-verify, move to
  another campaign (only before it reached Instantly), add domain / email to do-not-contact, export CSV.
- **Companies view**: one row per domain — people found, campaigns it's in, furthest stage, research status;
  the panel shows the research once and every person under it.
- **Pipeline board** (kanban, CSS exists in `.same/ref/leads_console.py`): Replied · Interested · Meeting · Won ·
  Lost. Dragging a card is the human override of the Inbox's classification: sets `prospects.stage` and the
  Instantly interest status (`updateInterest`), logs an event.
- **Lead panel** (extends `LeadPanel` from `campaigns/Leads.tsx`): one timeline merging agent events + the email
  thread (inline, "open in Inbox"), sequence position (step 1 sent 21 Oct, step 2 due 24 Oct), research,
  verification checks, fit reason, the emails, notes, actions (change stage, do-not-contact, open thread).
- **Import CSV** (Explee allows 30k; we cap 5,000 per file — decision 12): map columns (email, first / last name,
  title, company, website, country), pick campaign + segment, pick where they enter (verify -> score -> write, as
  usual). Every row goes through `verifyEmail` + suppression + one-conversation-per-company (decision 11).
  Result: imported / duplicate / suppressed / invalid, downloadable.
- **Export CSV** of the current filter (what you see is what you get).
- One row per prospect (person in a campaign); a person in two campaigns shows "also in <campaign>".

API (new module `backend/src/v2/leads/`, read-mostly; every WRITE goes through the campaign service so stage
rules live in one place): `GET /api/v2/leads?view=people|companies&…filters&sort&limit&offset` -> `{ rows, total,
facets }` · `GET /api/v2/leads/:pid` (prospectDetail + thread) · `POST /api/v2/leads/bulk {action, ids | filter}` ·
`PUT /api/v2/leads/:pid/stage {stage, note}` · `POST /api/v2/leads/import` + `GET /api/v2/leads/import/:id` ·
`GET /api/v2/leads/export?…` (text/csv) · `GET|PUT /api/v2/leads/views`.
Indexes: `prospects(stage, updated_at)`, `prospects(segment_id)`, `companies(country)`.

### 8.4 Targeting — set up who to go after, then see what's working
Revised 2026-10-21 (second pass): Targeting is first the SETUP screen — countries, cities, industries, size,
people — and only then the results screen.

**What's wrong today (verified in code @ 075c581).** A segment stores countries, industries, size, titles and
queries as free-text lines. Only some of them do anything:
| Field | Used for | Checked against the company? |
|---|---|---|
| countries | building the search plan (`segmentPlan`), the Instantly timezone (first country of the first segment) | No |
| queries | the searches | — |
| titles | picking the person (`pickPerson`) | Yes |
| industries | words in the AI fit-score prompt | No (only indirectly, through the AI's score) |
| company size | words in the AI fit-score prompt | No (same) |
A company found by "distributor Riyadh" that turns out to be in Cairo, or a government body, or a 3-person shop,
goes through unless the AI happens to score it low — and without an AI key nothing checks anything.

So targeting gets two levels, a structured builder, and a real filter step in the pipeline.

#### 8.4.1 Target market — the boundaries (one per campaign, `campaigns.targeting_json`)
Every segment of the campaign stays inside these.
| Setting | How you set it | Default |
|---|---|---|
| Countries | picker, "Gulf" preset (Saudi Arabia, UAE, Qatar, Kuwait, Bahrain, Oman) + Egypt, Jordan, … | Gulf 6 |
| Cities / regions | optional per country (Riyadh, Jeddah, Dammam / Eastern Province, Dubai, Sharjah, Abu Dhabi, Doha, …); empty = whole country | empty |
| Excluded countries / cities | picker | none |
| Company size | employee band (1-10, 11-50, 51-200, 201-500, 500+) and/or minimum branches; "if size is unknown": allow / skip; "strict" or "prefer" | 11-500, allow, prefer |
| Excluded industries | from the industry list | government, education, NGOs; for customer campaigns also ERP / software vendors |
| Must / must not (on the website) | keywords, e.g. must: "warehouse", "branches"; must not: "franchise", "government" | none |
| Website language | any / Arabic / English | any |
| People to contact | decision-maker titles, ranked (drag chips) | preset per kind (customer: Owner, CEO, GM, CFO, Finance Manager, Operations Manager; partner: Managing Partner, Founder, CEO, Sales Director) |
| People never to contact | titles (HR, recruitment, marketing, intern, assistant) + seniority floor (manager and up) | that list |
| Role addresses (info@, sales@) | inherit the agent setting / allow / never | inherit |
| Minimum fit score | 0-100 (moves here from campaign Settings) | agent setting |
| Never contact | this campaign's domains + link to the global list (8.4.6) | — |

#### 8.4.2 Segments — slices inside the market (structured builder, replaces the free-text lines)
- **Industry**: pick from the industry list (multi) + custom. Partner campaigns show partner types instead
  (accounting & audit, tax / VAT consultants, IT services & integrators, POS / hardware resellers, ERP
  consultancies, software distributors).
- **Where**: inherit the market, or narrow to some of its countries / cities.
- **Size**: inherit, or narrow.
- **Who**: inherit the market's ranked titles, or reorder for this segment (e.g. Plant Manager first for factories).
- **Signals** (optional): must / must-not keywords for this slice ("cold storage", "multi-branch").
- **Searches**: GENERATED from industry keywords x cities, in English and Arabic ("food distributor Riyadh",
  "موزع مواد غذائية الرياض"), shown as a list with a count ("24 searches"); AI adds extra phrasings when a key
  exists; "Advanced" lets you add / remove by hand (then `queries_auto = 0` and edits to the criteria stop
  regenerating them). Changing where / industry regenerates and restarts the walk (the cursor reset already
  exists for query / country changes).
- **Fit + why**: from "Suggest segments" (AI now fills the structured fields: industry ids, cities, size band,
  titles, signals) or by hand.

**Industry list** — new `backend/src/v2/targeting/taxonomy.ts`, ~25 industries that need an SME ERP in the Gulf,
each with English + Arabic search keywords and the words used to classify a researched company:
wholesale & distribution · import / export trading · manufacturing (food, plastics, metal, furniture,
chemicals, packaging) · building materials · retail chains · restaurants & F&B groups · pharmacies & medical
supplies · clinics · contracting & construction · MEP & facility management · logistics & freight · auto parts &
workshops · electronics & IT retail · fashion & textiles · cosmetics · printing · agriculture & food production ·
hospitality · private training centres · professional services; partner types as above.
Cities per country: add `CITIES` to `backend/src/country.ts` (it already has canonical names + aliases).

#### 8.4.3 The rules actually filter — new pipeline step "target check"
Runs at discovery (when the search result already shows the place) and right after Research, BEFORE Contact —
so off-target companies never cost a person search, a score or an email.
| Rule | Decided from | When it fails |
|---|---|---|
| Country / city | research country + city, then `resolveLeadCountry` (ccTLD, phone code) | skipped: "Outside the target: based in Cairo, Egypt" |
| Excluded industry | AI industry -> taxonomy id; without AI, keyword match on the site text | skipped |
| Size | AI estimate ("about 50 staff", "3 branches") -> band, saved on the company | strict: skipped · prefer: fit penalty · unknown: per setting |
| Must-not keywords | site text | skipped |
| Must keywords | site text | strict: skipped · otherwise fit penalty |
| Website language | detected language (already stored in `companies.language`) | skipped |
| Never-contact titles / seniority | at Contact | that person is passed over, the next-best person is tried |
- Every skip stores WHICH rule (`prospects.skip_rule`), so the Leads "Skipped" view groups them: "38 outside the
  target country · 12 too small · 5 excluded industry". That's how you see the targeting is wrong.
- The fit-score prompt gets the structured criteria instead of free text.
- **Changing the market re-checks the leads already found** that haven't gone to Instantly: dry run first
  ("this would skip 17 leads"), then Apply.
- **Sending timezone**: Instantly runs one schedule per campaign. Use the country with the most leads (not "first
  country of the first segment"). Gulf countries are within 1 hour of each other, so that's fine; a market
  spanning more (e.g. Gulf + Egypt in winter) is flagged, and later split into one Instantly campaign per timezone.

#### 8.4.4 Preview before launch
"Find 10 sample companies" on a segment: runs 1-2 of its searches + the target check on what the results
already say, shows each company with pass / fail per rule. Nothing is saved unless you press "Add these".
Shows "24 searches in the plan · sample: 7 of 10 in target". Without Gemini it uses the free search and may come
back thin — it says so. This is Explee's "see the lead list before outreach starts".

#### 8.4.5 What's working (results)
1. **Offers** — each campaign's offer side by side (customer vs partner), source badge, edit, "copy to campaign",
   re-learn from the website.
2. **Segments board** (all campaigns): status **Testing / Working / Scaling / Paused / Exhausted**, fit %, found,
   in target %, contacted, reply %, positive %, share of today's quota, searches left (cursor / plan length).
   Actions: on/off, edit, duplicate into another campaign, "find similar segments", retire.
3. **Segment detail**: the definition; the **search log** — every query that ran, results, new companies,
   rejected and by which rule (new table `segment_searches`: segment_id, query, country, via, ran_at, results,
   added, rejected_json); the companies found with fit.
4. **Learning loop** (`segment_rules` setting, applied by the campaign worker after each sync):
   - Testing until 50 leads contacted.
   - Scaling: positive rate ≥ 2 % or reply rate ≥ 5 %. Paused: 0 hot leads after 100 contacted, or bounce > 4 %.
     Working: everything in between. (Defaults, editable.)
   - Quota split of each day's new leads: Scaling 60 % · Working 30 % · Testing 10 % — applied to both discovery
     order and push order.
   - Mode (decision 9): **suggest** — status changes show as "Apply" chips with the numbers behind them, and an
     event — or **automatic**.
#### 8.4.6 Do-not-contact (global)
One list of domains + emails with reason and source (manual, import, Inbox unsubscribe, bounce, old console).
New `exclusions` table, checked by `suppression.ts` at discovery, verify and push. Paste, CSV in / out.
Automatic entries (opt-outs, bounces) show read-only so it's ONE answer to "who do we never email?".
Each campaign's own never-contact domains (today `settings.excludeDomains`) show in the same list.

#### 8.4.7 Steer by chat
"Focus on distributors with 3+ branches in Riyadh, skip pharmacies" -> the AI proposes a change list against the
STRUCTURED fields (market: cities, size, excluded industries; segments: industries, titles, signals; exclusions)
-> you tick and Apply, with the re-check dry run from 8.4.3. Never applies on its own. Needs an AI key; without
one the box explains that.

#### 8.4.8 Screen layout
Campaign picker at the top (targeting belongs to a campaign — decision 8), then four sections:
**Market** (8.4.1 form, sticky save bar) · **Segments** (cards -> builder 8.4.2, preview 8.4.4) ·
**Results** (8.4.5) · **Never contact** (8.4.6). Steer-by-chat box above Segments. The wizard's
"Ideal customers" step becomes **Market** + **Segments** using the same components.

API (new module `backend/src/v2/targeting/`):
- Setup: `GET /api/v2/targeting/taxonomy` (industries, partner types, cities, size bands, title presets) ·
  `GET|PUT /api/v2/campaigns/:id/targeting` (the market) · segment create / update keep the campaign routes but
  accept the structured fields (`industryIds`, `cities`, `sizeBand`, `titles`, `signals`, `queriesAuto`) ·
  `POST /api/v2/targeting/segments/:sid/queries/regenerate` · `POST /api/v2/targeting/segments/:sid/preview` ->
  sample companies with a pass / fail per rule · `POST /api/v2/campaigns/:id/targeting/recheck {apply: boolean}` ->
  `{ wouldSkip, byRule }`.
- Results: `GET /api/v2/targeting?campaign=` (offers, segments + stats + status + suggestions) ·
  `GET /api/v2/targeting/segments/:sid` (detail + search log + companies) ·
  `POST /api/v2/targeting/segments/:sid/duplicate {campaignId}` · `POST /api/v2/targeting/suggestions/apply {ids}` ·
  `GET|PUT /api/v2/targeting/rules`.
- `GET|POST|DELETE /api/v2/targeting/exclusions` · `POST /api/v2/targeting/steer {message}` -> `{ summary, changes[] }` ·
  `POST /api/v2/targeting/steer/apply {changes}`.

Migration: existing segments keep working — free-text countries are normalized with `normalizeCountry`,
industries are matched to the industry list where they can be (the rest stay as custom), queries are kept and
marked `queries_auto = 0`. Each existing campaign gets a market built from the union of its segments' countries
and the defaults above.

### 8.5 Sequences — the steps every lead gets
Today the AI writes every email of every lead from scratch under fixed rules. That stays the default (it's what
makes the copy personal), but the RULES become a visible, editable sequence.

- **A sequence** = ordered steps (max 4 — decision 13). Each step: `delayDays`, `kind` (`ai` — written per lead,
  or `template` — fixed text with variables, AI fills only `{{observation}}`), `angle` (observation / outcome /
  proof / question / close the loop), `instructions` (plain words: what this step must do), `maxWords`,
  `newThread` (subject or same thread), `bookingLink` (allowed or not), template text with variables
  `{{first_name}} {{company}} {{observation}} {{hook}} {{sender_name}}`.
- **One active sequence per campaign** (`campaigns.sequence_id`). Saving a change creates a new version; leads
  already written keep theirs (`prospects.sequence_version`) unless you press "Rewrite unsent leads"
  (written / approved only — never anything already in Instantly).
- **Editor**: left = timeline (Day 0 · Day 3 · Day 7) with add / remove / reorder; each step card has angle,
  instructions, word limit, thread and booking-link toggles, AI / template. Right = **live preview on a real lead**
  (pick from the campaign's verified / written leads; the fictional sample from `agent-preview.ts` when there are
  none) — generates the actual emails with word counts and guardrail warnings. Same sticky save bar as Agent.
- **Library**: starter sequences — Customer 3-step, Partner 3-step (Makers 15 % / 35 %), Arabic formal 3-step,
  Short 2-step — "use in campaign" copies one.
- **Per-step stats**: sent, replies, reply %, unsubscribes and bounces after each step, where people drop off —
  from Instantly `GET /api/v2/campaigns/analytics/steps` (listed in the docs; add to the notes) + our
  `messages.step` + `prospects.replied_step`.
- **Lead progress**: the campaign sync stores `last_step`, `last_step_at`, `replied_step` from the Instantly lead
  (`last_step_id`, `last_step_timestamp_executed`, `email_replied_step`) -> the Leads "next step" column.
- **A/B variants** (decision 10, later): variants per step -> Instantly step `variants[]` with their own custom
  variables, the lead's variant stored in `prospects.variant`, winner picked on reply rate after ~100 sends each.

Engine changes (the one real refactor):
- `writer.ts` takes the sequence steps instead of hard-coded rules; `checkEmails()` checks each step against ITS
  rules (links / booking link only where allowed, its word limit).
- `sender.ts` builds the Instantly sequence from the steps (custom variables `subject_1`, `body_1..body_4` as
  today) and patches it when the sequence changes (the settings-change patch already exists).
- Migration on first boot: every existing campaign gets a sequence built from its `followUps` + `followUpDelays`
  and the writer's current rules as step instructions -> nothing changes until someone edits it.
- `followUps` / `followUpDelays` leave CampaignSettings (read once by the migration, then ignored).

API: `GET /api/v2/sequences?campaign=` · `GET|PUT /api/v2/campaigns/:id/sequence` ·
`POST /api/v2/campaigns/:id/sequence/preview {prospectId?}` · `POST /api/v2/campaigns/:id/sequence/rewrite-unsent` ·
`GET /api/v2/sequences/templates` · `GET /api/v2/campaigns/:id/sequence/stats`.

### 8.6 What changes in the existing tabs
- **Campaigns** — the control room for one campaign. Its tabs become Overview (funnel, blockers, today, last pass)
  · Review · Leads · Sequence · Targeting · Settings · Activity, each the shared component with the filter preset.
  Wizard becomes: Basics -> Offer -> **Market** -> **Segments** (with the sample preview) -> **Sequence** ->
  Rules -> Launch. Launch shows the first leads found and a preview of their emails before "Start campaign".
  Minimum fit score moves from Settings to Market.
- **Inbox** — lead panel links to Leads; an inbound reply sets `prospects.replied_step`.
- **Mailboxes / Agent** — unchanged; Dashboard reads capacity, sequences use `voicePrompt()` + the knowledge base.
- **Shell** — 8 tabs, Dashboard first, Leads badge = emails to review.

### 8.7 How it gets built
Same method as Campaigns: the typed client is written first and is binding — `frontend/src/lib/v2/leads.ts`,
`sequences.ts`, `targeting.ts`, `dashboard.ts` — then backend, then screens. Each phase ships with a test script
(fake Instantly + mock LLM + own SQLite, run on SQLite AND Postgres), both tsc clean, vite build, screenshots in
dark / light / 390 px.

| Phase | Tab | New backend | Size | Needs real sends? |
|---|---|---|---|---|
| 5 | Targeting setup | `targeting_json`, structured segment columns, `taxonomy.ts` + `CITIES`, query generator, target-check step + `skip_rule`, re-check, preview, `exclusions`, migration | L | No |
| 6 | Leads | `v2/leads/` (filters, facets, bulk, import / export, stage override) | M | No |
| 7 | Sequences | `sequences` table + versions, writer / sender refactor, migration, preview, step stats | L | Stats only |
| 8 | Dashboard | `campaign_daily` sync, `/dashboard` aggregate, pause-all | M | Trends only |
| 9 | Targeting results | `segment_searches`, learning loop in the worker, steer-by-chat | M | Loop only (≥ 50 sends / segment) |

Why this order: targeting decides whether a lead is right at all, so it comes first; Leads and Sequences matter
before the first email goes out (seeing the list, shaping the copy while mailboxes warm); Dashboard is useful at
once but fills in with sends; the learning loop has nothing to learn from until segments have ~50 sends each.
