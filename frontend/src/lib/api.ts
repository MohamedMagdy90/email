const BASE = (import.meta as any).env?.VITE_API_URL || "";

/* ------------------------------- Auth ------------------------------- */
const TOKEN_KEY = "dna_auth_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function onUnauthorized() {
  clearToken();
  window.dispatchEvent(new Event("dna-unauthorized"));
}

/* ------------------------------ audience ------------------------------- */

// Who a company is to us: someone we sell DNA ERP to ('customer'), or someone
// we sell the Makers program to ('partner'). It's set on the discovery source,
// rides the lead into Contacts, and decides which automation lane emails them.
// Anything discovered before the tag existed reads as 'customer'.
export type Audience = "customer" | "partner";

// How the crawler got a page. The first three are free and unlimited-ish; the
// last two are metered, and keeping their share small is the whole game.
export type TransportName = "direct" | "commoncrawl" | "archive" | "reader" | "proxy";
export const FREE_TRANSPORTS: TransportName[] = ["direct", "commoncrawl", "archive"];
export const PAID_TRANSPORTS: TransportName[] = ["reader", "proxy"];

export interface Contact {
  id: string;
  email: string;
  company?: string;
  country?: string;
  industry?: string;
  category?: string;
  phone?: string;
  role_based?: boolean;
  source?: string;
  /** customer | partner — inherited from the discovery source that found them. */
  audience?: string | null;
  status: string;
  created_at: string;
  // Engagement (rolled up across all sends to this contact)
  open_count?: number;
  first_opened_at?: string | null;
  last_opened_at?: string | null;
  click_count?: number;
  last_clicked_at?: string | null;
}

export interface Template {
  id: string;
  type: "customer" | "partner";
  name: string;
  subject: string;
  body: string;
  created_at: string;
}

export interface Domain {
  id: string;
  domain: string;
  from_name: string;
  from_email: string;
  daily_cap: number;
  sent_today: number;
  active: boolean;
}

export interface SendRow {
  id: string;
  contact_email: string;
  company?: string;
  subject: string;
  status: string;
  error?: string;
  opened: boolean;
  open_count?: number;
  first_opened_at?: string | null;
  last_opened_at?: string | null;
  click_count?: number;
  first_clicked_at?: string | null;
  last_clicked_at?: string | null;
  // Which rung of the follow-up ladder this send was (0 / absent = the original).
  followup_step?: number;
  followup_branch?: string | null; // no_open | no_click
  sent_at?: string;
  created_at: string;
}

export interface Job {
  id: string;
  type: string;
  status: "running" | "done" | "error";
  progress: number;
  total: number;
  processed: number;
  logs: any[];
  result: any;
  error?: string;
}

export interface Place {
  display_name: string;
  short_name: string;
  osm_type: string;
  osm_id: number;
  type?: string;
  boundingbox?: string[];
}

export interface LeadCompany {
  name: string;
  website: string;
  city: string;
  email: string | null;
  phone: string | null;
  hasWebsite: boolean;
  domain: string;
  inContacts: boolean;
  crawled: boolean;
}

export interface LeadResult {
  companies: LeadCompany[];
  summary: { total: number; new: number };
}

// A row parsed from an uploaded directory PDF.
export interface ParsedRow {
  company: string;
  category?: string;
  phone?: string;
  phoneMobile?: boolean;
  email?: string;
  website?: string;
}

/* --------------------------- Discovery bot -------------------------- */

export interface DiscoveryStatus {
  enabled: boolean;
  autoEnrich: boolean;
  sources: number;
  activeSources: number;
  leads: { pending: number; approved: number; rejected: number; withEmail: number; total: number };
  pendingEnrich: number;
  // Pending, email-less leads still auto-retrying after a block/error.
  blocked: number;
  // Pending, email-less leads WITH a website that were given up on / predate
  // retry-tracking — the count "Re-check" re-queues (drives the recovery button).
  recoverable: number;
  // Is a scalable Cloudflare bypass configured, and how often has the free reader
  // been rate-limited — drives the "add a key/proxy" nudge.
  bypass: {
    readerKeyed: boolean;
    proxy: boolean;
    readerRateLimited: number;
    // Key health as the fetcher actually observed it — a key saved in Settings
    // is not necessarily a key that still has tokens.
    readerKeysConfigured: number;
    readerKeysLive: number;
    readerKeyRejected: boolean;
  };
  nextRunAt: string | null;
  lastLeadAt: string | null;
}

export interface DiscoverySource {
  id: string;
  type?: "osm" | "directory" | "search";
  base_url?: string | null;
  keywords?: string | null; // web-search sources: custom keywords (blank = from category)
  // Web-search sources: also walk Common Crawl's index of the country's own
  // ccTLD, not just the keyword queries. 1 = on (the default).
  sweep_country?: number;
  /** customer | partner — every lead this source files inherits it. */
  audience?: string | null;
  cursor?: number;
  exhausted?: number; // 0 | 1
  // Directory sources: the exact URL the next batch resumes from (any pager shape).
  next_url?: string | null;
  // Archived sources are retired but fully recoverable — the bot ignores them.
  archived?: number; // 0 | 1
  archived_at?: string | null;
  // Map-area sources sweep their country as a grid: `cursor` is the next tile,
  // `osm_tiles` the grid size, `osm_available` how many contactable businesses
  // OpenStreetMap holds in the area in total (the hard ceiling).
  osm_tiles?: number;
  osm_available?: number;
  location: string;
  place_json?: string | null;
  category: string;
  limit_n: number;
  interval_minutes: number;
  enabled: number; // 0 | 1
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  runs: number;
  total_found: number;
  created_at: string;
}

export interface DiscoveredLead {
  id: string;
  name?: string;
  website?: string | null;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
  category?: string | null;
  /** customer | partner — copied from the source that found it. */
  audience?: string | null;
  source_label?: string | null;
  status: string;
  enriched: number;
  confidence?: string | null;
  via?: string | null;
  created_at: string;
  // Enrichment retry state.
  retry_count?: number;
  enrich_status?: string | null; // found | empty | blocked | error
}

/* ------------------------------ Automation ----------------------------- */

// The automation runs as TWO independent lanes — customer and partner — fed by
// the audience tag on each discovery source. Each lane has its own switch,
// trigger count, templates and cooldown; the guard rails below them (rate,
// daily ceiling, gap, Resend) are shared, because the sending domains are.

export interface AutomationLaneConfig {
  enabled: boolean;
  /** Trigger point AND batch size: approve + email this many at a time. */
  threshold: number;
  /** Template(s) this lane sends — several rotate. */
  templateIds: string[];
  /** rotate = one template per run · split = alternate per recipient. */
  templateMode: "rotate" | "split";
  category: string;
  country: string;
}

export interface AutomationConfig {
  /** Master switch — off means neither lane runs. */
  enabled: boolean;
  customer: AutomationLaneConfig;
  partner: AutomationLaneConfig;
  perMinute: number;
  /** Max emails per day across both lanes (0 = no ceiling). */
  dailyLimit: number;
  /** Minimum gap between two runs of the SAME lane. */
  cooldownMinutes: number;
  /** Refuse to run without a Resend key (never auto-"dry-run"). */
  requireResend: boolean;
}

export interface AutomationRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;   // auto | manual
  status: string;    // running | done | error | skipped
  audience?: string; // customer | partner
  threshold: number;
  pool_count: number;
  approved: number;
  contacts_added: number;
  sent: number;
  failed: number;
  skipped: number;
  template_names: string | null;
  job_id: string | null;
  note: string | null;
  error: string | null;
}

export interface AutomationLaneStatus {
  audience: Audience;
  config: AutomationLaneConfig;
  /** Pending leads of this audience that already have an email. */
  ready: number;
  remaining: number;
  running: boolean;
  sentToday: number;
  nextEligibleAt: string | null;
  lastRun: AutomationRun | null;
  templates: { id: string; name: string; type: string }[];
  blockers: string[];
}

export interface AutomationStatus {
  config: AutomationConfig;
  lanes: AutomationLaneStatus[]; // [customer, partner]
  /** Both lanes combined. */
  ready: number;
  running: boolean;
  sentToday: number;
  dailyRemaining: number | null;
  lastRun: AutomationRun | null;
  runs: AutomationRun[];
  /** Blockers that stop both lanes. */
  blockers: string[];
}

/* ---------------------------- Follow-up ladder ------------------------- */

export type FollowUpBranch = "no_open" | "no_click";

export interface FollowUpStepConfig {
  /** Template sent at this rung. Blank = the rung is off. */
  templateId: string;
  /** Hours to wait after the PREVIOUS email before this one goes out. */
  delayHours: number;
}

export interface FollowUpConfig {
  enabled: boolean;
  /** Ceiling per sequence, including the original email (2 or 3). */
  maxEmails: number;
  noOpen: FollowUpStepConfig[];  // [first retry, second retry]
  noClick: FollowUpStepConfig[];
  perMinute: number;
  dailyLimit: number;
  batchSize: number;
  /** Sequences whose last email is older than this are abandoned. */
  lookbackDays: number;
  requireResend: boolean;
}

export interface FollowUpRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;   // auto | manual
  status: string;    // running | done | error | skipped
  due_count: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  no_open: number;
  no_click: number;
  retry1: number;
  retry2: number;
  template_names: string | null;
  job_id: string | null;
  note: string | null;
  error: string | null;
}

export interface FollowUpRung {
  branch: FollowUpBranch;
  step: number;                  // 1 = first retry, 2 = second
  templateId: string;
  templateName: string | null;   // null = the template was deleted
  delayHours: number;
  due: number;
  waiting: number;
  nextDueAt: string | null;
  // What this rung has produced so far, all time.
  sent: number;
  opened: number;
  clicked: number;
}

export interface FollowUpStatus {
  config: FollowUpConfig;
  running: boolean;
  dueNow: number;
  waiting: number;
  /** In a sequence, but the rung they'd take has no template. */
  unconfigured: number;
  sentToday: number;
  dailyRemaining: number | null;
  /** App URL set = opens/clicks are actually tracked. */
  trackingReady: boolean;
  lastRun: FollowUpRun | null;
  runs: FollowUpRun[];
  rungs: FollowUpRung[];
  totals: { retries: number; opened: number; clicked: number };
  templates: { id: string; name: string; type: string }[];
  blockers: string[];
  dueSample: { email: string; branch: FollowUpBranch; step: number; dueAt: string }[];
}

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers as any) },
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // auth
  login: async (username: string, password: string) => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || "Login failed");
    }
    const data = (await res.json()) as { token: string; username: string };
    setToken(data.token);
    return data;
  },
  checkAuth: async (): Promise<boolean> => {
    if (!getToken()) return false;
    try {
      await req("/api/auth/me");
      return true;
    } catch {
      return false;
    }
  },
  authStatus: async (): Promise<{ configured: boolean }> => {
    try {
      const res = await fetch(`${BASE}/api/auth/status`);
      if (!res.ok) return { configured: true };
      return await res.json();
    } catch {
      return { configured: true };
    }
  },
  setup: async (username: string, password: string) => {
    const res = await fetch(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || "Setup failed");
    }
    const data = (await res.json()) as { token: string; username: string };
    setToken(data.token);
    return data;
  },
  updateAccount: async (body: { currentPassword: string; username?: string; newPassword?: string }) => {
    const data = await req<{ ok: boolean; token: string; username: string }>(`/api/account`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (data.token) setToken(data.token);
    return data;
  },
  logout: () => clearToken(),

  // contacts (keyset pagination via opaque `cursor`)
  getContacts: (params: { status?: string; q?: string; category?: string; limit?: number; cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.q) qs.set("q", params.q);
    if (params.category) qs.set("category", params.category);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    return req<{
      contacts: Contact[];
      counts: { status: string; n: number }[];
      total: number;
      filteredTotal: number;
      nextCursor: string | null;
    }>(`/api/contacts?${qs.toString()}`);
  },
  addContact: (c: Partial<Contact>) =>
    req<{ contact: Contact }>(`/api/contacts`, { method: "POST", body: JSON.stringify(c) }),
  updateContact: (id: string, c: Partial<Contact>) =>
    req<{ contact: Contact }>(`/api/contacts/${id}`, { method: "PUT", body: JSON.stringify(c) }),
  bulkContacts: (contacts: Partial<Contact>[], upsert = false) =>
    req<{ added: number; updated?: number; skipped: number }>(`/api/contacts/bulk`, {
      method: "POST",
      body: JSON.stringify({ contacts, upsert }),
    }),
  deleteContacts: (ids: string[]) =>
    req<{ deleted: number }>(`/api/contacts/delete`, { method: "POST", body: JSON.stringify({ ids }) }),
  // Delete EVERY contact matching the current filter ("select all N matching").
  deleteContactsMatching: (filter: { status?: string; q?: string; category?: string }) =>
    req<{ deleted: number }>(`/api/contacts/delete`, {
      method: "POST",
      body: JSON.stringify({ all: true, ...filter }),
    }),
  // Set/clear category on ids, or on every row matching a filter (`all:true`).
  setContactsCategory: (
    value: string,
    target: { ids?: string[]; all?: boolean; status?: string; q?: string; category?: string }
  ) =>
    req<{ updated: number }>(`/api/contacts/set-category`, {
      method: "POST",
      body: JSON.stringify({ value, ...target }),
    }),

  // categories
  getCategories: () => req<{ categories: string[] }>(`/api/categories`),
  saveCategories: (categories: string[]) =>
    req<{ categories: string[] }>(`/api/categories`, { method: "POST", body: JSON.stringify({ categories }) }),

  // templates
  getTemplates: () => req<{ templates: Template[] }>(`/api/templates`),
  saveTemplate: (t: Partial<Template>) =>
    req<{ template: Template }>(`/api/templates`, { method: "POST", body: JSON.stringify(t) }),
  updateTemplate: (id: string, t: Partial<Template>) =>
    req<{ template: Template }>(`/api/templates/${id}`, { method: "PUT", body: JSON.stringify(t) }),
  deleteTemplate: (id: string) => req(`/api/templates/${id}`, { method: "DELETE" }),

  // domains
  getDomains: () => req<{ domains: Domain[] }>(`/api/domains`),
  saveDomain: (d: Partial<Domain>) =>
    req<{ domain: Domain }>(`/api/domains`, { method: "POST", body: JSON.stringify(d) }),
  updateDomain: (id: string, d: Partial<Domain>) =>
    req<{ domain: Domain }>(`/api/domains/${id}`, { method: "PUT", body: JSON.stringify(d) }),
  deleteDomain: (id: string) => req(`/api/domains/${id}`, { method: "DELETE" }),
  resetCounts: () => req(`/api/domains/reset-counts`, { method: "POST" }),

  // settings
  getSettings: () =>
    req<{
      resendConfigured: boolean;
      appUrl: string;
      replyTo: string;
      scrape: { configured: boolean; provider: string; mode: "blocked" | "always"; premium: boolean };
      reader: {
        configured: boolean;
        fromEnv: boolean;
        savedKeys: number;
        // One entry per key in the pool. `masked` is a fingerprint, never the
        // key itself — it is also the handle used to delete one.
        keys: { masked: string; live: boolean; status: number }[];
      };
      // Where the crawler's pages actually came from since the server booted.
      // `direct`, `commoncrawl` and `archive` are free; `reader` and `proxy`
      // cost money — which is the whole point of reporting the split.
      transports: {
        pages: Record<TransportName, { calls: number; ok: number }>;
        archives: { source: string; fails: number; downForMs: number }[];
        searchEngines: { engine: string; live: boolean; restingForMs: number; note?: string }[];
      };
    }>(`/api/settings`),

  // Add ONE key to the pool. Appends — it never replaces what is stored.
  addReaderKey: (key: string) =>
    req<{ ok: boolean; added: number; duplicates: number; total: number }>(`/api/settings/reader-key`, {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  removeReaderKey: (masked: string) =>
    req<{ ok: boolean; total: number }>(`/api/settings/reader-key`, {
      method: "DELETE",
      body: JSON.stringify({ masked }),
    }),
  saveSettings: (s: {
    resend_api_key?: string;
    app_url?: string;
    reply_to?: string;
    scrape_provider?: string;
    scrape_api_key?: string;
    scrape_mode?: "blocked" | "always";
    scrape_premium?: boolean;
    jina_api_key?: string;
  }) => req(`/api/settings`, { method: "POST", body: JSON.stringify(s) }),
  sendTestEmail: (to: string) =>
    req<{ ok: boolean; from: string }>(`/api/settings/test-email`, { method: "POST", body: JSON.stringify({ to }) }),
  testScrape: () =>
    req<{ ok: boolean; provider: string; via?: string; bytes: number }>(`/api/settings/test-scrape`, { method: "POST", body: "{}" }),
  testReader: () =>
    req<{ ok: boolean; keyed: boolean; bytes: number }>(`/api/settings/test-reader`, { method: "POST", body: "{}" }),

  // crawl
  startCrawl: (body: any) => req<{ jobId: string }>(`/api/crawl`, { method: "POST", body: JSON.stringify(body) }),
  getCrawl: (id: string) => req<Job>(`/api/crawl/${id}`),

  // PDF import: upload a directory PDF, get back parsed rows to enrich
  parsePdf: async (file: File, country?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (country) fd.append("country", country);
    const res = await fetch(`${BASE}/api/import/pdf`, { method: "POST", headers: { ...authHeaders() }, body: fd });
    if (res.status === 401) { onUnauthorized(); throw new Error("Unauthorized"); }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
    return res.json() as Promise<{
      rows: ParsedRow[];
      pages: number;
      count: number;
      textChars: number;
      lineCount: number;
      reason?: "scanned" | "no_listings";
      sample: string[];
    }>;
  },

  // send
  startSend: (body: any) => req<{ jobId: string }>(`/api/send`, { method: "POST", body: JSON.stringify(body) }),
  getSend: (id: string) => req<Job>(`/api/send/${id}`),

  // automation — auto-approve a full pool, then auto-send
  getAutomation: () => req<AutomationStatus>(`/api/automation`),
  // Lanes are patched independently: send only the one you changed.
  saveAutomation: (cfg: Partial<Omit<AutomationConfig, "customer" | "partner">> & {
    customer?: Partial<AutomationLaneConfig>;
    partner?: Partial<AutomationLaneConfig>;
  }) => req<AutomationStatus>(`/api/automation`, { method: "POST", body: JSON.stringify(cfg) }),
  runAutomation: (audience: Audience = "customer") =>
    req<{ started: boolean; audience?: Audience; runId?: string; jobId?: string; approved?: number; status: AutomationStatus }>(
      `/api/automation/run`,
      { method: "POST", body: JSON.stringify({ audience }) }
    ),

  // follow-up ladder — retry whoever didn't open / didn't click
  getFollowUp: () => req<FollowUpStatus>(`/api/followup`),
  saveFollowUp: (cfg: Partial<FollowUpConfig>) =>
    req<FollowUpStatus>(`/api/followup`, { method: "POST", body: JSON.stringify(cfg) }),
  runFollowUp: () =>
    req<{ started: boolean; runId?: string; jobId?: string; queued?: number; status: FollowUpStatus }>(
      `/api/followup/run`,
      { method: "POST", body: "{}" }
    ),

  // lead finder
  getLeadCategories: () => req<{ categories: string[] }>(`/api/leads/categories`),
  geocode: (q: string) =>
    req<{ places: Place[] }>(`/api/leads/geocode?q=${encodeURIComponent(q)}`),
  findLeads: (location: string, category: string, limit: number, place?: Place | null) =>
    req<LeadResult>(`/api/leads/find`, {
      method: "POST",
      body: JSON.stringify({ location, category, limit, place: place || undefined }),
    }),
  searchCompanies: (keywords: string, location: string, limit: number) =>
    req<LeadResult>(`/api/leads/search`, {
      method: "POST",
      body: JSON.stringify({ keywords, location, limit }),
    }),

  // check which pasted URLs are already known (dedup preview)
  checkCrawl: (urls: string[]) =>
    req<{ total: number; inContacts: number; crawled: number; fresh: number }>(
      `/api/crawl/check`,
      { method: "POST", body: JSON.stringify({ urls }) }
    ),

  // discovery bot
  getDiscoveryStatus: () => req<DiscoveryStatus>(`/api/discovery/status`),
  toggleDiscovery: (body: { enabled?: boolean; autoEnrich?: boolean }) =>
    req<DiscoveryStatus>(`/api/discovery/toggle`, { method: "POST", body: JSON.stringify(body) }),
  // Re-queue leads whose email couldn't be read (Cloudflare wall / reader rate
  // limit) so the bot tries them again — the historical "no email" recovery.
  reEnrichDiscovery: () => req<{ reset: number }>(`/api/discovery/re-enrich`, { method: "POST", body: "{}" }),
  // Company names saved by the old directory harvester could be the card's phone
  // number. Count them, and repair them by re-reading the directory sources.
  getBadNameCount: () => req<{ leads: number; contacts: number }>(`/api/discovery/bad-names`),
  repairNames: () => req<{ jobId: string }>(`/api/discovery/repair-names`, { method: "POST", body: "{}" }),
  purgeJunkLeads: () => req<{ swept: number }>(`/api/discovery/purge-junk`, { method: "POST", body: "{}" }),
  getDiscoverySources: (archived = false) =>
    req<{ sources: DiscoverySource[]; archivedCount: number }>(
      `/api/discovery/sources${archived ? "?archived=1" : ""}`
    ),
  // Retire a source without deleting it — the bot stops scheduling it, but its
  // walk position, stats and leads are all kept, ready to be restored.
  archiveDiscoverySource: (id: string) =>
    req<{ source: DiscoverySource }>(`/api/discovery/sources/${id}/archive`, { method: "POST", body: "{}" }),
  unarchiveDiscoverySource: (id: string) =>
    req<{ source: DiscoverySource }>(`/api/discovery/sources/${id}/unarchive`, { method: "POST", body: "{}" }),
  addDiscoverySource: (body: {
    type?: "osm" | "directory" | "search";
    location?: string;
    url?: string;
    keywords?: string;
    category?: string;
    audience?: Audience;
    limit?: number;
    intervalMinutes?: number;
    place?: Place | null;
    enabled?: boolean;
    sweepCountry?: boolean;
  }) => req<{ source: DiscoverySource }>(`/api/discovery/sources`, { method: "POST", body: JSON.stringify(body) }),
  updateDiscoverySource: (id: string, body: Partial<{ location: string; url: string; keywords: string; category: string; audience: Audience; limit: number; intervalMinutes: number; enabled: boolean; place: Place | null; sweepCountry: boolean }>) =>
    req<{ source: DiscoverySource }>(`/api/discovery/sources/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteDiscoverySource: (id: string) => req(`/api/discovery/sources/${id}`, { method: "DELETE" }),
  runDiscoverySource: (id: string) =>
    req<{ started?: boolean; found?: number }>(`/api/discovery/sources/${id}/run`, { method: "POST", body: "{}" }),
  getDiscoveryLeads: (params: { status?: string; q?: string; hasEmail?: boolean; limit?: number; country?: string; audience?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.q) qs.set("q", params.q);
    if (params.hasEmail) qs.set("hasEmail", "1");
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.country) qs.set("country", params.country);
    if (params.audience) qs.set("audience", params.audience);
    return req<{
      leads: DiscoveredLead[];
      counts: { status: string; n: number }[];
      filteredTotal: number;
      approvableTotal: number;
      // Every country present in the current tab, with a count — "__none__" is
      // the bucket for leads with no country on file.
      countries: { country: string; n: number }[];
      // How this tab splits between the two pitches.
      audiences: { audience: string; n: number }[];
      // Where the leads in this exact view stand on their way to an email.
      breakdown: { withEmail: number; crawling: number; queued: number; noEmail: number };
    }>(`/api/discovery/leads?${qs.toString()}`);
  },
  approveDiscoveryLeads: (body: { ids?: string[]; all?: boolean; q?: string; category?: string; country?: string; filterCountry?: string; filterAudience?: string }) =>
    req<{ added: number; skipped: number }>(`/api/discovery/leads/approve`, { method: "POST", body: JSON.stringify(body) }),
  rejectDiscoveryLeads: (body: { ids?: string[]; all?: boolean; q?: string; filterCountry?: string; filterAudience?: string }) =>
    req<{ rejected: number }>(`/api/discovery/leads/reject`, { method: "POST", body: JSON.stringify(body) }),
  deleteDiscoveryLeads: (body: { ids?: string[]; all?: boolean; status?: string; q?: string; filterCountry?: string; filterAudience?: string }) =>
    req<{ deleted: number }>(`/api/discovery/leads/delete`, { method: "POST", body: JSON.stringify(body) }),

  // export
  exportContacts: async (params: { status?: string; q?: string; category?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status && params.status !== "all") qs.set("status", params.status);
    if (params.q) qs.set("q", params.q);
    if (params.category && params.category !== "all") qs.set("category", params.category);
    const res = await fetch(`${BASE}/api/contacts/export?${qs.toString()}`, {
      headers: { ...authHeaders() },
    });
    if (res.status === 401) {
      onUnauthorized();
      throw new Error("Unauthorized");
    }
    return res.text();
  },
  exportHistory: async () => {
    const res = await fetch(`${BASE}/api/history/export`, { headers: { ...authHeaders() } });
    if (res.status === 401) {
      onUnauthorized();
      throw new Error("Unauthorized");
    }
    return res.text();
  },

  // overview
  getOverview: () =>
    req<{
      contacts: { status: string; n: number }[];
      sends: { status: string; n: number }[];
      opens: number;
      clicks: number;
      totalContacts: number;
      totalSends: number;
      daily: { d: string; n: number }[];
    }>(`/api/overview`),

  // history + stats
  getHistory: (limit = 200) => req<{ sends: SendRow[] }>(`/api/history?limit=${limit}`),
  getStats: () =>
    req<{
      contacts: { status: string; n: number }[];
      sends: { status: string; n: number }[];
      opens: number;
      clicks: number;
      totalContacts: number;
      totalSends: number;
    }>(`/api/stats`),
};
