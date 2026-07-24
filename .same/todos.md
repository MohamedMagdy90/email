# Discovery finds too few leads — add a "Web search" source (thousands, not 2)

## Verified root cause (with live data)
- OSM query for "Saudi Arabia · Construction & Contracting" → **exactly 2** companies
  (matches user's report). OSM = a map, not a registry; only businesses tagged
  with website/email are returned, and re-scans are deterministic (0 new).
- Plain DuckDuckGo web search is **blocked from the server IP** ("anomaly" page).
- Jina reader (already in app) **bypasses** the block → full SERP results, 0 anomaly.
  Verified for multiple queries + city-level queries return different companies.

## Plan — add a third source type: "search" (web search, reader-backed)
- [ ] search.ts: `searchCompaniesPaged(query, offset, limit, readerKey)` — fetch one
      DDG results page (direct → reader fallback), parse company domains, filter
      aggregators/listicles. Returns { companies, blocked }.
- [ ] discovery.ts: SEARCH_KEYWORDS (per category) + COUNTRY_CITIES + buildSearchPlan
      (keywords × [country + cities] × pages). `runSearchSource` walks the plan by
      cursor, inserts leads (enriched=0 → enrichTick finds emails), streams
      continuously, restarts each interval. Wire into executeSource + runSourceNow.
- [ ] db.ts: add `keywords` column (idempotent migration).
- [ ] index.ts: POST/PUT /discovery/sources handle type='search' (+ keywords).
- [ ] api.ts: DiscoverySource.keywords; add/update source accept keywords + 'search'.
- [ ] Discovery.tsx: 3-way type toggle (Area / Directory / Web search), search row
      rendering, modal fields + copy; clarify Area's limits point to Web search.
- [ ] Verify live: run a search source for Saudi construction → many leads.
- [ ] Version + push.
