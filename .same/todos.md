# Audience — Customer vs Partner ✅ shipped & verified

Every discovery source is tagged **Customer** or **Partner**. The tag rides the
lead into Contacts, and the auto-approve/auto-email automation runs as two
independent lanes, so the two pitches can never cross.

**Rule for existing data:** `audience` is NULL on everything that predates this,
and every read treats NULL as **customer** — the app's original behaviour.

## Backend
- [x] `db.ts` — `discovery_sources.audience` (NOT NULL DEFAULT 'customer'),
      `discovered_leads.audience` (+ index), `contacts.audience`,
      `automation_runs.audience`.
- [x] `pool.ts` — `Audience` + `normalizeAudience`, audience clause in
      `discoveredWhere`, `countApprovableLeads(q, country, audience)`,
      `approveLeads({ filterAudience })`; each contact keeps the tag of the LEAD
      it came from, never a global override.
- [x] `discovery.ts` — `audienceOf(src)`; every inserted lead inherits it.
- [x] `automation.ts` — two lanes. Per lane: switch, trigger/batch size,
      templates, rotate-vs-split, category, country, cooldown, rotation cursor,
      ledger rows. Shared: send rate, daily ceiling, gap, the Resend guard. The
      tick tries customer then partner, one run at a time. Legacy
      `automation_*` settings are read as the CUSTOMER lane's fallback.
- [x] `index.ts` — sources accept `audience`; pool list/approve/reject/delete
      take an audience filter (list also returns the split); `/api/automation`
      takes nested lane patches; `/api/automation/run` takes an audience.

## Frontend
- [x] `api.ts` — lane-shaped automation types, audience on Contact /
      DiscoverySource / DiscoveredLead, audience params on pool + source calls.
- [x] `Discovery.tsx` — Customer/Partner chooser at the top of the Add-source
      modal, badge on every source row and pool row, All/Customers/Partners
      filter with live counts that every bulk action respects, and a lane-aware
      automation strip (one progress bar per live lane).
- [x] `Automation.tsx` — two lane cards (Customers, Partners), each with its own
      switch, progress-to-trigger, batch size, template picker (own-audience copy
      first, foreign copy flagged), category, country and Run now; shared guard
      rails underneath; run history rows carry a lane chip.

## Verified
30/30 in-process checks on a throwaway DB (tag normalising · per-lane counts ·
untagged = customer · approving one lane leaves the other untouched · the
contact keeps the lead's tag · lanes save independently · clamping · legacy
fallback hits only the customer lane · runs tagged + recorded per lane · second
run refused mid-flight), the exact 18-column worker INSERT replayed, plus live
HTTP checks. backend `tsc` clean · frontend `tsc` clean · `vite build` clean.

## Housekeeping (local dev only)
- `backend/data.sqlite` was corrupt at boot again → parked in
  `.same/corrupt-db-backup-5`, recreated. Production is Postgres, unaffected.
  Local login re-seeded from env: **admin / dna-outreach**.
- `frontend/node_modules` was empty again → `bun install`.

---

# Follow-up ladder — retry non-openers / non-clickers ✅ shipped & verified

## What it does
Every email the app sends (campaign OR automation) starts a sequence, and what
the recipient DID with it decides what happens next:

  never opened      → after N hours, retry with a DIFFERENT template
                      still not opened → after M hours, the second retry
  opened, no click  → after N hours, its own retry template
                      still no click → after M hours, the second one
  clicked           → sequence over. They engaged; chasing costs goodwill.

Hard ceiling of 3 emails per sequence (the original + two retries), configured
in Settings → **Follow-up ladder**, with a template AND a wait per rung.

## Backend
- `db.ts`: `sends.followup_step` (0 = original, 1/2 = retries) +
  `sends.followup_branch` ('no_open' | 'no_click'), `idx_sends_contact`,
  `idx_sends_sent_at`, and the `followup_runs` ledger (+ its index).
- `send.ts`: split into `runSendJob` (rotation → a plan) and **`runSendPlan`**,
  one row per recipient carrying its OWN template + rung.
- `followup.ts`: config, the sequence scan, the run executor, a 5-minute worker
  and the ledger. State is DERIVED from `sends` on every pass, never queued.
- `index.ts`: `/api/followup` (GET status+config+ledger, POST save),
  `POST /api/followup/run`; worker started on boot.

## Safety rails
- 3 emails per sequence is a hard ceiling; a CLICK ends the sequence.
- `lookbackDays` (30) — switching it on doesn't blast every contact ever mailed.
- Refuses to run without an **App URL** (no pixel = everyone looks like a
  non-opener) or without a Resend key.
- Daily ceiling + per-pass batch size + send rate; unsubscribed/bounced are
  never chased; a rung with no template is simply off.

## Frontend
- `FollowUp.tsx`: the ladder drawn as a ladder — email 1, then the two branch
  columns, a template + wait per rung, live due/waiting counts, blockers, pass
  history and **Send due now**. Mounted in Settings under Automation.
- `History.tsx`: `retry 1` / `retry 2` badges so the same address twice never
  reads as a duplicate send.
- Retry starter pack in `lib/starters.ts` (8 templates, both voices), also
  exported as HTML in `.same/retry-templates/`.

## Verified
49/49 in-process checks plus a live HTTP pass (config round-trip, refusals,
clamping, garbage payloads) — all green.

---

# Done earlier

## Follow-up ladder (retry automation)
- Retry ladder derived from `sends` (no queue): no-open branch + opened/no-click
  branch, up to 3 emails total, a click ends the sequence.
- `backend/src/followup.ts` engine + worker, `/api/followup*` routes.
- `frontend/src/screens/FollowUp.tsx` card, mounted in Settings under Automation.
- Retry starter pack in `frontend/src/lib/starters.ts` (8 templates, both voices),
  exported as HTML in `.same/retry-templates/`.
- History rows show `retry 1` / `retry 2` badges with the branch in the tooltip.

---

# Automation — auto-approve at N emails → auto-send ✅ shipped & verified

## What it does
When the discovery pool holds N (default 100) PENDING leads that have an email,
the server approves that batch into Contacts and emails them with the configured
template(s) — no clicking Approve, no picking recipients, no Send. Configurable
in Settings → Automation, and every run (including the ones it refuses) is
written to a ledger you can read back.

## Backend
- [x] `db.ts`: `automation_runs` table (trigger, status, pool_count, approved,
      contacts_added, sent/failed/skipped, template names, job id, note, error,
      timings) + `idx_automation_runs_started`.
- [x] `pool.ts` (new): `discoveredWhere` + `approveLeads()` moved out of index.ts,
      so the Approve buttons AND the automation share ONE path — same country
      filter (incl. the `__none__` bucket), same `cleanEmail`/`isValidEmail`
      guard, same `normalizeCountry` override. Returns the new contact ids (how
      the automation knows exactly who to email) and takes `limit` +
      `oldestFirst` so the pool drains FIFO in fixed batches.
- [x] `send.ts` (new): `runSendJob` (+ `buildFrom` / `isEmail`) moved out of
      index.ts; now accepts MULTIPLE template ids and rotates them per recipient.
      `/api/send` accepts `templateIds` as well as `templateId`.
- [x] `automation.ts` (new): config read/write, threshold watcher tick (60s), run
      executor (approve → send), cooldown + daily ceiling + safety checks, history.
- [x] `index.ts`: `/api/automation` (GET config+status+runs, POST save,
      POST /run manual); automation worker started on boot.

## Frontend
- [x] `api.ts`: `AutomationConfig` / `AutomationRun` / `AutomationStatus` +
      `getAutomation` / `saveAutomation` / `runAutomation`.
- [x] Settings → **Automation** card: on/off, trigger size, multi-template picker
      with rotate-vs-split, category + country, send rate, daily ceiling,
      cooldown, progress-to-trigger bar, live batch progress, blockers panel,
      run history, **Run now**.
- [x] Discovery → **automation strip** under the stat row: off ⇒ "these leads
      wait until you approve them" + Set up automation; on ⇒ live progress to the
      trigger, "emailing a batch right now", the first blocker if it can't run,
      and sent-today. Deep-links to Settings through a `dna-navigate` event
      handled by the app shell (`goTo()` in `lib/ui`), so screens stay decoupled.

## Safety rails (all verified)
- A batch is never bigger than the trigger size, nor than what's left of the
  daily ceiling — leftovers wait for the next batch.
- Cooldown between runs, counted from the last run that did work, so a refusal
  can't keep pushing the next real run away.
- Refuses to run with no Resend key (`requireResend`), so a dry run can't
  silently mark a whole pool as emailed.
- Leads without an email never count toward the trigger and are never approved.

## Verified
- **38/38 in-process checks** on a throwaway DB: trigger counting · no-Resend
  refusal (+ ledger row + UI blocker) · batch = threshold · FIFO order ·
  category/country applied · contacts marked sent · merge tags rendered ·
  dry-run sends labelled `sent (dry-run)` · rotate advances the template · daily
  ceiling exact (partial batch of 2 to land on 12/12) · empty pool refused
  without spamming the ledger · no run left hanging in `running`.
- **Live over HTTP**: `/api/automation` 401 without a token; GET/POST config;
  `POST /run` on an empty pool → 400 (not 500); then with 4 leads and a threshold
  of 3 the **worker fired on its own** — "pool reached 4/3 … approved 3 → sent 3",
  leftover 1 left waiting.
- backend `tsc` clean · frontend `tsc` clean · `vite build` clean.

## Housekeeping
- `frontend/tsconfig.json`: dropped the removed `baseUrl` option (TS 5.9 errors
  on it); `paths` still resolves `@/*` relative to the config.

---

# Infinite-scroll directory (tdv.motc.gov.qa) + archive sources

## Verified root cause — tdv.motc.gov.qa/business-directory (1,318 companies, only 1 harvested)
- Drupal 8 view with `views_infinite_scroll`. **3 cards per page, 440 pages** (0-439).
  `items_per_page` is ignored; `/views/ajax` also returns 3.
- Pager uses Drupal's MULTI-pager format `?page=0,1` (`pager_element: 1`).
  `?page=1` alone silently returns page 1 again.
  1. `pageParamOf()` only accepted `^\d+$` → `0,1` unrecognised → no numeric walk.
  2. `withPage()` in discovery.ts wrote `?page=5` → the site returned page 1 → every
     batch re-read the same 3 companies → "0 new" → source declared finished.
- The `rel="next"` href is entity-encoded (`?combine=&amp;…&amp;page=0%2C1`).
  `collectLinks()` never decoded it, so the URL became `amp;page=…` → the
  pagination parameter was lost → page 2 == page 1.
- `useInline` said NO: the page's 3 cards vs. 6 unrelated nav links
  (`/tasmu-digital-valley-services/*-Membership-Form`) failed `distinct >= details*0.6`,
  so the crawler opened membership FORMS instead of reading the cards → 1 lead.
- `registrableDomain("tdv.motc.gov.qa")` returned **"gov.qa"** — every `*.gov.qa`
  site collapsed to the same registrable domain.
- TDV also marks up each company's DESCRIPTION as a second `<h2>`, and the name
  picker takes the last heading → the blurb became the company name.

## Fixes
- [x] `urls.ts`: generic second-level public suffixes (gov/org/net/edu/ac/mil/co/com…
      under a 2-letter ccTLD) → `tdv.motc.gov.qa` → `motc.gov.qa`.
- [x] `directory.ts`: `absUrl()` decodes HTML entities in EVERY href
      (`collectLinks` + `rel=next`) before parsing.
- [x] `directory.ts`: `pageMarkOf` / `setPageValue` understand multi-value page
      params; the moving slot is the last non-zero one. `pageNumberOf` now returns
      `null` (not 0) for "no marker", so a 0-indexed pager isn't unreachable.
- [x] `directory.ts`: `useInline` also wins when the detail links don't match the
      cards' own hrefs (nav links, not listings).
- [x] `directory.ts`: inline mode is STICKY for the rest of a walk — the shell page
      past the end can't fall back to the site menu (that's how the directory's own
      `tdvinfo@mcit.gov.qa` leaked in as a "company").
- [x] `directory.ts`: returns `nextUrl` — the exact next unread page (or `null` at the
      end) — so a walk resumes through ANY pager shape.
- [x] `directory.ts`: `maxListings` soft budget — stops BETWEEN pages, never mid-page,
      so the resume point is always a whole page.
- [x] `directory.ts`: `looksLikeName` rejects prose (>14 words, or two sentences) and
      `pickCardName` ignores headings longer than 160 raw chars.
- [x] `discovery.ts`: directory batches resume from the stored `next_url`; budgets are
      25 pages OR 40 listings, whichever comes first; `walkedOff` (`nextUrl === null`)
      ends the walk; `stalled` now keys off "did we read a page", not cursor maths;
      `withPage`/`initialCursor` are multi-pager aware.
- [x] `db.ts`: `next_url` column + `SQLITE_PATH` override (two processes on one WAL
      file corrupt it — that's what kept trashing `data.sqlite`).

## Archive sources
- [x] `db.ts`: `archived` + `archived_at` on `discovery_sources`.
- [x] Worker scheduling, `getDiscoveryStatus()` counts and the boot report all ignore
      archived sources.
- [x] `GET /api/discovery/sources?archived=1` (+ `archivedCount`),
      `POST …/:id/archive`, `POST …/:id/unarchive`; "Run now" refuses an archived source.
- [x] Discovery UI: an **Archive** action per source, a collapsible **Archived** drawer
      showing type · leads found · where it stopped · when it was archived, with
      **Restore** and permanent delete. Delete now warns and suggests archiving.

## Verified live
- **TDV, 3 batches from page 1** → pages 1-14, 15-28, 29-42 · **125 leads, 0 bad names**,
  89 emails / 116 phones / 97 websites. Resume URL advanced exactly:
  `page=0,14` → `page=0,28` → `page=0,42`.
- **TDV tail (resumed at `page=0,435`)** → walked 435→440, 13 leads, then
  `FINISHED — the last page had no next page`, `exhausted=1`, `next_url=null`.
  No directory-owned contact leaked in.
- **CRA regression** → batch 1 pages 1-5 (48 leads), batch 2 pages 6-9 (40 leads),
  88 leads, 0 bad names — the listing budget keeps batches at ~4 pages as before.
- **Archive API** → archive hides it from the list + every count, `archivedCount:1`,
  "Run now" refused, restore puts it back with `archivedCount:0`.
- 24/24 offline checks (registrable domains, page cursors, name validation).
- backend tsc clean · frontend vite build clean.

---

# Previously shipped (condensed)
- **Repair company names** (`backend/src/repair.ts`): `GET /api/discovery/bad-names`,
  `POST /api/discovery/repair-names`, Discovery banner + live progress;
  `insertDiscovered` self-heals a junk stored name on a later harvest.
- **Full CRA walk**: `pagesRead` (contiguous reads only) drives the cursor, blocked
  pages retry with a doubling cooldown, `productive = extracted >= 2` so the walk
  terminates. 391 leads / 41 pages verified.
- **Directory harvest stored the PHONE as the company name**: locale-aware path
  templating, parent-path detail grouping, card-segmentation `harvestInline`,
  `looksLikeName` + `pickCardName`, chrome filter by page frequency, captcha-page
  detection in `fetcher.ts`.
- **Web search source** (`search.ts` + `runSearchSource`): keywords × country/cities
  query plan walked by cursor, reader-backed so DuckDuckGo's IP block is bypassed.

---

# Todos

## Map area (OSM) source — "Jordan found only 60+ in 3 days"

Measured live against Overpass (Jordan, relation 184818):

| scope | POIs | website | email | phone |
|---|---|---|---|---|
| old query: office/shop/craft | 3,943 | 134 | **61** | 237 |
| new query: + amenity/tourism/healthcare/leisure/industrial | 18,823 | 717 | 391 | 861 |

The 61 emails WERE the entire database. Not a speed problem — a ceiling problem.

- [x] Widen `Companies (general)` to every business key, not just office/shop/craft
- [x] Accept phone as a contact signal (was website/email only)
- [x] Collapse contact keys into one key-regex (81 statements -> 9, no timeouts)
- [x] Deny-list street furniture (ATMs, benches, car parks) that carry contact tags
- [x] Ignore social/profile links in `website` (youtube/facebook were becoming "domains")
- [x] Tile the area into a ~0.6-degree grid; sweep 6 tiles/batch via `cursor`
- [x] Fix bbox ordering ([S,N,W,E] from Nominatim -> [S,W,N,E] for Overpass)
- [x] Probe `out count` once per pass -> `osm_available` (the real ceiling)
- [x] "Run now" on a finished sweep restarts from tile 1
- [x] UI: sweeping · tile n of m / swept the whole area · "N of M on the map"
- [x] Rewrite the modal note that claimed re-scanning "can't surface more"

Verified end-to-end: 12 of 56 tiles (the empty southern desert) -> 132 leads,
43 emails, 77 websites. Old system: 61 emails in 3 days for the whole country.

## Delete/archive/pause left the running batch alive

Delete only removed the DB row. The batch already in flight kept going (a
country sweep is ~70s, a directory batch is minutes) and kept filing leads
under a source that no longer existed — so the bot really was "still active"
after you deleted it.

- [x] Cooperative stop flag (`stopSource` / `stopAllSources`) + DB backstop
- [x] Checkpoint before every OSM tile, directory page and search query
- [x] DELETE, archive and switch-off endpoints now signal the worker
- [x] Bot master switch OFF halts the in-flight batch too
- [x] A stopped sweep keeps its position — resumes at the tile it never reached
- [x] Delete confirm warns when it's mid-scan; toast confirms the stop

Verified: control batch 71s / 6 tiles. Deleting 5s in -> stopped at 11s,
zero leads added after the delete, position preserved.

## Country was blank on approved contacts, and unfilterable in the pool

Leads DID have a country column, and approve DID carry it. Three holes made it
useless:
  a) Directory's Country field was labelled "helps read local phone numbers",
     so it was left blank -> country "" -> approves as NULL
  b) Map area stored the raw pick: "Amman, Amman Governorate, Jordan"
  c) No country column, no country filter; the visible "Country (optional)" box
     is a WRITE override, easily mistaken for a filter. Approve all ignored it.

- [x] `backend/src/country.ts` — canonical names, alias/city-path normalisation,
      ccTLD and dialling-code inference
- [x] All three source runners resolve: source -> domain TLD -> phone code
- [x] Boot backfill repairs existing leads AND contacts (set-based SQL)
- [x] `discoveredWhere` gains a country filter; `__none__` = no country on file
- [x] Approve/reject/delete "all" honour the filter via `filterCountry`
- [x] Country column in the pool; click a value to filter by it
- [x] Country dropdown with per-country counts for the whole tab
- [x] "Approve all N in Qatar -> Contacts" label reflects the filter
- [x] Relabelled the override box; Directory Country hint now tells the truth
- [x] Dropped `.co` from TLD inference (generic startup TLD, not Colombia)

Verified: city paths and aliases normalise, .jo/.com.qa/+962/+974 all infer,
backfill fixed 4/5 legacy rows (the 5th has a local phone + gmail = genuinely
unknowable), and approval carries the country into Contacts.

## Log review — email finding (2026-08-06)

Measured from the posted log: 07:52:21 → 07:58:40 = 379s, ~22 leads = **17s/lead**.
Actual work per lead is 1–3s. **~85% of the loop is idle**, waiting for the next tick.

- [x] Fix 1 — parallel enrichment: batch (12) + worker pool (4) + chain 750ms instead of idling 15s
- [x] Fix 2 — website-bearing leads always fill the batch first, no-site tail only tops up
- [x] Fix 3 — dedup_key UNIQUE race caught and retired like any other duplicate
- [x] Fix 4 — companyNameFromTitle: domain match wins (skipping a bare URL fragment),
      COMPANY_SUFFIX capped at 6 words, address + category tails cut, "Website" stripped
- [x] repairPageTitleNames now also re-selects names with a comma tail, so the
      already-mangled rows get repaired on next boot
- [x] Verified: tsc clean on both files, boots clean

## Web search quality (2026-08-06, v55)

Root cause: the QUERIES, not the filters. "Companies (general)" generated head
terms — "companies", "suppliers", "establishment" — which no operating company
competes for. Page one of "companies Qatar" is structurally directories,
listicles and company-formation agencies.

- [x] Head terms removed; general sweep = portfolio of specific trades + Gulf
      legal suffixes ("trading and contracting W.L.L.", "MEP contractor")
- [x] Query variants: dropped "<kw> in <place> contact" (reads as a question,
      pulls explainers) for "<kw> <place> contact" and quoted "<kw>" <place> email
- [x] isContentTitle(): rejects guides, rankings, B2B directories, news
      headlines, and category phrases ("Companies in Qatar")
- [x] SETUP_BLOCK: company-formation agency cluster (qshield, emerhub, qcfglobal,
      agentsgrp, generisonline, rch, qatarcompanyformation …)
- [x] OFFICIAL_BLOCK: regulators/exchanges/gov/edu (qfc.qa, qe.com.qa)
- [x] rejectContentLeads() + repairEscapedEmails() wired into boot
- [x] BUG: JSON escapes not decoded → "u003einfo@companydata.com" was saved as a
      real address. decodeEntities now handles \uXXXX and \xXX
- [x] REGRESSION FIX: ADDRESS_TAIL matched thousands separators, so
      "List of 15,506 Registered Companies" → "List of 15". Now requires a space
- [x] Validated: 20/20 junk titles rejected, 11/11 real companies kept

## Unmailable addresses: markup glued to the local part
Seen in the pool: `//info@rumaillahgroup.com`, `//sales@sagarsteel.net`,
`%20info@mepeqatar.com`. All three were saved as "likely" contacts.
- Root cause: RFC 5321 permits `/`, `%`, `!`, `=` in a local part, so the old
  `EMAIL_RE` charset and `isValidEmail()` both accepted them. Two sources:
  1. `mailto://info@x.com` — a common authoring slip. `mailto:([^"'>\s?]+)`
     captured the slashes; the text regex did too, since `/` was legal.
  2. `mailto:%20info@x.com` — URL-encoded padding, never decoded.
- [x] `decodeEntities()` decodes `%00`–`%20`/`%7f` to a space before matching
- [x] `EMAIL_RE` local part narrowed to `[a-z0-9._+'-]`, must start/end
      alphanumeric, plus a lookbehind so a match can't start mid-token
- [x] mailto regex skips stray slashes (`mailto:\/*`)
- [x] `cleanEmail()` peels repeated/malformed schemes, percent-decodes, and cuts
      the local part at the last markup separator; domain side sanitised too
- [x] `isValidEmail()` now stricter than RFC on purpose — glue can't pass
- [x] `repairEscapedEmails()` widened from JSON-escapes to every mangled row;
      clashes → duplicate, unsalvageable → email cleared and lead re-queued
- [x] Approve / bulk / manual contact inserts validate before writing to
      `contacts`, so junk can never reach the sender
- [x] Verified: 4 mangled rows repaired, clash deduped, unsalvageable re-queued;
      `first.last+tag@`, `sales_2@steel-works.com.sa`, multi-label ccTLDs intact

## Search source stalled for 16h on one step (rate limit + cursor bug)
Log evidence: `Qatar — step 46/300` repeated hourly from Aug 7 16:11 to Aug 8
08:43. Steps 25, 34, 37, 40, 43 stalled the same way. ~21 plan steps in 2 days.
- ROOT CAUSE: `runBatch` only saved the cursor when `r.okish` was true. A batch
  that ran 2 queries fine and got rate-limited on the 3rd threw away ALL of it.
  Next hour it re-ran the same 2 queries (`+0 new` both), hit the same limit on
  the 3rd, and never moved. `runSearchSource` had computed the right cursor the
  whole time — the caller discarded it.
- Compounding: p2 requests are ~half of all traffic and nearly always `+0 new`,
  and they're what trips the limiter. Blocks were also punished with the
  source's FULL interval (60m) when the engine's ceiling is per-minute.
- [x] Cursor advances by queries actually covered, even on a block; the blocked
      query stays next up (`covered` counter, separate from pages fetched)
- [x] Block backoff 3 → 6 → 12 → 24 → 30m, reset by any progress (`block_streak`
      column added via idempotent migration)
- [x] p2 skipped when p1 returned zero NEW sites — halves request volume
- [x] `SEARCH_BLOCK_SKIP_AFTER=5`: a query refused 5× with zero progress is
      stepped over, so one poisoned entry can't hold a pass hostage
- [x] Switched-off mid-batch no longer shares the `blocked` path (no fake backoff)
- [x] Block message no longer says "add a free JINA key" when one is configured
- [x] Verified by replaying step 46 with p2 permanently blocked: partial progress
      kept (47→48), backoff escalated 3/6/12/24m, step-over fired on the 5th,
      then a clean run covered 3 entries with 2 requests (47→50)

### Still open
- Geographic drift: Gulf city names matching US homonyms (Medina OH, Hail TX)
- OSM map source still sweeping micro-businesses with no websites
- Web search has a structural ceiling (~10 results/query); Directory sources are
  the higher-yield path for volume
- Crawler give-ups are dominated by Cloudflare; a scraping proxy is the only
  real fix for those (`vymaps`, `datanyze`, `muqawil`, `arablocal` …)
- Local dev SQLite corrupts if the bun process is SIGKILLed while holding the
  WAL. Shut the dev server down with plain `kill`, never `kill -9`.

## Crawler efficiency rollout (agreed 2026-08-13)

Diagnosis: search is healthy; enrichment collapsed when the Jina key hit HTTP 402
at 07:45:12 (~10 blocks/21min before → ~56 blocks/7min after). On top of that
~1 in 5 crawls is a re-crawl of a domain we already resolved.

### Phase 2 — recover wasted capacity (free, needs nothing from the user)
- [x] 4. Domain tombstone: new `pool_domains` ledger claims a domain atomically on
      insert and never releases it, so promoting `dedup_key` to `e:<email>` can no
      longer let the same site be re-discovered and re-crawled. Backfilled on boot.
- [x] 5. Split retry ladder: `blockReason` now surfaces on `SiteResult`;
      cloudflare/403 → 2 tries (30m, 6h) then parked, transient → full 6-try ladder
- [x] 6. `isNonProspectHost()` in search.ts is now the single gate, applied at
      insert, at enrich, and in a boot sweep (`sweepNonProspectLeads`). Added
      `AGGREGATOR_BLOCK` + `.directory`-style TLD guard + `domainLooksForeign()`
- [x] 7. robots.txt + sitemap deferred until the seed answers; a walled site now
      costs 1 request instead of 7, and a hard block stops the crawl immediately
- [x] 8. Enrich batch de-duplicated by registrable domain (`more` measured on the
      pre-filter list so the chain doesn't stall)

Verified end-to-end on a scratch DB: 8 seeded leads → backfill claimed 8, sweep
retired 6 junk (nascar/datanyze/ohio/.directory/herecareers/muqawil), the two real
companies survived, and a resolved domain could no longer be re-claimed.

NOTE: local `backend/data.sqlite` was already corrupt at 07:51 (pre-existing WAL
issue, identical backup in .same/corrupt-db-backup). Moved to
.same/corrupt-db-backup-2 and recreated empty. Production is Postgres — unaffected.

### Phase 1 — free bypass capacity
- [x] 1. UI/logs no longer lie: `bypass.readerKeys{Configured,Live}` + `readerKeyRejected`
      come from the fetcher's real observations, badge turns RED on exhaustion
- [x] 2. Multi-key rotation: comma/newline separated keys, per-key rejection with a
      30m re-test, round-robin. One key dying no longer drops the bot to 20/min.
- [x] 3. Wayback tier (`web.archive.org/web/2id_/…`) inserted between the reader and
      the paid proxy. Budgeted to 2 calls/site (≈11s each), and the sitemap is
      skipped when the seed only arrived via reader/archive/proxy.

Live-tested Wayback against the 5 sites that hard-blocked in the log:
  qgcontracting.com  → quantumcont14@gmail.com
  benzcontracting.ae → info@benzcontracting.ae
  kon-uae.com        → info@kon-uae.com
  qmic.com           → business@qmic.com
  baobabtrading.com  → archive 403 (the only miss)
Key pool tested with 3 bogus keys: rotated 1→2→3, fell through to the free tier,
still returned the page, and flipped keyRejected=true so the UI goes red.

### Phase 3 — email quality
- [x] 9. `PLACEHOLDER_LOCAL` catches yoursite@ / youremail@ / example@ on any domain
- [x] 10. `roleRank()` orders info/sales > support > finance > person > hr > abuse
      /no-reply, and BOTH pickers now use it (discovery.ts previously preferred
      personal addresses while enrich.ts preferred role ones — they disagreed)
- [x] 11. `MAILTO_ARTIFACT` rejects mailoinfo@ / mailtoinfo@ while keeping
      mail@, mailbox@, mailroom@
- [x] 12. Query saturation: new `search_query_stats` table. Two consecutive
      zero-yield passes cools a query off for 6h, doubling to 72h max; ANY yield
      resets it. Deliberately a cool-off, not a permanent skip.

INCIDENT: the apply model duplicated ~900 lines of discovery.ts and invented two
bogus helpers during item 12. Repaired by deleting lines 1851-2702 and 2749-2779;
verified all 17 exports still present and typecheck clean. No git repo here, so
/tmp/discovery.broken.ts was kept until the repair was confirmed, then removed.

# Discovery sources — collapsible container ✅ shipped

The sources list sat between the stat strip and the review pool, so on a screen
with several sources the pool (the thing you actually work) started below the
fold. The card now folds away.

- [x] `Discovery.tsx`: the card header is the toggle, using the accordion
      pattern — `<h2>` WRAPS the `<button>`, so the whole title is clickable
      without putting block elements inside a button. `aria-expanded` on the
      button; chevron rotates 180°.
- [x] Body animates with `grid-rows-[1fr] ⇄ [0fr]` + an `overflow-hidden` child,
      so it opens to the content's real height — no hard-coded max, and a source
      that starts streaming mid-open still fits.
- [x] Collapsed header carries a live summary (`N active · N paused · N archived
      · N found`) plus a green **"N scanning"** pill with a spinner, so folding
      the list away can never hide the fact that a batch is running.
- [x] Count badge next to the title; the empty state keeps its own copy.
- [x] **Add source** expands the card as well as opening the modal — you always
      see the row you just created.
- [x] Past 6 sources the list scrolls inside the card (`max-h-[26rem]`) so the
      review pool stays reachable even when expanded.
- [x] Open/closed persisted in `localStorage` (`dna-discovery-sources-open`),
      read/written through try/catch because storage can throw in an iframe.
- [x] The Archived drawer nests inside the collapsible body and keeps its own
      independent toggle.

Verified: frontend `tsc` clean · `vite build` clean · Tailwind emitted
`grid-rows-[0fr]` / `grid-rows-[1fr]` / `transition-[grid-template-rows]` /
`max-h-[26rem]` · all 21 original declarations and all 7 section banners intact.

INCIDENT: the apply model stripped ~30 explanatory comments across the whole
file (and flattened two typographic apostrophes) while making this edit. The
file was rebuilt from the original and every comment restored; there is no git
repo here, so this was verified by diffing declaration-by-declaration.

NOTE: local `backend/data.sqlite` was corrupt again on boot — THREE dev servers
had stacked up, two of them backends writing the same WAL, which is exactly the
documented corruption cause. All were shut down with SIGTERM (never `kill -9`),
the corrupt file moved to `.same/corrupt-db-backup-3`, and a single dev server
restarted. Production is Postgres — unaffected.

---
