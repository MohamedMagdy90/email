# DNA Outreach v2 — Reachability + AI Lead Engine (analysis & plan)

Date: 2026-10-20. Inputs: current repo `MohamedMagdy90/email` @ b2a8930,
UI reference `MohamedMagdy90/dna-erp-api` (leads/partner/support console shell),
product reference explee.com.

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

---------------------------------------------------------------------------
## 5. UI — DNA console design (ported from dna-erp-api)
Dark-first palette (`--bg #08090c`, `--surf #0d1015`, accent teal `#00d4aa`), light theme on
`html[data-theme=light]` (same `dnaConsoleTheme` key), sticky brand bar with the DNA ERP lockup +
divider + mark + "Outreach console", underline tabs, 12px cards, uppercase micro-labels, stat tiles,
3-pane inbox, kanban pipeline.
Target tabs: Inbox · Campaigns · Leads · Contacts · Mailboxes · Templates · History · KPIs · Settings.

---------------------------------------------------------------------------
## 6. Phases
- **Phase 0 (now)** — DNA console UI on the existing screens; local env repaired.
- **Phase 1** — Mailboxes + warmup tracking + readiness gate + ramp; plain-text sender; verification;
  stop cold sends through Resend. START FIRST: warmup needs 2-3 weeks of calendar time anyway.
- **Phase 2** — Inbox: reply ingestion, threads, reply-from-platform, unread badges.
- **Phase 3** — AI lead engine: offer -> ICP -> companies -> people -> verify (Gemini/Groq).
- **Phase 4** — AI writer + campaigns + sequences + reply classification/auto-drafts.
- **Phase 5** — Learning loop + KPIs (per segment / mailbox / step).

## 7. Decisions needed from the user
1. Route A (Instantly engine) vs Route B (own engine via Gmail API/Graph, or Railway Pro + SMTP).
2. Mailbox vendor + count (suggest Zapmail or Mailforge, 3 domains x 3 mailboxes).
3. Gemini API key (free, aistudio.google.com) and optionally a Groq key.
4. Verification: MillionVerifier (cheap, paid) vs self-hosted Reacher (free, needs a VPS with port 25).
5. Contact-finder fallback: Hunter free tier vs a paid plan.
6. Explee: copy the product workflow only, or also clone the marketing landing page?
7. Auto-reply level: drafts only / auto for safe categories / fully autonomous.
