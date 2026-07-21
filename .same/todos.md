## 24/7 Discovery Bot — DONE

### Backend
- [x] db.ts: `discovery_sources` + `discovered_leads` tables (portable sqlite/pg)
- [x] config.ts: shared proxy/reader config (no circular import)
- [x] discovery.ts: always-on worker (discovery loop + enrichment loop + status)
- [x] index.ts: boot worker + /api/discovery/* routes (status, toggle, sources CRUD, run, leads approve/reject/delete)

### Frontend
- [x] api.ts: discovery types + methods
- [x] Discovery.tsx: bot control + sources manager + reviewable leads pool
- [x] App.tsx: "Discovery" nav (02) + route

### Verified live
- [x] Created source, ran it -> 4 companies discovered into pool
- [x] Approve -> Contacts works; reject/delete work; cleanup done
- [x] Frontend tsc clean; both dev servers healthy
