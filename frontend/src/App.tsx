import { useEffect, useState } from "react";
import { HeadSlot, Logo, Mark, Spinner, ThemeButton, Toaster } from "./lib/ui";
import { api, clearToken } from "./lib/api";
import Login from "./screens/Login";
import Setup from "./screens/Setup";
import Inbox from "./screens/Inbox";
import Campaigns from "./screens/Campaigns";
import Mailboxes from "./screens/Mailboxes";
import Agent from "./screens/Agent";
import AccountDialog from "./screens/Account";
import { req } from "./lib/api";

type Tab = "inbox" | "campaigns" | "mailboxes" | "agent";

const TABS: { id: Tab; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "campaigns", label: "Campaigns" },
  { id: "mailboxes", label: "Mailboxes" },
  { id: "agent", label: "Agent" },
];

// Other screens can jump tabs: window.dispatchEvent(new CustomEvent("dna-tab", { detail: "agent" }))
const TAB_EVENT = "dna-tab";

const TAB_KEY = "dnaOutreachTab";

function initials(name: string) {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

function initialTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY) as Tab | null;
    if (t && TABS.some((x) => x.id === t)) return t;
  } catch {
    /* private mode */
  }
  return "inbox";
}

export default function App() {
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking
  const [needsSetup, setNeedsSetup] = useState(false);
  const [username, setUsername] = useState("");
  const [headEl, setHeadEl] = useState<HTMLDivElement | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  function setTab(t: Tab) {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* private mode */
    }
    window.scrollTo({ top: 0 });
  }

  useEffect(() => {
    (async () => {
      const { configured } = await api.authStatus();
      if (!configured) {
        setNeedsSetup(true);
        setAuthed(false);
        return;
      }
      setAuthed(await api.checkAuth());
    })();
    const onUnauth = () => setAuthed(false);
    window.addEventListener("dna-unauthorized", onUnauth);
    return () => window.removeEventListener("dna-unauthorized", onUnauth);
  }, []);

  useEffect(() => {
    if (!authed) return;
    api
      .me()
      .then((r) => setUsername(r.username || ""))
      .catch(() => {});
  }, [authed]);

  // Any screen can switch tabs (e.g. "Connect Instantly" -> Agent tab).
  useEffect(() => {
    const h = (e: Event) => {
      const t = (e as CustomEvent).detail as Tab;
      if (TABS.some((x) => x.id === t)) setTab(t);
    };
    window.addEventListener(TAB_EVENT, h);
    return () => window.removeEventListener(TAB_EVENT, h);
  }, []);

  // Inbox badge: unread + needs-a-human counts, polled like the leads console.
  const [inboxCount, setInboxCount] = useState<{ unread: number; needsHuman: number }>({ unread: 0, needsHuman: 0 });
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    const poll = () => {
      if (document.hidden) return;
      req<{ unread: number; needsHuman: number }>("/api/v2/inbox/counts")
        .then((r) => alive && setInboxCount({ unread: Number(r.unread) || 0, needsHuman: Number(r.needsHuman) || 0 }))
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, 20000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [authed]);

  function logout() {
    clearToken();
    setAuthed(false);
  }

  if (authed === null) {
    return (
      <div className="grid h-screen w-screen place-items-center">
        <Spinner className="h-6 w-6 text-muted" />
      </div>
    );
  }

  if (needsSetup && !authed) {
    return (
      <Setup
        onSuccess={() => {
          setNeedsSetup(false);
          setAuthed(true);
        }}
      />
    );
  }

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  const who = username || "admin";

  return (
    <div className="min-h-screen pb-16">
      {/* ---- brand bar ---- */}
      <div className="bar">
        <div className="w">
          <div className="brand">
            <Logo />
            <div className="bd" />
            <Mark />
            <div className="bn">
              <i>Sales &amp; outreach</i>
              Outreach console
            </div>
          </div>
          <div className="who">
            <ThemeButton />
            <div className="av">{initials(who)}</div>
            <div className="meta-lines">
              <b>{who}</b>
              Administrator &middot;{" "}
              <button type="button" className="lk" onClick={() => setAccountOpen(true)}>
                account
              </button>{" "}
              &middot;{" "}
              <button type="button" className="lk" onClick={logout}>
                sign out
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="w">
        {/* Title row — each screen portals its own title/subtitle/actions here */}
        <div className="head" ref={setHeadEl} />

        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => {
            const badge = t.id === "inbox" ? inboxCount.unread + inboxCount.needsHuman : 0;
            return (
              <button
                key={t.id}
                type="button"
                className={tab === t.id ? "tab on" : "tab"}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
              >
                {t.label}
                {badge > 0 && <span className="badge">{badge > 99 ? "99+" : badge}</span>}
              </button>
            );
          })}
        </nav>

        <HeadSlot.Provider value={headEl}>
          <main>
            {tab === "inbox" && <Inbox />}
            {tab === "campaigns" && <Campaigns />}
            {tab === "mailboxes" && <Mailboxes />}
            {tab === "agent" && <Agent />}
          </main>
        </HeadSlot.Provider>
      </div>

      <AccountDialog open={accountOpen} username={who} onClose={() => setAccountOpen(false)} onRenamed={setUsername} />
      <Toaster />
    </div>
  );
}
