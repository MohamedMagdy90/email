import { useEffect, useState } from "react";
import { api, type AutomationStatus } from "../lib/api";
import { Button, Card, Spinner, cn, goTo } from "../lib/ui";
import { Header } from "./Contacts";
import { AutomationLaneBars } from "./Discovery";
import { FillRateCard } from "./FillRate";

const STATUS_COLORS: Record<string, string> = {
  new: "#c9c1b2",
  sent: "#36a2ff",
  "sent (dry-run)": "#ffb020",
  unsubscribed: "#a99f8d",
  bounced: "#d64545",
  failed: "#d64545",
  queued: "#d8cfbf",
};

type OverviewData = Awaited<ReturnType<typeof api.getOverview>>;
type Day = { label: string; value: number; opens: number; failed: number };

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function load() {
      // Settled, not all: the automation call must never be able to blank the
      // whole screen, and vice versa.
      const [ov, auto] = await Promise.allSettled([api.getOverview(), api.getAutomation()]);
      if (!alive) return;
      if (ov.status === "fulfilled") setData(ov.value);
      if (auto.status === "fulfilled") setAutomation(auto.value);
      setLoading(false);
    }
    load();
    const t = window.setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
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
  const openRate = sentCount ? Math.round((data!.opens / sentCount) * 100) : 0;
  const clickRate = sentCount ? Math.round((clicks / sentCount) * 100) : 0;

  const daily = buildDailySeries(data?.daily || [], data?.windowDays || 14);
  const windowTotal = daily.reduce((n, d) => n + d.value, 0);

  const stale = data?.sources?.stale ?? 0;
  const staleAfter = data?.sources?.staleAfterRuns ?? 2;
  const staleNames = (data?.sources?.staleList || []).map(sourceLabel);

  // "Contacts" led this strip and is the one number here that was already
  // answered twice over — the donut below is titled "Contacts by status" and
  // prints the very same total in its middle. The fill rate takes the slot
  // because nothing else on this page says whether the machine is still being
  // fed, and that is the question a front page exists to answer.
  const cards = [
    { label: "Emails sent", value: sentCount },
    { label: "Open rate", value: `${openRate}%` },
    { label: "Click rate", value: `${clickRate}%` },
  ];

  return (
    <div>
      <Header title="Overview" subtitle="Your outreach at a glance." />

      <div className="mb-5 grid grid-cols-2 items-stretch gap-2.5 sm:mb-6 sm:gap-3 lg:grid-cols-4">
        <FillRateCard fill={data?.fill} openLabel="Open Discovery" onOpen={() => goTo("discovery")} />
        {cards.map((c) => (
          <Card key={c.label} className="flex flex-col justify-center px-4 py-3.5 sm:px-5 sm:py-4">
            <div className="font-clash text-2xl font-semibold sm:text-3xl">{typeof c.value === "number" ? c.value.toLocaleString() : c.value}</div>
            <div className="mono-label mt-1 text-muted">{c.label}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-[1fr_1.4fr]">
        {/* Contacts donut */}
        <Card className="p-4 sm:p-5">
          <div className="mono-label mb-4 text-muted">Contacts by status</div>
          {data?.totalContacts ? (
            <div className="flex items-center gap-4 sm:gap-6">
              <Donut segments={contactSeg} total={data.totalContacts} />
              <div className="min-w-0 flex-1 space-y-2">
                {contactSeg.map((s: any) => (
                  <div key={s.label} className="flex items-center gap-2 text-[13px]">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="truncate capitalize text-ink/75">{s.label}</span>
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
        <Card className="p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div className="mono-label text-muted">Emails sent · last {data?.windowDays || 14} days</div>
            <div className="flex items-center gap-3 text-[11px] text-muted">
              <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-[2px] bg-ink/85 not-italic" /> sent</span>
              <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-[2px] bg-good not-italic" /> opened</span>
            </div>
          </div>
          {sentCount ? (
            <Bars data={daily} total={windowTotal} />
          ) : (
            <EmptyMini text="No sends yet — head to the Send tab to start." />
          )}
        </Card>
      </div>

      {/* Automation batch progress + discovery health. Both answer "what is the
          app doing for me right now", which the numbers above never do. */}
      <div className="mt-4 grid gap-4 sm:mt-5 sm:gap-5 lg:grid-cols-[1.4fr_1fr]">
        <AutomationCard a={automation} />
        <StaleCard count={stale} after={staleAfter} names={staleNames} total={data?.sources?.total ?? 0} />
      </div>

      {/* Engagement strip */}
      <Card className="mt-4 grid grid-cols-2 gap-5 p-4 sm:mt-5 sm:grid-cols-3 sm:gap-6 sm:p-5 lg:grid-cols-5">
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

/* --------------------------- Automation card --------------------------- */

// The same batch bars the Discovery tab shows, on the front page — "how close
// is the next batch" is a headline question, not a Discovery-tab detail.
function AutomationCard({ a }: { a: AutomationStatus | null }) {
  const lanes = (a?.lanes ?? []).filter((l) => l.config.enabled);
  const master = !!a?.config.enabled;
  const sending = !!a?.running || a?.lastRun?.status === "running";
  const blocked = master && (a?.blockers.length ?? 0) > 0;

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="mono-label text-muted">Automation · next batch</div>
        {a && a.sentToday > 0 && <span className="text-[11px] text-muted">{a.sentToday.toLocaleString()} sent today</span>}
      </div>

      {!a ? (
        <div className="flex h-32 items-center gap-2 text-sm text-muted"><Spinner /> Reading the pool…</div>
      ) : !master ? (
        <div className="flex h-32 flex-col items-start justify-center gap-3">
          <p className="text-[13px] leading-relaxed text-muted">
            Automation is off — discovered leads wait in the pool until you approve them by hand. Switch it on and every
            batch is approved and emailed on its own, customers and partners in their own lane.
          </p>
          <Button size="sm" variant="outline" onClick={() => goTo("settings")}>Set up automation</Button>
        </div>
      ) : !lanes.length ? (
        <div className="flex h-32 flex-col items-start justify-center gap-3">
          <p className="text-[13px] text-muted">Automation is on, but both lanes are switched off.</p>
          <Button size="sm" variant="outline" onClick={() => goTo("settings")}>Open Settings</Button>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-start gap-2.5">
            <span className={cn("relative mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg", blocked ? "bg-[#e0b354]/25" : "bg-good/15")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", blocked ? "bg-[#b06b16]" : "bg-good")} />
              {!blocked && <span className="absolute h-1.5 w-1.5 animate-ping rounded-full bg-good/60" />}
            </span>
            <p className="text-[13px] leading-relaxed">
              <span className="font-medium text-ink">
                {sending ? "Emailing a batch right now" : blocked ? "On, but it can’t run yet" : "Watching the pool"}
              </span>
              <span className="text-muted">{blocked ? ` — ${a.blockers[0]}` : " — approved automatically, then emailed."}</span>
            </p>
          </div>
          <AutomationLaneBars lanes={lanes} size="md" />
          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => goTo("discovery")}>See the pool</Button>
            <Button size="sm" variant="ghost" onClick={() => goTo("settings")}>Settings</Button>
          </div>
        </>
      )}
    </Card>
  );
}

/* ----------------------------- Stale sources ---------------------------- */

// A source that has stopped producing is invisible in every other number on
// this page: it is enabled, on schedule, error-free — and useless. Clicking
// through lands on the Discovery tab with exactly these rows showing.
function StaleCard({ count, after, names, total }: { count: number; after: number; names: string[]; total: number }) {
  const bad = count > 0;
  return (
    <Card
      className={cn(
        "group cursor-pointer p-4 transition-colors sm:p-5",
        bad ? "border-[#e0b354]/60 bg-[#fdf6e7] hover:bg-[#fcf1dc]" : "hover:bg-ink/[0.02]"
      )}
    >
      <button
        type="button"
        onClick={() => goTo("discovery", bad ? "stale" : undefined)}
        className="flex h-full w-full flex-col items-start text-left"
      >
        <div className="mono-label text-muted">Stale sources</div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={cn("font-clash text-4xl font-semibold", bad ? "text-[#b06b16]" : "text-ink")}>{count}</span>
          {total > 0 && <span className="text-[11px] text-muted">of {total}</span>}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {bad ? (
            <>
              Ran {after} time{after === 1 ? "" : "s"} in a row and fetched nobody new. The ground is covered — re-aim
              {count === 1 ? " it" : " them"} or archive {count === 1 ? "it" : "them"}.
            </>
          ) : total === 0 ? (
            <>No discovery sources yet. Add one and this watches whether it keeps producing.</>
          ) : (
            <>Every source is still finding companies. A source is flagged here the moment it finishes {after} runs in a row with nothing new.</>
          )}
        </p>
        {bad && names.length > 0 && (
          <ul className="mt-3 w-full space-y-1">
            {names.slice(0, 3).map((n) => (
              <li key={n} className="truncate text-[12px] text-[#8a5a12]">· {n}</li>
            ))}
            {names.length > 3 && <li className="text-[12px] text-muted">+{names.length - 3} more</li>}
          </ul>
        )}
        <span className={cn("mt-auto pt-3 text-[12px] font-medium underline-offset-2 group-hover:underline", bad ? "text-[#b06b16]" : "text-ink/60")}>
          {bad ? "Review them in Discovery →" : "Open Discovery →"}
        </span>
      </button>
    </Card>
  );
}

function sourceLabel(s: { type?: string; location: string; base_url?: string | null; category?: string }): string {
  if (s.type === "directory" && s.base_url) {
    try { return new URL(s.base_url).hostname.replace(/^www\./, ""); } catch { return s.base_url; }
  }
  const kind = s.type === "search" ? "Web search" : s.type === "osm" ? "Map area" : "";
  return [s.location, s.category, kind && `(${kind.toLowerCase()})`].filter(Boolean).join(" · ");
}

/* ------------------------------ Donut ------------------------------- */

function Donut({ segments, total }: { segments: { label: string; value: number; color: string }[]; total: number }) {
  const size = 168, stroke = 24, r = (size - stroke) / 2, C = 2 * Math.PI * r;
  let acc = 0;
  return (
    // Sized by class rather than by attribute so it can give up 28px on a
    // phone without the legend beside it collapsing.
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-[132px] w-[132px] shrink-0 sm:h-[168px] sm:w-[168px]"
      role="img"
      aria-label={`${total} contacts by status`}
    >
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

// EVERY BAR HEIGHT IS A PIXEL VALUE, DELIBERATELY.
//
// This chart drew every bar flat for as long as it existed. The bars were sized
// with `height: N%` inside a column that was itself `flex-1` of a row set to
// `items-end` — and `align-items: flex-end` means the columns are NOT stretched
// to the row's height, so each one collapsed to its content height, the track
// resolved to zero, and every percentage was a percentage of nothing. The data
// was always correct; only the geometry was wrong. Computing the heights in JS
// against a known track height removes the entire class of bug, and it lets the
// opened-share be drawn inside the same bar.
const TRACK = 148;

function Bars({ data, total }: { data: Day[]; total: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0]);
  const today = data[data.length - 1]?.label;

  return (
    <div>
      <div className="relative" style={{ height: TRACK }}>
        {/* Reference lines, so a bar can be READ rather than merely compared.
            Translated down by half their own height so the label straddles the
            line instead of stacking on top of the card's heading. */}
        {[1, 0.5].map((f) => (
          <div key={f} className="pointer-events-none absolute inset-x-0 flex translate-y-1/2 items-center gap-2" style={{ bottom: f * TRACK }}>
            <span className="w-6 shrink-0 text-right text-[9px] tabular-nums text-muted/70">{Math.round(max * f)}</span>
            <span className="h-px flex-1 bg-line-soft" />
          </div>
        ))}
        <div className="absolute inset-y-0 left-8 right-0 flex items-end gap-1 sm:gap-1.5">
          {data.map((d) => {
            const h = d.value ? Math.max(3, Math.round((d.value / max) * TRACK)) : 0;
            const openH = d.value ? Math.round((Math.min(d.opens, d.value) / max) * TRACK) : 0;
            const isToday = d.label === today;
            return (
              <div key={d.label} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end">
                {/* Value on hover — and always for the peak, so the chart has a
                    number on it even before anyone touches it. */}
                <span
                  className={cn(
                    "pointer-events-none absolute inset-x-0 z-10 text-center text-[10px] font-semibold leading-none tabular-nums text-ink transition-opacity",
                    d.value === max && d.value > 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  style={{ bottom: h + 4 }}
                >
                  {d.value || ""}
                </span>
                {h > 0 ? (
                  <div
                    className={cn(
                      "relative w-full overflow-hidden rounded-t-md transition-colors",
                      isToday ? "bg-ink" : "bg-ink/85 group-hover:bg-ink"
                    )}
                    style={{ height: h }}
                    title={`${d.label}: ${d.value} sent · ${d.opens} opened${d.failed ? ` · ${d.failed} failed` : ""}`}
                  >
                    {openH > 0 && (
                      <span className="absolute inset-x-0 bottom-0 bg-good" style={{ height: Math.max(2, openH) }} />
                    )}
                  </div>
                ) : (
                  <div className="w-full rounded-t-sm bg-line-soft" style={{ height: 2 }} title={`${d.label}: nothing sent`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-2 flex gap-1 pl-8 sm:gap-1.5">
        {data.map((d) => (
          // Fourteen "08-25" labels do not fit across a phone; the day alone does.
          <span key={d.label} className={cn("min-w-0 flex-1 text-center text-[9px] leading-none", d.label === today ? "font-semibold text-ink/70" : "text-muted")}>
            <span className="sm:hidden">{d.label.slice(8)}</span>
            <span className="hidden sm:inline">{d.label.slice(5)}</span>
          </span>
        ))}
      </div>

      <div className="mt-3 border-t border-line-soft pt-2.5 text-[11px] text-muted">
        {total > 0 ? (
          <>
            <b className="text-ink/70 tabular-nums">{total.toLocaleString()}</b> sent in this window
            {peak && peak.value > 0 && <> · busiest day {peak.label.slice(5)} with {peak.value}</>}
          </>
        ) : (
          <>Nothing sent in this window — the totals above are lifetime.</>
        )}
      </div>
    </div>
  );
}

// The server now sends one entry per day, already in order and already padded
// with the empty days. Older builds sent only the days that had rows, so the
// gaps are still filled in here — but against the SERVER's calendar, taken from
// the payload itself, never from the viewer's clock (which used to drop today's
// bucket for anyone east of UTC).
function buildDailySeries(daily: { d: string; n: number; sent?: number; opens?: number; failed?: number }[], windowDays: number): Day[] {
  const map = new Map(daily.map((x) => [x.d, x]));
  if (daily.length >= windowDays) {
    return daily.map((x) => ({ label: x.d, value: x.sent ?? x.n ?? 0, opens: x.opens ?? 0, failed: x.failed ?? 0 }));
  }
  // Anchor on the newest day the server reported, so the axis still belongs to
  // the server; fall back to the browser's date only when there is no data.
  const last = daily.length ? daily[daily.length - 1].d : new Date().toISOString().slice(0, 10);
  const endMs = Date.parse(`${last}T00:00:00Z`);
  const out: Day[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const key = new Date(endMs - i * 86400000).toISOString().slice(0, 10);
    const hit = map.get(key);
    out.push({ label: key, value: hit?.sent ?? hit?.n ?? 0, opens: hit?.opens ?? 0, failed: hit?.failed ?? 0 });
  }
  return out;
}
