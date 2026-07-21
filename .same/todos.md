# Directory bot — "0 found" fix

## Root cause
- Directory crawler works perfectly on `/listings` (39 contacts / 4 pages) but the
  user saved the **homepage** (`qatarcontact.com`) as the source URL, which has no
  company listings → `0 found`. The real listings live at `/listings` (paginates to
  page 412 ≈ 4,000+ companies).
- Secondary: scanning "stops" because the **global bot is paused** — with it off,
  "Run now" does one batch then stops. Both the source AND the bot must be on to stream.

## Plan
- [x] Add auto-index-discovery to `crawlDirectory`: if the pasted URL yields 0
      companies, find the best internal "listings/directory/companies" link and retry there.
- [x] Return `resolvedSeed` so the worker can persist the corrected base_url and page it.
- [x] Relax NAV_STOP so detail pages under the seed's own path segment aren't dropped.
- [x] Worker: persist resolved index as base_url, walk from page 1 of it.
- [x] UI: paused-with-sources banner + "homepage works" guidance + show resolved path.
- [x] Verify live: homepage seed → auto-resolved to /listings → streamed 39→106+ continuously.
- [x] Commit & push (Railway auto-deploy).

## Worker logging (for Railway debugging) — DONE
- [x] `[discovery]` structured logs: boot state, bot on/off, per-source start.
- [x] `[discovery:dir]` per-page crawl (URL), detail progress, auto-index switch,
      batch summary, every new lead (name · email · phone), pool +new/skipped, schedule.
- [x] `[discovery:osm]` search target, candidate count, each new lead, summary.
- [x] `[discovery:enrich]` which site is crawled + ✓/✗ email result.
- [x] Surface previously-swallowed tick errors via `console.error`.
- [x] Verified log output live against qatarcontact.com (fresh temp DB).

## Pagination bug (found in Railway logs) — DONE
- Symptom: each batch crawled seed, seed-1, page 1, page 2 (e.g. 93 -> 92 -> 1 -> 2).
- Impact: re-crawled pages 1-2 every batch (wasted ~half the proxy credits) AND
  skipped ~half the directory's pages (94,95,98,99...), missing thousands of companies.
- Root cause: findPageLinks enqueued all pager links (incl. page 1/2/prev) before
  the forward nextPageUrl ran, starving the 4-page budget.
- [x] Fix: walk STRICTLY FORWARD via nextPageUrl first; findPageLinks only as a
      fallback for non-numeric pagers, and then forward-only + ascending.
- [x] Verified: ?page=93 -> 93→94→95→96 (38 contacts); /listings -> 1→2→3→4 (39).
- [ ] Note for user: Restart the source after deploy to re-cover skipped low pages.

## No duplicate emails (pool + contacts) — DONE
- Contacts: already hard-guaranteed by `contacts.email UNIQUE` + ON CONFLICT DO NOTHING
  on every insert path (approve, manual, bulk). Added within-batch dedup on approve.
- Pool: `dedup_key` is `e:<email>` when present (UNIQUE) — blocks direct duplicates.
  Closed the enrichment gap:
  - insertDiscovered now also checks the pool's `email` column before inserting.
  - enrichTick: if a found email is already a Contact or another pool row, the
    redundant lead is deleted; otherwise its dedup_key is promoted to `e:<email>`.
  - Added index `idx_discovered_leads_email` for fast lookups.
- [x] Verified with a temp-DB test: contacts UNIQUE, pool dedup_key, enrichment
      guard, and the index — all pass.

## Approve: choose a country (like category) — DONE
- Backend approve endpoint accepts `country`; applied as country || lead.country.
- api.ts: approveDiscoveryLeads accepts `country`.
- Discovery.tsx: `saveCountry` state, country input (w/ datalist of pool countries)
  next to the category select, passed in approve + approve-all, confirm text updated.
- [x] Verified live: lead country "Qatar" -> approved with override "Testland" ->
      contact saved with country "Testland". Test data cleaned up.

## Fix: OSM "Companies (general)" finds almost nothing (Qatar)
- [x] Broaden category tag matching — support "any value of a key" (key-only) filters
- [x] Make "Companies (general)"/"Trading & Retail"/"Manufacturing" match any office/shop/craft
- [x] Raise per-scan cap (120 -> 500) so a whole country can stream in one scan
- [x] Add clearer worker log when an area is fully harvested from OSM
- [x] Update modal copy to explain OSM limits + steer to Directory for thousands
- [x] Verified live: Qatar · Companies (general) 24 -> 178 (147 w/ site, 84 w/ email)
- [x] Version 43 + committed 32b6552 + pushed to origin/main (Railway auto-deploy)
- Note: restored local .git (was empty) → re-linked to MohamedMagdy90/email

## Fix: qatarcontact.com directory crawler (path to thousands)
- [x] Diagnosed: crawler DOES read /listing/ cards (proved: 39/40 w/ contact info)
- [x] Root cause: "+0" logs were page 426 (past the 412-page end), not broken cards
- [x] Fix premature-finish: end-of-directory now = "no listing cards seen",
      not "no NEW leads" — so re-scans of known directories walk to the true end
- [x] Safety: maxDetails >= pages*40 so dense pages aren't truncated by the cursor
- [x] "Run now" on a FINISHED directory restarts from page 1 (manual re-scan)
- [x] Clearer logs: "already known — still walking to the end"
- [x] Integration test PASSED: duplicate re-scan no longer trips the empty streak
- [ ] Version + push
