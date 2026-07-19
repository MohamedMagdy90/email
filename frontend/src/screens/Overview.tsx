import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Card, Spinner } from "../lib/ui";
import { Header } from "./Contacts";

const STATUS_COLORS: Record<string, string> = {
  new: "#c9c1b2",
  sent: "#36a2ff",
  "sent (dry-run)": "#ffb020",
  unsubscribed: "#a99f8d",
  bounced: "#d64545",
  failed: "#d64545",
  queued: "#d8cfbf",
};

export default function Overview() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getOverview().then((d) => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div>
        <Header title="Overview" subtitle="Your outreach at a glance." />
        <div className="flex items-center gap-2 py-20 text-muted"><Spinner /> Loading…</div>
      </div>
    );
  }

  const contactSeg = (data?.contacts || []).map((r: any) => ({ label: r.status, value: r.n, color: STATUS_COLORS[r.status] || "#c9c1b2" }));
  const sentCount = (data?.sends || []).reduce((a: number, r: any) => a + (String(r.status).startsWith("sent") ? r.n : 0), 0);
  const failed = (data?.sends || []).find((r: any) => r.status === "failed")?.n || 0;
  const unsub = (data?.contacts || []).find((r: any) => r.status === "unsubscribed")?.n || 0;
  const clicks = data?.clicks || 0;
  const openRate = sentCount ? Math.round((data.opens / sentCount) * 100) : 0;
  const clickRate = sentCount ? Math.round((clicks / sentCount) * 100) : 0;

  const daily = buildDailySeries(data?.daily || []);

  const cards = [
    { label: "Contacts", value: data?.totalContacts || 0 },
    { label: "Emails sent", value: sentCount },
    { label: "Open rate", value: `${openRate}%` },
    { label: "Click rate", value: `${clickRate}%` },
  ];

  return (
    <div>
      <Header title="Overview" subtitle="Your outreach at a glance." />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} className="px-5 py-4">
            <div className="font-clash text-3xl font-semibold">{typeof c.value === "number" ? c.value.toLocaleString() : c.value}</div>
            <div className="mono-label mt-1 text-muted">{c.label}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        {/* Contacts donut */}
        <Card className="p-5">
          <div className="mono-label mb-4 text-muted">Contacts by status</div>
          {data?.totalContacts ? (
            <div className="flex items-center gap-6">
              <Donut segments={contactSeg} total={data.totalContacts} />
              <div className="space-y-2">
                {contactSeg.map((s: any) => (
                  <div key={s.label} className="flex items-center gap-2 text-[13px]">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    <span className="capitalize text-ink/75">{s.label}</span>
                    <span className="ml-auto font-medium tabular-nums">{s.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyMini text="No contacts yet — add some from the Contacts tab." />
          )}
        </Card>

        {/* Sends bar chart */}
        <Card className="p-5">
          <div className="mono-label mb-4 text-muted">Emails sent · last 14 days</div>
          {sentCount ? (
            <Bars data={daily} />
          ) : (
            <EmptyMini text="No sends yet — head to the Send tab to start." />
          )}
        </Card>
      </div>

      {/* Engagement strip */}
      <Card className="mt-5 grid grid-cols-2 gap-6 p-5 sm:grid-cols-5">
        <Metric label="Delivered / dry-run" value={sentCount} tone="ink" />
        <Metric label="Opens" value={data?.opens || 0} tone="good" />
        <Metric label="Clicks" value={clicks} tone="good" />
        <Metric label="Failed" value={failed} tone={failed ? "bad" : "ink"} />
        <Metric label="Unsubscribed" value={unsub} tone="muted" />
      </Card>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "ink" | "good" | "bad" | "muted" }) {
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "muted" ? "text-muted" : "text-ink";
  return (
    <div>
      <div className={`font-clash text-2xl font-semibold ${color}`}>{value.toLocaleString()}</div>
      <div className="mono-label mt-0.5 text-muted">{label}</div>
    </div>
  );
}

function EmptyMini({ text }: { text: string }) {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
      <div className="prism-bar h-1 w-12 rounded-full opacity-50" />
      <div className="text-sm text-muted">{text}</div>
    </div>
  );
}

/* ------------------------------ Donut ------------------------------- */

function Donut({ segments, total }: { segments: { label: string; value: number; color: string }[]; total: number }) {
  const size = 168, stroke = 24, r = (size - stroke) / 2, C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#ece6da" strokeWidth={stroke} />
        {segments.map((s, i) => {
          const frac = total ? s.value / total : 0;
          const dash = frac * C;
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={-acc * C}
            />
          );
          acc += frac;
          return el;
        })}
      </g>
      <text x="50%" y="47%" textAnchor="middle" className="font-clash" style={{ fontSize: 30, fontWeight: 600, fill: "#0b0b0b" }}>
        {total}
      </text>
      <text x="50%" y="60%" textAnchor="middle" style={{ fontSize: 11, letterSpacing: "0.15em", fill: "#837c6f" }}>
        TOTAL
      </text>
    </svg>
  );
}

/* ------------------------------- Bars ------------------------------- */

function Bars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex h-44 items-end gap-1.5">
      {data.map((d, i) => (
        <div key={i} className="group flex flex-1 flex-col items-center gap-1.5">
          <div className="relative flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t-md bg-ink/85 transition-all group-hover:bg-ink"
              style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value ? 4 : 0 }}
              title={`${d.label}: ${d.value}`}
            />
          </div>
          <span className="text-[9px] text-muted">{d.label.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function buildDailySeries(daily: { d: string; n: number }[]) {
  const map = new Map(daily.map((x) => [x.d, x.n]));
  const out: { label: string; value: number }[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const key = dt.toISOString().slice(0, 10);
    out.push({ label: key, value: map.get(key) || 0 });
  }
  return out;
}
