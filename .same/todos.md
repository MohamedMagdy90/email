# Fill rate — is discovery feeding the automation? (2026-08-25) ✅

Replaces **Discovery → Pending review** and **Overview → Contacts** with one
number: emailable leads arriving per 10 minutes, against what the automation
actually eats. Every other figure on those two screens is a LEVEL, and a level
cannot answer the question either screen exists to answer — will this still be
sending tomorrow? A pool of 4,000 with nothing coming in and a pool of 400 with
plenty coming in read identically right up until the first one stops.

Neither replaced card lost anything: the pending count is already on the pool
tab below it, and the contacts total is already in the middle of the donut.

## 1. The target derives itself
A lane approves `threshold` leads and can only fire once per `cooldownMinutes`,
so it consumes `threshold / cooldown` — 150 every 3 hours IS 8.3 per 10 minutes.
Nothing to enter, nothing to keep in sync: change the batch size or the cooldown
and the target moves with it.
- [x] Capped by the shared daily ceiling, proportionally across live lanes. You
      cannot need more leads than the sender will ever send, and a card demanding
      1,200/day against a 300/day ceiling would be permanently, wrongly red
- [x] A lane that is switched OFF adds no demand — and its arrivals don't count
      either, because a partner haul cannot feed a starving customer lane
- [x] With no lane live at all: the rate is reported, no verdict given

## 2. `email_at`, and why `created_at` could not do this job
A lead is worth nothing to the automation until it has an address, and the gap
between discovery and address is the crawl queue — days long precisely when the
crawler is being walled, which is precisely when this number has to be right.
On `created_at` the metric would have reported a healthy inflow right through an
outage, then gone red days after it ended.
- [x] Column + index, stamped in all three places an address reaches a lead:
      listed on the card at insert, found by a crawl, and cleared again when
      `repairEscapedEmails` decides an address is unsalvageable
- [x] One-time backfill from `created_at` for rows that predate the column —
      the best answer available, and only ever read for history older than the
      deploy. Flag-guarded so a 10k pool isn't re-scanned every boot

## 3. Saying WHY, not just that
A red light with no cause is a puzzle. `reason` names it, ordered by how much it
explains: bot off · no sources on · every live source dry · and the one that
separates two failures that look identical from outside — *"1,284 companies
arrived, none with an email"*, which is a crawler problem (walls, no key), not a
discovery one, and has a completely different fix.

## 4. Two things live data caught that the design hadn't
- [x] **8.0 against a target of 8.3 turned the card red.** Being 4% under over a
      three-hour window is noise — one directory page landing either side of the
      boundary moves it further. Bands now: ok ≥ 95%, red only under 60% AND
      with less than 12h of banked leads. A light that goes red for noise is a
      light nobody looks at
- [x] **Turning the bot on lit it red for three hours.** Time the bot spent
      switched off is not time it failed to find anything. The window now
      measures from the later of the pool's age and `discovery_enabled_at`

## Also fixed while building
- `api.ts` wrote the auth token straight to `localStorage`. Inside an iframe
  with partitioned storage — and in Safari private mode — that THROWS rather
  than returning null, on the first line of the auth check, so the app fell
  through to a login screen that could never be got past (signing in writes the
  token too, so it threw again). Falls back to an in-memory session.
- `db.ts`'s corrupt-database guard matched `malformed|corrupt|not a database`.
  The ninth corruption said **`unsupported file format`**, sailed past the
  guard, and took the API down at boot — the exact failure that code exists to
  absorb. Widened, and it caught the tenth an hour later.
- The 13 parked `data.sqlite.corrupt-*` files moved to `.same/corrupt-db-backups/`.

## Verified
`scripts/verify-fillrate.ts` — **57/57** offline: the target derives from the
lane config · warming gives no verdict · an established pool at exactly target
reads 8.3 · **200 leads discovered a month ago whose emails were also found a
month ago don't inflate today's rate, and 30 emails found ten minutes ago on
month-old leads do count** · the tolerance band · slow-vs-starved by cover ·
each of the four reasons · an off lane's arrivals excluded, then included when
it is switched on · rejected/duplicate never counted · the daily-ceiling cap ·
the bot-just-switched-on window · idle · sparkline bucketing and totals · ETA ·
and the production migration path (20 pre-existing emailable rows stamped, 7
address-less ones left alone, no re-scan on the next boot).

`verify-recheck.ts` 28/28 and `verify-names.ts` 29/29 still pass. backend `tsc`
clean · frontend `tsc` clean · `vite build` clean · live over HTTP on both
`/api/discovery/status` and `/api/overview`.

⚠️ The dev-only seed and the preview auto-login used to check this were removed.
⚠️ `.git` has been wiped from the container AGAIN — re-attach with `git init` +
`fetch` + `reset --mixed origin/main` before pushing. Not committed yet.

---


# Stale sources: switch them off, and stop the note eating the row (2026-08-25) ✅

## 1. The stale note was a paragraph in a 100px column
On a 390px screen the source row is `switch | text (flex-1) | actions (shrink-0)`.
The four action buttons are ~250px and never shrink, so the text column got what
was left — about 100px — and every line broke one word at a time. The title was
squeezed out of existence entirely and the stale sentence ran thirteen lines,
taller than the row it was describing.
- [x] Actions drop to their own line under `sm`, so the text column gets the full
      row width. Same markup rendered in two places rather than two variants
- [x] The note is a full-width strip under the row, not a third line inside the
      middle column, with a top rule so it reads as a footnote to the source
- [x] Copy cut to what is actually actionable: `5 dry runs · last find 12d ago`
      (or `never found anyone`), plus `off at 4` while it is still running, and a
      `Re-aim` link. The rest moved to the `title`

## 2. A flagged source kept running anyway
Flagging a spent source but leaving it scanning means it keeps spending crawl
budget, rate-limit headroom and reader quota on ground it has already covered —
every barren run is taken from a source that would have found someone.
- [x] `STALE_OFF_AFTER_RUNS = 4`, alongside the existing flag at 2 — two
      thresholds so there is a warning before the switch actually moves
- [x] `barrenState()` now also returns `off` / `enabled` / `autoOff`; all three
      source types write `enabled` and `auto_off` with the rest of the batch
- [x] `off` requires the run to have COUNTED, for the same reason it can't raise
      the streak: a blocked source has not been shown to be empty. It also
      requires the source to have been ON, so the transition (and its log line)
      fires once rather than on every later run
- [x] `cont` is false when a source switches itself off — otherwise a directory
      or search would keep streaming a source it had just disabled
- [x] `auto_off` column so the row can say "switched off" instead of looking
      like somebody paused it by hand
- [x] Switching it back on BY HAND clears the counter. Without that the bot runs
      it once, sees the same dry result and switches it straight off again,
      which reads as a broken toggle. Only a real 0 → 1 transition counts, so
      re-scheduling or re-saving an already-on source keeps its history
- [x] A manual "Run now" DOES count — it restarts a finished source from the
      top, so a full pass that finds nobody is the strongest evidence there is

**Verified.** 12/12 offline checks on the threshold logic: the streak counts
1–5, flags at 2, switches off exactly at 4 and does not re-fire at 5; a blocked
run neither advances it nor switches off even at 9; a find resets it. Live over
HTTP: bot-off source shows `enabled=0 barren_runs=5 auto_off=1 staleCount=1` →
switched on by hand → `enabled=1 barren_runs=0 auto_off=0 staleCount=0`; changing
only the interval, and re-saving an already-on source, both leave `barren_runs=3`
untouched; re-aiming it at a new country clears it. Both typechecks and the vite
build are clean.

---

# Overview repair + stale sources (2026-08-25) ✅ shipped & verified

## 1. "Emails sent · last 14 days" bars were all flat
Root cause is CSS, not data: the chart row is `flex h-40 items-end`, so
`align-items: flex-end` stops the columns being stretched — each column's height
becomes its CONTENT height. The bar track inside is `flex-1` of that auto-height
column, so it resolves to 0, and the bar's `height: N%` is a percentage of zero.
Every bar collapsed to its 4px `minHeight`, which reads as "all zero".
- [x] Redraw the chart with pixel heights computed in JS against a known `TRACK`
      constant — no percentage of an auto-height parent anywhere in the chart,
      which retires the whole class of bug rather than nudging this instance
- [x] Two counting bugs found while fixing the geometry: the series counted
      EVERY row in `sends` (failures and still-queued included), so it disagreed
      with the "Emails sent" card directly above it; and it bucketed on
      `created_at`, so a mail queued 23:50 and delivered 00:05 landed a day early
- [x] Backend owns the calendar now: all 14 days pre-filled, keyed on
      `COALESCE(sent_at, created_at)`, split into sent / failed / opens / clicks.
      It used to return only the days that HAD rows and leave the browser to line
      them up against a locally-built calendar — which silently dropped today's
      bucket for any viewer east of UTC
- [x] `buildDailySeries` still pads, but anchors on the newest day the SERVER
      reported, so an older API keeps working without handing the axis back to
      the viewer's clock

## 2. Automation batch bars only existed on Discovery
- [x] Extracted to a shared `AutomationLaneBars({ lanes, className, size })` and
      used on both screens, so the two can't drift
- [x] Overview `AutomationCard` also states WHY nothing is moving — master off,
      both lanes off, or the first blocker — instead of just drawing empty bars

## 3. Stale sources — "ran twice and fetched nobody"
- [x] `discovery_sources.barren_runs` / `last_found` / `last_found_at`.
      Deliberately NOT `empty_streak`: that is walk bookkeeping ("these pages
      held no more listings"), it drives `exhausted`, a manual Run now resets it,
      and it never applies to map areas at all
- [x] Counted in `runBatch` for all three source types via one `barrenState()`
      helper. A blocked / rate-limited / errored / hand-stopped batch does NOT
      count — it can neither raise the streak (that would libel a blocked source
      as spent) nor reset it (that would let a permanently blocked source hide
      behind its own failures)
- [x] Re-aiming a source (url / keywords / location / category / place / sweep)
      clears the counter — that IS the replacement. Pausing, renaming or
      re-scheduling doesn't, since none of those change what it can find
- [x] `staleSources` on `/api/discovery/status`, `staleCount` on the sources
      list, `sources.stale` + `staleList` on `/api/overview` — all three read the
      same `barren_runs >= STALE_AFTER_RUNS` so they can't disagree
- [x] Discovery: amber left-border + "stale" chip per row, a "N sources have run
      dry" banner, and a stale-only filter
- [x] Overview: Stale sources metric deep-linking into Discovery via
      `goTo("discovery", "stale")` + one-shot `takeFocus()`, which opens the
      sources card, switches the filter on and scrolls it into view. Landing on a
      tab of forty rows and leaving the reader to find the two being pointed at
      is a hint, not a link

**Verified.** Backend `tsc --noEmit` clean, frontend `tsc --noEmit` + `vite build`
clean. Live check with four sources at `barren_runs` 3/2/1/0: overview
`stale=2`, `/discovery/status` `staleSources=2`, `/discovery/sources`
`staleCount=2` — the 1 and the 0 correctly not flagged. `/api/overview` returns
14 buckets with sent/failed/opens/clicks on each.

⚠️ The dev-only seed route and the preview auto-login used to check this were
removed before the commit; `POST /api/dev/seed` now 404s.

Pushed as **`c5aeec3`** to `MohamedMagdy90/email` (`8d32bff` → `c5aeec3`).
Note the container had wiped `.git` again — re-attached with `git init` +
`fetch` + `reset --mixed origin/main`. `frontend/{package.json,tsconfig.json,
vite.config.ts,bun.lock}` carry Same-IDE-only edits (`same-runtime`,
`react-grab`, `jsxImportSource`) and were deliberately left OUT of the commit.

---

# Cut the Jina bill — free page sources instead of paid reader tokens ✅ shipped & verified

## Problem
Jina keys kept hitting HTTP 402 (out of tokens) and topping them up was getting
expensive. The cause was not volume, it was ORDER: the reader was the FIRST
escalation everywhere, so it absorbed essentially every blocked fetch.

Reader call sites before this:
- `search.ts` — every walled results page (the big one: DuckDuckGo walls a
  datacenter IP within ~3 queries, so nearly every search page became a token)
- `crawler/index.ts` — first escalation on a blocked page, 2 per site
- `enrich.ts` — website resolution

## The new ladder (cheapest first, stop at the first real page)
```
1. direct fetch     free, unlimited      browser-shaped request, rotating UA
2. Common Crawl     free, unlimited      someone already crawled it
3. Wayback          free, rate-limited   someone already archived it
4. Jina reader      PAID (tokens)        renders JS — only what the archives miss
5. scraping proxy   PAID (credits)       residential IPs — last resort
```
A Cloudflare wall is not a property of the page, it is a property of us asking
from a datacenter IP. Somebody already fetched that page and wrote it down, so
we read their copy — free, no key, no signup.

## What was measured before building (5 probe rounds, from this container)
| source | verdict |
|---|---|
| Common Crawl index + WARC range + gunzip | **WORKS** ~1.2s · free · no key |
| CC coverage varies per crawl | kon-uae.com held 0 / 1 / 6 / 40 rows across 4 indexes → must query several |
| Wayback CDX + `id_` snapshots | 429 from this IP; proven in production earlier → kept, with backoff |
| Bing RSS (`&format=rss`) | **10/10 queries** while everything else was walled · 5 KB · ~100ms |
| Brave HTML | great results, walls after ~10 queries |
| DDG html / lite | good results, walls fastest |
| allorigins · codetabs · corsproxy · cors.lol · whateverorigin · thingproxy | all dead / 403 / key-gated → **not used** |
| Marginalia | non-commercial index, returns no companies → dropped |
| SERP snippet → email | 1 of 5 domains → not worth a tier |

## Built
- [x] `crawler/http.ts` (new) — shared `rawFetch`/`rawBytes`, realistic browser
      headers incl. client hints + `Sec-Fetch-*`, UA rotation per attempt, block
      detection, and per-transport counters. Exists so transports can share the
      floor without a circular import.
- [x] `crawler/archives.ts` (new) — Common Crawl (collinfo → multi-index CDX →
      WARC byte-range → gunzip) and Wayback (CDX page index + `id_` snapshots),
      each with per-domain caching, global pacing and tolerant backoff.
      `archivedPagesFor(domain)` ranks a domain's archived contact pages.
- [x] `crawler/fetcher.ts` — re-ordered the ladder; re-exports the shared types
      so every existing import keeps working. Reader demoted to tier 4.
- [x] `crawler/index.ts` — when a live crawl ends walled with no email, sweep the
      domain's archived contact pages. This is the part that cracks a site we can
      never open: the archive is an INDEX, so it hands us `/contact` without the
      walled homepage ever linking to it. Reader budget 2 → 1, archives 2 → 3.
- [x] `search.ts` — rotating pool of four keyless engines (DDG html, DDG lite,
      Brave, Bing RSS) with per-engine parsers and cooldowns, ahead of the
      reader. Plus `REFERENCE_BLOCK` — Bing reads "electromechanical company
      Riyadh" as a vocabulary question and returns Merriam-Webster.
- [x] `enrich.ts` — archives inserted ahead of the reader.
- [x] `/api/settings` → `transports` (per-tier pages, archive health, engine
      health); Settings → **Where pages come from** card shows the free/paid
      split; reader + Discovery copy rewritten (a missing key is now a normal,
      supported state, not a warning).

## Verified
- **Walled sites cracked from free archives alone:** `kon-uae.com` →
  `info@kon-uae.com`, `qmic.com` → `business@qmic.com`. Both had previously only
  ever been reachable via the paid tiers. `qgcontracting.com` is in neither
  archive and now says so honestly ("a scraping proxy is the only thing that
  opens these") instead of burning tokens to find out.
- **Live discovery pass** (Qatar · Construction, real run against the dev
  server): 149 pages delivered — 145 direct, 4 reader → **97% free**. Real leads
  found: `info@city-stars.qa`, `contraco@contraco.com.qa`, `info@pscc.sa`,
  `info@kobraish.com.sa`, `info@amadconstructions.com`.
- **Walled-only run:** direct delivered 0 of 15 attempts, Common Crawl delivered
  8 — i.e. 100% of the emails on walled sites came from a free archive.
- Search pool served 6/6 queries with 0 reader calls; engine rotation and
  resting confirmed (`duckduckgo`, `duckduckgo-lite`, `brave` resting,
  `bing-rss` live).
- backend `tsc` clean · frontend `tsc` clean · `vite build` clean.

## Bugs found and fixed while building
- `rawFetch`'s content-type gate rejected `text/x-ndjson`, which is what the
  Common Crawl CDX server returns — every lookup looked like a failure and
  backed the whole source off. Added `anyContentType` for index calls.
- The archive backoff fired after ONE failure, so a single 502 from one CC shard
  disabled Common Crawl for every domain that followed. Now only a run of 4
  failures with no success in between counts.
- `fetchViaWayback` asked for timestamp `2`, i.e. the snapshot nearest the year
  2 — the OLDEST capture on file. For an email that is the wrong end of the
  history; it now asks for `3000` (the newest).

## Notes
- Wayback 429s this container's IP on every call, so its contribution could not
  be measured here. It cracked 4 of these 5 domains from the Railway IP in the
  earlier session, and the code paces it at 2s with a single 429 retry.
- Env kill-switches: `DISABLE_COMMONCRAWL=1`, `DISABLE_WAYBACK=1`,
  `DISABLE_READER=1`.

## Housekeeping (local dev only)
- `backend/data.sqlite` was corrupt at boot again → parked in
  `.same/corrupt-db-backup-6`, recreated. Production is Postgres, unaffected.
- `frontend/node_modules` was missing its binaries again → `bun install`.
- Local login re-seeded from env: **admin / dna-outreach**.

## Incident
- The apply model replaced the WHOLE of `search.ts` with the new engine pool,
  deleting ~430 lines (every blocklist, `companyNameFromTitle`,
  `searchCompanies`, `searchRaw`, `searchCompaniesPaged`). Rebuilt from the diff
  and verified declaration-by-declaration: all 13 original exports present, plus
  the new `searchEngineHealth`. There is no git repo here, so this was checked
  by hand.

---
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
      wait until you approve them" + Set up automation; on ⇒ live progress to
      the trigger, "emailing a batch right now", the first blocker if it can't
      run, and sent-today. Deep-links to Settings through a `dna-navigate` event
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

---

# Web search quality regression — FIXED (2026-08-22)

Complaint: "the search results are complete rubbish — wrong company names,
companies not in the country, industry or keywords we searched."

**Root cause: Bing degrades silently instead of blocking.** HTTP 200, ten
plausible results, with the `site:` operator, the city and the country all
discarded, and `&first=11/21/31/41` repeating page one. No captcha, no 429 —
nothing the old code could detect. DuckDuckGo and Brave hard-wall a datacenter
IP, so Bing served nearly every query. Measured: `bing-rss` 10/162 hits on
target (6%); `bing-html` 0/74. My FIRST diagnosis ("the RSS endpoint is bad, the
HTML page is fine") was wrong — the user pushed back and was right.

The pool was chosen on *availability*, never on *correctness*. Nothing ever
compared a result against the query that produced it.

Shipped:
- [x] `places.ts` — one shared country/city/ccTLD table for the planner AND the
      verifier, so a query and its check can never disagree
- [x] Snippets parsed from every engine (locality evidence)
- [x] `QueryIntent` + `hitSatisfies` — `site:` enforced absolutely; otherwise the
      result must carry the country in its ccTLD, domain, path, title or snippet
- [x] Ambiguous cities ("hail", "tyre", "sur", "medina", "mecca") excluded from
      evidence — fine in a query, useless as proof
- [x] A degraded engine is rested on the same backoff ladder as a 429 after 3
      consecutive off-query pages; `offtopic` is its own outcome so a lying
      engine is never recorded as "this query is exhausted"
- [x] A degraded pass stops after 3 off-topic queries and resumes in place
- [x] Reader and proxy tiers verified too
- [x] Encyclopedic titles ("Steel: Definition, Composition…") and titles cut
      mid-bracket no longer become company names
- [x] Country sweep defaults OFF, filters non-business hosts, readable names;
      one-time migration switches existing sources off it
- [x] Boot sweep also retires reference pages and leads whose own ccTLD belongs
      to a different country than their source; exposed as
      `POST /api/discovery/purge-junk` + "Clean up pool" button
- [x] `scripts/verify-intent.ts` replays the exact production failures offline

### Engine hunt — done, and the answer is "no new engine needed"

Full measurements in `.same/engine-bakeoff.md`. Summary:

- Every candidate is dead from this IP: Mojeek/Yep/Ecosia 403, Stract 404,
  Brave 429, searx.be walled, priv.au captcha, search.inetol.net returns an
  empty result set then 429.
- Bing's degradation is **keyword-dependent, not shape-dependent**: five head
  terms × five query shapes all scored 0/47. Cookies make no difference;
  `setmkt=en-QA` makes it worse. So it can only be checked, never predicted.
- **DuckDuckGo is not permanently walled** — it walls under hammering and
  recovers with polite pacing. Its earlier 0/18 was my own probing.
- End-to-end proof the fix works: the five keywords Bing scored 0/47 on now
  return **41/41 on-target** Qatari companies via duckduckgo + reader.

Recommendation: keep the verifier strict, and add a free Jina key — the reader
carried 3 of the 5 queries.

## Deployed ✅ (2026-08-22)

Repo is **`MohamedMagdy90/email`** (public) — not `bandoorahamra/email`, which is
why the first push attempt 404'd. The integration account has write access.

- `55f9ece` → **`32ddddb`** "Verify every search result against the query that
  produced it" — 3 files created, 10 updated, all 13 blob-SHA verified byte-exact
- `32ddddb` → **`6af1658`** "Publish the built commit on /api/health"
- Railway auto-deployed: `GET /api/health` returns `{"ok":true,"rev":"6af1658"}`
- Netlify frontend live at `https://same-5gyl6ypl5ye-latest.netlify.app`, proxy
  verified end to end (Netlify `/api/health` → Railway, HTTP 200)

**Why `/api/health` now publishes the build.** Every other `/api/*` path sits
behind the auth middleware, which 401s a route that does not exist exactly as
readily as one that does — so probing a newly added endpoint could not tell a
landed deploy from a failed one. Confirmed by control test: a made-up
`/api/discovery/definitely-not-a-real-route` also returned 401. Publishing the
commit is the only honest answer, and it made this deploy verifiable.

⚠️ Local `.git` is still empty — the repo is the source of truth, this container
is not. Re-clone before any further work if history matters.

---

# Three fixes (2026-08-24) ✅ shipped & verified

## 1. The partner retry ladder overwrote the customer one

**Root cause.** `followup.ts` stored ONE ladder — `followup_no_open` /
`followup_no_click` — for both audiences. The Customer/Partner toggle on the
card only chose which starter pack to load; the rungs underneath were shared.
So the second lane you configured replaced the first, in both directions. The
`fill()` in the pack loader only touched EMPTY rungs, which is why loading the
partner pack after the customer one appeared to do nothing at all.

- [x] `followup.ts` — `FollowUpLadder` per audience, keys
      `followup_{customer,partner}_{no_open,no_click}`; the old flat keys are
      read as the CUSTOMER lane's fallback, so an existing install keeps its
      templates and waits (same pattern the automation lanes already use)
- [x] `setFollowUpConfig` writes lanes independently — a patch for one lane
      cannot touch the other, and a legacy flat payload only writes customer
- [x] `scanSequences` reads `contacts.audience` and walks THAT lane's ladder;
      rung keys are now `audience:branch:step`
- [x] `rungPerformance()` joins contacts so each lane's sent/opened/clicked are
      its own
- [x] `laneBlockers` — "No partner retry chosen" can no longer hide behind a
      configured customer ladder
- [x] `config.noOpen` / `config.noClick` still returned as a mirror of the
      customer lane, so a frontend mid-deploy doesn't break
- [x] `FollowUp.tsx` — a lane tab (with an `n/2 set` chip per lane), the branch
      columns render the selected lane, the pack loads into the selected lane,
      Save posts both lanes as separate objects

## 2. Three tool cards ate the top of Discovery

Re-check emails · Clean up pool · Repair company names were three full-width
banners — permanent screen for buttons pressed once a month.

- [x] `ui.tsx` — a real `Tooltip` (CSS-only, no portal, works on focus too)
- [x] `Discovery.tsx` — one `PoolTools` row of 9×9 icon buttons beside the bot
      switch. The count that mattered is a badge on the icon; the paragraph
      that justified the banner is the tooltip; a tool with nothing to do is
      disabled and says so instead of vanishing.

## 3. Automation ran at midnight, ignoring time zones

**The unit of scheduling is the COUNTRY, not the server.** A pool spanning
Qatar, Jordan, the UK and Singapore has no single "good time" — 9am is four
different moments — so one server clock could never get this right.

- [x] `schedule.ts` (new) — ISO2 → IANA zone for every country in the country
      table; Sun–Thu working week for the Gulf (UAE deliberately Mon–Fri since
      2022); `SendWindow` {start, end, days}; per-country overrides + pause;
      `isOpen` / `minutesUntilOpen` / `nextOpenAt` computed arithmetically from
      one `Intl` lookup rather than by stepping a clock
- [x] `pool.ts` — `discoveredWhere({ countries })` (a LIST; `__none__` = no
      country on file; an empty list matches NOTHING, which is the honest answer
      when every window is shut), `approvableByCountry()`
- [x] `automation.ts` — the tick counts only leads in open countries toward the
      trigger, and the batch is approved with `filterCountries`; per-lane
      `readyNow` vs `ready`; `getScheduleStatus()` returns every country in the
      pool with its live local clock, window and next opening
- [x] `followup.ts` — a retry that comes due at 02:00 local is HELD, counted as
      `holding` with `holdingUntil`, not sent
- [x] Manual **Run now** deliberately ignores the window (it already ignores the
      trigger and the cooldown)
- [x] `Automation.tsx` — `ScheduleBlock`: default window (time inputs + day
      chips) and a live per-country list showing the local time right now,
      open/closed, "opens in 5h", and per-country hours / hold / reset
- [x] **Defaults to ON at 09:00–17:00** — a rail that ships switched off is not
      a rail. Existing installs get it on their next boot.

## Verified
- `scripts/verify-schedule.ts` — **49/49** offline checks on a scratch DB: zone
  resolution and aliases · Gulf vs European weeks · open/closed at four real
  instants · "Saturday in Doha waits 33h for Sunday 09:00" · overrides stored
  canonically · an end-before-start repaired rather than silently disabling a
  country · pause · unknown-country hold · the empty-list `1 = 0` guard ·
  approve honouring the open-country list and leaving closed countries pending ·
  both ladder-save directions · legacy migration.
- Live HTTP: schedule round-trips through `/api/automation` (including
  `country: null` → back to the default); saving the partner ladder leaves the
  customer ladder byte-identical and vice versa; the legacy mirror tracks the
  customer lane.
- backend `tsc` clean · frontend `tsc` clean · `vite build` clean.

## Note for the next session
Local `data.sqlite` was NOT seeded, so the per-country panel shows its empty
state on this container. It fills in as soon as the pool holds emailable leads.

---

# "Re-check emails" was a loop — 166 in, 166 out (2026-08-25) ✅

## The bug (confirmed in the SQL, not guessed)
`enrichOne()` parks a lead it has given up on as
`enriched=1, enrich_status='blocked'|'error', next_enrich_at=NULL`.
`recoverable` counts exactly `enriched=1 AND enrich_status IN (NULL,'blocked','error')`.
`reEnrichBlocked()` resets exactly that same set.

**The marker meaning "we gave up" is the marker the tool selects on.** Nothing
recorded that a recovery pass had ever run, so the button re-armed its own
queue: 166 reset → each burns 2 crawls (hard wall) or up to 6 (soft) against the
same datacenter IP that refused them last time → all park with the identical
status → badge reads 166 again. ~332 guaranteed-wasted crawls per press.

The leads WERE being marked as failed. "Failed" just also meant "try me again".

## Fix — record the pass, and what capability it ran with
- [x] `recheck_count` / `recheck_key` / `recheck_at` on `discovered_leads`
- [x] `bypassFingerprint()` — FNV-1a digest of the saved Jina keys + proxy
      provider/mode/premium. Built from the CONFIGURATION, not from live health:
      a key running out of tokens is not a reason to re-crawl (nothing the
      operator did changed), whereas adding or removing one is. Hashed, so a
      lead row never carries a fragment of an API key
- [x] `PARKED_SQL` / `RECHECKABLE_SQL` / `EXHAUSTED_SQL` live together, and the
      badge COUNT and the button's UPDATE both read them — the button can never
      again offer a number it cannot deliver
- [x] `RECHECK_MAX_PASSES = 1`. By the time a lead is parked the automatic
      ladder has already tried it twice (hard wall) or six times out to 72h
      (soft), so the transient case is long ruled out. A second hand-pressed
      pass from the same IP with the same key is the definition of doing the
      same thing and expecting a different result
- [x] `stuck` + `lastRecheckAt` on the status, so the disabled button explains
      itself: what parked them, when it was last tried, what would unlock them
- [x] Toast now reports what a pass ACHIEVED, incl. `reArmed` — "166 unlocked by
      your new key/proxy" vs the old, always-true, always-meaningless "166"

## Verified
`scripts/verify-recheck.ts` — **28/28** offline on a scratch DB: 166 parked →
recoverable 166 / stuck 0 → press → the crawls fail again → **recoverable 0,
stuck 166** (this is the line that used to read 166 for ever) → press again
re-queues 0 and re-crawls nothing → a newly parked lead is still offered
alongside the stuck ones → adding a Jina key re-arms all 167 and reports them as
re-armed → removing the key re-arms too, restoring it parks them again → a proxy
re-arms on its own. Four control rows (`empty`, resolved, site-less, approved)
untouched throughout.

Live over HTTP: `stuck` / `lastRecheckAt` serialize on `/api/discovery/status`;
`POST /api/discovery/re-enrich` returns `{reset, stuck, reArmed}`; first press
`reset:29`, second and third `reset:0` — the log says "nothing to re-queue"
instead of re-crawling. backend `tsc` clean · frontend `tsc` clean · `vite
build` clean.

⚠️ Note for the operator: the parked leads are NOT lost. They stay pending in
the pool with their website on file, and the moment a Jina key or scraping proxy
is added in Settings → Crawler every one of them becomes re-checkable again.

---

# "Repair company names" — yes, same loop, plus a worse one (2026-08-25) ✅

Asked straight after the re-check fix: does this tool do the same thing? It did.

## 1. Same loop, more expensive
`countBadNames()` counted EVERY unusable name. `repairLeadNames()` can only fix
the ones it can look up in a re-walked directory or derive from a domain —
everything else hits `result.stillBad++` and is left exactly as it was, so it is
counted again on the next call. The badge therefore stuck at a number no amount
of pressing could move, and **the count over-promised from the very first press**
(seeded 4 bad names → fixed 1 → badge still said 3).

Worse than the re-check case on cost: every press re-walks EVERY directory
source from page 1 at `maxPages: 80, maxDetails: 5000` to rebuild a byte-identical
index. That is minutes of crawling out of the same budget the discovery bot
needs, to learn nothing.

- [x] `name_fix_key` on `discovered_leads` AND `contacts` — the fingerprint a
      failed attempt ran under
- [x] `namingFingerprint()` = hash(sorted directory `base_url`s + `NAME_RULES_VERSION`).
      Those are the ONLY inputs that can change the answer; same directories +
      same rules rebuilds the same index by definition
- [x] `NAME_RULES_VERSION`, bumped whenever `looksLikeName` / `nameFromDomain`
      improves, so a smarter rule re-offers every parked row on deploy
- [x] **Early return before any crawling** when nothing is fixable — this is the
      part that stops the expensive half
- [x] `countBadNames()` now returns `{leads, contacts, stuckLeads, stuckContacts}`
      and the badge only counts what the button can actually deliver
- [x] Tooltip explains the parked names instead of the icon just going grey

## 2. …and it was renaming contacts to "Gmail"
`nameFromDomain(null, "gmail.com")` → `"Gmail"` → passes `looksLikeName` → written
to `contacts.company`. Worse than an empty field: it reads as valid so it never
comes back for review, and `{{company}}` renders it into the body of a real cold
email. Reproduced on the first press of the probe.
- [x] `nameFromDomain` refuses free-mail hosts outright
- [x] `clearFreemailCompanyNames()` at boot, once, blanking only contacts whose
      company name is exactly the brand label of their OWN free-mail domain —
      demonstrably this bug's output, not a real firm sharing the word
- [x] The free-mail list was duplicated byte-for-byte in `discovery.ts` and
      `leads.ts` and absent from `repair.ts` — which is exactly how the third
      caller ended up without it. One canonical copy now lives in
      `crawler/validate.ts` (a leaf, so no import cycle) and all three read it

## Verified
`scripts/verify-names.ts` — **29/29**: free-mail guard on five domains · 4 bad
names offered → press → 1 lead + 1 contact fixed, **offered drops to 0 (was 4)**,
4 reported parked · presses 2 and 3 walk **0 pages** and change nothing · parked
rows not corrupted · adding a directory source re-arms all 4 · the gmail contact
is never renamed to "Gmail" · the one-time cleanup blanks exactly 1, leaves the
real company alone, and refuses to run twice.

`scripts/verify-recheck.ts` still 28/28 after the free-mail consolidation.
backend `tsc` clean · frontend `tsc` clean · `vite build` clean · clean boot with
both migrations applied · `/api/discovery/bad-names` returns the new shape.

## Shipped
Both pool-tool fixes pushed as **`5b58737`** to `MohamedMagdy90/email`
(`367d410` → `5b58737`) — 11 files, 2 added (the verify scripts) and 9 modified,
confirmed file-by-file against the remote rather than trusting the push output.
Railway auto-deployed: `GET /api/health` returns `{"ok":true,"rev":"5b58737"}`.

`frontend/{package.json,tsconfig.json,vite.config.ts,bun.lock}` carry Same-IDE-only
edits (`same-runtime`, `react-grab`, an `optimizeDeps.exclude` for the JSX runtime)
and were deliberately left OUT, as before. They still show as modified locally;
that is expected, not drift.

⚠️ Unverified from here: the two `ALTER TABLE` migrations run against production
POSTGRES, not the SQLite used locally. They follow the same idempotent
try/catch pattern as the ~30 migrations already in `ensureSchema()`, and the
process booted cleanly, but the first person to open the Discovery tab should
confirm the two pool-tool icons render without a 500.

---
