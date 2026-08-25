import { useEffect, useState, type ReactNode } from "react";
import { cn, Toaster, Spinner, Sheet } from "./lib/ui";
import { api, clearToken } from "./lib/api";
import { useInstallPrompt, useSwUpdate, reloadWithUpdate } from "./lib/pwa";
import Login from "./screens/Login";
import Setup from "./screens/Setup";
import Overview from "./screens/Overview";
import Discovery from "./screens/Discovery";
import Contacts from "./screens/Contacts";
import Templates from "./screens/Templates";
import Send from "./screens/Send";
import History from "./screens/History";
import Settings from "./screens/Settings";

type Tab = "overview" | "discovery" | "contacts" | "templates" | "send" | "history" | "settings";
type IconName = Tab | "more" | "logout" | "install";

const NAV: { id: Tab; label: string; num: string }[] = [
  { id: "overview", label: "Overview", num: "01" },
  { id: "discovery", label: "Discovery", num: "02" },
  { id: "contacts", label: "Contacts", num: "03" },
  { id: "templates", label: "Templates", num: "04" },
  { id: "send", label: "Send", num: "05" },
  { id: "history", label: "History", num: "06" },
  { id: "settings", label: "Settings", num: "07" },
];

// Five slots is the most a thumb can hit reliably, so the tab bar carries the
// working sequence — find, collect, write, send — and the rest lives one tap
// deeper in a sheet.
const PRIMARY: Tab[] = ["overview", "discovery", "contacts", "send"];
const SECONDARY: Tab[] = ["templates", "history", "settings"];

/* -------------------------------- Icons ------------------------------ */

// Hoisted: this map is otherwise rebuilt for each of the ten icons rendered
// on every pass over the shell.
const ICON_PATHS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <path d="M3 20h18" />
      <path d="M6.5 20v-5" />
      <path d="M11.5 20V9" />
      <path d="M16.5 20v-8" />
      <path d="M21 20V5" />
    </>
  ),
  discovery: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.7-3.7" />
    </>
  ),
  contacts: (
    <>
      <path d="M15.5 20v-1.5a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20" />
      <circle cx="9.5" cy="7.5" r="3.5" />
      <path d="M21 20v-1.5a4 4 0 0 0-3-3.87" />
      <path d="M16 4.13a4 4 0 0 1 0 6.74" />
    </>
  ),
  send: (
    <>
      <path d="M21.5 2.5 10.5 13.5" />
      <path d="M21.5 2.5 15 21l-4.5-7.5L3 9Z" />
    </>
  ),
  templates: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18" />
      <path d="M7.5 14h9" />
      <path d="M7.5 17h5" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.2V12l3.4 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10" />
      <path d="m16 16 4-4-4-4" />
      <path d="M20 12H10" />
    </>
  ),
  install: (
    <>
      <path d="M12 3.5v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 20h15" />
    </>
  ),
};

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className || "h-[22px] w-[22px]"}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("prism-bar grid place-items-center rounded-xl", className || "h-9 w-9")}>
      <span className="font-clash text-sm font-bold text-ink">D</span>
    </div>
  );
}

/* --------------------------------- App -------------------------------- */

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking
  const [needsSetup, setNeedsSetup] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const { canInstall, iosHint, install } = useInstallPrompt();
  const hasUpdate = useSwUpdate();

  useEffect(() => {
    (async () => {
      try {
        const { configured } = await api.authStatus();
        if (!configured) {
          setNeedsSetup(true);
          setAuthed(false);
          return;
        }
        setAuthed(await api.checkAuth());
      } catch {
        // Offline or the API is down — fall through to the login screen rather
        // than leaving the boot spinner up for ever.
        setAuthed(false);
      }
    })();

    // The installed app's shortcuts land on /?tab=send and friends.
    const wanted = new URLSearchParams(window.location.search).get("tab");
    if (wanted && NAV.some((n) => n.id === wanted)) {
      setTab(wanted as Tab);
      window.history.replaceState({}, "", window.location.pathname);
    }

    const onUnauth = () => setAuthed(false);
    window.addEventListener("dna-unauthorized", onUnauth);
    // Screens deep-link to each other (Discovery → Settings) via this event.
    const onNavigate = (e: Event) => {
      const next = (e as CustomEvent).detail as Tab;
      if (NAV.some((n) => n.id === next)) {
        setTab(next);
        setMoreOpen(false);
      }
    };
    window.addEventListener("dna-navigate", onNavigate);
    return () => {
      window.removeEventListener("dna-unauthorized", onUnauth);
      window.removeEventListener("dna-navigate", onNavigate);
    };
  }, []);

  // Tells the stylesheet a tab bar is on screen, so the toaster can sit clear
  // of it without either component knowing about the other.
  useEffect(() => {
    if (authed) document.body.dataset.mobileNav = "true";
    else delete document.body.dataset.mobileNav;
    return () => { delete document.body.dataset.mobileNav; };
  }, [authed]);

  // A phone keeps its scroll position when the tab changes, which lands you
  // half-way down a screen you have never seen.
  useEffect(() => {
    document.getElementById("app-scroll")?.scrollTo({ top: 0 });
  }, [tab]);

  function logout() {
    clearToken();
    setAuthed(false);
    setMoreOpen(false);
    setTab("overview");
  }

  function pick(next: Tab) {
    setTab(next);
    setMoreOpen(false);
  }

  if (authed === null) {
    return (
      <div className="grid h-[100dvh] w-full place-items-center bg-ink">
        <Spinner className="h-6 w-6 text-cream/60" />
      </div>
    );
  }

  if (needsSetup && !authed) {
    return <Setup onSuccess={() => { setNeedsSetup(false); setAuthed(true); }} />;
  }

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  const current = NAV.find((n) => n.id === tab)!;
  const moreActive = SECONDARY.includes(tab);

  return (
    // 100dvh, not 100vh: a mobile URL bar collapsing mid-scroll would otherwise
    // leave the tab bar floating above the bottom of the screen.
    <div className="flex h-[100dvh] w-full overflow-hidden bg-cream">
      {/* ----------------------------- Sidebar (lg+) ---------------------- */}
      <aside className="hidden w-[248px] shrink-0 flex-col bg-ink text-cream lg:flex">
        <div className="flex items-center gap-3 px-6 py-6">
          <BrandMark />
          <div className="leading-tight">
            <div className="font-clash text-[15px] font-semibold tracking-tight">DNA</div>
            <div className="mono-label text-cream/50">Outreach</div>
          </div>
        </div>

        <nav className="mt-2 flex flex-1 flex-col gap-1 px-3">
          {NAV.map((n) => {
            const active = tab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className={cn(
                  "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                  active ? "bg-white/[0.08] text-cream" : "text-cream/55 hover:bg-white/[0.05] hover:text-cream/90"
                )}
              >
                {active && (
                  <span className="prism-bar absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full" />
                )}
                <span className="mono-label w-6 text-cream/30">{n.num}</span>
                <span className="font-medium">{n.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="space-y-1 px-3 pb-3">
          {canInstall && (
            <button
              onClick={install}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-cream/55 transition-colors hover:bg-white/[0.05] hover:text-cream/90"
            >
              <Icon name="install" className="ml-0.5 h-[18px] w-[18px] text-cream/40" />
              <span className="font-medium">Install app</span>
            </button>
          )}
          <button
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-cream/55 transition-colors hover:bg-white/[0.05] hover:text-cream/90"
          >
            <span className="mono-label w-6 text-cream/30">↩</span>
            <span className="font-medium">Log out</span>
          </button>
        </div>
        <div className="px-6 pb-5 text-[11px] leading-relaxed text-cream/35">
          Cold outreach — send from secondary domains, never your primary.
        </div>
      </aside>

      {/* ------------------------------ Column ---------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar (below lg). The ink strip also gives the translucent iOS
            status bar something deliberate to sit on. */}
        <header className="shrink-0 bg-ink pt-[var(--sat)] text-cream lg:hidden">
          <div className="flex h-12 items-center gap-2.5 px-4">
            <BrandMark className="h-7 w-7 rounded-lg" />
            <div className="font-clash text-[14px] font-semibold tracking-tight">DNA</div>
            <span className="mono-label text-cream/30">Outreach</span>
            <span className="ml-auto mono-label text-cream/35">{current.num}</span>
          </div>
        </header>

        {hasUpdate && <UpdateBanner />}

        <main id="app-scroll" className="touch-scroll flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
            {tab === "overview" && <Overview />}
            {tab === "discovery" && <Discovery />}
            {tab === "contacts" && <Contacts />}
            {tab === "templates" && <Templates />}
            {tab === "send" && <Send />}
            {tab === "history" && <History />}
            {tab === "settings" && <Settings />}
          </div>
        </main>

        {/* Tab bar (below lg). In normal flow rather than fixed, so it can never
            cover the last row of a list. */}
        <nav
          className="shrink-0 border-t border-white/10 bg-ink pb-[var(--sab)] text-cream lg:hidden"
          aria-label="Primary"
        >
          <div className="flex h-[58px] items-stretch">
            {PRIMARY.map((id) => {
              const n = NAV.find((x) => x.id === id)!;
              return <TabButton key={id} icon={id} label={n.label} active={tab === id} onClick={() => pick(id)} />;
            })}
            <TabButton
              icon="more"
              label="More"
              active={moreActive || moreOpen}
              onClick={() => setMoreOpen(true)}
            />
          </div>
        </nav>
      </div>

      {/* ------------------------------- Sheets --------------------------- */}
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} label="More">
        <div className="px-3 pb-2">
          <div className="mono-label px-3 pb-2 pt-2 text-cream/35">More</div>
          {SECONDARY.map((id) => {
            const n = NAV.find((x) => x.id === id)!;
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => pick(id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left text-[15px] transition-colors",
                  active ? "bg-white/[0.08] text-cream" : "text-cream/70 active:bg-white/[0.06]"
                )}
              >
                <Icon name={id} className="h-5 w-5 text-cream/45" />
                <span className="font-medium">{n.label}</span>
                <span className="mono-label ml-auto text-cream/25">{n.num}</span>
              </button>
            );
          })}

          <div className="my-2 h-px bg-white/10" />

          {canInstall && (
            <button
              onClick={() => { void install(); setMoreOpen(false); }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left text-[15px] text-cream/70 transition-colors active:bg-white/[0.06]"
            >
              <Icon name="install" className="h-5 w-5 text-cream/45" />
              <span className="font-medium">Install app</span>
            </button>
          )}

          <button
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left text-[15px] text-cream/70 transition-colors active:bg-white/[0.06]"
          >
            <Icon name="logout" className="h-5 w-5 text-cream/45" />
            <span className="font-medium">Log out</span>
          </button>

          {iosHint && !canInstall && (
            <p className="px-3 pb-1 pt-3 text-[12px] leading-relaxed text-cream/35">
              To install: tap Share, then <span className="text-cream/60">Add to Home Screen</span>.
            </p>
          )}
          <p className="px-3 pb-1 pt-3 text-[12px] leading-relaxed text-cream/30">
            Cold outreach — send from secondary domains, never your primary.
          </p>
        </div>
      </Sheet>

      <Toaster />
    </div>
  );
}

/* ------------------------------ Tab button ---------------------------- */

function TabButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex flex-1 flex-col items-center justify-center gap-1 transition-colors",
        active ? "text-cream" : "text-cream/45 active:text-cream/70"
      )}
    >
      {active && (
        <span className="prism-bar absolute top-0 h-[3px] w-8 rounded-b-full" />
      )}
      <Icon name={icon} className="h-[21px] w-[21px]" />
      <span className={cn("text-[10px] tracking-wide", active ? "font-semibold" : "font-medium")}>
        {label}
      </span>
    </button>
  );
}

/* ---------------------------- Update banner --------------------------- */

// registerType is "prompt", so a deploy never reloads the page under someone
// who is mid-campaign. It waits here until they say so.
function UpdateBanner() {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-paper px-4 py-2.5 text-[13px] lg:px-8">
      <span className="prism-bar h-1.5 w-1.5 shrink-0 rounded-full" />
      <span className="text-ink/75">A new version is ready.</span>
      <button
        onClick={reloadWithUpdate}
        className="ml-auto shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-semibold text-cream transition-colors hover:bg-ink-soft"
      >
        Reload
      </button>
    </div>
  );
}
