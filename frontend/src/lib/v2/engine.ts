// Own sending engine API (backend/src/v2/engine/module.ts).
// Our own Google Workspace / Microsoft 365 mailboxes: sign-in apps, mailboxes,
// domains (DNS assistant), test inboxes, inbox tests, the send queue and the
// warmup on/off test.
import { req } from "../api";
import { del, j, patch } from "./core";

export type Provider = "google" | "microsoft";

export interface Connection {
  id: string;
  provider: Provider;
  label: string;
  clientId: string;
  status: string;
  lastError: string | null;
  mailboxes: number;
  seeds: number;
  createdAt: string;
}

export interface Seed {
  id: string;
  email: string;
  /** workspace | m365 | gmail | outlook | imap */
  provider: string;
  /** oauth | imap */
  access: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  last7: { tests: number; inbox: number; spam: number; missing: number };
}

export interface EngineStatus {
  secretWarning: string | null;
  callbackPath: string;
  publicBase: string | null;
  connections: Connection[];
  seeds: Seed[];
  ownMailboxes: number;
}

export interface RecordCheck {
  ok: boolean;
  found: string[];
  indeterminate?: boolean;
  note?: string;
}

export interface DomainCheck {
  domain: string;
  provider: "google" | "microsoft" | "unknown";
  mx: RecordCheck;
  spf: RecordCheck;
  dkim: RecordCheck;
  dmarc: RecordCheck;
  forward: { ok: boolean | null; finalUrl: string | null };
  allPass: boolean;
  indeterminate: string[];
  checkedAt: string;
}

export interface ExpectedRecord {
  key: "mx" | "spf" | "dkim" | "dmarc" | "forward";
  type: string;
  host: string;
  value: string;
  priority?: number;
  note?: string;
}

export interface DomainSetup {
  domain: string;
  provider: "google" | "microsoft" | "unknown";
  records: ExpectedRecord[];
  check: DomainCheck | null;
  registeredAt: string | null;
  firstAddedAt: string;
}

/** inbox | other_tab | spam | missing | pending | failed | other */
export type TestResult = string;

export interface PlacementTest {
  id: string;
  mailboxId: string;
  seedId: string;
  day: string;
  result: TestResult;
  folder: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  checkedAt: string | null;
  error: string | null;
}

export interface PlacementGrid {
  days: string[];
  seeds: { id: string; email: string; provider: string; enabled: boolean; status: string }[];
  tests: PlacementTest[];
}

export interface GroupStats {
  group: "warmup_on" | "warmup_off";
  mailboxes: { id: string; email: string; provider: string; warmup: string }[];
  tests: number;
  inboxRate: number | null;
  bySeed: Record<string, { tests: number; rate: number | null }>;
  sent: number;
  contacted: number;
  replies: number;
  replyRate: number | null;
  bounces: number;
  bounceRate: number | null;
}

export type Experiment =
  | { active: false; testDays: number }
  | {
      active: true;
      testDays: number;
      startedAt: string | null;
      day: number;
      on: GroupStats;
      off: GroupStats;
      verdict: { decided: boolean; keepWarmup: boolean | null; text: string };
      note: string;
    };

export interface QueueItem {
  id: string;
  step: number;
  to: string;
  toName: string | null;
  /** scheduled | sending | sent | failed | cancelled | bounced | soft_bounced */
  status: string;
  reason: string | null;
  at: string;
  mailbox: string | null;
  campaignId: string | null;
}

const B = "/api/v2/engine";
const enc = encodeURIComponent;

export const engineApi = {
  status: () => req<EngineStatus>(`${B}/status`),

  saveConnection: (body: { id?: string; provider?: Provider; label?: string; clientId?: string; clientSecret?: string }) =>
    body.id
      ? req<{ connections: Connection[] }>(`${B}/connections/${enc(body.id)}`, { method: "PUT", body: JSON.stringify(body) })
      : req<{ connections: Connection[] }>(`${B}/connections`, j(body)),
  deleteConnection: (id: string) => req<{ connections: Connection[] }>(`${B}/connections/${enc(id)}`, del),

  /** redirectBase = the backend's public address; returnTo = the app, for a full-page sign-in (API on another host). */
  startOAuth: (body: { connectionId: string; purpose: "mailbox" | "seed"; redirectBase: string; loginHint?: string | null; mailboxId?: string | null; returnTo?: string | null }) =>
    req<{ url: string; redirectUri: string }>(`${B}/oauth/start`, j(body)),

  testMailbox: (id: string) => req<{ ok: boolean; error?: string; email?: string }>(`${B}/mailboxes/${enc(id)}/test`, j({})),
  removeMailbox: (id: string) => req<{ cancelled: number }>(`${B}/mailboxes/${enc(id)}`, del),
  runTests: (id: string) => req<{ scheduled: number }>(`${B}/mailboxes/${enc(id)}/tests/run`, j({})),

  domain: (domain: string) => req<DomainSetup>(`${B}/domains/${enc(domain)}`),
  checkDomain: (domain: string) => req<DomainSetup>(`${B}/domains/${enc(domain)}/check`, j({})),

  seeds: () => req<{ seeds: Seed[] }>(`${B}/seeds`),
  addImapSeed: (body: { email: string; host: string; port?: number; user?: string; password: string }) => req<{ seeds: Seed[] }>(`${B}/seeds/imap`, j(body)),
  updateSeed: (id: string, body: { enabled?: boolean }) => req<{ seeds: Seed[] }>(`${B}/seeds/${enc(id)}`, patch(body)),
  deleteSeed: (id: string) => req<{ seeds: Seed[] }>(`${B}/seeds/${enc(id)}`, del),
  testSeed: (id: string) => req<{ ok: boolean; error?: string }>(`${B}/seeds/${enc(id)}/test`, j({})),

  placement: (days = 7, mailboxId?: string) => req<PlacementGrid>(`${B}/placement?days=${days}${mailboxId ? `&mailboxId=${enc(mailboxId)}` : ""}`),
  experiment: () => req<Experiment>(`${B}/experiment`),
  queueToday: (campaignId?: string) => req<{ items: QueueItem[] }>(`${B}/queue/today${campaignId ? `?campaignId=${enc(campaignId)}` : ""}`),
};

/**
 * Where the browser reaches the backend. Live (Railway) the frontend and the
 * backend are two services on two hosts and the build carries the backend's
 * address in VITE_API_URL; in development (and behind a proxy) it is this page's.
 */
export function apiOrigin(): string {
  const base = ((import.meta as any).env?.VITE_API_URL || "") as string;
  try {
    return base ? new URL(base).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

/** The API on another host: a popup can't report back across hosts, so sign-in goes through a full page. */
const apiOnAnotherHost = () => apiOrigin() !== window.location.origin;

/** The redirect URI to register in the Google / Microsoft app: the BACKEND's callback (never the frontend host). */
export const callbackUrl = (path = "/api/v2/oauth/callback") => `${apiOrigin()}${path}`;

export const PROVIDER_LABEL: Record<Provider, string> = { google: "Google Workspace", microsoft: "Microsoft 365" };

export const SEED_LABEL: Record<string, string> = {
  workspace: "Google Workspace",
  m365: "Microsoft 365",
  gmail: "Gmail",
  outlook: "Outlook.com",
  imap: "IMAP",
};

/* ------------------------------ OAuth popup ------------------------------ */

export interface OAuthResult {
  type: "dna-oauth";
  ok: boolean;
  message: string;
  kind: string | null;
  email: string | null;
}

const RESULT_KEY = "dnaOauthResult";

/**
 * A full-page sign-in comes back to the app as /#dnaOauth=<result>. Keep the
 * result where the Mailboxes / Agent screens announce it on mount, and clean
 * the address bar. Runs once when this module loads (before any screen mounts).
 */
function captureReturnedOAuth() {
  try {
    const m = window.location.hash.match(/^#dnaOauth=(.+)$/);
    if (!m) return;
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    const r = JSON.parse(decodeURIComponent(m[1]));
    if (r && r.type === "dna-oauth" && typeof r.message === "string") localStorage.setItem(RESULT_KEY, JSON.stringify({ type: "dna-oauth", ok: !!r.ok, message: r.message.slice(0, 400), kind: r.kind ?? null, email: r.email ?? null }));
  } catch {
    /* malformed or private mode: nothing to announce */
  }
}
captureReturnedOAuth();

/** A result left behind by the callback page when it couldn't reach a popup opener (full-page redirect). */
export function takeStoredOAuthResult(): OAuthResult | null {
  try {
    const raw = localStorage.getItem(RESULT_KEY);
    if (!raw) return null;
    localStorage.removeItem(RESULT_KEY);
    const r = JSON.parse(raw);
    return r && r.type === "dna-oauth" ? (r as OAuthResult) : null;
  } catch {
    return null;
  }
}

/**
 * Sign in with Google / Microsoft.
 *
 * API on another host (live): a full-page round trip. The browser goes to the
 * provider, the provider to the backend's callback, the callback back to this
 * app with the result in the fragment (captureReturnedOAuth). Resolves null;
 * the page is navigating away.
 *
 * Same host (development, proxied): a popup that resolves when the callback
 * reports back. The callback page posts a message to its opener AND writes
 * localStorage, because Google's pages can cut the opener link (COOP); either
 * signal finishes the flow. A blocked popup falls back to a full-page redirect.
 */
export async function signInWithProvider(opts: { connectionId: string; purpose: "mailbox" | "seed"; loginHint?: string | null; mailboxId?: string | null }): Promise<OAuthResult | null> {
  try {
    localStorage.removeItem(RESULT_KEY);
  } catch {
    /* private mode */
  }
  if (apiOnAnotherHost()) {
    const { url } = await engineApi.startOAuth({ ...opts, redirectBase: apiOrigin(), returnTo: `${window.location.origin}${window.location.pathname}` });
    window.location.assign(url);
    return null;
  }
  const { url } = await engineApi.startOAuth({ ...opts, redirectBase: window.location.origin });
  const w = 520;
  const h = 680;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  const popup = window.open(url, "dna-oauth", `width=${w},height=${h},left=${left},top=${top}`);
  if (!popup) {
    window.location.href = url;
    return null;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: OAuthResult | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      clearInterval(poll);
      resolve(r);
    };
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === "dna-oauth") finish(e.data as OAuthResult);
    };
    window.addEventListener("message", onMsg);
    const started = Date.now();
    const poll = setInterval(() => {
      const stored = takeStoredOAuthResult();
      if (stored) return finish(stored);
      let closed = false;
      try {
        closed = popup.closed;
      } catch {
        closed = false;
      }
      // Closed without a result: give the storage write a moment, then give up.
      if (closed && Date.now() - started > 1500) setTimeout(() => finish(takeStoredOAuthResult()), 600);
      if (Date.now() - started > 15 * 60_000) finish(null);
    }, 500);
  });
}
