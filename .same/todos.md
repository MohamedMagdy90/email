# DNA Outreach — Build Todos

## Setup
- [x] Scaffold frontend (Vite + React + TS + Tailwind)
- [x] Scaffold backend (Bun + Hono)
- [x] DB layer (PGlite dev / Postgres prod) + schema init
- [x] Root dev script (run both together)

## Backend API
- [x] Contacts (CRUD, CSV import, dedupe, status)
- [x] Templates (CRUD, customer/partner)
- [x] Domains (CRUD, rotation, daily caps)
- [x] Send job (Resend, rotation, delays, unsubscribe, tracking, dry-run)
- [x] Unsubscribe + open-tracking endpoints
- [x] History / stats

## Crawler (state of the art)
- [x] URL normalization + http/https fallback + IDN
- [x] Robust fetch (timeout, retry, realistic UA, size guard)
- [x] robots.txt respect (toggle)
- [x] Multi-page crawl (contact/about/imprint priority, depth + page limits)
- [x] Email extraction: mailto, plain text, HTML-entity decode
- [x] Deobfuscation ([at]/[dot]/spaces/words/entities)
- [x] Cloudflare data-cfemail decode
- [x] Validation + false-positive filtering (assets, placeholders)
- [x] MX record check (deliverability)
- [x] Role vs personal classification
- [x] Concurrency + politeness delay
- [x] Job progress (start + poll)
- [x] Verified live: debian.org + fsf.org -> 15 real MX-verified emails

## Frontend
- [x] Layout + nav (DNA look: black / cream)
- [x] Contacts screen
- [x] Templates screen (+ starter templates)
- [x] Send screen (live progress)
- [x] History screen
- [x] Settings (Resend key, domains)
- [x] Crawler UI (seed URLs, options, live progress, results -> add)

## Finish
- [x] Run dev, fix errors (versioning check — clean)
- [x] Version (v1 created)
- [x] Deploy notes (Netlify + Railway) — netlify.toml, railway.json, DEPLOY.md
- [x] Frontend production build verified (vite build OK)

## Round 2 (requested features)
- [x] Lead Finder: discover companies by country + industry (OpenStreetMap Nominatim + Overpass) -> crawl -> add
- [x] CSV export for contacts (backend) and crawl results (client)
- [x] Overview dashboard: stat cards + donut (contacts) + 14-day bar chart (sends) + engagement strip
- [x] Reliability fix: PGlite hung in this runtime -> switched to Bun SQLite (portable SQL for Railway Postgres)
- [x] Preview reliability: backend serves built frontend as a single process on one port
- [ ] Deployment walkthrough (Railway -> Netlify) — guiding user
