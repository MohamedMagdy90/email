import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // We register by hand in main.tsx so the "new version" prompt is a toast
      // in the app's own language rather than a browser-level reload.
      injectRegister: null,
      registerType: "prompt",
      includeAssets: ["favicon.svg", "favicon-32.png", "apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "DNA Outreach",
        short_name: "Outreach",
        description:
          "Discover companies, find their public emails, and run cold outreach campaigns from secondary domains.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#0b0b0b",
        theme_color: "#0b0b0b",
        categories: ["business", "productivity"],
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "Contacts", short_name: "Contacts", url: "/?tab=contacts" },
          { name: "Send", short_name: "Send", url: "/?tab=send" },
          { name: "Discovery", short_name: "Discovery", url: "/?tab=discovery" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        navigateFallback: "/index.html",
        // A navigation to /api/* must reach the network, never the app shell.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Clash Display + Satoshi are fetched from a CDN on every cold
            // start. Cached, they are the difference between a flash of
            // fallback type and none at all.
            urlPattern: ({ url }) =>
              url.origin === "https://api.fontshare.com" || url.origin === "https://cdn.fontshare.com",
            handler: "CacheFirst",
            options: {
              cacheName: "fontshare",
              expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Contact records are PII and the session is bearer-token based.
            // Nothing from the API is written to CacheStorage, where it would
            // outlive a log out.
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
          },
        ],
      },
      devOptions: {
        // On, so the manifest and the install prompt can be exercised in the
        // dev preview. Deliberately WITHOUT navigateFallback: letting a dev
        // worker answer navigations from cache is how you end up debugging a
        // build from ten minutes ago. Vite already serves the SPA fallback.
        enabled: true,
        type: "module",
        suppressWarnings: true,
      },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true
      }
    }
  },
  optimizeDeps: {
    exclude: ["same-runtime/dist/jsx-runtime", "same-runtime/dist/jsx-dev-runtime"]
  }
});
