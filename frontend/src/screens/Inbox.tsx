// Inbox (v2 workstream B): every reply from every campaign, threaded, with the
// agent's read on each one and what it did about it. Layout from the DNA leads
// console: list | conversation + composer | lead panel.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { req } from "../lib/api";
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, cn, toast } from "../lib/ui";
import { ago } from "../lib/v2/core";
import {
  CATEGORY,
  CATEGORY_ORDER,
  STATUS,
  clock,
  dueIn,
  inboxApi,
  initials,
  type InboxFilter,
  type InboxList,
  type InboxMessage,
  type PlaygroundResult,
  type ThreadDetail,
  type ThreadRow,
} from "../lib/v2/inbox";

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "needs_human", label: "Needs you" },
  { id: "scheduled", label: "Sending" },
  { id: "unread", label: "Unread" },
  { id: "closed", label: "Closed" },
];

const goTab = (t: string) => window.dispatchEvent(new CustomEvent("dna-tab", { detail: t }));
const EXAMPLE_NOTE = "Example data: connect Instantly to act on real replies.";

function matches(t: ThreadRow, f: InboxFilter, q: string) {
  const okF =
    f === "all" ||
    (f === "active" && t.status !== "closed") ||
    (f === "needs_human" && t.status === "needs_human") ||
    (f === "scheduled" && t.pending?.kind === "scheduled") ||
    (f === "unread" && t.unread) ||
    (f === "closed" && t.status === "closed");
  const s = q.trim().toLowerCase();
  const okQ = !s || [t.leadName, t.leadEmail, t.company, t.subject].some((v) => String(v || "").toLowerCase().includes(s));
  return okF && okQ;
}

export default function Inbox() {
  const [mode, setMode] = useState<"live" | "example">("live");
  const [list, setList] = useState<InboxList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("active");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  // Another tab can ask for a thread ("Open in Inbox" on a lead): a one-shot key.
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      const t = localStorage.getItem("dnaInboxOpen");
      if (t) localStorage.removeItem("dnaInboxOpen");
      return t;
    } catch {
      return null;
    }
  });
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [, setTick] = useState(0);
  const ibRef = useRef<HTMLDivElement>(null);
  const example = mode === "example";

  // Size the inbox to the space left below the banners (desktop only; phones scroll the page).
  useEffect(() => {
    const el = ibRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty("--ib-top", `${Math.round(top)}px`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [!!list, example, !!list?.connected]);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 280);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setList(mode === "example" ? await inboxApi.example() : await inboxApi.list({ filter, q: query || undefined }));
        setLoadError("");
      } catch (e: any) {
        setLoadError(e.message || "Couldn't load the inbox.");
      } finally {
        setLoading(false);
      }
    },
    [mode, filter, query]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live: pick up new replies and the agent's work without a reload.
  useEffect(() => {
    if (example || !list?.connected) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      load(true);
      if (selected) inboxApi.thread(selected).then(setDetail).catch(() => {});
    }, 20_000);
    return () => clearInterval(t);
  }, [example, list?.connected, load, selected]);

  // Re-render countdowns ("sends in 12m").
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Open a thread.
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    if (example) {
      setDetail(list?.details?.[selected] || null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    inboxApi
      .thread(selected)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        if (d.thread.unread) {
          inboxApi.read(d.thread.id).catch(() => {});
          setList((l) => (l ? { ...l, threads: l.threads.map((t) => (t.id === d.thread.id ? { ...t, unread: false } : t)) } : l));
        }
      })
      .catch((e) => toast(e.message, "error"))
      .finally(() => alive && setDetailLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, example]);

  // The example opens on its first thread on wide screens, so there's something to look at.
  useEffect(() => {
    if (example && list?.threads.length && !selected && window.innerWidth > 860) setSelected(list.threads[0].id);
  }, [example, list, selected]);

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await inboxApi.sync();
      if (!r.result.ok) toast(`Synced with a problem: ${r.result.errors[0]}`, "error");
      else toast(r.result.stored ? `Pulled ${r.result.stored} new message${r.result.stored === 1 ? "" : "s"} from Instantly.` : "Up to date. No new replies.", "success");
      await load(true);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSyncing(false);
    }
  }

  const threads = useMemo(() => (list ? (example ? list.threads.filter((t) => matches(t, filter, query)) : list.threads) : []), [list, example, filter, query]);
  const connected = !!list?.connected;

  const header = (
    <PageHeader
      title="Inbox"
      subtitle="Every reply from every campaign, threaded, with the agent's read on each one and what it did about it."
      actions={
        list && (
          <>
            {example ? <Badge className="bg-wnb text-warn">Example data</Badge> : connected ? <SyncPill list={list} syncing={syncing} /> : null}
            <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
              Test a reply
            </Button>
            {!example && connected && (
              <Button size="sm" onClick={syncNow} loading={syncing}>
                Sync now
              </Button>
            )}
          </>
        )
      }
    />
  );

  if (loading && !list) {
    return (
      <div>
        {header}
        <div className="flex items-center gap-2 py-20 text-muted">
          <Spinner /> Loading the inbox…
        </div>
      </div>
    );
  }
  if (loadError && !list) {
    return (
      <div>
        {header}
        <Card className="px-6 py-10 text-center">
          <p className="text-sm text-bad">{loadError}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => load()}>
            Try again
          </Button>
        </Card>
      </div>
    );
  }
  if (!list) return null;

  return (
    <div>
      {header}

      {!example && !connected ? (
        <Setup aiConfigured={!!list.ai?.configured} onPreview={() => setMode("example")} onTest={() => setTestOpen(true)} />
      ) : (
        <>
          {example && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-keepl bg-keep1 px-4 py-3">
              <p className="max-w-[820px] text-[13px] leading-relaxed text-ink-soft">
                <span className="font-semibold text-accent">Example data.</span> These people are made up, but what happens to each reply comes
                from your Agent rules right now. Change them on the Agent tab and this preview follows.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => goTab("agent")}>
                  Open Agent rules
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelected(null);
                    setMode("live");
                  }}
                >
                  Back to setup
                </Button>
              </div>
            </div>
          )}
          {!example && list.lastSync && !list.lastSync.ok && (
            <div className="mb-4 rounded-xl border border-wnl bg-wnb px-4 py-3 text-[13px] leading-relaxed text-warn">
              <span className="font-semibold">Last sync {ago(list.lastSync.at)} had a problem:</span> {list.lastSync.errors[0]}
            </div>
          )}
          {!example && !list.ai?.configured && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-wnl bg-wnb px-4 py-3 text-[13px] leading-relaxed text-warn">
              <span>
                <span className="font-semibold">No AI key yet.</span> Bounces, auto-replies and unsubscribes are still handled; every other reply waits
                for you.
              </span>
              <Button variant="outline" size="sm" onClick={() => goTab("agent")}>
                Add a key
              </Button>
            </div>
          )}

          <div className={cn("ib", selected && "open")} ref={ibRef}>
            <ThreadList
              threads={threads}
              counts={list.counts}
              filter={filter}
              onFilter={(f) => {
                setFilter(f);
                if (!example) setSelected(null);
              }}
              search={search}
              onSearch={setSearch}
              selected={selected}
              onSelect={setSelected}
              loading={loading}
              connected={connected || example}
            />
            <div className="ib-r">
              {detail && detail.thread.id === selected ? (
                <ThreadView
                  key={detail.thread.id}
                  detail={detail}
                  example={example}
                  aiConfigured={example || !!list.ai?.configured}
                  onBack={() => setSelected(null)}
                  onDetail={(d) => {
                    setDetail(d);
                    load(true);
                  }}
                />
              ) : selected && detailLoading ? (
                <div className="ib-empty">
                  <Spinner className="mx-auto h-5 w-5" />
                </div>
              ) : (
                <NothingOpen counts={list.counts} />
              )}
            </div>
          </div>
        </>
      )}

      <PlaygroundModal open={testOpen} onClose={() => setTestOpen(false)} />
    </div>
  );
}

/* --------------------------------- header --------------------------------- */

function SyncPill({ list, syncing }: { list: InboxList; syncing: boolean }) {
  if (syncing || list.syncing) {
    return (
      <span className="livep open">
        <i />
        Syncing…
      </span>
    );
  }
  if (!list.lastSync) {
    return (
      <span className="livep">
        <i />
        Not synced yet
      </span>
    );
  }
  return (
    <span className={cn("livep", list.lastSync.ok && "open")} title={list.lastSync.errors[0] || "Checks Instantly every 3 minutes"}>
      <i />
      Synced {ago(list.lastSync.at)}
    </span>
  );
}

/* ---------------------------------- setup ---------------------------------- */

const ACTION_GROUP: Record<string, { title: string; hint: string; dot: string }> = {
  send: { title: "Answers on its own", hint: "Written, checked, sent from the same mailbox after a short delay.", dot: "bg-brand" },
  draft: { title: "Drafts for you", hint: "Written and waiting for you to press send.", dot: "bg-inf" },
  handoff: { title: "Hands to you", hint: "Flagged in Needs you, usually with a draft to start from.", dot: "bg-warn" },
  silent: { title: "Housekeeping only", hint: "No email goes out. Stops, blocks or pauses the lead.", dot: "bg-muted" },
};

function Setup({ aiConfigured, onPreview, onTest }: { aiConfigured: boolean; onPreview: () => void; onTest: () => void }) {
  const [rules, setRules] = useState<{ id: string; outcome: { action: string; reason: string } }[] | null>(null);
  useEffect(() => {
    req<{ categories: { id: string; outcome: { action: string; reason: string } }[] }>("/api/v2/agent/rules/preview", { method: "POST", body: "{}" })
      .then((r) => setRules(r.categories))
      .catch(() => setRules([]));
  }, []);

  const steps: { title: string; body: ReactNode; done: boolean; action?: ReactNode }[] = [
    {
      title: "Connect Instantly",
      body: "Replies to your campaigns arrive in Instantly's Unibox. The inbox checks it every 3 minutes and answers from the mailbox the lead wrote to.",
      done: false,
      action: (
        <Button size="sm" onClick={() => goTab("agent")}>
          Connect Instantly
        </Button>
      ),
    },
    {
      title: "Add a free AI key",
      body: aiConfigured
        ? "Connected. The agent reads every reply and writes answers in your voice."
        : "Optional, but without it every reply except bounces, auto-replies and unsubscribes waits for you.",
      done: aiConfigured,
      action: !aiConfigured && (
        <Button variant="outline" size="sm" onClick={() => goTab("agent")}>
          Add a key
        </Button>
      ),
    },
    {
      title: "Check the rules",
      body: "Decide which replies the agent may answer alone, how sure it must be, and how fast it replies. The board on the right is live.",
      done: false,
      action: (
        <Button variant="outline" size="sm" onClick={() => goTab("agent")}>
          Open Agent rules
        </Button>
      ),
    },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
      <Card className="p-6 sm:p-7">
        <div className="mono-label text-accent">Not connected yet</div>
        <h2 className="mt-2 text-[1.15rem] font-[650] tracking-[-0.01em]">Replies land here once Instantly is connected</h2>
        <p className="mt-2 max-w-[620px] text-[13.5px] leading-relaxed text-ink-soft">
          The agent reads each reply, decides what it is, and then answers, drafts, hands it to you or just tidies up, following your rules. Nothing is
          sent until a mailbox and a campaign exist.
        </p>
        <ol className="mt-6 space-y-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3 rounded-xl border border-line-soft bg-surf2 p-4">
              <span
                className={cn(
                  "grid h-7 w-7 flex-none place-items-center rounded-full text-[12px] font-bold tabular-nums",
                  s.done ? "bg-okb text-good" : "bg-ink/[0.06] text-ink-soft"
                )}
              >
                {s.done ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 6.2l2.3 2.3 4.7-5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold">{s.title}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{s.body}</p>
              </div>
              {s.action && <div className="flex-none self-center">{s.action}</div>}
            </li>
          ))}
        </ol>
        <div className="mt-6 flex flex-wrap gap-2 border-t border-line-soft pt-5">
          <Button variant="outline" onClick={onPreview}>
            Preview with example replies
          </Button>
          <Button variant="ghost" onClick={onTest}>
            Test a reply against your rules
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">What the agent does today</div>
          <button type="button" className="text-[12px] font-semibold text-accent hover:underline" onClick={() => goTab("agent")}>
            Change
          </button>
        </div>
        {!rules ? (
          <div className="flex items-center gap-2 py-10 text-[13px] text-muted">
            <Spinner /> Reading your rules…
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {(["send", "draft", "handoff", "silent"] as const).map((a) => {
              const ids = rules.filter((r) => r.outcome.action === a).map((r) => r.id);
              if (!ids.length) return null;
              const g = ACTION_GROUP[a];
              return (
                <div key={a}>
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    <span className={cn("h-2 w-2 rounded-full", g.dot)} />
                    {g.title}
                    <span className="ml-auto text-[11.5px] font-medium tabular-nums text-muted">{ids.length}</span>
                  </div>
                  <p className="mt-0.5 pl-4 text-[12px] leading-relaxed text-muted">{g.hint}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
                    {ids.map((id) => (
                      <Badge key={id} className={CATEGORY[id]?.chip || "bg-ink/[0.06] text-ink-soft"}>
                        {CATEGORY[id]?.label || id}
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- list ---------------------------------- */

function ThreadList({
  threads,
  counts,
  filter,
  onFilter,
  search,
  onSearch,
  selected,
  onSelect,
  loading,
  connected,
}: {
  threads: ThreadRow[];
  counts: Record<InboxFilter, number>;
  filter: InboxFilter;
  onFilter: (f: InboxFilter) => void;
  search: string;
  onSearch: (s: string) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  connected: boolean;
}) {
  return (
    <div className="ib-l">
      <div className="ib-tools">
        <div className="ib-srch">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search name, company, email" className="py-2 text-[13px]" aria-label="Search threads" />
        </div>
        <div className="ib-fl" role="tablist" aria-label="Filter threads">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={cn(filter === f.id && "on", f.id === "needs_human" && counts.needs_human > 0 && "hot")}
              onClick={() => onFilter(f.id)}
            >
              {f.label}
              <b>{counts[f.id] ?? 0}</b>
            </button>
          ))}
        </div>
      </div>
      <div className="ib-list">
        {loading && !threads.length ? (
          <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted">
            <Spinner /> Loading…
          </div>
        ) : threads.length === 0 ? (
          <div className="px-6 py-12 text-center text-[13px] leading-relaxed text-muted">
            {search
              ? "Nothing matches that search."
              : filter === "needs_human"
                ? "Nothing needs you right now."
                : filter === "scheduled"
                  ? "No replies waiting to go out."
                  : filter === "unread"
                    ? "All caught up."
                    : filter === "closed"
                      ? "No closed threads yet."
                      : connected
                        ? "No replies yet. They appear here within 3 minutes of landing in Instantly."
                        : "No replies yet."}
          </div>
        ) : (
          threads.map((t) => <ThreadItem key={t.id} t={t} on={t.id === selected} onClick={() => onSelect(t.id)} />)
        )}
      </div>
    </div>
  );
}

function NextHint({ t }: { t: ThreadRow }) {
  const p = t.pending;
  if (p?.kind === "scheduled") return <span className="nx a">Sends {dueIn(p.dueAt)}</span>;
  if (p?.kind === "failed") return <span className="nx w">Send failed</span>;
  if (p?.kind === "drafted") return <span className="nx w">Draft ready</span>;
  if (p?.kind === "needs_human") return <span className="nx w">Needs you</span>;
  if (p?.kind === "pending") return <span className="nx">Reading…</span>;
  if (t.status === "closed") return <span className="nx">Closed</span>;
  return null;
}

function ThreadItem({ t, on, onClick }: { t: ThreadRow; on: boolean; onClick: () => void }) {
  const cat = t.classification ? CATEGORY[t.classification] : null;
  return (
    <button type="button" className={cn("ib-li", on && "on", t.unread && "unread")} onClick={onClick} aria-current={on ? "true" : undefined}>
      <span className="ib-av" aria-hidden="true">
        {initials(t.leadName || t.leadEmail)}
        {t.unread && <i />}
      </span>
      <span className="bd">
        <span className="t">
          <span className="nm">{t.leadName || t.leadEmail}</span>
          <span className="tm">{ago(t.lastMessageAt)}</span>
        </span>
        <span className="sb block">{[t.company, t.subject].filter(Boolean).join(" · ") || t.leadEmail}</span>
        <span className="pv">
          {t.lastDirection === "out" && <span className="font-semibold text-ink-soft">Replied: </span>}
          {t.lastPreview}
        </span>
        <span className="tg">
          {cat && <Badge className={cat.chip}>{cat.label}</Badge>}
          {t.aiPaused && <Badge className="bg-ink/[0.06] text-muted">Agent paused</Badge>}
          <NextHint t={t} />
        </span>
      </span>
    </button>
  );
}

function NothingOpen({ counts }: { counts: Record<InboxFilter, number> }) {
  return (
    <div className="ib-empty">
      <b>Pick a conversation</b>
      {counts.needs_human > 0
        ? `${counts.needs_human} thread${counts.needs_human === 1 ? " needs" : "s need"} you. The agent is handling the rest.`
        : counts.scheduled > 0
          ? `Nothing needs you. The agent has ${counts.scheduled} repl${counts.scheduled === 1 ? "y" : "ies"} on the way out.`
          : "Nothing needs you right now."}
    </div>
  );
}

/* --------------------------------- thread --------------------------------- */

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function ThreadView({
  detail,
  example,
  aiConfigured,
  onBack,
  onDetail,
}: {
  detail: ThreadDetail;
  example: boolean;
  aiConfigured: boolean;
  onBack: () => void;
  onDetail: (d: ThreadDetail) => void;
}) {
  const t = detail.thread;
  const [busy, setBusy] = useState<string | null>(null);
  const [side, setSide] = useState(false);
  const [text, setText] = useState("");
  const tlRef = useRef<HTMLDivElement>(null);
  const status = STATUS[t.status] || STATUS.handled;
  const cat = t.classification ? CATEGORY[t.classification] : null;
  const name = detail.lead.name || t.leadName || t.leadEmail;
  const lastIn = [...detail.messages].reverse().find((m) => m.direction === "in");

  useEffect(() => {
    const el = tlRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail.messages.length]);

  async function act(key: string, fn: () => Promise<{ detail: ThreadDetail | null }>, ok?: string) {
    if (example) return toast(EXAMPLE_NOTE, "info");
    setBusy(key);
    try {
      const r = await fn();
      if (r.detail) onDetail(r.detail);
      if (ok) toast(ok, "success");
      return true;
    } catch (e: any) {
      toast(e.message, "error");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function sendOwn() {
    const body = text.trim();
    if (!body) return;
    if (await act("reply", () => inboxApi.reply(t.id, body), "Reply sent.")) setText("");
  }

  // Day separators between messages.
  const items: ReactNode[] = [];
  let lastDay = "";
  for (const m of detail.messages) {
    const day = dayLabel(m.sentAt);
    if (day !== lastDay) {
      items.push(
        <div key={`d-${m.id}`} className="ib-day">
          {day}
        </div>
      );
      lastDay = day;
    }
    items.push(<MailCard key={m.id} m={m} leadName={name} />);
    if (m.direction === "in" && (m.classification || m.aiStatus === "pending")) {
      items.push(
        <AgentCard
          key={`a-${m.id}`}
          m={m}
          eaccount={t.eaccount}
          latest={m.id === lastIn?.id}
          aiConfigured={aiConfigured}
          busy={busy}
          act={act}
        />
      );
    }
  }

  return (
    <>
      <div className="ib-dh">
        <div className="ib-dhl">
          <button type="button" className="ib-ico ib-back" onClick={onBack} aria-label="Back to the list">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span className="ib-av lg" aria-hidden="true">
            {initials(name)}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-[1.02rem] font-[650] tracking-[-0.01em]">{name}</b>
              <Badge className={status.chip}>{status.label}</Badge>
              {cat && <Badge className={cat.chip}>{cat.label}</Badge>}
            </div>
            <div className="mt-0.5 break-words text-[12.5px] text-muted">
              {[detail.lead.title, detail.lead.company].filter(Boolean).join(" at ")}
              {(detail.lead.title || detail.lead.company) && " · "}
              {t.leadEmail}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted">
              <span>
                via <span className="text-ink-soft">{t.eaccount || "unknown mailbox"}</span>
              </span>
              {detail.campaign && <span>· {detail.campaign.name}</span>}
              {t.autoReplies > 0 && (
                <span>
                  · {t.autoReplies} auto-repl{t.autoReplies === 1 ? "y" : "ies"}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="ib-dact">
          <Button
            variant="outline"
            size="sm"
            loading={busy === "ai"}
            onClick={() => act("ai", () => inboxApi.setAi(t.id, !t.aiPaused), t.aiPaused ? "Agent back on for this thread." : "Agent paused for this thread.")}
            title={t.aiPaused ? "Let the agent answer this thread again" : "Stop the agent answering this thread; its pending reply becomes a draft"}
          >
            <span className={cn("h-2 w-2 rounded-full", t.aiPaused ? "bg-muted" : "bg-brand")} />
            {t.aiPaused ? "Agent paused" : "Agent on"}
          </Button>
          {t.status === "needs_human" && (
            <Button variant="outline" size="sm" loading={busy === "handled"} onClick={() => act("handled", () => inboxApi.setStatus(t.id, "handled"), "Marked handled.")}>
              Mark handled
            </Button>
          )}
          {t.status === "closed" ? (
            <Button variant="outline" size="sm" loading={busy === "open"} onClick={() => act("open", () => inboxApi.setStatus(t.id, "open"), "Thread reopened.")}>
              Reopen
            </Button>
          ) : (
            <button
              type="button"
              className="ib-ico"
              title="Close thread"
              aria-label="Close thread"
              disabled={busy === "close"}
              onClick={() => act("close", () => inboxApi.setStatus(t.id, "closed"), "Thread closed.")}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="ib-ico"
            title="Mark as unread"
            aria-label="Mark as unread"
            onClick={() => act("unread", () => inboxApi.read(t.id, false), "Marked unread.")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M3 7l9 6 9-6" />
            </svg>
          </button>
          <button
            type="button"
            className={cn("ib-ico ib-only-narrow", side && "bg-hov text-ink")}
            title="Lead details"
            aria-label="Lead details"
            aria-pressed={side}
            onClick={() => setSide((s) => !s)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
            </svg>
          </button>
        </div>
      </div>

      <div className={cn("ib-body", side && "side-on")}>
        <div className="ib-tlw">
          <div className="ib-tl" ref={tlRef}>
            {items}
          </div>
          <div className="ib-cmp">
            <div className="ib-crow">
              <Textarea
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    sendOwn();
                  }
                }}
                placeholder={`Reply to ${name.split(/\s+/)[0]} yourself…`}
                aria-label="Your reply"
              />
              <Button onClick={sendOwn} loading={busy === "reply"} disabled={!text.trim()} className="h-[46px]">
                Send
              </Button>
            </div>
            <div className="mt-1.5 text-[11.5px] text-muted">
              Goes from <span className="text-ink-soft">{t.eaccount || "the thread's mailbox"}</span>, in this thread. Ctrl/Cmd + Enter sends. Replying
              yourself cancels any reply the agent has queued.
            </div>
          </div>
        </div>
        <LeadPanel detail={detail} />
      </div>
    </>
  );
}

function MailCard({ m, leadName }: { m: InboxMessage; leadName: string }) {
  const [quoted, setQuoted] = useState(false);
  const ai = m.direction === "out" && (m.sentBy === "agent" || m.sentBy === "approved");
  const who =
    m.direction === "in"
      ? leadName
      : m.sentBy === "campaign"
        ? `Campaign${m.step ? ` · step ${m.step}` : ""}`
        : m.sentBy === "agent"
          ? "Agent"
          : m.sentBy === "approved"
            ? "Agent · approved by you"
            : m.sentBy === "you"
              ? "You"
              : "Sent from Instantly";
  const rest = m.hasQuote ? m.text.trim().slice(m.replyText.length).trim() : "";
  return (
    <div className={cn("ib-mail", m.direction, ai && "ai")}>
      <div className="mh">
        <b>{who}</b>
        {m.isAutoReply && <Badge className="bg-ink/[0.06] text-ink-soft">Auto-reply</Badge>}
        {m.direction === "out" && <span className="truncate">{m.from}</span>}
        <time dateTime={m.sentAt}>{clock(m.sentAt)}</time>
      </div>
      {m.subject && <div className="ms">{m.subject}</div>}
      <div className="mb" dir="auto">
        {m.replyText}
      </div>
      {rest && (
        <>
          <button type="button" className="mq" onClick={() => setQuoted((q) => !q)}>
            {quoted ? "Hide quoted text" : "Show quoted text"}
          </button>
          {quoted && (
            <div className="mqt" dir="auto">
              {rest}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { ai: "read by AI", rules: "matched a rule", human: "set by you", none: "no AI" };

const STATE: Record<string, { title: (m: InboxMessage, eaccount: string) => string; dot: string; hot?: boolean }> = {
  pending: { title: () => "Reading this reply…", dot: "bg-muted" },
  scheduled: { title: (m, e) => `Replying ${dueIn(m.replyDueAt)} from ${e}`, dot: "bg-brand" },
  drafted: { title: () => "A draft is waiting for you", dot: "bg-warn", hot: true },
  needs_human: { title: () => "This one needs you", dot: "bg-warn", hot: true },
  failed: { title: () => "Couldn't send", dot: "bg-bad", hot: true },
  replied: { title: () => "Answered", dot: "bg-good" },
  skipped: { title: () => "No reply needed", dot: "bg-muted" },
  classified: { title: () => "No action", dot: "bg-muted" },
};

const REWRITES = [
  { label: "Shorter", instruction: "Make it shorter: two or three sentences." },
  { label: "Warmer", instruction: "Make it warmer and more personal." },
  { label: "More direct", instruction: "Make it more direct and confident." },
  { label: "In Arabic", instruction: "Write it in Modern Standard Arabic." },
  { label: "In English", instruction: "Write it in English." },
];

function AgentCard({
  m,
  eaccount,
  latest,
  aiConfigured,
  busy,
  act,
}: {
  m: InboxMessage;
  eaccount: string;
  latest: boolean;
  aiConfigured: boolean;
  busy: string | null;
  act: (key: string, fn: () => Promise<{ detail: ThreadDetail | null }>, ok?: string) => Promise<boolean | void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.aiDraft || "");
  const [changing, setChanging] = useState(false);
  const [custom, setCustom] = useState("");
  useEffect(() => {
    if (!editing) setDraft(m.aiDraft || "");
  }, [m.aiDraft, editing]);

  const st = STATE[m.aiStatus || "classified"] || STATE.classified;
  const cat = m.classification ? CATEGORY[m.classification] : null;
  const actionable = ["scheduled", "drafted", "needs_human", "failed"].includes(m.aiStatus || "");
  const showDraft = !!m.aiDraft && actionable;
  const low = m.confidence != null && m.confidence < 0.7;
  const k = (s: string) => `${s}:${m.id}`;

  // Older, settled messages get a one-line read.
  if (!latest && !actionable) {
    return (
      <div className="ib-ev">
        Agent: {cat ? <b>{cat.label}</b> : "read"}
        {m.aiReason ? ` · ${m.aiReason}` : ""}
      </div>
    );
  }

  return (
    <div className={cn("ib-agent", st.hot && "hot")}>
      <div className="ah">
        <span className="mono-label text-muted">Agent</span>
        {m.aiStatus === "pending" ? (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Spinner className="h-3 w-3" /> reading
          </span>
        ) : (
          <>
            {cat && <Badge className={cat.chip}>{cat.label}</Badge>}
            {m.confidence != null && m.aiSource !== "human" && m.aiSource !== "none" && (
              <span className={cn("ib-conf", low && "low")} title="How sure the agent is">
                <span>
                  <i style={{ width: `${Math.round(m.confidence * 100)}%` }} />
                </span>
                {Math.round(m.confidence * 100)}%
              </span>
            )}
            {m.aiSource && <span className="text-[11px] text-muted">{SOURCE_LABEL[m.aiSource] || m.aiSource}</span>}
            {m.meta?.language === "ar" && <Badge className="bg-ink/[0.06] text-ink-soft">Arabic</Badge>}
            <span className="ml-auto flex items-center gap-1.5">
              {changing ? (
                <Select
                  autoFocus
                  value={m.classification || ""}
                  onChange={(e) => {
                    setChanging(false);
                    if (e.target.value && e.target.value !== m.classification) {
                      act(k("cls"), () => inboxApi.classify(m.id, e.target.value), `Set to ${CATEGORY[e.target.value]?.label}. The agent re-decided.`);
                    }
                  }}
                  onBlur={() => setChanging(false)}
                  className="h-8 w-auto py-1 text-[12px]"
                  aria-label="Correct the category"
                >
                  {CATEGORY_ORDER.map((id) => (
                    <option key={id} value={id}>
                      {CATEGORY[id].label}
                    </option>
                  ))}
                </Select>
              ) : (
                <button type="button" className="text-[11.5px] font-semibold text-accent hover:underline" onClick={() => setChanging(true)}>
                  {busy === k("cls") ? "Re-deciding…" : "Correct"}
                </button>
              )}
            </span>
          </>
        )}
        {m.summary && <div className="sum">{m.summary}</div>}
        {m.meta?.returnDate && <div className="sum">Back on {m.meta.returnDate}.</div>}
        {m.meta?.referral && <div className="sum">Pointed to: {m.meta.referral}</div>}
      </div>

      {m.aiStatus !== "pending" && (
        <div className="ad">
          <div className="flex items-center gap-2 font-semibold text-ink">
            <span className={cn("h-2 w-2 flex-none rounded-full", st.dot)} />
            {st.title(m, eaccount)}
          </div>
          {m.aiReason && <p className="mt-1 pl-4 text-[12.5px] text-muted">{m.aiReason}</p>}
          {(m.aiStatus === "failed" || m.aiSource === "none") && (
            <div className="mt-2 pl-4">
              <Button variant="outline" size="sm" loading={busy === k("rerun")} onClick={() => act(k("rerun"), () => inboxApi.rerun(m.id), "The agent read it again.")}>
                Ask the agent again
              </Button>
            </div>
          )}
        </div>
      )}

      {showDraft && (
        <div className="dr">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">
            {m.aiStatus === "scheduled" ? "Reply going out" : "Agent's draft"}
          </div>
          {editing ? (
            <Textarea rows={7} value={draft} onChange={(e) => setDraft(e.target.value)} dir="auto" aria-label="Edit the reply" />
          ) : (
            <div className="whitespace-pre-wrap break-words rounded-lg border border-line-soft bg-sunk px-3 py-2.5 text-[13.5px] leading-relaxed" dir="auto">
              {m.aiDraft}
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {m.aiStatus === "scheduled" ? (
              <Button size="sm" loading={busy === k("now")} onClick={() => act(k("now"), () => inboxApi.sendNow(m.id), "Sent.")}>
                Send now
              </Button>
            ) : (
              <Button
                size="sm"
                loading={busy === k("approve")}
                onClick={async () => {
                  const ok = await act(k("approve"), () => inboxApi.approve(m.id, editing ? draft : undefined), "Sent.");
                  if (ok) setEditing(false);
                }}
              >
                Approve and send
              </Button>
            )}
            {editing ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  loading={busy === k("save")}
                  onClick={async () => {
                    const ok = await act(k("save"), () => inboxApi.saveDraft(m.id, draft), "Draft saved.");
                    if (ok) setEditing(false);
                  }}
                >
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Button variant="ghost" size="sm" loading={busy === k("discard")} onClick={() => act(k("discard"), () => inboxApi.discard(m.id), "Won't be sent.")}>
              {m.aiStatus === "scheduled" ? "Don't send" : "Discard"}
            </Button>
          </div>
          {aiConfigured && !editing && (
            <div className="mt-3">
              <div className="ib-qr">
                {REWRITES.map((r) => (
                  <button
                    key={r.label}
                    type="button"
                    disabled={!!busy}
                    onClick={() => act(k("rw"), () => inboxApi.rewrite(m.id, r.instruction), "Rewritten.")}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!custom.trim()) return;
                  act(k("rw"), () => inboxApi.rewrite(m.id, custom.trim()), "Rewritten.").then((ok) => ok && setCustom(""));
                }}
              >
                <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or tell the agent what to change…" className="py-2 text-[13px]" />
                <Button variant="outline" size="sm" type="submit" loading={busy === k("rw")} disabled={!custom.trim() && busy !== k("rw")} className="h-[38px]">
                  Rewrite
                </Button>
              </form>
            </div>
          )}
        </div>
      )}

      {!showDraft && actionable && m.aiStatus !== "scheduled" && aiConfigured && m.classification !== "legal" && (
        <div className="dr">
          <Button variant="outline" size="sm" loading={busy === k("rw")} onClick={() => act(k("rw"), () => inboxApi.rewrite(m.id), "Draft ready.")}>
            Write a draft for me
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- lead panel ------------------------------- */

function Kv({ k, children }: { k: string; children: ReactNode }) {
  if (children == null || children === "") return null;
  return (
    <div className="ib-kv">
      <span>{k}</span>
      <span>{children}</span>
    </div>
  );
}

const LEVEL_DOT: Record<string, string> = { info: "bg-inf", success: "bg-good", warn: "bg-warn", error: "bg-bad" };

function LeadPanel({ detail }: { detail: ThreadDetail }) {
  const L = detail.lead;
  const site = L.website ? L.website.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;
  return (
    <aside className="ib-side">
      <h4>Lead</h4>
      <Kv k="Name">{L.name}</Kv>
      <Kv k="Title">{L.title}</Kv>
      <Kv k="Company">{L.company}</Kv>
      <Kv k="Email">
        <a href={`mailto:${L.email}`}>{L.email}</a>
      </Kv>
      <Kv k="Website">
        {site && L.website ? (
          <a href={L.website} target="_blank" rel="noreferrer">
            {site}
          </a>
        ) : null}
      </Kv>
      <Kv k="Where">{[L.city, L.country].filter(Boolean).join(", ")}</Kv>
      <Kv k="Industry">{L.industry}</Kv>
      <Kv k="Phone">{L.phone}</Kv>
      <Kv k="LinkedIn">
        {L.linkedin ? (
          <a href={L.linkedin} target="_blank" rel="noreferrer">
            Profile
          </a>
        ) : null}
      </Kv>
      <Kv k="Stage">{L.stage ? L.stage.replace(/_/g, " ") : null}</Kv>
      <Kv k="Fit">{L.fitScore != null ? `${L.fitScore}/100` : null}</Kv>
      {!L.source && <p className="mt-2 text-[12px] leading-relaxed text-muted">Not a prospect from a campaign here, so there's no research on file.</p>}

      {L.research.length > 0 && (
        <>
          <h4>What the agent knows</h4>
          <ul className="space-y-1.5">
            {L.research.map((r) => (
              <li key={r} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-soft">
                <span className="mt-[7px] h-1 w-1 flex-none rounded-full bg-muted" />
                {r}
              </li>
            ))}
          </ul>
        </>
      )}

      {(detail.campaign || detail.mailbox) && <h4>Sending</h4>}
      {detail.campaign && <Kv k="Campaign">{detail.campaign.name}</Kv>}
      {detail.mailbox && (
        <>
          <Kv k="Mailbox">{detail.mailbox.email}</Kv>
          <Kv k="Mailbox stage">{detail.mailbox.stage}</Kv>
        </>
      )}

      {detail.events.length > 0 && (
        <>
          <h4>Activity</h4>
          <ol className="space-y-2.5">
            {detail.events.map((e) => (
              <li key={e.id} className="flex gap-2.5">
                <span className={cn("mt-[6px] h-1.5 w-1.5 flex-none rounded-full", LEVEL_DOT[e.level] || "bg-muted")} />
                <div className="min-w-0">
                  <p className="text-[12.5px] leading-snug text-ink-soft">{e.message}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{ago(e.created_at)}</p>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}

/* ------------------------------- playground ------------------------------- */

const SAMPLES: { label: string; subject?: string; message: string }[] = [
  { label: "Wants a call", message: "This is timely, we're replacing our accounting system next quarter. Could we do a call on Sunday?" },
  { label: "Price question", message: "Does it handle stock across two warehouses, and roughly what does it cost for 15 users?" },
  { label: "Not now", message: "Thanks, but we're in the middle of our year-end close. Please reach out again in January." },
  { label: "Discount", message: "We're comparing you with two others. Can you do 30% off if we sign for three years?" },
  { label: "Arabic", message: "السلام عليكم، هل النظام يدعم الفوترة الإلكترونية لهيئة الزكاة؟ وكم يستغرق التطبيق؟" },
  { label: "Unsubscribe", message: "Please remove me from your mailing list." },
  { label: "Away", subject: "Automatic reply: quick question", message: "I am on annual leave until 9 November with limited access to email." },
  { label: "Legal", message: "Under data protection law I request that you delete all personal data you hold about me." },
];

const ACTION_BADGE: Record<string, { label: string; chip: string }> = {
  send: { label: "Answers on its own", chip: "bg-tlb text-accent" },
  draft: { label: "Drafts for you", chip: "bg-inb text-inf" },
  handoff: { label: "Hands to you", chip: "bg-wnb text-warn" },
  silent: { label: "Housekeeping only", chip: "bg-ink/[0.06] text-ink-soft" },
};

function PlaygroundModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [error, setError] = useState("");

  async function run(over?: { subject?: string; message: string }) {
    const msg = (over?.message ?? message).trim();
    if (!msg) return;
    setRunning(true);
    setError("");
    try {
      setResult(await inboxApi.playground({ message: msg, subject: (over?.subject ?? subject) || undefined, category: category || undefined }));
    } catch (e: any) {
      setError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  const cls = result?.classification;
  const cat = cls ? CATEGORY[cls.category] : null;
  const act = result ? ACTION_BADGE[result.decision.action] : null;

  return (
    <Modal open={open} onClose={onClose} title="Test a reply against your rules" wide>
      <p className="-mt-1 mb-4 text-[13px] leading-relaxed text-muted">
        Paste what a prospect might write. The agent reads it, decides with your saved Agent settings, and shows the reply it would write. Nothing is
        stored or sent.
      </p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {SAMPLES.map((s) => (
          <button
            key={s.label}
            type="button"
            className="rounded-full border border-line bg-sunk px-3 py-1 text-[12px] font-semibold text-ink-soft transition-colors hover:border-line-strong hover:bg-hov hover:text-ink"
            onClick={() => {
              setMessage(s.message);
              setSubject(s.subject || "");
              run({ message: s.message, subject: s.subject || "" });
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
        <Field label="Subject (optional)">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Re: two warehouses" />
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Let the agent decide</option>
            {CATEGORY_ORDER.map((id) => (
              <option key={id} value={id}>
                {CATEGORY[id].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Their reply">
          <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Thanks for reaching out. Does it work for two branches?" dir="auto" />
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <Button onClick={() => run()} loading={running} disabled={!message.trim()}>
          Run
        </Button>
      </div>

      {error && <p className="mt-4 rounded-lg border border-dgl bg-dgb px-3 py-2 text-[13px] text-bad">{error}</p>}

      {result && cls && act && (
        <div className="mt-5 space-y-3 border-t border-line-soft pt-5">
          <div className="rounded-xl border border-line-soft bg-surf2 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">The agent's read</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {cat && <Badge className={cat.chip}>{cat.label}</Badge>}
              {cls.source !== "human" && cls.source !== "none" && (
                <span className={cn("ib-conf", cls.confidence < 0.7 && "low")}>
                  <span>
                    <i style={{ width: `${Math.round(cls.confidence * 100)}%` }} />
                  </span>
                  {Math.round(cls.confidence * 100)}% sure
                </span>
              )}
              <span className="text-[11.5px] text-muted">{SOURCE_LABEL[cls.source]}</span>
            </div>
            {cls.summary && <p className="mt-2 text-[13px] text-ink-soft">{cls.summary}</p>}
            {cls.error && cls.source !== "ai" && <p className="mt-2 text-[12.5px] text-warn">{cls.error}</p>}
          </div>
          <div className="rounded-xl border border-line-soft bg-surf2 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">What happens</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge className={act.chip}>{act.label}</Badge>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{result.decision.reason}</p>
          </div>
          {(result.reply || result.writeError) && (
            <div className="rounded-xl border border-keepl bg-keep1 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-accent">
                  {result.decision.action === "send" ? "The reply it would send" : "The draft it would leave you"}
                </div>
                {result.reply && <span className="text-[11px] text-muted">{result.reply.provider}</span>}
              </div>
              {result.reply ? (
                <div className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed" dir="auto">
                  {result.reply.body}
                </div>
              ) : (
                <p className="mt-2 text-[13px] text-warn">{result.writeError}</p>
              )}
              {result.held && (
                <p className="mt-3 rounded-lg border border-wnl bg-wnb px-3 py-2 text-[12.5px] text-warn">
                  Would be held for you instead of sent: {result.held}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
