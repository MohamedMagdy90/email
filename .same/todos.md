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
