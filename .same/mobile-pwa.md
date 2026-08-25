# Mobile + PWA — DNA Outreach frontend

Scope: `email/frontend` only. Backend untouched. **COMPLETE.**

## Baseline measured before any change
- No manifest, no service worker, no icons, no `vite-plugin-pwa`. `public/` held
  only `_redirects`.
- `App.tsx` sidebar is a hard `w-[248px] shrink-0` with no breakpoint — 64% of a
  390px viewport. Shell is `h-screen w-screen`.
- Content wrapper `mx-auto max-w-6xl px-8 py-8`.
- Tables: Contacts 10 cols · History 7 · Discovery 7 · Send 4 · Crawler 3 tables,
  all in `overflow-x-auto`.
- 16 `grid-cols-*` with no responsive prefix across 5 screens.
- Inputs `text-sm` (14px) -> iOS zooms on focus. Buttons `h-8`/`h-10`.
- `Tooltip` is hover-only (its own comment says so); Discovery icon buttons rely
  on it.
- Responsive prefix usage across all screens: `sm:` 46 · `md:` 1 · `lg:` 8 · `xl:` 0.

## Breakpoint contract (the thing to keep consistent from here)
- **`lg` (1024px) is the SHELL breakpoint.** Sidebar vs tab bar; table vs card
  list; one-row toolbar vs stacked toolbar.
- **`sm` (640px) is the CONTROL breakpoint.** Form grids, button heights, fixed
  control widths, `Modal` sheet-vs-dialog.
- Anything inside the crawler `Modal` uses `sm`, because the modal itself
  switches there.

## Done
- [x] A1 `vite-plugin-pwa`, `injectRegister: null` + `registerType: "prompt"`
- [x] A2 icons generated from brand SVG geometry (a path-drawn "D", no font
      dependency): 192 / 512 / maskable-512 / apple-touch-180 / favicon 32+svg
- [x] A3 manifest: standalone, ink theme, 3 shortcuts (`/?tab=…`)
- [x] A4 `index.html`: `viewport-fit=cover`, theme-color, apple web-app meta,
      `format-detection`, description, icon links
- [x] A5 Workbox: precache the shell (17 entries), CacheFirst on the Fontshare
      CDN, **NetworkOnly on `/api/*`** — contact PII must not outlive a logout
      in CacheStorage
- [x] A6 `src/lib/pwa.ts` — `initPWA` / `useSwUpdate` / `reloadWithUpdate` /
      `useInstallPrompt` (+ iOS Share-sheet hint, since iOS never fires
      `beforeinstallprompt`)
- [x] A7 `public/_headers` + matching `netlify.toml` headers
- [x] B1 `index.css`: safe-area vars, `--nav-h`, 16px input override, tap
      highlight, overscroll, pointer-only scrollbars, `no-scrollbar` /
      `touch-scroll` utilities, sheet animations
- [x] B2 `App.tsx` responsive shell
- [x] B3 More sheet (Templates / History / Settings / Install / Log out)
- [x] C1 Contacts card list · C2 History · C3 Discovery · Send · Crawler ×2
- [x] D1-D5 `ui.tsx` Button / fields / Modal / Toaster / Tooltip
- [x] E1 all non-responsive grids
- [x] F1 `tsc --noEmit` clean · `vite build` clean

## Verified in the built CSS
`h-[100dvh]`, `max-h-[55|60|85|92dvh]`, `pt-[var(--sat)]`, `pb-[var(--sab)]`,
`pb-[calc(1rem+var(--sab))]`, `bottom-[calc(var(--nav-h)+var(--sab)+0.75rem)]`,
`body[data-mobile-nav=true]{--nav-h:58px}` and its `lg` reset,
`.no-scrollbar::-webkit-scrollbar{display:none}` all present.

## Deliberate calls
- **`--nav-h` is set from a `body` data attribute**, not passed as a prop, so the
  Toaster clears the tab bar without either component importing the other. It is
  `0px` by default and reset to `0px` again at `lg`, so the desktop toaster is
  byte-identical to before.
- **The tab bar is in normal flow, not `fixed`.** A fixed bar covers the last row
  of every list, and every list here ends in a pager.
- **The desktop tables were kept verbatim** and merely wrapped in
  `hidden lg:block`. No column was dropped anywhere.
- **`registerType: "prompt"`, not `autoUpdate`.** A deploy must not reload the
  page under someone who is part-way through a send.
- **`devOptions` has no `navigateFallback`** — a dev worker answering navigations
  from cache is how you end up debugging a ten-minute-old build.
- **`user-scalable` was left alone.** Pinch-zoom stays available.
- **`sharp` was installed only to rasterise the icons and then removed** — it
  pulled 295 packages into an otherwise tiny dependency tree. The PNGs are
  committed; regenerating them needs `bun add -d sharp` again.

## Known, not done
- The Send screen still asks for two scrolls on a phone: template and the Send
  button sit above the recipient list. A sticky send bar would fix it but would
  have to negotiate with the tab bar — worth doing only if asked.
- `Tooltip` still rides `group-focus-within` on touch, so the label appears after
  the tap has already fired the button's action. Fine for the icon buttons it is
  used on; not a general solution.
