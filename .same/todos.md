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
