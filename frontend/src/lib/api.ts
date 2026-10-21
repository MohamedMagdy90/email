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

// Exported so the v2 API modules (lib/v2/*.ts) share auth + error handling.
export async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
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
  me: () => req<{ ok: boolean; username: string | null }>("/api/auth/me"),
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
};
