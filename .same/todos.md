# Full CRA walk (41 pages / 409 companies) — cursor + termination fixes

## Two bugs that made a complete walk impossible
1. **The page cursor skipped blocked pages.** `nextCursor = cursor + result.listingPages`,
   and `listingPages` counted every page *attempted*, including ones a bot wall
   refused (and counted retried pages twice). A captcha'd page therefore advanced
   the cursor straight past its companies — permanently lost, and the directory
   could never be fully harvested.
2. **The walk never ended.** Past page ~42 CRA still returns a valid-looking shell
   whose few cards the chrome filter (correctly) strips to zero. `productive` was
   `r.detailPages > 0 || r.extracted >= 2`, and `detailPages` now includes inline
   cards, so the phantom pages read as "productive" → `empty_streak` never grew →
   it kept paging forever (observed: still walking at page 60).

## Fixes
- [x] `DirectoryResult.pagesRead` — listing pages read successfully *and contiguously*
      from the seed. The cursor may only advance by this. Retried pages no longer
      double-count in `listingPages`.
- [x] `DirectoryResult.listingsRead` split from `detailPages`; `detailPages` is once
      again ONLY real profile pages opened (0 in inline mode). Logs/UI use `listingsRead`.
- [x] `productive = r.extracted >= 2` — only real contacts count as progress.
- [x] Blocked page → up to 2 retries with doubling cooldown (2s→4s…30s), and the
      cooldown persists for the rest of the run.
- [x] Batch with zero cursor progress = "stalled": stop chaining, wait the normal
      interval so the block clears, resume from that exact page.

## Result — verified end to end through the real Discovery source
- Created the CRA directory source, turned the bot on, let it walk unattended.
- Walked pages 1 → 42 in 4-page batches, no blocks, no skips.
- **391 leads · 0 bad names · 388 unique · 352 with email · 387 with phone · 329 with website**
  (409 listings − ~21 duplicate listings CRA repeats, e.g. AL MARWA ENTERPRISES ×3).
- Coverage confirmed A→Z: "4U" … "zqzooq".
- Termination confirmed: re-ran from page 39 → `FINISHED — walked to the end of the
  directory`, `exhausted=1`, `last_status=done`.
- Manual Crawler (directory mode) path re-checked: 10/10 correct on page 1.

---

# Directory harvest stores the PHONE NUMBER as the company name (cra.gov.qa)

## Verified root cause (reproduced live against cra.gov.qa)
- Seed: https://www.cra.gov.qa/Services/ICT-Business/ICT-Business-List/ICT-Business-Directory
- `harvestInline()` picks the name as "nearest `<h1-4>|strong|b|a>` before the email".
  In a CRA card the element immediately before the email is
  `<a href="tel:66828808">…66828808</a>` → **the phone becomes the name**.
  Also `<h5>`/`<h6>` (where the real name lives) were not even in the regex.
- `findDetailLinks()` drops every real listing link because the path starts with the
  locale segment `/en/`, which is in NAV_STOP → 41 company links ignored, and the
  Arabic mirror of the listing page is mistaken for the single "detail page".
  Consequence: page 1's cards were never harvested at all.
- CRA's per-company pages are BROKEN (empty `<title>`, no `<h1>`/og:title, and a
  placeholder `tel:+4733378901` on every card) → opening them is worse than reading
  the listing inline.
- The directory's own footer contact (`info@cra.gov.qa`) survived the chrome filter.

## Fix plan
- [x] Locale-aware path templating — `pathSegs()` strips a leading `/en`, `/ar-QA`,
      `/pt_BR`… before templating, so a language prefix can't make every listing
      link look like navigation (`findDetailLinks`, `pickIndexCandidates`).
- [x] Group fallback detail links by PARENT path, not first segment. On deep paths
      the first segment is a generic nav word ("services"), which flooded the
      bucket with the whole menu.
- [x] Rewrote `harvestInline` as card segmentation:
      contact marks (mailto:/tel:/bare email, excluding `<header|footer|nav>`) →
      merged into cards → each card's slice runs from the END of the previous card
      to the START of the next, so a card can't borrow a neighbour's data.
- [x] `looksLikeName()` + `pickCardName()`: prefers real headings (h1–h6, incl. h5/h6
      which the old regex ignored), skips `tel:`/`mailto:` anchors, and rejects
      phones, emails, URLs, bare domains, registration numbers and UI labels.
- [x] Crawl prefers inline cards when the listing already carries ≥3 distinct
      contacts (and ≥60% of the detail-link count) — 1 fetch instead of N, and it
      avoids CRA's broken profile pages (empty `<title>`, placeholder
      `tel:+4733378901` on EVERY company).
- [x] Card website + card detail URL captured inline.
- [x] Chrome filter: also drops values seen on ≥60% of listing pages, plus emails on
      the directory's own domain → `info@cra.gov.qa` no longer becomes a lead.
- [x] fetcher: an HTTP-200 reCAPTCHA/hCaptcha interstitial now counts as blocked
      (CRA serves one after a few fast requests) + directory crawl backs off and
      retries the page once, and reports a partial harvest in the note.
- [x] Verified live: 4 pages → 38/38 companies, 0 bad names, 30 websites, 38 emails,
      38 phones. Page-3 "shortfall" was CRA listing AL MARWA ENTERPRISES 3×.
- [x] 27/27 offline regression tests pass (classic detail-page directories still work).
- [x] backend tsc clean; frontend vite build OK.

## Note for the user
- Leads already saved from this source keep the old (phone-number) company name —
  re-running the source overwrites nothing automatically.
- `backend/data.sqlite` was already corrupt on disk; moved to `*.corrupt-bak` so the
  local API could boot. Production uses Postgres (DATABASE_URL), unaffected.

---

# Discovery finds too few leads — add a "Web search" source (thousands, not 2)

## Verified root cause (with live data)
- OSM query for "Saudi Arabia · Construction & Contracting" → **exactly 2** companies
  (matches user's report). OSM = a map, not a registry; only businesses tagged
  with website/email are returned, and re-scans are deterministic (0 new).
- Plain DuckDuckGo web search is **blocked from the server IP** ("anomaly" page).
- Jina reader (already in app) **bypasses** the block → full SERP results, 0 anomaly.
  Verified for multiple queries + city-level queries return different companies.

## Plan — add a third source type: "search" (web search, reader-backed)
- [x] search.ts: `searchCompaniesPaged(query, offset, limit, readerKey)` — fetch one
      DDG results page (direct → reader fallback), parse company domains, filter
      aggregators/listicles. Returns { companies, blocked }. VERIFIED live.
- [x] discovery.ts: SEARCH_KEYWORDS (per category) + COUNTRY_CITIES + buildSearchPlan
      (keywords × [country + cities] × pages, ~340 for Saudi construction).
      `runSearchSource` walks the plan by cursor, inserts leads (enriched=0 →
      enrichTick finds emails), streams continuously, restarts each interval.
      Wired into executeSource + runSourceNow + srcLabel.
- [x] db.ts: added `keywords` column (idempotent migration).
- [x] index.ts: POST/PUT /discovery/sources handle type='search' (+ keywords).
- [x] api.ts: DiscoverySource.keywords; add/update source accept keywords + 'search'.
- [x] Discovery.tsx: 3-way type toggle (Web search / Map area / Directory), search row
      rendering, modal fields + copy; Area copy points to Web search for volume.
- [x] Verified live end-to-end: one 3-query batch inserted 7 real Saudi construction
      companies (ACC, Almabani, Astra, PSCC, Al-Shalawi, Shapoorji, AlKifah), enriched=0.
- [x] backend tsc clean (search.ts + discovery.ts); frontend vite build OK.
- [x] Version 20 + pushed to MohamedMagdy90/email main (a5abdf2).

## Follow-up recommendation for the user
- Add a FREE Jina key in Settings → Crawler so web search + Cloudflare bypass run
  at full speed (15/min → 120/min). Then turn the bot ON with a Web search source.
