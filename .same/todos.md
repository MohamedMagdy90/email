# DNA Outreach — Email Discovery Redesign

## Tier-one search upgrade (latest)
- [x] Overpass 504 fix: 5 mirrors, race + 3-round retry with backoff, 30s abort
- [x] Searchable location dropdown: Photon autocomplete ("qat"→Qatar), Nominatim fallback
- [x] Keyword search engine: DuckDuckGo-based, finds companies by website content
- [x] Resilient search: UA rotation, retry/backoff, html+lite fallback, 10-min cache
- [x] Keyword content-match in crawler + "Must mention / Required" filter + badges
- [x] Verified: Photon autocomplete, place-based discovery, "car rental" search→crawl→match

## Goal
Make email discovery genuinely high-yield AND never waste work re-crawling
domains/emails we already know.

## Plan
- [x] Fix corrupted local SQLite DB (backed up, fresh start) + restart dev servers
- [x] DB: add `crawled_domains` ledger + helpers (record / known-since / contact-domains)
- [x] Crawler: sitemap.xml discovery of contact/about/team pages
- [x] Crawler: JSON-LD (schema.org) email extraction
- [x] Crawler: smart role-inbox inference (info@domain) when page has none + MX ok
- [x] Crawler: confidence tiers on every email
- [x] Leads: broaden Overpass query + capture OSM-native emails/phones (grouped value-regex, race mirrors)
- [x] API /api/crawl: skip already-known domains (ledger + contacts), record results
- [x] API /api/leads/find: annotate companies (inContacts / crawled) + /api/crawl/check
- [x] Frontend: skip-known toggle, guess-inbox toggle, dedup badges, confidence, skipped summary
- [x] Verified live: dedup (crawled/in_contacts/dupe), JSON-LD, guess-inbox (tesla→info@), OSM emails

## Verified
- fsf.org → campaigns@fsf.org (mailto/high); re-crawl skipped via ledger
- Malta IT discovery → 15 companies in ~12s incl. OSM emails (sales@scanmalta.com)
- tesla.com (hides email) + guessInbox → info@tesla.com (guessed, MX-verified)
- extract unit test → jsonld + mailto + text + deobfuscated all captured
