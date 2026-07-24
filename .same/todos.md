# Discovery bot MISSES emails that are clearly on the site — FIXED (1–5)

## Example verified: "Murshed Al Harbi Sons Ltd. Co" — https://mhsons.com.sa/contact-us/
- Before: plain fetch → HTTP 403 `cf-mitigated: challenge` → 0 emails → lead buried.
- After:  crawlSite("mhsons.com.sa") → status OK · found **info@mhsons.com.sa**
  [cloudflare/high] · 2 reader calls · 0 rate-limited · 8.9s. (verified live)

## Root causes (recap)
1. Cloudflare wall on many sites; only free bypass (Jina reader) is 20/min → 429 at scale.
2. enrichTick marked EVERY miss enriched=1 → transient blocks buried permanently.
3. Reader called per-page (6x/site) → burned the tiny budget.
4. Directory leads: website=null + enriched=1 → never enrichable.

## Done
- [x] #1 enrichTick: classify outcome (found/empty/blocked/error). Only 'empty'
      (site loaded, no email) is permanent. blocked/error → retry_count + backoff
      (5m→30m→2h→6h→24h→72h), give up after 6 tries but keep enrich_status.
      New cols: retry_count, next_enrich_at, enrich_status (+ index). (db.ts, discovery.ts)
- [x] #2 fetcher: global reader rate-limiter (serialized reservations, ~15/min
      no key · ~120/min keyed) so calls queue not 429. crawlSite: reader budget
      of 2/site spent on seed + contact/about pages only (allowReader gate). Verified.
- [x] #3 reEnrichBlocked() + POST /api/discovery/re-enrich + "Re-check blocked"
      button. Resets blocked/errored/legacy leads to enriched=0; leaves 'empty'
      + 'found' alone. Verified: reset 3, skipped empty+has-email.
- [x] #4 directory.ts: pull each listing's own website (extractContactFromProfile);
      store it; runDirectorySource sets enriched=0 when website-but-no-email so
      enrichTick crawls it. finalContacts keeps website-only leads.
- [x] #5 SiteResult.note (block reason). getDiscoveryStatus → blocked count +
      bypass{readerKeyed,proxy,readerRateLimited}. Discovery UI: blocked banner
      w/ recommendation + EmailCell shows "blocked — retrying" / "couldn't read site".
      Reader 429 tracking (getReaderStats).

## Verified
- [x] crawlSite live vs mhsons.com.sa → email recovered.
- [x] reEnrichBlocked + status.blocked + bypass (DB test).
- [x] backend tsc: no real errors (only Bun/Node env type-noise, pre-existing).
- [x] frontend tsc clean + vite build OK.
- [x] live API: /discovery/status (blocked,bypass) + /discovery/re-enrich → 200.

## Not done (needs user OK)
- [ ] Commit + push to MohamedMagdy90/email (local .git is empty — must re-init;
      pushing triggers Railway + Netlify deploy). Awaiting go-ahead.
- Note: recommend adding a free JINA_API_KEY and/or a scraping proxy in
  Settings → Crawler to bypass Cloudflare at full scale.
