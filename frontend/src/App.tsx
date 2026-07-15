import { useEffect, useState } from "react";
import { cn, Toaster, Spinner } from "./lib/ui";
import { api, clearToken } from "./lib/api";
import Login from "./screens/Login";
import Overview from "./screens/Overview";
import Contacts from "./screens/Contacts";
import Templates from "./screens/Templates";
import Send from "./screens/Send";
import History from "./screens/History";
import Settings from "./screens/Settings";

type Tab = "overview" | "contacts" | "templates" | "send" | "history" | "settings";

const NAV: { id: Tab; label: string; num: string }[] = [
  { id: "overview", label: "Overview", num: "01" },
  { id: "contacts", label: "Contacts", num: "02" },
  { id: "templates", label: "Templates", num: "03" },
  { id: "send", label: "Send", num: "04" },
  { id: "history", label: "History", num: "05" },
  { id: "settings", label: "Settings", num: "06" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking

  useEffect(() => {
    api.checkAuth().then(setAuthed);
    const onUnauth = () => setAuthed(false);
    window.addEventListener("dna-unauthorized", onUnauth);
    return () => window.removeEventListener("dna-unauthorized", onUnauth);
  }, []);

  function logout() {
    clearToken();
    setAuthed(false);
    setTab("overview");
  }

  if (authed === null) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-ink">
        <Spinner className="h-6 w-6 text-cream/60" />
      </div>
    );
  }

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-cream">
      {/* Sidebar */}
      <aside className="flex w-[248px] shrink-0 flex-col bg-ink text-cream">
        <div className="flex items-center gap-3 px-6 py-6">
          <div className="prism-bar grid h-9 w-9 place-items-center rounded-xl">
            <span className="font-clash text-sm font-bold text-ink">D</span>
          </div>
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

        <div className="px-3 pb-3">
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

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">
          {tab === "overview" && <Overview />}
          {tab === "contacts" && <Contacts />}
          {tab === "templates" && <Templates />}
          {tab === "send" && <Send />}
          {tab === "history" && <History />}
          {tab === "settings" && <Settings />}
        </div>
      </main>

      <Toaster />
    </div>
  );
}
