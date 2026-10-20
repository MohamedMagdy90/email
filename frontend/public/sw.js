// Retires the service worker left behind by the old PWA build.
//
// Browsers that installed the old app keep running its worker, which serves
// the old cached bundle. They re-check /sw.js on navigation; when they fetch
// this file it installs, deletes every cache the old worker made, unregisters
// itself and reloads open tabs, so they land on the current build from the
// network. Fresh visitors never register a worker at all.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.navigate(client.url);
      }
    })(),
  );
});
