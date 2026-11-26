// Alerts on this phone or computer (Web Push). The server side is
// backend/src/v2/push; the worker that shows them is public/sw.js.
import { req } from "../api";
import { del, j, put } from "./core";

export interface PushPrefs {
  /** Replies handed to you (kinds you keep, unclear, legal, low confidence, couldn't write / send). */
  handoff: boolean;
  /** Wants a call, a demo or the next step, even when the agent answers it. */
  interested: boolean;
  /** The agent wrote an answer and holds it for your approval. */
  drafts: boolean;
}
export interface PushDevice {
  id: string;
  endpoint: string;
  label: string;
  /** Apple / Google / Mozilla / Microsoft: who delivers to it. */
  service: string;
  createdAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}
export interface PushRecent {
  kind: "interested" | "handoff" | "draft" | "summary";
  title: string;
  body: string;
  /** sent | held | grouped | no_device | failed | dropped */
  status: string;
  delivered: number;
  devices: number;
  threadId: string | null;
  at: string;
}
export interface PushView {
  publicKey: string;
  prefs: PushPrefs;
  devices: PushDevice[];
  recent: PushRecent[];
}

export const pushApi = {
  view: () => req<PushView>("/api/v2/push"),
  subscribe: (subscription: PushSubscriptionJSON, label: string) => req<{ device: PushDevice; view: PushView }>("/api/v2/push/subscribe", j({ subscription, label })),
  unsubscribe: (endpoint: string) => req<{ removed: boolean; view: PushView }>("/api/v2/push/unsubscribe", j({ endpoint })),
  removeDevice: (id: string) => req<{ view: PushView }>(`/api/v2/push/devices/${encodeURIComponent(id)}`, del),
  savePrefs: (p: Partial<PushPrefs>) => req<{ view: PushView }>("/api/v2/push/prefs", put(p)),
  test: (endpoint?: string) => req<{ result: { devices: number; delivered: number; errors: string[] }; view: PushView }>("/api/v2/push/test", j({ endpoint })),
};

/* ------------------------------- this device ------------------------------- */

const ENDPOINT_KEY = "dnaPushEndpoint";

export const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** "iPhone · app", "Mac · Chrome", "Windows · Edge" … shown in the device list. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const platform = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
    ? "iPad"
    : /iPhone|iPod/.test(ua)
      ? "iPhone"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "Chromebook"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${platform} · ${isStandalone() ? "app" : browser}`;
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Register the alerts worker (no caching, no fetch handler). Safe to call repeatedly. */
export function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return Promise.resolve(null);
  if (!registration) {
    registration = navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) => {
      console.warn("[alerts] service worker not registered:", e);
      registration = null;
      return null;
    });
  }
  return registration;
}

export type DeviceState =
  /** Alerts reach this device. */
  | { kind: "on"; endpoint: string }
  /** Can be turned on with one tap. */
  | { kind: "off" }
  /** The person said no to notifications for this site. */
  | { kind: "blocked" }
  /** iPhone / iPad in Safari: add it to the Home Screen first (iOS 16.4+). */
  | { kind: "ios-install" }
  /** No push in this browser (or not https). */
  | { kind: "unsupported" };

/** Where this device stands. `serverEndpoints` = the devices the server knows (on = known there too). */
export async function deviceState(serverEndpoints?: string[]): Promise<DeviceState> {
  if (!window.isSecureContext) return { kind: "unsupported" };
  if (isIos() && !isStandalone()) return { kind: "ios-install" };
  if (!pushSupported()) return { kind: "unsupported" };
  if (Notification.permission === "denied") return { kind: "blocked" };
  const reg = await registerWorker();
  if (!reg) return { kind: "unsupported" };
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  if (!sub || Notification.permission !== "granted") return { kind: "off" };
  if (serverEndpoints && !serverEndpoints.includes(sub.endpoint)) return { kind: "off" };
  return { kind: "on", endpoint: sub.endpoint };
}

function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const s = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Was this subscription made with the server's current key? (Unknown counts as yes.) */
function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function freshSubscription(reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
}

/**
 * Turn alerts on for this device. Call it straight from a tap: iPhones only
 * show the permission question for a direct tap (no await before it).
 */
export async function turnOn(publicKey: string): Promise<PushView> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied" ? "Alerts are blocked for this site. Allow notifications for it in the browser's settings, then try again." : "Alerts weren't allowed. Tap Turn on again and choose Allow.");
  }
  const reg = await registerWorker();
  if (!reg) throw new Error("This browser couldn't start the alerts worker.");
  await navigator.serviceWorker.ready;
  const sub = await freshSubscription(reg, publicKey);
  const r = await pushApi.subscribe(sub.toJSON(), deviceLabel());
  try {
    localStorage.setItem(ENDPOINT_KEY, sub.endpoint);
  } catch {
    /* private mode */
  }
  return r.view;
}

/** Turn alerts off for this device only. */
export async function turnOff(): Promise<PushView | null> {
  const reg = await registerWorker();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  try {
    localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    /* private mode */
  }
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  return (await pushApi.unsubscribe(endpoint)).view;
}

/**
 * On start (signed in): keep this device's sign-up in step. Re-subscribes when
 * the server made new keys, and re-sends a sign-up the browser renewed. A
 * device removed from the list on purpose stays removed.
 */
export async function resyncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const reg = await registerWorker();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (!reg || !sub) return;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(ENDPOINT_KEY);
  } catch {
    /* private mode */
  }
  const view = await pushApi.view();
  const keyChanged = !sameKey(sub, view.publicKey);
  if (!keyChanged && (!stored || stored === sub.endpoint)) return;
  const next = keyChanged ? await freshSubscription(reg, view.publicKey) : sub;
  await pushApi.subscribe(next.toJSON(), deviceLabel());
  try {
    localStorage.setItem(ENDPOINT_KEY, next.endpoint);
  } catch {
    /* private mode */
  }
}

/** The installed app's icon badge (unread + needs you), where supported. */
export function setIconBadge(n: number) {
  const nav = navigator as any;
  try {
    if (n > 0) nav.setAppBadge?.(n)?.catch?.(() => {});
    else nav.clearAppBadge?.()?.catch?.(() => {});
  } catch {
    /* not supported */
  }
}

/* ------------------------------ install prompt ------------------------------ */
// Chrome / Edge / Android offer "Install app"; keep the event so the alerts
// dialog can show an Install button. (Safari has no prompt: Share -> Add to Home Screen.)

let installEvent: any = null;
export const INSTALLABLE_EVENT = "dna-installable";

export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e;
    window.dispatchEvent(new Event(INSTALLABLE_EVENT));
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    window.dispatchEvent(new Event(INSTALLABLE_EVENT));
  });
}

export const canInstall = () => !!installEvent && !isStandalone();

export async function promptInstall(): Promise<boolean> {
  if (!installEvent) return false;
  installEvent.prompt();
  const choice = await installEvent.userChoice.catch(() => null);
  installEvent = null;
  window.dispatchEvent(new Event(INSTALLABLE_EVENT));
  return choice?.outcome === "accepted";
}
