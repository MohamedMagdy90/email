// Dashboard (plan §8.2) — "is it working, and what needs me?"
// One call to /api/v2/dashboard (cached 60 s on the server) feeds every
// section: needs-you, KPI tiles, funnel, daily trend, campaigns, segments,
// sending capacity + AI budget, and the latest activity.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Badge, Button, Input, Modal, PageHeader, Spinner, cn, toast } from "../lib/ui";
import { ago } from "../lib/v2/core";
import type { Funnel } from "../lib/v2/campaigns";
import { dashboardApi, type DashCampaign, type DashSegment, type Dashboard as Data, type Kpi, type KpiKey, type LoopStatus, type NeedsYou, type Range, type TrendDay } from "../lib/v2/dashboard";
import { CampaignFilter, refreshCampaignList, setCampaignFilter, useCampaignFilter, useCampaignList } from "./shared/CampaignFilter";
import { Empty, StatusChip, errMsg, goTab, openCampaign, openLeads, openSegment, plural } from "./campaigns/parts";

const RANGE_KEY = "dnaDashRange";
const RANGES: Range[] = [7, 30, 90];

function readRange(): Range {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    return (RANGES as number[]).includes(v) ? (v as Range) : 30;
  } catch {
    return 30;
  }
}

const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());
const dayLabel = (day: string, month: "short" | "long" = "short") => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month, timeZone: "UTC" });
const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

function runAction(a: NonNullable<NeedsYou["action"]>) {
  if (a.campaignId) return openCampaign(a.campaignId);
  if (a.leadsView) return openLeads(a.leadsView);
  goTab(a.tab);
}

function Arrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 6h7M6.5 3l3 3-3 3" />
    </svg>
  );
}

function Head({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="db-h">
      <h2>{title}</h2>
      <div className="flex items-center gap-3">
        {aside != null && <span className="aside">{aside}</span>}
        {children}
      </div>
    </div>
  );
}

function LinkBtn({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent hover:underline">
      {children} <Arrow />
    </button>
  );
}

/* ================================ screen ================================ */

export default function Dashboard() {
  const [campaign, setCampaign] = useCampaignFilter();
  const campaigns = useCampaignList();
  const [range, setRangeState] = useState<Range>(readRange);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [confirm, setConfirm] = useState<"pause" | "resume" | null>(null);
  const [costOpen, setCostOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // A remembered filter can point at a campaign that was archived since.
  const cid = !campaign || !campaigns || campaigns.some((c) => c.id === campaign) ? campaign : "";
  const reload = () => setTick((n) => n + 1);

  const setRange = (r: Range) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_KEY, String(r));
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    dashboardApi
      .get(range, cid || undefined)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e) => alive && setError(errMsg(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [range, cid, tick]);

  // Fresh numbers every minute while the tab is open, and on coming back to it.
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setTick((n) => n + 1), 60_000);
    const onVis = () => !document.hidden && setTick((n) => n + 1);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  async function doPause() {
    setBusy(true);
    try {
      const r = await dashboardApi.pauseAll();
      toast(r.paused ? `Paused ${plural(r.paused, "campaign")}. Resume brings them back.` : "Nothing was running.", "success");
      setConfirm(null);
      refreshCampaignList().catch(() => {});
      reload();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  }
  async function doResume() {
    setBusy(true);
    try {
      const r = await dashboardApi.resumeAll();
      if (r.failed.length) toast(`Resumed ${r.resumed}. Couldn't restart ${r.failed[0]}${r.failed.length > 1 ? ` (+${r.failed.length - 1} more)` : ""}`, "error");
      else toast(`Resumed ${plural(r.resumed, "campaign")}.`, "success");
      setConfirm(null);
      refreshCampaignList().catch(() => {});
      reload();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const name = cid ? campaigns?.find((c) => c.id === cid)?.name : null;
  const pause = data?.pause;
  const header = (
    <PageHeader
      title="Dashboard"
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <span>Is it working, and what needs you?</span>
          <span className="text-ink/40">·</span>
          <span>
            {name || "All campaigns"}, last {range} days
          </span>
          {data && (
            <>
              <span className="text-ink/40">·</span>
              <span className="inline-flex items-center gap-1.5">
                {loading ? <Spinner className="h-3 w-3" /> : null}
                updated {ago(data.generatedAt)}
              </span>
            </>
          )}
        </span>
      }
      actions={
        <>
          <div className="seg" role="group" aria-label="Period">
            {RANGES.map((r) => (
              <button key={r} type="button" className={r === range ? "on" : ""} aria-pressed={r === range} onClick={() => setRange(r)}>
                {r} days
              </button>
            ))}
          </div>
          <CampaignFilter value={cid} onChange={setCampaign} list={campaigns} />
          {pause && pause.active > 0 ? (
            <Button variant="danger" size="sm" onClick={() => setConfirm("pause")} title="Pauses every running campaign, not only the one in view">
              Pause everything
            </Button>
          ) : pause && pause.pausedByAll > 0 ? (
            <Button size="sm" onClick={() => setConfirm("resume")}>
              Resume {pause.pausedByAll}
            </Button>
          ) : null}
        </>
      }
    />
  );

  if (!data) {
    return (
      <>
        {header}
        {error && !loading ? <Empty title="The dashboard didn't load" body={error} action={<Button onClick={reload}>Try again</Button>} /> : <Skeleton />}
      </>
    );
  }

  const noCampaigns = data.campaigns.length === 0;
  return (
    <>
      {header}
      <div className={cn("space-y-6 transition-opacity duration-200", loading && "opacity-60")}>
        {!data.hasData && data.firstSendNote && <BeforeFirstSend d={data} />}
        {data.needsYou.length > 0 && <NeedsSection items={data.needsYou} />}
        {data.hasData && <KpiRow d={data} onEditCost={() => setCostOpen(true)} />}

        {!noCampaigns && (
          <div className="grid gap-4 lg:grid-cols-12">
            <section className={cn("db-card db-in", data.hasData ? "lg:col-span-5" : "lg:col-span-12")} style={delay(120)}>
              <FunnelCard f={data.funnel} wide={!data.hasData} />
            </section>
            {data.hasData && (
              <section className="db-card db-in lg:col-span-7" style={delay(160)}>
                <TrendCard days={data.trend} range={data.range} />
              </section>
            )}
          </div>
        )}

        {!noCampaigns && (
          <section className="db-card db-in" style={delay(200)}>
            <CampaignsTable rows={data.campaigns} />
          </section>
        )}

        <div className="grid gap-4 lg:grid-cols-12">
          {!noCampaigns && (
            <section className="db-card db-in lg:col-span-7" style={delay(240)}>
              <SegmentsBoard rows={data.segments} showCampaign={!cid} />
            </section>
          )}
          <div className={cn("grid content-start gap-4", noCampaigns ? "lg:col-span-12 lg:grid-cols-2" : "lg:col-span-5")}>
            <section className="db-card db-in" style={delay(260)}>
              <CapacityCard d={data} />
            </section>
            <section className="db-card db-in" style={delay(300)}>
              <ActivityCard events={data.events} />
            </section>
          </div>
        </div>
      </div>

      <Modal open={confirm === "pause"} onClose={() => !busy && setConfirm(null)} title="Pause every running campaign?">
        <div className="space-y-3 text-[13.5px] leading-relaxed text-ink-soft">
          <p>
            {plural(pause?.active || 0, "running campaign")} stop finding, researching, writing and sending, on your own mailboxes and in Instantly. Nothing is deleted, and replies keep arriving in the Inbox.
          </p>
          <p className="text-muted">This covers every campaign, not only the one in view. Resume brings back exactly the campaigns paused here.</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={doPause} loading={busy}>
            Pause {plural(pause?.active || 0, "campaign")}
          </Button>
        </div>
      </Modal>

      <Modal open={confirm === "resume"} onClose={() => !busy && setConfirm(null)} title="Resume the paused campaigns?">
        <p className="text-[13.5px] leading-relaxed text-ink-soft">
          {plural(pause?.pausedByAll || 0, "campaign")} paused with "Pause everything" start again. Each one is checked first (offer, segments, a way to send), so one that isn't ready stays paused and says why.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={doResume} loading={busy}>
            Resume {plural(pause?.pausedByAll || 0, "campaign")}
          </Button>
        </div>
      </Modal>

      <CostDialog open={costOpen} current={data.monthlyCost} onClose={() => setCostOpen(false)} onSaved={reload} />
    </>
  );
}

/* =============================== skeleton =============================== */

function Skeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading the dashboard">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="db-sk h-[132px]" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="db-sk h-[330px] lg:col-span-5" />
        <div className="db-sk h-[330px] lg:col-span-7" />
      </div>
      <div className="db-sk h-[220px]" />
    </div>
  );
}

/* ============================ before first send ============================ */

function BeforeFirstSend({ d }: { d: Data }) {
  const f = d.funnel;
  const stats: [string, number, string][] = [
    ["Companies found", f.total, "all"],
    ["Researched", reach(f).researched, "researched"],
    ["To review", f.written, "review"],
    ["Approved", f.approved + f.queued, "ready"],
  ];
  const noCampaigns = d.campaigns.length === 0;
  return (
    <section className="hb keep db-in">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 max-w-[620px]">
          <div className="mono-label">Before the first send</div>
          <p className="mt-2 text-[15px] font-[600] leading-snug text-ink">{d.firstSendNote}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {noCampaigns ? (
              <Button size="sm" onClick={() => goTab("campaigns")}>
                Create a campaign
              </Button>
            ) : (
              <>
                {f.written > 0 && (
                  <Button size="sm" onClick={() => openLeads("review")}>
                    Review {plural(f.written, "email")}
                  </Button>
                )}
                {d.capacity.sending === 0 && (
                  <Button size="sm" variant="outline" onClick={() => goTab("mailboxes")}>
                    Open Mailboxes
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        {!noCampaigns && (
          <div className="grid w-full grid-cols-2 gap-x-8 gap-y-3 sm:w-auto sm:grid-cols-4">
            {stats.map(([label, n, view]) => (
              <button key={label} type="button" onClick={() => openLeads(view)} className="min-w-0 text-left text-ink transition-opacity hover:opacity-80">
                <div className="text-[1.45rem] font-[650] leading-none tracking-[-0.02em] tabular-nums">{fmt(n)}</div>
                <div className="mt-1.5 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ================================ needs you ================================ */

/** "3 emails to review" + count 3 -> "Emails to review" (the count has its own badge). */
function stripCount(title: string, count?: number) {
  if (count == null) return title;
  const p = `${count.toLocaleString()} `;
  const alt = `${count} `;
  const rest = title.startsWith(p) ? title.slice(p.length) : title.startsWith(alt) ? title.slice(alt.length) : null;
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : title;
}

function NeedsSection({ items }: { items: NeedsYou[] }) {
  return (
    <section className="db-in">
      <Head title="Needs you" aside={items.length} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((n, i) => (
          <article key={n.id} className="db-need db-in" data-tone={n.tone} style={delay(40 + i * 40)}>
            <div className="top">
              {n.count != null ? <span className="n">{n.count > 999 ? "999+" : fmt(n.count)}</span> : <span className="dot" />}
              <b>{stripCount(n.title, n.count)}</b>
            </div>
            <p>{n.body}</p>
            {n.action && (
              <button type="button" className="go" onClick={() => runAction(n.action!)}>
                {n.action.label} <Arrow />
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

/* ================================== KPIs ================================== */

type KpiDef = { key: KpiKey; label: string; kind: "count" | "rate" | "money"; upIsGood: boolean; tip: (d: Data) => string };

const KPIS: KpiDef[] = [
  { key: "sent", label: "Sent", kind: "count", upIsGood: true, tip: () => "Emails sent in the period, every step. From Instantly's daily numbers, or our own records for your own mailboxes." },
  { key: "replyRate", label: "Reply rate", kind: "rate", upIsGood: true, tip: () => "Leads who replied ÷ leads contacted. A person replying, not an auto-reply." },
  { key: "hot", label: "Hot leads", kind: "count", upIsGood: true, tip: () => "Leads that became interested, booked a meeting or were won." },
  { key: "meetings", label: "Meetings", kind: "count", upIsGood: true, tip: () => "Leads that reached Meeting or Won." },
  { key: "bounceRate", label: "Bounce rate", kind: "rate", upIsGood: false, tip: () => "Bounced ÷ leads contacted. Keep it under 2%; a mailbox pauses itself above 3%." },
  { key: "newLeads", label: "New leads", kind: "count", upIsGood: true, tip: () => "Companies the agent found in the period." },
  { key: "costPerHot", label: "Cost per hot lead", kind: "money", upIsGood: false, tip: (d) => `Running cost for the period ($${d.monthlyCost} a month) ÷ hot leads.` },
];

function deltaOf(k: Kpi, def: KpiDef): { text: string; tone: "good" | "bad" | "flat"; up?: boolean } | null {
  if (k.value == null || k.prev == null) return null;
  if (def.kind === "rate") {
    const diff = Math.round((k.value - k.prev) * 10) / 10;
    if (Math.abs(diff) < 0.1) return { text: "same", tone: "flat" };
    return { text: `${Math.abs(diff)} pts`, tone: diff > 0 === def.upIsGood ? "good" : "bad", up: diff > 0 };
  }
  if (k.prev === 0) return k.value > 0 ? { text: "new", tone: def.upIsGood ? "good" : "bad", up: true } : { text: "same", tone: "flat" };
  const pct = Math.round(((k.value - k.prev) / k.prev) * 100);
  if (pct === 0) return { text: "same", tone: "flat" };
  return { text: `${Math.abs(pct) > 999 ? "999+" : Math.abs(pct)}%`, tone: pct > 0 === def.upIsGood ? "good" : "bad", up: pct > 0 };
}

function KpiValue({ v, kind }: { v: number | null; kind: KpiDef["kind"] }) {
  if (v == null) return <>—</>;
  if (kind === "rate") return (
    <>
      {v.toLocaleString()}
      <small>%</small>
    </>
  );
  if (kind === "money") return (
    <>
      <small>$</small>
      {v.toLocaleString()}
    </>
  );
  return <>{v.toLocaleString()}</>;
}

function KpiRow({ d, onEditCost }: { d: Data; onEditCost: () => void }) {
  return (
    <section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {KPIS.map((def, i) => {
          const k = d.kpis[def.key];
          const dl = deltaOf(k, def);
          return (
            <div key={def.key} className="hb db-kpi db-in" style={delay(60 + i * 35)}>
              <div className="lbl">
                <span className="mono-label truncate">{def.label}</span>
                <i title={def.tip(d)} aria-label={def.tip(d)}>
                  ?
                </i>
                {def.key === "costPerHot" && (
                  <button type="button" className="edit" onClick={onEditCost}>
                    ${d.monthlyCost}/mo
                  </button>
                )}
              </div>
              <div className="v">
                <KpiValue v={k.value} kind={def.kind} />
              </div>
              <div className="d">
                {dl ? (
                  <span className={cn("db-delta", dl.tone)}>
                    {dl.up != null && <span aria-hidden>{dl.up ? "↑" : "↓"}</span>}
                    {dl.text}
                  </span>
                ) : (
                  <span className="db-delta flat">—</span>
                )}
                <span className="truncate">vs previous {d.range}d</span>
              </div>
              {def.key === "costPerHot" ? (
                <div className="mt-[10px] flex h-[30px] items-end text-[11px] leading-snug text-muted">{d.kpis.hot.value ? `${plural(d.kpis.hot.value, "hot lead")} in ${d.range} days` : "No hot leads yet in this period"}</div>
              ) : (
                <Spark values={k.series} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 14-day sparkline. Gaps where a rate has nothing to divide by. Stretches to the tile. */
function Spark({ values }: { values: (number | null)[] }) {
  const n = values.length;
  const nums = values.filter((v): v is number => v != null);
  const max = Math.max(0, ...nums);
  if (n < 2 || !nums.length || max === 0) {
    return (
      <svg className="db-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
        <line className="z" x1="0" y1="28" x2="100" y2="28" />
      </svg>
    );
  }
  const x = (i: number) => (i / (n - 1)) * 100;
  const y = (v: number) => 28 - (v / max) * 25;
  let line = "";
  let area = "";
  let run: [number, number][] = [];
  const flush = () => {
    if (!run.length) return;
    line += run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`).join("");
    if (run.length > 1) area += `M${run[0][0].toFixed(2)},29${run.map(([px, py]) => `L${px.toFixed(2)},${py.toFixed(2)}`).join("")}L${run[run.length - 1][0].toFixed(2)},29Z`;
    run = [];
  };
  values.forEach((v, i) => (v == null ? flush() : run.push([x(i), y(v)])));
  flush();
  return (
    <svg className="db-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <path className="a" d={area} />
      <path className="l" d={line} />
    </svg>
  );
}

/* ================================= funnel ================================= */

/** How many leads got at least as far as each step. Exits count up to where they left. */
function reach(f: Funnel) {
  const won = f.won;
  const meeting = f.meeting + won;
  const interested = f.interested + meeting;
  const replied = f.replied + interested + f.lost + f.unsubscribed;
  const sent = f.sent + replied + f.bounced;
  const approved = f.approved + f.queued + sent;
  const written = f.written + approved;
  const verified = f.verified + written;
  const contact = f.contact_found + verified;
  const researched = f.researched + contact;
  return { found: f.total, researched, contact, verified, written, approved, sent, replied, interested, meeting, won };
}

function FunnelCard({ f, wide }: { f: Funnel; wide: boolean }) {
  const r = reach(f);
  type Step = { label: string; n: number; now: number; view: string; out?: boolean };
  const pipeline: Step[] = [
    { label: "Found", n: r.found, now: f.total, view: "all" },
    { label: "Researched", n: r.researched, now: f.researched, view: "researched" },
    { label: "Contact found", n: r.contact, now: f.contact_found, view: "contact_found" },
    { label: "Verified", n: r.verified, now: f.verified, view: "verified" },
    { label: "Written", n: r.written, now: f.written, view: "review" },
    { label: "Approved", n: r.approved, now: f.approved, view: "ready" },
    { label: "Sent", n: r.sent, now: f.queued + f.sent, view: "sequence" },
  ];
  const outcomes: Step[] = [
    { label: "Replied", n: r.replied, now: f.replied + f.interested + f.meeting + f.won + f.lost, view: "replied", out: true },
    { label: "Interested", n: r.interested, now: f.interested + f.meeting + f.won, view: "hot", out: true },
    { label: "Meeting", n: r.meeting, now: f.meeting, view: "meeting", out: true },
    { label: "Won", n: r.won, now: f.won, view: "won", out: true },
  ];
  const all = [...pipeline, ...outcomes];
  const max = Math.max(1, r.found);
  // The step that loses the most, among steps with enough leads to mean something.
  let worst = -1;
  let worstRate = 2;
  all.forEach((s, i) => {
    if (i === 0 || all[i - 1].n < 5) return;
    const rate = s.n / all[i - 1].n;
    if (rate < worstRate) {
      worstRate = rate;
      worst = i;
    }
  });
  const exits: [string, number, string][] = (
    [
      ["Skipped", f.skipped + f.failed, "skipped"],
      ["Bounced", f.bounced, "bounced"],
      ["Unsubscribed", f.unsubscribed, "bounced"],
      ["Not interested", f.lost, "lost"],
    ] as [string, number, string][]
  ).filter(([, n]) => n > 0);

  const row = (s: Step, i: number) => {
    const prev = i > 0 ? all[i - 1].n : 0;
    const conv = i > 0 && prev > 0 ? Math.round((s.n / prev) * 100) : null;
    return (
      <button key={s.label} type="button" className={cn("db-fr", s.out && "out")} onClick={() => openLeads(s.view)} title={`${fmt(s.n)} got this far · ${fmt(s.now)} here now. Open them in Leads.`}>
        <span className="nm">{s.label}</span>
        <span className="bar">
          <i style={{ width: `${s.n ? Math.max(1.5, (s.n / max) * 100) : 0}%` }} />
        </span>
        <span className="ct">{fmt(s.n)}</span>
        <span className={cn("cv", i === worst && "low")} title={i === worst ? "The biggest drop-off" : undefined}>
          {conv == null ? "" : `${conv}%`}
        </span>
      </button>
    );
  };

  return (
    <>
      <Head title="Funnel" aside={`${fmt(f.total)} leads`} />
      {f.total === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted">No leads yet. The agent starts finding companies as soon as a campaign runs.</p>
      ) : (
        <div className={cn(wide && "grid gap-x-10 lg:grid-cols-2")}>
          <div className="db-fun">{pipeline.map((s, i) => row(s, i))}</div>
          <div className={cn("db-fun", !wide && "mt-0")}>
            {!wide && <div className="db-sep" />}
            {outcomes.map((s, i) => row(s, pipeline.length + i))}
            {exits.length > 0 && (
              <div className="db-exits">
                {exits.map(([label, n, view]) => (
                  <button key={label} type="button" onClick={() => openLeads(view)}>
                    {label} <b>{fmt(n)}</b>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted">Each bar counts leads that got at least that far; the percentage is from the step before. Click a bar to open those leads.</p>
    </>
  );
}

/* ================================= trend ================================= */

type SeriesKey = "sent" | "replies" | "hot" | "bounced";
const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: "sent", label: "Sent", color: "var(--acb)" },
  { key: "replies", label: "Replies", color: "var(--inf)" },
  { key: "hot", label: "Hot leads", color: "var(--wnf)" },
  { key: "bounced", label: "Bounces", color: "var(--dgf)" },
];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setW(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Axis max + step on round numbers; counts never get fractional ticks. */
function scale(max: number, ticks = 4) {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  return { max: step * ticks, step };
}

function TrendCard({ days, range }: { days: TrendDay[]; range: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [on, setOn] = useState<Record<SeriesKey, boolean>>({ sent: true, replies: true, hot: true, bounced: true });
  const [hover, setHover] = useState<number | null>(null);
  const totals = useMemo(() => {
    const t = { sent: 0, replies: 0, hot: 0, bounced: 0 };
    for (const d of days) for (const k of Object.keys(t) as SeriesKey[]) t[k] += d[k];
    return t;
  }, [days]);

  const H = 220;
  const pl = 34;
  const pr = 30;
  const pt = 10;
  const pb = 24;
  const n = days.length;
  const innerW = Math.max(10, w - pl - pr);
  const innerH = H - pt - pb;
  const band = n ? innerW / n : innerW;
  const left = scale(Math.max(0, ...days.map((d) => d.sent)));
  const lineKeys = (["replies", "hot", "bounced"] as SeriesKey[]).filter((k) => on[k]);
  const right = scale(Math.max(0, ...days.flatMap((d) => lineKeys.map((k) => d[k]))));
  const yL = (v: number) => pt + innerH - (v / left.max) * innerH;
  const yR = (v: number) => pt + innerH - (v / right.max) * innerH;
  const cx = (i: number) => pl + i * band + band / 2;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 64))));
  const ticks = Array.from({ length: 5 }, (_, i) => i);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left - pl) / band);
    setHover(i >= 0 && i < n ? i : null);
  };

  const hd = hover != null ? days[hover] : null;
  const tipLeft = hover != null ? Math.min(Math.max(0, cx(hover) - 80), Math.max(0, w - 168)) : 0;

  return (
    <>
      <Head title="Daily trend" aside={`last ${range} days`} />
      <div className="db-key mb-3">
        {SERIES.map((s) => (
          <button key={s.key} type="button" className={on[s.key] ? "" : "off"} aria-pressed={on[s.key]} onClick={() => setOn((o) => ({ ...o, [s.key]: !o[s.key] }))}>
            <span className="sw" style={{ background: s.color, borderRadius: s.key === "sent" ? 3 : 99 }} />
            {s.label} <b>{fmt(totals[s.key])}</b>
          </button>
        ))}
      </div>
      <div className="db-tr" ref={ref}>
        {w > 0 && (
          <svg height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={`Daily sent, replies, hot leads and bounces over the last ${range} days`}>
            {ticks.map((t) => {
              const y = pt + innerH - (t / 4) * innerH;
              return (
                <g key={t}>
                  <line className="gl" x1={pl} x2={w - pr} y1={y} y2={y} strokeDasharray={t === 0 ? undefined : "2 4"} />
                  {on.sent && (
                    <text className="ax" x={pl - 8} y={y + 3} textAnchor="end">
                      {fmt(left.step * t)}
                    </text>
                  )}
                  {lineKeys.length > 0 && (
                    <text className="ax" x={w - pr + 8} y={y + 3} textAnchor="start">
                      {fmt(right.step * t)}
                    </text>
                  )}
                </g>
              );
            })}
            {hover != null && <rect className="hl" x={pl + hover * band} y={pt} width={band} height={innerH} rx={3} />}
            {on.sent &&
              days.map((d, i) =>
                d.sent > 0 ? (
                  <rect key={d.day} className={cn("bs", hover === i && "on")} x={pl + i * band + band * 0.18} y={yL(d.sent)} width={Math.max(1, band * 0.64)} height={Math.max(1, pt + innerH - yL(d.sent))} rx={Math.min(3, band * 0.2)} />
                ) : null
              )}
            {lineKeys.map((k) => {
              const s = SERIES.find((x) => x.key === k)!;
              const dPath = days.map((d, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${yR(d[k]).toFixed(1)}`).join("");
              return (
                <g key={k}>
                  <path className="ln" d={dPath} stroke={s.color} />
                  {hover != null && <circle cx={cx(hover)} cy={yR(days[hover][k])} r={3.5} fill={s.color} stroke="var(--surf)" strokeWidth={2} />}
                </g>
              );
            })}
            {days.map((d, i) =>
              i % labelEvery === 0 || i === n - 1 ? (
                (i === n - 1 || n - 1 - i >= labelEvery * 0.6) && (
                  <text key={d.day} className="ax" x={cx(i)} y={H - 6} textAnchor="middle">
                    {dayLabel(d.day)}
                  </text>
                )
              ) : null
            )}
            <rect x={pl} y={pt} width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
          </svg>
        )}
        {hd && (
          <div className="db-tip" style={{ left: tipLeft }}>
            <b>{dayLabel(hd.day, "long")}</b>
            {SERIES.filter((s) => on[s.key]).map((s) => (
              <div key={s.key}>
                <span>
                  <span className="sw" style={{ background: s.color, borderRadius: s.key === "sent" ? 3 : 99 }} />
                  {s.label}
                </span>
                <strong>{fmt(hd[s.key])}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-muted">Bars: emails sent (left scale). Lines: replies, hot leads and bounces (right scale).</p>
    </>
  );
}

/* =============================== campaigns =============================== */

function CampaignsTable({ rows }: { rows: DashCampaign[] }) {
  return (
    <>
      <Head title="Campaigns" aside={rows.length}>
        <LinkBtn onClick={() => goTab("campaigns")}>All campaigns</LinkBtn>
      </Head>
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="db-tbl min-w-[820px]">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th className="r">Sent</th>
              <th className="r" title="Leads who replied ÷ leads contacted">
                Reply rate
              </th>
              <th className="r">Hot</th>
              <th className="r" title="Bounced ÷ leads contacted">
                Bounces
              </th>
              <th className="r">To review</th>
              <th title="First emails queued today, of the daily limit">Today</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} onClick={() => openCampaign(c.id)}>
                <td className="max-w-[280px]">
                  <div className="truncate font-[600]">{c.name}</div>
                  <div className="truncate text-[11.5px] text-muted">
                    {c.kind === "partner" ? "Partners" : "Customers"} · {c.engine === "own" ? "your own mailboxes" : "Instantly"}
                  </div>
                </td>
                <td>
                  <StatusChip status={c.status} />
                </td>
                <td className="r">{fmt(c.sent)}</td>
                <td className="r">{c.replyRate == null ? <span className="text-muted">—</span> : `${c.replyRate}%`}</td>
                <td className={cn("r", c.hot > 0 && "font-[650] text-good")}>{fmt(c.hot)}</td>
                <td className={cn("r", c.bounceRate != null && c.bounceRate > 3 && "font-[650] text-bad", c.bounceRate != null && c.bounceRate > 2 && c.bounceRate <= 3 && "text-warn")}>
                  {c.bounceRate == null ? <span className="text-muted">—</span> : `${c.bounceRate}%`}
                </td>
                <td className="r">
                  {c.review > 0 ? (
                    <button
                      type="button"
                      className="font-[650] text-warn hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCampaignFilter(c.id);
                        openLeads("review");
                      }}
                    >
                      {fmt(c.review)}
                    </button>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </td>
                <td className="min-w-[120px]">
                  {c.queueLimit > 0 ? (
                    <div className="flex items-center gap-2.5">
                      <span className="whitespace-nowrap text-[12px]">
                        {fmt(c.queuedToday)}
                        <span className="text-muted"> / {fmt(c.queueLimit)}</span>
                      </span>
                      <div className="db-meter w-14 shrink-0">
                        <i style={{ width: `${Math.min(100, (c.queuedToday / c.queueLimit) * 100)}%` }} />
                      </div>
                    </div>
                  ) : (
                    <span className="text-[12px] text-muted" title={c.engine === "own" ? "None of your own mailboxes is sending yet" : "No Instantly mailbox is sending yet"}>
                      no mailbox yet
                    </span>
                  )}
                </td>
                <td className="w-[1%] whitespace-nowrap">
                  {c.lastError ? (
                    <Badge className="bg-dgb text-bad">
                      <span title={c.lastError}>Problem</span>
                    </Badge>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ================================ segments ================================ */

const LOOP_TONE: Record<LoopStatus, string> = {
  scaling: "bg-okb text-good",
  working: "bg-tlb text-accent",
  testing: "bg-ink/[0.06] text-muted",
  paused: "bg-wnb text-warn",
};
const LOOP_LABEL: Record<LoopStatus, string> = { scaling: "Scaling", working: "Working", testing: "Testing", paused: "Paused" };

function SegmentsBoard({ rows, showCampaign }: { rows: DashSegment[]; showCampaign: boolean }) {
  const open = (s: DashSegment) => openSegment(s.campaignId, s.id);
  return (
    <>
      <Head title="Segments" aside={rows.length ? "most emailed first" : undefined}>
        <LinkBtn onClick={() => goTab("targeting")}>Targeting</LinkBtn>
      </Head>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted">No segments yet. Add ideal-customer segments to a campaign in Targeting.</p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="db-tbl min-w-[560px]">
            <thead>
              <tr>
                <th>Segment</th>
                <th>Status</th>
                <th className="r">Emailed</th>
                <th className="r">Reply rate</th>
                <th className="r" title="Interested, meeting or won ÷ emailed">
                  Positive
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} onClick={() => open(s)} title={s.verdict}>
                  <td className="max-w-[300px]">
                    <div className="truncate font-[600]">{s.name}</div>
                    <div className="truncate text-[11.5px] text-muted">
                      {showCampaign ? `${s.campaignName} · ` : ""}
                      {s.verdict}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge className={LOOP_TONE[s.status]}>{LOOP_LABEL[s.status]}</Badge>
                      {s.suggested && (
                        <span className="whitespace-nowrap text-[11px] font-semibold text-accent" title={s.suggested.reason}>
                          → {LOOP_LABEL[s.suggested.status as LoopStatus] || s.suggested.status}?
                        </span>
                      )}
                      {s.exhausted && <span className="text-[11px] text-muted">searched out</span>}
                    </div>
                  </td>
                  <td className="r">{fmt(s.contacted)}</td>
                  <td className="r">{s.replyRate == null ? <span className="text-muted">—</span> : `${s.replyRate}%`}</td>
                  <td className={cn("r", s.positive > 0 && "font-[650] text-good")}>{s.positiveRate == null ? <span className="text-muted">—</span> : `${s.positiveRate}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* =============================== capacity =============================== */

function StageDot({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]", n === 0 && "opacity-50")}>
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <b className="font-[650] tabular-nums">{n}</b>
      <span className="text-muted">{label}</span>
    </span>
  );
}

function CapacityCard({ d }: { d: Data }) {
  const c = d.capacity;
  const mb = c.mailboxes;
  const pct = c.dailyCapacity > 0 ? Math.min(100, (c.usedToday / c.dailyCapacity) * 100) : 0;
  const aiTotal = d.ai.callsToday + Math.max(0, d.ai.budgetLeft);
  const aiPct = aiTotal > 0 ? Math.min(100, (d.ai.callsToday / aiTotal) * 100) : 0;
  const engines: [string, typeof mb.own][] = [];
  if (mb.own.total > 0) engines.push(["Your own mailboxes", mb.own]);
  if (mb.instantly.total > 0) engines.push(["Instantly", mb.instantly]);

  return (
    <>
      <Head title="Sending capacity">
        <LinkBtn onClick={() => goTab("mailboxes")}>Mailboxes</LinkBtn>
      </Head>
      {mb.total === 0 ? (
        <div className="py-2">
          <p className="text-[13px] leading-relaxed text-muted">No mailboxes yet. Sign in your own Google Workspace or Microsoft 365 mailboxes, or connect Instantly.</p>
          <Button size="sm" className="mt-3" onClick={() => goTab("mailboxes")}>
            Add a mailbox
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[1.5rem] font-[650] leading-none tracking-[-0.02em] tabular-nums">{fmt(c.usedToday)}</span>
            <span className="text-[12.5px] text-muted">of {plural(c.dailyCapacity, "first email")} possible today</span>
          </div>
          <div className={cn("db-meter mt-2.5", pct >= 90 && "warn")}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1.5">
            <StageDot color="var(--okf)" label="sending" n={mb.sending} />
            <StageDot color="var(--inf)" label="warming" n={mb.warming} />
            {mb.ready > 0 && <StageDot color="var(--acb)" label="ready" n={mb.ready} />}
            <StageDot color="var(--wnf)" label="paused" n={mb.paused} />
            {mb.failing > 0 && <StageDot color="var(--dgf)" label="failing a check" n={mb.failing} />}
          </div>
          <div className="mt-3">
            {engines.map(([label, p]) => (
              <div key={label} className="db-kv">
                <span>{label}</span>
                <b>
                  {p.sending} of {p.total} sending · {fmt(p.dailyCapacity)}/day
                </b>
              </div>
            ))}
            {mb.nextReady && (
              <div className="db-kv">
                <span>Next ready</span>
                <b className="min-w-0 truncate" title={mb.nextReady.email}>
                  around {dayLabel(mb.nextReady.day)} <span className="font-normal text-muted">· {mb.nextReady.email}</span>
                </b>
              </div>
            )}
          </div>
        </>
      )}

      <div className="db-sep !my-4" />
      <Head title="AI today">
        <LinkBtn onClick={() => goTab("agent")}>Agent</LinkBtn>
      </Head>
      {!d.ai.configured ? (
        <p className="text-[13px] leading-relaxed text-warn">No AI key yet, so nothing is researched in depth, scored or written.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[1.5rem] font-[650] leading-none tracking-[-0.02em] tabular-nums">{fmt(d.ai.callsToday)}</span>
            <span className="text-[12.5px] text-muted">calls · {fmt(Math.max(0, d.ai.budgetLeft))} left in today's budget</span>
          </div>
          <div className={cn("db-meter mt-2.5", aiPct >= 90 && "warn")}>
            <i style={{ width: `${aiPct}%` }} />
          </div>
          <div className="mt-2.5 text-[12px] text-muted">{d.ai.canSearch ? "Gemini search is on: campaigns find companies and people with it." : "No Gemini search: discovery falls back to the free web search."}</div>
        </>
      )}
    </>
  );
}

/* ================================ activity ================================ */

function ActivityCard({ events }: { events: Data["events"] }) {
  const tone: Record<string, string> = { success: "bg-good", warn: "bg-warn", error: "bg-bad", info: "bg-ink/30" };
  return (
    <>
      <Head title="Activity" aside={events.length ? "latest" : undefined} />
      {events.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted">Nothing yet. Everything the agent does is written here in plain words.</p>
      ) : (
        <div className="-mx-1 max-h-[420px] divide-y divide-line-soft overflow-y-auto px-1">
          {events.map((e) => (
            <div key={e.id} className="flex gap-2.5 py-2">
              <span className={cn("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", tone[e.level] || tone.info)} />
              <div className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-snug text-ink-soft">{e.message}</div>
              <div className="shrink-0 whitespace-nowrap text-[11.5px] text-muted">{ago(e.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ============================== cost dialog ============================== */

function CostDialog({ open, current, onClose, onSaved }: { open: boolean; current: number; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(String(current));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setV(String(current));
  }, [open, current]);
  async function save() {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return toast("Enter a monthly amount in dollars", "error");
    setBusy(true);
    try {
      await dashboardApi.setMonthlyCost(n);
      toast("Saved. Cost per hot lead uses the new amount.", "success");
      onSaved();
      onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Monthly running cost">
      <p className="text-[13px] leading-relaxed text-muted">What the whole setup costs a month: mailboxes and domains, Instantly, AI and verifier credits, hosting. Cost per hot lead = this amount for the period ÷ hot leads.</p>
      <div className="relative mt-4">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13.5px] text-muted">$</span>
        <Input type="number" min={0} step={1} inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} className="pl-7" aria-label="Monthly cost in dollars" autoFocus />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={save} loading={busy}>
          Save
        </Button>
      </div>
    </Modal>
  );
}
