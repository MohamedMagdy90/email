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
  status: string;
  created_at: string;
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
    }>(`/api/settings`),
  saveSettings: (s: {
    resend_api_key?: string;
    app_url?: string;
    reply_to?: string;
    scrape_provider?: string;
    scrape_api_key?: string;
    scrape_mode?: "blocked" | "always";
    scrape_premium?: boolean;
  }) => req(`/api/settings`, { method: "POST", body: JSON.stringify(s) }),
  sendTestEmail: (to: string) =>
    req<{ ok: boolean; from: string }>(`/api/settings/test-email`, { method: "POST", body: JSON.stringify({ to }) }),
  testScrape: () =>
    req<{ ok: boolean; provider: string; via?: string; bytes: number }>(`/api/settings/test-scrape`, { method: "POST", body: "{}" }),

  // crawl
  startCrawl: (body: any) => req<{ jobId: string }>(`/api/crawl`, { method: "POST", body: JSON.stringify(body) }),
  getCrawl: (id: string) => req<Job>(`/api/crawl/${id}`),

  // send
  startSend: (body: any) => req<{ jobId: string }>(`/api/send`, { method: "POST", body: JSON.stringify(body) }),
  getSend: (id: string) => req<Job>(`/api/send/${id}`),

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
      totalContacts: number;
      totalSends: number;
    }>(`/api/stats`),
};
