# DNA Outreach — Directory Harvester + Phone capture

## Phase 1 — Contacts get a phone field ✅
- [x] db.ts: `phone` column + migration; inserts/updates/upsert/export
- [x] index.ts routes: POST/PUT/bulk/export accept + return phone
- [x] api.ts: Contact.phone
- [x] csv.ts: parse phone column + template
- [x] Contacts.tsx: phone column + Add/Edit inputs + import preview

## Phase 2 — Phone + name extraction (crawler) ✅
- [x] libphonenumber-js added
- [x] crawler/phones.ts: extractPhones() mobile-vs-fixed, country/TLD defaults, chrome-safe
- [x] directory.ts: extractName() (og/h1/jsonld/title + suffix strip)
- [x] normal crawler (discover/keyword/paste): captures site phone (mobile pref)
- [x] normal crawl adds contact even with NO phone (phone optional)
- [x] defaultCountry hint passed from discover location / paste country tag
- [x] discover/keyword "Add listed" + crawl results pass phone through

## Phase 3 — Directory crawler (backend) ✅
- [x] crawler/directory.ts: pagination detect (?page/​/page/​/rel=next) + detail-link
      auto-detect (template + first-seg fallback) + 2-pass chrome filtering
- [x] /api/crawl mode:"directory" → job.result.contacts, inContacts annotation

## Phase 4 — Frontend directory mode ✅
- [x] Crawler.tsx: "Directory" tab (paste URL + country + max pages/listings)
- [x] leads table (company | email | phone+mobile | tag) + select + add w/ category + export

## Verified (live)
- qatarcontact.com/listings/31 → 10–12 leads: real emails + phones; mediaplus
  site-chrome contact correctly filtered out
- odoo.com/partners/country/qatar-180 → 12 leads: INFORISE/Zmakan/etc. emails +
  Qatar mobiles; Odoo's own +1 footer number filtered by country preference
- phone round-trips: bulk add → GET (phone kept) → CSV export (phone column)
- extractPhones proven on FSF contact page (+1 617 542 5942); wired identically
  into normal crawlSite
- frontend tsc clean · backend bundles · vite build clean

## Next (optional)
- [ ] push to GitHub for Railway (on request)

## Server-side pagination for Contacts

### Backend (`backend/src/index.ts`)
- [x] Add shared `contactWhere()` filter helper + cursor encode/decode helpers
- [x] Rewrite `GET /api/contacts` to use keyset (cursor) pagination + return `nextCursor` & `filteredTotal`
- [x] Extend `POST /api/contacts/delete` to support `all` + filter (delete all matching)
- [x] Add `POST /api/contacts/set-category` (set category by ids OR all matching)
- [x] Refactor `GET /api/contacts/export` to reuse `contactWhere()`

### Frontend
- [x] `api.ts`: update `getContacts` (cursor/limit + new return), add `bulkDeleteContacts`, `setContactsCategory`
- [x] `Contacts.tsx`: cursor page stack, page-size selector, prev/next, "showing X–Y of Z"
- [x] `Contacts.tsx`: "select all N matching" banner + wire bulk delete/category to all-matching

### Verify
- [x] Backend paging verified end-to-end (no overlaps; bulk-by-filter works)
- [x] Frontend typechecks; dev server running
- [x] Version + screenshot review (v19)

## Scraping-proxy support (beat Cloudflare)

### Backend
- [x] `fetcher.ts`: `ProxyConfig` type, `buildProxyUrl()` for ScrapingBee/ScraperAPI/ZenRows, `fetchViaProxy()`, and proxy-aware `fetchWithRetry` (mode: blocked-retry vs always)
- [x] `getProxyConfig()` helper (in `index.ts`) reading settings
- [x] `directory.ts`: thread `proxy` through `DirectoryOptions` to all fetches
- [x] `crawler/index.ts`: thread `proxy` through `CrawlOptions` to all fetches
- [x] `index.ts`: load proxy config in `/api/crawl` (both modes); extend GET/POST `/api/settings`; add `POST /api/settings/test-scrape`

### Frontend
- [x] `api.ts`: extend settings types; add `testScrape`
- [x] `Settings.tsx`: "Scraping proxy" card (provider, key, mode, premium toggle, save, test)

### Verify
- [x] Type-check clean (FE + BE)
- [x] buildProxyUrl correct for all 3 providers (encoding + premium flags)
- [x] Settings round-trip works; API key never exposed in GET

## Send page — scale to unlimited recipients

- [x] Backend `/api/send`: accept `all:true` + filter (status/category) to resolve recipients server-side (LIMIT 200k), excluding unsubscribed/bounced
- [x] Frontend `Send.tsx`: paginated recipient preview (100/page, prev/next, showing X–Y of Z)
- [x] "Select all N matching" (default) so a send targets the whole filtered set, not just the loaded page
- [x] Fixed the 200-cap symptom (list endpoint clamp) by making sends filter-driven
- [x] Verified: send-all resolved total=2 of 3 (unsubscribed excluded); throwaway data cleaned up; real data untouched

## Engagement tracking: open timestamps/counts + click tracking

### Backend
- [x] db.ts: add sends columns (first/last_opened_at, open_count, first/last_clicked_at, click_count) + migrations + backfill
- [x] index.ts: add /api/click to PUBLIC_API allowlist
- [x] index.ts: enhance /api/open (count + first/last timestamps)
- [x] index.ts: add /api/click endpoint (record + 302 redirect, safe URL only)
- [x] index.ts: /api/contacts LEFT JOIN engagement (last_opened_at, open_count, clicks)
- [x] index.ts: /api/history/export add engagement columns
- [x] index.ts: /api/stats + /api/overview add `clicks`
- [x] index.ts: send job builds clickBase, passes to wrapHtml
- [x] template.ts: wrapLinks() + wrapHtml clickBase param

### Frontend
- [x] api.ts: extend Contact + SendRow types; add clicks to stats/overview
- [x] Overview.tsx: show Clicks metric + Click rate card
- [x] History.tsx: Clicks card + column + "clicked" filter + open counts
- [x] Contacts.tsx: "Last opened" column

### Verify
- [x] FE builds clean (vite build OK)
- [x] End-to-end test PASS: open_count=2, first/last set, click 302, js: guard 400, rollup + stats delta all correct
- [x] Recovered from corrupt local SQLite (test-only data; prod Postgres unaffected)
- [ ] Version

### Notes
- open tracking now: open_count + first_opened_at + last_opened_at (was boolean)
- click tracking: /api/click?s=<sendId>&u=<url> records + 302 redirects; only http(s) counted
- links auto-wrapped in wrapHtml (skips unsub, mailto:, tel:, anchors, our own endpoints)
- a click also marks opened (covers image-blocked clients)
- REMINDER: not committed/pushed to GitHub yet (Railway won't have it until pushed)
