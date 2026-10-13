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

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {cards.map((c) => (
          <Card key={c.label} className="px-4 py-3.5">
            <div className="font-clash text-2xl font-semibold">{Number(c.value).toLocaleString()}</div>
            <div className="mono-label mt-0.5 text-muted">{c.label}</div>
          </Card>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-line bg-paper p-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full px-3 py-1 text-[13px] font-medium capitalize transition-colors",
                filter === f ? "bg-ink text-cream" : "text-ink/55 hover:text-ink"
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <Input
          placeholder="Search recipient or subject…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto h-9 w-64"
        />
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted"><Spinner /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">
            {sends.length === 0 ? "No sends yet. Head to the Send tab to start." : "No sends match this view."}
          </div>
        ) : (
          <div className="overflow-x-auto">
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
                    <td className="px-4 py-2.5 font-medium">{s.contact_email}</td>
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
        )}
      </Card>
    </div>
  );
}
