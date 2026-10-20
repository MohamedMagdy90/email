# Outreach v2 — build contract (BINDING for every workstream)

Project: `/home/project/email` — Bun + Hono backend (`backend/`), React + Vite + Tailwind v4 frontend (`frontend/`).
Plan: `.same/outreach-v2-plan.md`. Instantly API reference (verified from the official OpenAPI spec):
`.same/ref/instantly-api-notes.md`. DNA leads-console reference UI: `.same/ref/leads_console.py`
(CSS for the 3-pane inbox, chips, kanban) and `.same/ref/partner_console.py` (shell/palette).

User decisions: Instantly is the sending engine · 6 mailboxes from 2 vendors (Zapmail + Mailforge; vendor-agnostic)
· Gemini key comes LATER (build now, must degrade gracefully) · free self-hosted verifier (Reacher) ·
copy Explee's product WORKFLOW (not its marketing site) · auto-replies FULLY AUTOMATIC with tone controls.

---------------------------------------------------------------------------
## 0. Safety rules (non-negotiable)
1. **Never start a dev server.** One is already running under the platform supervisor (API :3001 via
   `bun --watch`, Vite :5173 with HMR). Two processes on one SQLite file corrupt it.
   Never `kill` anything. Never `kill -9`.
2. Backend reloads automatically when a file already in the import graph changes. A NEW module file
   (loaded dynamically by `v2/index.ts`) is picked up by running `touch backend/src/index.ts`.
3. Standalone scripts that import backend modules MUST run with
   `SQLITE_PATH=/tmp/<yourname>.sqlite V2_WORKERS=0 bun <script>` (own DB file, no workers).
   Delete temp scripts when done.
4. Test HTTP routes with curl against `http://localhost:3001` using a token:
   `curl -s -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' -d '{"username":"<AUTH_USERNAME>","password":"<AUTH_PASSWORD>"}'`
   (values in `backend/.env`; never print them in reports) then `-H "Authorization: Bearer <token>"`.
5. **No Instantly key and no AI key exist yet.** Everything must work in "not connected" mode with clear
   UI states, and your logic must be proven with `setLlmMock()` (from `v2/llm.ts`) and fake Instantly
   data in scripts. Never call real paid services.
6. Only edit files you own (section 3). Shared foundation files are READ-ONLY except for small
   ADDITIVE exports if truly needed (never change an existing signature) — list any such change in
   your report.
7. Typecheck: `cd backend && bunx tsc --noEmit -p .` and `cd frontend && bunx tsc --noEmit -p .`.
   Fix every error in YOUR files. (Other workstreams are editing in parallel; ignore their transient errors.)
8. Leave `node_modules`, lockfiles and `package.json` alone unless a dependency is unavoidable (report it).

---------------------------------------------------------------------------
## 1. Shared foundation (already built — use it, don't duplicate it)

### Backend `backend/src/`
- `db.ts`: `q(sql, params)` (portable SQL, `?` placeholders; SQLite locally, Postgres in prod — no
  SQLite-only syntax, no `now()`, booleans 0/1, ISO text timestamps, `ON CONFLICT ... DO UPDATE`),
  `getSetting`, `setSetting`, `nowIso`.
- `v2/schema.ts`: all v2 tables — READ IT. mailboxes, mailbox_health, campaigns, segments, companies,
  prospects, threads, messages, email_verifications, llm_usage, agent_events. Need a new column? Add an
  idempotent `try { await q("ALTER TABLE x ADD COLUMN ...") } catch {}` inside YOUR module's register().
- `v2/events.ts`: `uid()`, `sleep()`, `todayUtc()`, `parseJson(raw, fallback)`, `logEvent(kind, message,
  {level, refType, refId, campaignId})` (activity feed — log every meaningful agent action in plain
  English), `listEvents()`, `textToHtml()`, `htmlToText()`.
- `v2/llm.ts`: `llm<T>({system, prompt, json?, search?, tier?: "smart"|"fast", temperature?, maxTokens?, task?})`
  → `{text, data, provider, model, sources}`. Throws `LlmUnavailable` (no key / all failed) and
  `LlmBudgetExceeded`. `search: true` = Gemini + Google Search grounding (returns `sources`).
  `aiStatus()`, `budgetRemaining()`, `extractJson()`, `setLlmMock(fn)` for tests.
- `v2/instantly.ts`: typed client — accounts (list/get/create/patch, warmup enable/disable,
  warmupAnalytics, testVitals, dailyAccountAnalytics, pause/resume), campaigns (create/get/patch/
  activate/pause/analytics), leads (addLeads ≤1000, listCampaignLeads, updateInterest, blockEntry),
  Unibox (listEmails, getEmail, replyToEmail, markThreadRead, unreadCount), `instantlyCall()` for
  anything else, `instantlyConfigured()`, `InstantlyError`, `timezoneForCountry()`, `workDaysForCountry()`.
- `v2/verify.ts`: `verifyEmail(email)` → `{status: valid|invalid|risky|catch_all|unknown, reasons, checks}`;
  `findEmail({fullName, domain, publishedEmail?, knownPeopleEmails?})`; `splitName`, `candidateEmails`,
  `inferPattern`; `getReacherConfig()`.
- `v2/agent-settings.ts`: `getAgentSettings()`, `saveAgentSettings()`, `voicePrompt(settings, toneOverrides?)`
  (include it in EVERY writing prompt), `AgentSettings` type (tone, autoReply, sending policy, KB, signature,
  bookingLink, language).
- `v2/core-routes.ts`: `/api/v2/status`, `/api/v2/integrations` (GET/PUT), `/api/v2/integrations/test`,
  `/api/v2/agent-settings` (GET/PUT), `/api/v2/events`, `/api/v2/verify`.
- `v2/index.ts`: dynamically loads `./mailboxes/module`, `./inbox/module`, `./campaigns/module`.
  Each module exports `register(app: Hono)` (mount routes under `/api/v2/<feature>`) and optional
  `start()` (workers; must be idempotent, use setInterval/setTimeout, never block boot, catch every error).
- Existing helpers worth reusing: `crawler/fetcher.ts` `fetchWithRetry(url, tries, timeoutMs, proxy, readerKey)`
  (direct fetch with free Jina-reader fallback; `config.ts` `getProxyConfig()`, `getReaderKey()`),
  `crawler/extract.ts` `extractEmails(html)`, `decodeEntities`, `crawler/urls.ts` `extractLinks(html, base)`,
  `scoreLink(url)`, `registrableDomain(host)`, `hostOf(url)`, `crawler/validate.ts` `cleanEmail`,
  `isValidEmail`, `isRole`, `hasMx`, `search.ts` `searchRaw(keywords, location, limit)` (free web search
  via reader — fallback when Gemini search is unavailable), `country.ts` `normalizeCountry`.

### Frontend `frontend/src/`
- `lib/api.ts`: `req<T>(path, init)` (auth + errors). `lib/v2/core.ts`: `j()`, `put()`, `patch()`, `del`,
  `v2.status/integrations/saveIntegrations/testIntegration/agentSettings/saveAgentSettings/events/verify`,
  types (`AgentSettings`, `Integrations`, `AgentEvent`, `VerifyResult`), `ago(iso)`.
- `lib/ui.tsx`: `Button` (solid|outline|ghost|danger, sm|md, loading), `Card`, `Badge`, `StatusPill`,
  `Field`, `Input`, `Textarea`, `Select`, `Spinner`, `Modal` (wide), `toast(msg, type)`, `PageHeader`
  (title/subtitle/actions — portals into the shell's title row; every screen renders exactly one), `cn`.
- Switch tabs from anywhere: `window.dispatchEvent(new CustomEvent("dna-tab", { detail: "agent" }))`.
- Shell polls `GET /api/v2/inbox/counts` → `{ unread, needsHuman }` for the Inbox tab badge.

---------------------------------------------------------------------------
## 2. Design system — DNA ERP console (match it exactly)
- Dark-first; light theme via `html[data-theme=light]`. EVERYTHING must look right in both. **No hex
  colours, no `bg-white`, no `text-black`, no emojis, no gradients except the ones below.**
- Token classes (Tailwind): surfaces `bg-cream` (page) `bg-paper` (card) `bg-surf2` (side panels, list
  panes) `bg-sunk` (inputs, wells) `bg-hov` (hover/selected); borders `border-line-soft` (cards)
  `border-line` (inputs, dividers) `border-line-strong` (outline buttons); text `text-ink` `text-ink-soft`
  `text-muted` `text-accent`; accent fill `bg-brand text-onbrand` (primary actions ONLY); status pairs
  (always fg+bg together): `bg-okb text-good` · `bg-wnb text-warn` · `bg-dgb text-bad` · `bg-inb text-inf`
  · `bg-pub text-puf` · `bg-tlb text-accent` · `bg-orb text-orf`; highlighted panel `border-keepl bg-keep1`;
  subtle tints `bg-ink/[0.04]`.
- CSS classes from `index.css`: `.hb` stat tile (+ `.keep` for the one accent tile), `.mono-label`
  (uppercase micro-label), `.livep` (+ `.open`) live pill with dot, `.badge` count pill.
- Shapes: controls `rounded-lg`, cards `rounded-xl`, large panels `rounded-[14px]`; chips `rounded-full`
  uppercase 10.5px bold tracking .05em (use `Badge`). Section labels: 11px uppercase tracking .09em muted.
  Headings `font-[650] tracking-[-0.01em]`. Numbers `tabular-nums`.
- Selected filter/segmented controls are QUIET: `bg-hov text-ink ring-1 ring-inset ring-line-strong`.
- Tables: header 11px uppercase muted, rows `border-b border-line-soft`, hover `hover:bg-hov`.
- Empty states: dashed border `border-dashed border-line`, centered, muted, one clear next action.
- Responsive: works at 390px wide. Multi-pane layouts collapse to one pane on phones (see leads console
  `@media(max-width:860px)` rules in `.same/ref/leads_console.py`).
- Copy: plain, specific, no hype. Explain WHY something is blocked and the one action that unblocks it.

---------------------------------------------------------------------------
## 3. Workstreams and ownership

### A — Mailboxes (deliverability)
Owns: `backend/src/v2/mailboxes/**`, `frontend/src/screens/Mailboxes.tsx`, `frontend/src/lib/v2/mailboxes.ts`.
MUST export from `backend/src/v2/mailboxes/service.ts`:
- `getSendableMailboxes(): Promise<{ email: string; dailyLimit: number }[]>` — mailboxes in stage
  `ramping` or `active` (never `warming`/`ready`-but-held/`paused`), for campaign `email_list`.
- `syncMailboxes(): Promise<{ synced: number; errors: string[] }>`.

### B — Inbox + Agent (replies, tone, integrations UI)
Owns: `backend/src/v2/inbox/**`, `frontend/src/screens/Inbox.tsx`, `frontend/src/screens/Agent.tsx`,
`frontend/src/lib/v2/inbox.ts`. MUST serve `GET /api/v2/inbox/counts` → `{ unread, needsHuman }`.
Writes prospect outcome on replies: `prospects.stage` (replied|interested|meeting|unsubscribed|bounced|lost),
`prospects.interest`, `prospects.replied_at` — matched by `prospects.email` (lower-case).

### C — Campaigns (AI lead engine + Explee workflow)
Owns: `backend/src/v2/campaigns/**`, `frontend/src/screens/Campaigns.tsx`, `frontend/src/lib/v2/campaigns.ts`.
Imports mailboxes via `await import("../mailboxes/service").catch(() => null)` (A may not be finished).
Never writes threads/messages; reads them only for stats.

### Integrator (lead agent) — owns everything else (App.tsx, index.ts, foundation, Settings, legacy screens).
