import { useEffect, useMemo, useState } from "react";
import { api, type SendRow } from "../lib/api";
import { Button, Card, Input, Spinner, StatusPill, cn, toast } from "../lib/ui";
import { downloadCsv } from "../lib/csv";
import { Header } from "./Contacts";

const FILTERS = ["all", "sent", "failed", "opened", "clicked"];

function timeAgo(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function History() {
  const [sends, setSends] = useState<SendRow[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    const [h, s] = await Promise.all([api.getHistory(1000), api.getStats()]);
    setSends(h.sends);
    setStats(s);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const sentCount = (stats?.sends || []).reduce((a: number, r: any) => a + (r.status.startsWith("sent") ? r.n : 0), 0);
  const failedCount = (stats?.sends || []).find((r: any) => r.status === "failed")?.n || 0;
  const unsub = (stats?.contacts || []).find((r: any) => r.status === "unsubscribed")?.n || 0;

  const cards = [
    { label: "Emails sent", value: sentCount },
    { label: "Opens", value: stats?.opens || 0 },
    { label: "Clicks", value: stats?.clicks || 0 },
    { label: "Failed", value: failedCount },
    { label: "Unsubscribed", value: unsub },
  ];

  const filtered = useMemo(() => {
    return sends.filter((s) => {
      const matchFilter =
        filter === "all" ||
        (filter === "sent" && s.status.startsWith("sent")) ||
        (filter === "failed" && s.status === "failed") ||
        (filter === "opened" && (s.open_count || 0) > 0) ||
        (filter === "clicked" && (s.click_count || 0) > 0);
      const q = search.trim().toLowerCase();
      const matchSearch = !q || s.contact_email.toLowerCase().includes(q) || (s.subject || "").toLowerCase().includes(q);
      return matchFilter && matchSearch;
    });
  }, [sends, filter, search]);

  async function exportCsv() {
    try {
      const csv = await api.exportHistory();
      if (!csv.trim() || csv.split("\n").length <= 1) return toast("Nothing to export", "info");
      downloadCsv("send-history.csv", csv);
      toast("Exported", "success");
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  return (
    <div>
      <Header
        title="History"
        subtitle="Every send, its status, and engagement."
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={exportCsv}>Export</Button>
            <Button size="sm" variant="outline" onClick={load}>Refresh</Button>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:mb-6 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5">
        {cards.map((c) => (
          <Card key={c.label} className="px-3.5 py-3 sm:px-4 sm:py-3.5">
            <div className="font-clash text-xl font-semibold sm:text-2xl">{Number(c.value).toLocaleString()}</div>
            <div className="mono-label mt-0.5 text-muted">{c.label}</div>
          </Card>
        ))}
      </div>

      <div className="mb-3 space-y-2 lg:flex lg:flex-wrap lg:items-center lg:gap-2 lg:space-y-0">
        <Input
          type="search"
          placeholder="Search recipient or subject…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full lg:order-2 lg:ml-auto lg:h-9 lg:w-64"
        />
        <div className="-mx-4 overflow-x-auto px-4 no-scrollbar lg:order-1 lg:mx-0 lg:overflow-visible lg:px-0">
          <div className="inline-flex rounded-full border border-line bg-paper p-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium capitalize transition-colors lg:px-3 lg:py-1",
                  filter === f ? "bg-ink text-cream" : "text-ink/55 hover:text-ink"
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted"><Spinner /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-muted">
            {sends.length === 0 ? "No sends yet. Head to the Send tab to start." : "No sends match this view."}
          </div>
        ) : (
          <>
            {/* Phone / tablet: the subject is the headline and engagement reads
                as a footer, rather than six columns pushed off the right edge. */}
            <ul className="divide-y divide-line-soft lg:hidden">
              {filtered.map((s) => (
                <li key={s.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-[14px] font-medium">{s.contact_email}</span>
                    <span className="shrink-0"><StatusPill status={s.status} /></span>
                  </div>

                  <div className="mt-0.5 line-clamp-2 text-[13px] text-ink/70">{s.subject}</div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted">
                    <span>{timeAgo(s.created_at)}</span>
                    {(s.open_count || 0) > 0 && (
                      <span className="font-medium tabular-nums text-good">{s.open_count}× opened</span>
                    )}
                    {(s.click_count || 0) > 0 && (
                      <span className="font-medium tabular-nums text-good">{s.click_count}× clicked</span>
                    )}
                    {!!s.followup_step && (
                      <span className="rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/50">
                        retry {s.followup_step}
                        {s.followup_branch === "no_click" ? " · no click" : " · no open"}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left mono-label text-muted">
                    <th className="px-4 py-3">Recipient</th>
                    <th className="px-2 py-3">Subject</th>
                    <th className="px-2 py-3">Status</th>
                    <th className="px-2 py-3">Opens</th>
                    <th className="px-2 py-3">Clicks</th>
                    <th className="px-2 py-3">When</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr key={s.id} className="border-b border-line-soft last:border-0 hover:bg-ink/[0.015]">
                      <td className="px-4 py-2.5 font-medium">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate">{s.contact_email}</span>
                          {/* A second or third email is a retry — say which rung
                              and why, so the same address twice never looks like
                              a duplicate send. */}
                          {!!s.followup_step && (
                            <span
                              className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/50"
                              title={
                                s.followup_branch === "no_click"
                                  ? "Follow-up: they opened the previous email but didn't click"
                                  : "Follow-up: they never opened the previous email"
                              }
                            >
                              retry {s.followup_step}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="max-w-[280px] truncate px-2 py-2.5 text-ink/70" title={s.subject}>{s.subject}</td>
                      <td className="px-2 py-2.5"><StatusPill status={s.status} /></td>
                      <td className="px-2 py-2.5">
                        {(s.open_count || 0) > 0 ? (
                          <span
                            className="tabular-nums font-medium text-good"
                            title={s.last_opened_at ? `Last opened ${timeAgo(s.last_opened_at)}` : "Opened"}
                          >
                            {s.open_count}×
                          </span>
                        ) : (
                          <span className="text-ink/20">○</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5">
                        {(s.click_count || 0) > 0 ? (
                          <span
                            className="tabular-nums font-medium text-good"
                            title={s.last_clicked_at ? `Last clicked ${timeAgo(s.last_clicked_at)}` : "Clicked"}
                          >
                            {s.click_count}×
                          </span>
                        ) : (
                          <span className="text-ink/20">○</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-xs text-muted">{timeAgo(s.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
