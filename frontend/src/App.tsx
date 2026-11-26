import { useEffect, useState } from "react";
import { HeadSlot, Logo, Mark, Spinner, ThemeButton, Toaster } from "./lib/ui";
import { api, clearToken } from "./lib/api";
import Login from "./screens/Login";
import Setup from "./screens/Setup";
import Dashboard from "./screens/Dashboard";
import Inbox from "./screens/Inbox";
import Leads from "./screens/Leads";
import Campaigns from "./screens/Campaigns";
import Targeting from "./screens/Targeting";
import Sequences from "./screens/Sequences";
import Mailboxes from "./screens/Mailboxes";
import Agent from "./screens/Agent";
import AccountDialog from "./screens/Account";
import { AlertsButton } from "./screens/Alerts";
import { req } from "./lib/api";
import { registerWorker, resyncPush, setIconBadge } from "./lib/v2/push";

type Tab = "dashboard" | "inbox" | "leads" | "campaigns" | "targeting" | "sequences" | "mailboxes" | "agent";

// Groups: work (dashboard, inbox, leads) | set up (campaigns, targeting, sequences) | infrastructure (mailboxes, agent).
const TABS: { id: Tab; label: string; sepBefore?: boolean }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "inbox", label: "Inbox" },
  { id: "leads", label: "Leads" },
  { id: "campaigns", label: "Campaigns", sepBefore: true },
  { id: "targeting", label: "Targeting" },
  { id: "sequences", label: "Sequences" },
  { id: "mailboxes", label: "Mailboxes", sepBefore: true },
  { id: "agent", label: "Agent" },
];

// Other screens can jump tabs: window.dispatchEvent(new CustomEvent("dna-tab", { detail: "agent" }))
const TAB_EVENT = "dna-tab";

// Per browser TAB session: a reload stays where you were, a new visit opens
// on the Dashboard (plan §8.1).
const TAB_KEY = "dnaOutreachTab";

function initials(name: string) {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

/**
 * An alert opens the app at /?thread=<id> (that conversation) or /?tab=inbox.
 * Read it once on load: the thread is handed to the Inbox like "Open in Inbox".
 */
function deepLinkTab(): Tab | null {
  try {
    const p = new URLSearchParams(window.location.search);
    const thread = p.get("thread");
    const tab = p.get("tab") as Tab | null;
    if (thread) localStorage.setItem("dnaInboxOpen", thread);
    if (thread || tab) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    if (thread) return "inbox";
    if (tab && TABS.some((x) => x.id === tab)) return tab;
  } catch {
    /* private mode */
  }
  return null;
}

function initialTab(): Tab {
  const linked = deepLinkTab();
  if (linked) {
    try {
      sessionStorage.setItem(TAB_KEY, linked);
    } catch {
      /* private mode */
    }
    return linked;
  }
  try {
    const t = sessionStorage.getItem(TAB_KEY) as Tab | null;
    if (t && TABS.some((x) => x.id === t)) return t;
  } catch {
    /* private mode */
  }
  return "dashboard";
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
      sessionStorage.setItem(TAB_KEY, t);
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
    // This device's alert sign-up, kept in step with the server.
    resyncPush().catch(() => {});
  }, [authed]);

  // The alerts worker: registered on every visit (it caches nothing). A tapped
  // alert while the app is open arrives as a message: open that conversation.
  useEffect(() => {
    registerWorker();
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data || {};
      if (d.type !== "dna-open") return;
      if (d.threadId) {
        try {
          localStorage.setItem("dnaInboxOpen", String(d.threadId));
        } catch {
          /* private mode */
        }
        window.dispatchEvent(new CustomEvent("dna-open-thread", { detail: String(d.threadId) }));
      }
      setTab("inbox");
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    navigator.serviceWorker.startMessages?.();
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // Any screen can switch tabs (e.g. "Connect Instantly" -> Agent tab).
  useEffect(() => {
    const h = (e: Event) => {
      const t = (e as CustomEvent).detail as Tab;
      if (TABS.some((x) => x.id === t)) setTab(t);
    };
    window.addEventListener(TAB_EVENT, h);
    return () => window.removeEventListener(TAB_EVENT, h);
  }, []);

  // Badges: Inbox = unread + needs a human; Leads = emails waiting for review. Polled like the leads console.
  const [inboxCount, setInboxCount] = useState<{ unread: number; needsHuman: number }>({ unread: 0, needsHuman: 0 });
  const [reviewCount, setReviewCount] = useState(0);
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    const poll = () => {
      if (document.hidden) return;
      req<{ unread: number; needsHuman: number }>("/api/v2/inbox/counts")
        .then((r) => {
          if (!alive) return;
          const c = { unread: Number(r.unread) || 0, needsHuman: Number(r.needsHuman) || 0 };
          setInboxCount(c);
          setIconBadge(c.unread + c.needsHuman); // the installed app's icon
        })
        .catch(() => {});
      req<{ review: number }>("/api/v2/leads/counts")
        .then((r) => alive && setReviewCount(Number(r.review) || 0))
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
            <AlertsButton />
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
            const badge = t.id === "inbox" ? inboxCount.unread + inboxCount.needsHuman : t.id === "leads" ? reviewCount : 0;
            return (
              <span key={t.id} className="contents">
                {t.sepBefore && <span className="tabsep" aria-hidden />}
                <button
                  type="button"
                  className={tab === t.id ? "tab on" : "tab"}
                  onClick={() => setTab(t.id)}
                  aria-current={tab === t.id ? "page" : undefined}
                  title={t.id === "leads" && badge ? `${badge} email${badge === 1 ? "" : "s"} waiting for review` : undefined}
                >
                  {t.label}
                  {badge > 0 && <span className="badge">{badge > 99 ? "99+" : badge}</span>}
                </button>
              </span>
            );
          })}
        </nav>

        <HeadSlot.Provider value={headEl}>
          <main>
            {tab === "dashboard" && <Dashboard />}
            {tab === "inbox" && <Inbox />}
            {tab === "leads" && <Leads />}
            {tab === "campaigns" && <Campaigns />}
            {tab === "targeting" && <Targeting />}
            {tab === "sequences" && <Sequences />}
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
