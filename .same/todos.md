# DNA Outreach — Production-Readiness Pass

## 0. Baseline
- [x] Reset corrupt local SQLite (prod uses Postgres)
- [x] Local dev credentials (.env, gitignored)
- [x] Dev server up; all screens load

## 1. CSV Import overhaul (explicit request)
- [x] "Download template" button → downloads contacts-template.csv
- [x] File upload (picker + drag & drop) in addition to paste
- [x] Live parse preview + validation (ready / duplicate-in-file / invalid) before import
- [x] Clear step-by-step helper text + example

## 2. Auth / account (real-use readiness)
- [x] Backend: public /api/auth/status
- [x] Backend: first-run /api/auth/setup (only if not configured)
- [x] Backend: protected /api/account (change username + password)
- [x] Frontend: first-run setup screen when no credentials
- [x] Frontend: "Account" section in Settings to change username/password

## 3. Settings polish
- [x] "Send test email" button + backend /api/settings/test-email
- [x] Cleaner email wrapper (skip pixel/unsub when not applicable)

## 4. Contacts polish
- [x] Edit contact (email/company/country/industry/status)
- [x] Remove unused imports / lint (Select now used)
- [x] Dedupe within import batch (client + server)
- [x] Clear selection of hidden rows on reload

## 5. Send polish
- [x] Guide when no templates
- [x] Warn on real send without App URL

## 6. History polish
- [x] Export sends CSV
- [x] Filter by status + search

## 7. QA
- [x] Frontend tsc + production build clean
- [x] Backend endpoints tested live (edit, bulk, account, test-email, export, send)
- [x] CSV parser unit-tested (headers, positional, quoted, invalid, dupes, whitespace, reorder)
- [x] Lead Finder verified live (Malta → 5 companies)
- [x] Crawler verified live (fsf.org → campaigns@fsf.org)
- [x] Version 8 created; git re-linked to live repo (not pushed)

## Notes
- Local preview login: admin / dna-local-dev (from backend/.env, gitignored)
- Production credentials come from Railway AUTH_USERNAME / AUTH_PASSWORD env vars
- To ship: push modified files to MohamedMagdy90/email (main) → Railway auto-redeploys
