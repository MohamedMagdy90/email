/// <reference types="vite-plugin-pwa/client" />

import { useEffect, useState } from "react";
import { registerSW } from "virtual:pwa-register";

/* --------------------------- service worker -------------------------- */

let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null;

const UPDATE_EVENT = "dna-sw-update";
const INSTALL_EVENT = "dna-can-install";

/**
 * Registers the worker. `registerType` is "prompt", so a new build never swaps
 * itself in underneath someone half-way through composing a campaign — it
 * raises a banner and waits to be told.
 */
export function initPWA() {
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      window.dispatchEvent(new Event(UPDATE_EVENT));
    },
  });
}

/** Activates the waiting worker and reloads onto the new build. */
export function reloadWithUpdate() {
  void applyUpdate?.(true);
}

/** True once a newer build is sitting in the wings. */
export function useSwUpdate() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener(UPDATE_EVENT, on);
    return () => window.removeEventListener(UPDATE_EVENT, on);
  }, []);
  return ready;
}

/* --------------------------- install prompt -------------------------- */

// Chromium fires this once, early, and it is the only handle on the native
// install flow. It has to be captured before React mounts or it is lost, so
// this listener is attached at module scope.
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: InstallPromptEvent | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as InstallPromptEvent;
    window.dispatchEvent(new Event(INSTALL_EVENT));
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    window.dispatchEvent(new Event(INSTALL_EVENT));
  });
}

/** Already running from the home screen / an app window? */
export function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari's own flag; it never fires beforeinstallprompt.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIos() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * `install` is null when there is nothing to offer — either the app is already
 * installed, or the browser has not (or will not) hand over a prompt. iOS never
 * does, so `iosHint` carries the Share-sheet instructions instead.
 */
export function useInstallPrompt() {
  const [available, setAvailable] = useState(() => !!deferredPrompt);
  const [installed, setInstalled] = useState(() => isStandalone());

  useEffect(() => {
    const on = () => {
      setAvailable(!!deferredPrompt);
      setInstalled(isStandalone());
    };
    window.addEventListener(INSTALL_EVENT, on);
    return () => window.removeEventListener(INSTALL_EVENT, on);
  }, []);

  async function install() {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    setAvailable(false);
    return outcome === "accepted";
  }

  return {
    installed,
    canInstall: available && !installed,
    iosHint: !installed && isIos(),
    install,
  };
}
