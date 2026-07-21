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
