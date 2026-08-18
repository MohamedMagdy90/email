# Web search yield — "it only finds a handful of leads per source" ✅ shipped & verified

The complaint: a Web search source returns far fewer companies than the country
actually has. Two separate problems were underneath it — the searches were
mostly wasted, and even a perfect keyword search has a ceiling far below "every
company in the country".

## Measured first, from this container (5 probe rounds)

| engine | answers? | results/page | paginates? |
|---|---|---|---|
| **Brave** | yes, ~5 requests then 429 | **20** | **YES — `&offset=1..9`** |
| **Bing RSS** | always, ~140ms, never limited | 10 | **no** (`first=` returns page 1) |
| DuckDuckGo html | ~3 requests then walled | 10 | **no** (`s=30` returns page 1) |
| DuckDuckGo lite | walled on the first call (202) | – | – |
| Mojeek · Startpage · Ecosia · Yep · Qwant · Presearch · Yahoo · 4get · 3 SearXNG instances | **none usable** (captcha / 403 / JS-gated) | – | – |

| Common Crawl index | value |
|---|---|
| `*.qa` | 17-23 index pages · **~220 NEW hosts per page** |
| `*.sa` · `*.ae` · `*.jo` | 73 · 161 · 24 pages |
| cost | ~5-10s/page, free, keyless, no key or signup |
| `filter=~url:…` | **404 — unsupported**, so category filtering must be client-side |
| a page past the end | **HTTP 400**, not 404 (`"Page 17 invalid: … Last Page is 16"`) |

## The four root causes (all measured, none guessed)

1. **Half of every plan was a page no engine can serve.** `SEARCH_PAGES = [0, 30]`
   made each query TWO plan entries, but DuckDuckGo's `&s=30` and Bing's
   `&first=` both return **page one again**, and Brave's `build()` returned
   `null` for any offset. So entry #2 was either a duplicate fetch — which then
   taught `search_query_stats` to cool the query off for being "unproductive" —
   or, when the two page-one engines were resting, every engine declined,
   `freeSerp` returned null, and `fetchSearchPage` reported `blocked`
   ⟹ **a 3-30 minute rate-limit backoff for a page that never existed.**
2. **Brave paginates and nobody asked.** `&offset=1/2/3` measured 20/19/20/19
   hosts — **69 unique across four pages against 20 for page one** — and it was
   capped at page one in code. It is also the engine with the smallest quota,
   which is exactly why depth beats breadth: four pages of one query cost the
   same ~5-request quota as four separate queries.
3. **The `" contact"` variant was dead weight.** On Bing (the engine that
   answers every time, so the one that serves most of a real pass)
   `"MEP contractor" Qatar contact`, `… Qatar email`, `… Qatar W.L.L.` and
   `… Qatar P.O. Box` each returned **zero domains the plain query had not
   already returned**. Half the plan was spent on them. Only a different CITY
   and the `site:` operator actually diversified the results.
4. **One global 4s pacer for engines with wildly different quotas** — so Bing,
   never once rate-limited, waited out Brave's problem on every request.

## Built

### `search.ts` — the engine layer
- [x] Per-engine `maxPage` + `gapMs`. Brave 4 pages @2.5s, Bing 1 page @1s,
      DuckDuckGo 1 page @4s. Real Brave pagination via `&offset=`.
- [x] `SerpOutcome` is now four cases — `hits` / `unsupported` / `resting` /
      `walled` — because `null` meant three different things and the caller
      could only read it as "rate-limited". **Only page 0 can mark a source
      blocked**; a deep page nobody serves ends the deep loop and costs nothing.
- [x] `pacedEngine()` — a serialised, spaced queue PER ENGINE.
- [x] `searchCompaniesDeep()` — pulls every page the answering engine serves,
      merged and deduped, stopping at the first page that adds nothing new
      (which is what an engine repeating page one looks like from here).
- [x] The paid tiers (reader, proxy) are never spent on a deep page — they
      render DuckDuckGo's first page, so there is nothing there to render.

### `discovery.ts` — the plan
- [x] A plan entry is **one QUERY**; depth lives inside the step.
- [x] Dropped the measured-dead `" contact"` variants; added `site:.<tld>` per
      city, which was measured to diversify.
- [x] Keyword lists expanded ~4× (general sweep 10 → 40 trades; every category
      grown). **Qatar · general is now 560 queries, was ~150.**
- [x] `SEARCH_QUERIES_PER_RUN` 3 → 5 · `SEARCH_PACING_MS` 4000 → 1200 ·
      `SEARCH_CONTINUE_MS` 8000 → 4000 · plan cap 800 → 4000.

### The country sweep — the order-of-magnitude tier
- [x] `archives.ts`: `ccPageCount()` + `ccHostsForPattern()` — Common Crawl's
      index read as "every host under `.qa`" rather than as a page fetcher.
- [x] Sweep steps ride the SAME cursor as the queries, so resume, stop-mid-batch,
      saturation, block-backoff and "a full pass finished" all work unchanged.
- [x] **Interleaved, never appended** — an index page is a multi-megabyte
      response and running them back to back got this IP refused within ~15
      calls; and appending would mean no swept lead arrives until the whole
      keyword plan is done. First index page lands at step 33 of 577.
- [x] Category relevance without a server-side filter: `CATEGORY_URL_TOKENS`
      matches the host's own crawled URLs (`/contracting`, `/construction-…`).
      Custom keywords beat the table. A general sweep keeps everything.
- [x] `sweep_country` column (default ON) + a checkbox in the Add-source modal
      that says plainly what it does and warns when a category filter is loose.
- [x] Toggling it counts as a plan change, so the cursor restarts — a cursor
      pointing into a plan that changed length resumes on the wrong step.

### Quality — the "trading" collision (found by running it, not by testing it)
A live Qatar pass on `trading and contracting W.L.L.` returned **trading212,
etrade, metatrader5, olymptrade, wrtrading, simul8or and yandex**. In the Gulf a
"trading company" sells goods; on the open web "trading" means FOREX.
- [x] `FINANCE_BLOCK` (host) for the known platforms — their titles are just a
      brand name, so only the host catches them.
- [x] `PLATFORM_TITLE` (title) for the long tail — "Free Trading Simulator".
- [x] `yandex|naver|seznam|ecosia|brave|startpage|qwant` added to `BLOCK`.

## Verified
`backend/scripts/` — re-runnable, `bun run verify` and `bun run verify:batch`.

- **26/26** `verify-search.ts` — plan shape · no dead variants · deep search
  against the live pool · **page 9 is `unsupported`, not `blocked`** · index page
  count and host collapse · past-the-end handling · interleaving (0 adjacent
  index pages) · category tokens · engine health.
- **10/10** `verify-batch.ts` — a REAL batch end to end:
  - 5 keyword steps → **+31 leads in 9s**, all country-resolved, no duplicates,
    cursor advanced, no rate limit recorded.
  - one index step → **+106 leads in 15s** (109 hosts, 106 in scope).
- **15/15 + 15/15** `verify-blocks.ts` — every trading platform blocked, every
  real Gulf company kept.
- **4/4** `verify-db.ts` — a corrupt local DB parks itself and boots fresh.
- Degradation proven: with `index.commoncrawl.org` refusing this IP (it did,
  repeatedly, after the probes), the plan silently becomes queries-only and the
  pass still runs.
- backend `tsc` clean · frontend `tsc` clean · `vite build` clean.

## The recurring SQLite corruption — root-caused and fixed
`backend/data.sqlite` has been found "malformed" at boot in session after
session (**eight** parked copies in `.same/`). It corrupted twice more during
this work, which finally made the cause reproducible: **WAL mode on this
container's overlay filesystem**. WAL needs a `-shm` shared-memory file and
working POSIX locking; neither is dependable here, so any hard interruption —
a supervisor SIGKILLing the dev server, say — leaves the `-wal`/`-shm` pair
inconsistent with the main file and the next open fails outright.

- [x] `journal_mode = TRUNCATE` by default (`SQLITE_WAL=1` opts back in).
      A rollback journal needs no shared memory and replays on open.
      **Proven: SIGKILL the server mid-run → `integrity_check` = ok, 34 tables.**
- [x] The handle is pinned to `globalThis`, because `bun --watch` re-evaluates
      the module in the SAME process and a module-scope `new Database()` opened
      another writer on every save.
- [x] A corrupt file now parks itself as `data.sqlite.corrupt-<ts>` and boots
      fresh with a loud log line, instead of a crash loop. Never deletes.
- Production is Postgres and is untouched by all of this.

## Gotchas (this session's additions)
- **Heredocs over the bash tool are still mangled** — hit 3× here, and once it
  HUNG the shell (the mangling broke the terminator). Use the editor tools.
  `bunx tsc` also re-resolves dependencies and can drop `@types/*`; the project
  now pins `typescript` + `@types/bun` and has a `typecheck` script.
- **Any script must set `SQLITE_PATH`**, whatever it looks like it touches —
  the import graph decides, not the script.
- **`concurrently` traps SIGTERM and restarts its children.** Kill the
  supervisor first (`-9` is fine, it holds no database), then SIGTERM the bun
  backend, which does.
- `rawFetch` discards the body on a non-OK status, so a 400 has to be
  identified by its code alone.

## Open
- The free pool is down to **three usable engines**, and two of them serve one
  page. Brave is the only one with depth and it rests after ~5 requests, so most
  queries are answered by Bing's 10 results. The country sweep is what makes the
  volume, not the engines.
- **Swept leads arrive as a bare domain** and rely on enrichment to read the
  real company name off the site. `repair.ts` already treats a bare domain as a
  name needing repair, so nothing regresses — but a big sweep will queue
  thousands of crawls, and the enrichment loop is the next bottleneck to watch.
- `SWEEP_PAGES_PER_PASS = 40` caps one pass; `.ae` has 161 index pages, so a big
  country is covered across several passes rather than one.
- The static `CC_FALLBACK_INDEXES` list is only used when `collinfo.json` cannot
  be reached. Worth refreshing occasionally.
