import { useEffect, useState } from "react";
import { api, type SendRow } from "../lib/api";
import { Button, Card, Spinner, StatusPill } from "../lib/ui";
import { Header } from "./Contacts";

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

  async function load() {
    setLoading(true);
    const [h, s] = await Promise.all([api.getHistory(300), api.getStats()]);
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
    { label: "Failed", value: failedCount },
    { label: "Unsubscribed", value: unsub },
  ];

  return (
    <div>
      <Header
        title="History"
        subtitle="Every send, its status, and engagement."
        actions={<Button size="sm" variant="outline" onClick={load}>Refresh</Button>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} className="px-4 py-3.5">
            <div className="font-clash text-2xl font-semibold">{Number(c.value).toLocaleString()}</div>
            <div className="mono-label mt-0.5 text-muted">{c.label}</div>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted"><Spinner /> Loading…</div>
        ) : sends.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">No sends yet. Head to the Send tab to start.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left mono-label text-muted">
                  <th className="px-4 py-3">Recipient</th>
                  <th className="px-2 py-3">Subject</th>
                  <th className="px-2 py-3">Status</th>
                  <th className="px-2 py-3">Open</th>
                  <th className="px-2 py-3">When</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((s) => (
                  <tr key={s.id} className="border-b border-line-soft last:border-0 hover:bg-ink/[0.015]">
                    <td className="px-4 py-2.5 font-medium">{s.contact_email}</td>
                    <td className="max-w-[280px] truncate px-2 py-2.5 text-ink/70">{s.subject}</td>
                    <td className="px-2 py-2.5"><StatusPill status={s.status} /></td>
                    <td className="px-2 py-2.5">{s.opened ? <span className="text-good">●</span> : <span className="text-ink/20">○</span>}</td>
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
