// DNA Outreach service worker: shows alerts (Web Push) when a reply needs you,
// and opens that conversation when one is tapped.
//
// It caches nothing and has no fetch handler, so page loads come straight from
// the network and a new build is live as soon as it is deployed.
//
// This file has the same name as the worker from the old PWA build. When that
// worker updates to this one, activation deletes its caches and reloads the
// tabs it was serving.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();

      // Existing caches indicate that the old build's worker was running.
      if (keys.length) {
        const windows = await self.clients.matchAll({ type: "window" });
        for (const client of windows) {
          client.navigate(client.url).catch(() => {});
        }
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "DNA Outreach",
      body: event.data ? event.data.text() : "",
    };
  }

  const title = data.title || "DNA Outreach";

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: !!data.tag,
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        timestamp: data.at ? Date.parse(data.at) : Date.now(),
        data: {
          url: data.url || "/",
          threadId: data.threadId || null,
        },
      });

      // Update the app icon badge where the browser supports it.
      if (typeof data.count === "number") {
        try {
          if (data.count > 0 && self.navigator.setAppBadge) {
            await self.navigator.setAppBadge(data.count);
          } else if (data.count <= 0 && self.navigator.clearAppBadge) {
            await self.navigator.clearAppBadge();
          }
        } catch {
          // Badges are optional and may not be supported.
        }
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const url = new URL(data.url || "/", self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existingWindow = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );

      if (existingWindow) {
        // Bring the open app forward and open the conversation in place.
        await existingWindow.focus().catch(() => {});
        existingWindow.postMessage({
          type: "dna-open",
          threadId: data.threadId || null,
        });
        return;
      }

      await self.clients.openWindow(url);
    })(),
  );
});
