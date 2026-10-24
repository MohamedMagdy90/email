// Mailboxes — the sending pool in Instantly: warmup health, the readiness gate,
// the daily ramp and auto-pause. Works before Instantly is connected (setup
// steps + an example pool run through the real rules).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, cn, toast } from "../lib/ui";
import { ago, v2, type AgentEvent } from "../lib/v2/core";
import {
  VENDOR_LABEL,
  fmtDay,
  mailboxesApi,
  rampSteps,
  type Check,
  type Dns,
  type HealthDay,
  type Mailbox,
  type MailboxDetail,
  type MailboxPolicy,
  type PoolResponse,
  type Stage,
} from "../lib/v2/mailboxes";

/* ------------------------------- vocabulary ------------------------------- */

const STAGE_LABEL: Record<Stage, string> = {
  warming: "Warming",
  ready: "Ready",
  ramping: "Ramping",
  active: "Active",
  paused: "Paused",
};
const STAGE_PILL: Record<Stage, string> = {
  warming: "bg-inb text-inf",
  ready: "bg-wnb text-warn",
  ramping: "bg-tlb text-accent",
  active: "bg-okb text-good",
  paused: "bg-dgb text-bad",
};
const STAGE_DOT: Record<Stage, string> = {
  warming: "bg-inf",
  ready: "bg-warn",
  ramping: "bg-accent",
  active: "bg-good",
  paused: "bg-bad",
};
const STAGE_HINT: Record<Stage, string> = {
  warming: "Warmup running, not sending yet",
  ready: "Passed every check, waiting for you",
  ramping: "Sending, limit climbing each day",
  active: "Sending at the full daily limit",
  paused: "Stopped until you resume it",
};

const DEFAULT_POLICY: MailboxPolicy = {
  minWarmDays: 14,
  minWarmDaysPreWarmed: 7,
  minInboxRate: 95,
  minWarmupSample: 20,
  pauseInboxRate: 90,
  maxBounceRate: 3,
  minSendsForBounce: 50,
  rampStart: 10,
  rampStep: 3,
  targetLimit: 30,
  autoStart: true,
  keepWarmupOn: true,
};

const Label = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("text-[11px] font-semibold uppercase tracking-[0.09em] text-muted", className)}>{children}</div>
);

function StagePill({ stage }: { stage: Stage }) {
  return <Badge className={STAGE_PILL[stage]}>{STAGE_LABEL[stage]}</Badge>;
}

function rateTone(rate: number | null, p: MailboxPolicy) {
  if (rate == null) return "text-muted";
  if (rate >= p.minInboxRate) return "text-good";
  if (rate >= p.pauseInboxRate) return "text-warn";
  return "text-bad";
}

/* ---------------------------------- screen --------------------------------- */

export default function Mailboxes() {
  const [data, setData] = useState<PoolResponse | null>(null);
  const [mode, setMode] = useState<"live" | "example">("live");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState<Stage | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const d = mode === "example" ? await mailboxesApi.example() : await mailboxesApi.list();
        setData(d);
        setLoadError("");
        if (mode === "example") setEvents(d.events || []);
        else if (d.connected) setEvents((await v2.events({ kind: "mailbox", limit: 40 })).events);
      } catch (e: any) {
        setLoadError(e.message || "Couldn't load mailboxes.");
      } finally {
        setLoading(false);
      }
    },
    [mode]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Pick up the background sync (every 30 min) without a reload.
  useEffect(() => {
    if (mode !== "live" || !data?.connected) return;
    const t = setInterval(() => !document.hidden && load(true), 60_000);
    return () => clearInterval(t);
  }, [mode, data?.connected, load]);

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await mailboxesApi.sync();
      setData(r.view);
      setEvents((await v2.events({ kind: "mailbox", limit: 40 })).events);
      if (r.result.errors.length) toast(`Synced ${r.result.synced}, with a problem: ${r.result.errors[0]}`, "error");
      else toast(`Synced ${r.result.synced} mailbox${r.result.synced === 1 ? "" : "es"} from Instantly.`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSyncing(false);
    }
  }

  const example = mode === "example";
  const policy = data?.policy || DEFAULT_POLICY;

  const header = (
    <PageHeader
      title="Mailboxes"
      subtitle="Your sending mailboxes in Instantly: warmup health, readiness checks and the daily ramp. Nothing sends until a mailbox has earned it."
      actions={
        data && (
          <>
            {example ? (
              <Badge className="bg-wnb text-warn">Example data</Badge>
            ) : data.connected ? (
              <SyncPill data={data} syncing={syncing} />
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setRulesOpen(true)}>
              Rules
            </Button>
            {!example && data.connected && (
              <Button size="sm" onClick={syncNow} loading={syncing}>
                Sync now
              </Button>
            )}
          </>
        )
      }
    />
  );

  if (loading && !data) {
    return (
      <div>
        {header}
        <div className="flex items-center gap-2 py-20 text-muted">
          <Spinner /> Loading mailboxes…
        </div>
      </div>
    );
  }

  if (loadError && !data) {
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

  if (!data) return null;

  const showSetup = !example && !data.connected;
  const visible = data.mailboxes.filter((m) => filter === "all" || (filter === m.stage && !m.missing) || (filter === "paused" && m.missing));
  const detail = example && openId ? data.details?.[openId] || null : null;

  return (
    <div>
      {header}

      {showSetup ? (
        <Setup policy={policy} onPreview={() => setMode("example")} onRules={() => setRulesOpen(true)} onConnected={(v) => setData(v)} />
      ) : (
        <>
          {example && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-keepl bg-keep1 px-4 py-3">
              <p className="max-w-[760px] text-[13px] leading-relaxed text-ink-soft">
                <span className="font-semibold text-accent">Example data.</span> These six mailboxes are made up, but every stage,
                check and limit below comes from the same rules your real mailboxes will follow. Change the Rules to see how they
                move.
              </p>
              <Button variant="outline" size="sm" onClick={() => setMode("live")}>
                Back to setup
              </Button>
            </div>
          )}
          {!example && data.lastSync && !data.lastSync.ok && (
            <div className="mb-5 rounded-xl border border-wnl bg-wnb px-4 py-3 text-[13px] leading-relaxed text-warn">
              <span className="font-semibold">Last sync {ago(data.lastSync.at)} had a problem:</span> {data.lastSync.errors[0]}
            </div>
          )}

          {data.mailboxes.length === 0 ? (
            <EmptyPool onSync={syncNow} syncing={syncing} />
          ) : (
            <>
              <SummaryTiles data={data} />
              <StageRail data={data} value={filter} onChange={setFilter} />
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0 space-y-4">
                  {data.domains
                    .map((d) => ({ d, list: visible.filter((m) => m.domain === d.domain) }))
                    .filter((g) => g.list.length > 0)
                    .map(({ d, list }) => (
                      <DomainGroup key={d.domain} dns={d.dns} domain={d.domain} vendors={d.vendors} total={d.count} mailboxes={list} policy={policy} onOpen={setOpenId} />
                    ))}
                  {visible.length === 0 && (
                    <div className="rounded-xl border border-dashed border-line px-5 py-12 text-center text-sm text-muted">
                      No {filter === "all" ? "" : STAGE_LABEL[filter as Stage].toLowerCase()} mailboxes right now.
                    </div>
                  )}
                </div>
                <div className="space-y-4">
                  <RulesGlance policy={policy} onEdit={() => setRulesOpen(true)} />
                  <ActivityFeed events={events} onOpen={(id) => data.mailboxes.some((m) => m.id === id) && setOpenId(id)} />
                </div>
              </div>
            </>
          )}
        </>
      )}

      {openId && (
        <DetailModal
          id={openId}
          example={example}
          exampleDetail={detail}
          policy={policy}
          onClose={() => setOpenId(null)}
          onChanged={() => load(true)}
        />
      )}
      <RulesModal
        open={rulesOpen}
        policy={policy}
        poolSize={data.summary.total || 6}
        onClose={() => setRulesOpen(false)}
        onSaved={() => {
          setRulesOpen(false);
          load(true);
        }}
      />
    </div>
  );
}

/* --------------------------------- header --------------------------------- */

function SyncPill({ data, syncing }: { data: PoolResponse; syncing: boolean }) {
  if (syncing || data.syncing) return <span className="livep open"><i />Syncing…</span>;
  if (!data.lastSync) return <span className="livep"><i />Not synced yet</span>;
  return (
    <span className={cn("livep", data.lastSync.ok && "open")} title={data.lastSync.errors[0] || "Synced without problems"}>
      <i />
      Synced {ago(data.lastSync.at)}
    </span>
  );
}

/* ---------------------------------- setup ---------------------------------- */

function Setup({
  policy,
  onPreview,
  onRules,
  onConnected,
}: {
  policy: MailboxPolicy;
  onPreview: () => void;
  onRules: () => void;
  onConnected: (v: PoolResponse) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    const k = key.trim();
    if (!k) return;
    setBusy(true);
    setError("");
    try {
      await v2.saveIntegrations({ instantlyKey: k });
      const t = await v2.testIntegration("instantly");
      if (!t.ok) {
        await v2.saveIntegrations({ instantlyKey: "" });
        setError(t.error || "Instantly didn't accept that key.");
        return;
      }
      const r = await mailboxesApi.sync();
      setKey("");
      toast(`Instantly connected. Found ${r.result.synced} mailbox${r.result.synced === 1 ? "" : "es"}.`, "success");
      onConnected(r.view);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const steps: { n: string; title: string; body: ReactNode; extra?: ReactNode }[] = [
    {
      n: "1",
      title: "Buy 2–3 spare domains and 6 mailboxes",
      body: (
        <>
          Pre-warmed Google or Microsoft mailboxes from Zapmail and Mailforge, about $3–4 each a month. Never use{" "}
          <span className="font-medium text-ink">dna.systems</span>, or a domain you already send from with Resend.
        </>
      ),
    },
    {
      n: "2",
      title: "Add them to Instantly and switch warmup on",
      body: "Both vendors can export mailboxes straight into Instantly (Growth plan, $37 a month). Leave warmup on for good. If it is ever switched off, this tab turns it back on.",
    },
    {
      n: "3",
      title: "Connect Instantly",
      body: (
        <>
          In Instantly: Settings → Integrations → API keys. Create a key with the <span className="font-medium text-ink">all:all</span> scope
          and paste it here. Mailboxes then sync every 30 minutes.
        </>
      ),
      extra: (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <Input
            type="password"
            name="instantly-key"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            placeholder="Instantly API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="sm:flex-1"
            aria-label="Instantly API key"
          />
          <Button type="submit" loading={busy} disabled={!key.trim()}>
            Connect
          </Button>
        </form>
      ),
    },
  ];

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <Card className="p-5 sm:p-6">
        <Label>Get the pool running</Label>
        <h2 className="mt-1.5 text-[1.05rem] font-[650] tracking-[-0.01em]">Three steps, then this tab takes over</h2>
        <ol className="mt-5">
          {steps.map((s, i) => (
            <li key={s.n} className="relative flex gap-4 pb-6 last:pb-0">
              {i < steps.length - 1 && <span className="absolute left-[13px] top-8 bottom-1 w-px bg-line" aria-hidden />}
              <span className="grid h-[27px] w-[27px] shrink-0 place-items-center rounded-full border border-line-strong bg-sunk text-[12px] font-bold tabular-nums text-ink-soft">
                {s.n}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="text-[14px] font-semibold">{s.title}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{s.body}</p>
                {s.extra}
                {s.n === "3" && error && <p className="mt-2 text-[12.5px] leading-relaxed text-bad">{error}</p>}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="p-5 sm:p-6">
        <Label>How a mailbox earns the right to send</Label>
        <Lifecycle policy={policy} />
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line-soft pt-4">
          <Button variant="outline" size="sm" onClick={onPreview}>
            Preview with example mailboxes
          </Button>
          <Button variant="ghost" size="sm" onClick={onRules}>
            Edit the rules
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Lifecycle({ policy: p }: { policy: MailboxPolicy }) {
  const steps = rampSteps(p.rampStart, p.rampStep, p.targetLimit);
  const rows: { stage: Stage; title: string; body: ReactNode }[] = [
    { stage: "warming", title: "Warming", body: "Instantly's warmup network sends and answers mail for it. Checked every 30 minutes." },
    {
      stage: "ready",
      title: "Passes the gate",
      body: (
        <ul className="mt-1.5 space-y-1">
          {[
            "Connected in Instantly, no errors",
            "Warmup on",
            "MX, SPF, DKIM and DMARC found",
            `${p.minWarmDays} days warming (${p.minWarmDaysPreWarmed} if pre-warmed)`,
            `${p.minInboxRate}%+ of warmup mail in the inbox, last 7 days`,
          ].map((t) => (
            <li key={t} className="flex items-start gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-good" />
              {t}
            </li>
          ))}
        </ul>
      ),
    },
    {
      stage: "ramping",
      title: "Ramps up",
      body: (
        <>
          {p.rampStart} a day, then {p.rampStep} more each day.
          <RampStairs steps={steps} doneThrough={steps.length - 1} className="mt-2 h-9 max-w-[320px]" />
        </>
      ),
    },
    {
      stage: "active",
      title: "Full limit",
      body: `${p.targetLimit} a day per mailbox, reached after ${steps.length} days. 6 mailboxes ≈ ${(6 * p.targetLimit).toLocaleString()} emails a day.`,
    },
    {
      stage: "paused",
      title: "Pauses itself",
      body: `If the inbox rate drops below ${p.pauseInboxRate}%, bounces pass ${p.maxBounceRate}%, or Instantly reports an error. Resuming sends it back through the gate.`,
    },
  ];
  return (
    <ol className="mt-4">
      {rows.map((r, i) => (
        <li key={r.stage} className="relative flex gap-3.5 pb-4 last:pb-0">
          {i < rows.length - 1 && <span className="absolute left-[5px] top-5 bottom-0 w-px bg-line" aria-hidden />}
          <span className={cn("mt-[5px] h-[11px] w-[11px] shrink-0 rounded-full ring-4 ring-paper", STAGE_DOT[r.stage])} />
          <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
            <div className="text-[13.5px] font-semibold text-ink">{r.title}</div>
            {r.body}
          </div>
        </li>
      ))}
    </ol>
  );
}

function EmptyPool({ onSync, syncing }: { onSync: () => void; syncing: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-14 text-center">
      <h3 className="text-[15px] font-[650]">No mailboxes in Instantly yet</h3>
      <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-relaxed text-muted">
        Export the mailboxes from Zapmail and Mailforge into Instantly. They appear here on the next sync, which runs every 30
        minutes on its own.
      </p>
      <Button className="mt-5" size="sm" onClick={onSync} loading={syncing}>
        Sync now
      </Button>
    </div>
  );
}

/* --------------------------------- summary --------------------------------- */

function SummaryTiles({ data }: { data: PoolResponse }) {
  const s = data.summary;
  const p = data.policy;
  const tiles: { label: string; value: ReactNode; sub: ReactNode; keep?: boolean; tone?: string }[] = [
    {
      label: "Can send today",
      value: s.capacityToday.toLocaleString(),
      sub: `of ${s.capacityFull.toLocaleString()} a day at full speed · ${s.sentToday.toLocaleString()} sent so far`,
      keep: true,
    },
    {
      label: "Sending",
      value: (
        <>
          {s.sendable}
          <span className="text-[1rem] font-semibold text-muted"> / {s.total}</span>
        </>
      ),
      sub: `${s.byStage.ramping} ramping · ${s.byStage.active} at full limit`,
    },
    {
      label: "Warmup inbox rate",
      value: s.inboxRate7 == null ? "—" : `${s.inboxRate7}%`,
      sub: s.warmupVolume7 ? `last 7 days · ${s.warmupVolume7.toLocaleString()} warmup emails` : "no warmup data yet",
      tone: rateTone(s.inboxRate7, p),
    },
    s.attention > 0
      ? {
          label: "Needs attention",
          value: s.attention,
          sub: "paused, or failing a check",
          tone: "text-bad",
        }
      : {
          label: "Next ready",
          value: s.nextReady ? fmtDay(s.nextReady.day) : "—",
          sub: s.nextReady ? s.nextReady.email : "nothing waiting on the gate",
        },
  ];
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className={t.keep ? "hb keep" : "hb"}>
          <div className="mono-label mb-2">{t.label}</div>
          <div className={cn("text-[1.62rem] font-bold leading-none tracking-[-0.02em] tabular-nums", t.tone)}>{t.value}</div>
          <div className="mt-2 truncate text-[12px] text-muted" title={typeof t.sub === "string" ? t.sub : undefined}>
            {t.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

function StageRail({ data, value, onChange }: { data: PoolResponse; value: Stage | "all"; onChange: (s: Stage | "all") => void }) {
  const counts = data.summary.byStage;
  const missing = data.mailboxes.filter((m) => m.missing).length;
  const quiet = "bg-hov text-ink ring-1 ring-inset ring-line-strong";
  const btn = "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold transition-colors";
  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0 text-ink/25" aria-hidden>
      <path d="M3 1.5L6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const stageBtn = (s: Stage) => {
    const n = counts[s] + (s === "paused" ? missing : 0);
    return (
      <button
        key={s}
        type="button"
        title={STAGE_HINT[s]}
        onClick={() => onChange(value === s ? "all" : s)}
        className={cn(btn, value === s ? quiet : "text-ink/70 hover:bg-hov hover:text-ink", n === 0 && value !== s && "opacity-55")}
      >
        <span className={cn("h-2 w-2 rounded-full", STAGE_DOT[s])} />
        {STAGE_LABEL[s]}
        <span className="tabular-nums text-muted">{n}</span>
      </button>
    );
  };
  return (
    <div className="mb-4 flex items-center gap-1 overflow-x-auto pb-1 [scrollbar-width:none]" role="toolbar" aria-label="Filter by stage">
      <button type="button" onClick={() => onChange("all")} className={cn(btn, value === "all" ? quiet : "text-ink/70 hover:bg-hov hover:text-ink")}>
        All <span className="tabular-nums text-muted">{data.mailboxes.length}</span>
      </button>
      <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden />
      {stageBtn("warming")}
      {chevron}
      {stageBtn("ready")}
      {chevron}
      {stageBtn("ramping")}
      {chevron}
      {stageBtn("active")}
      <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden />
      {stageBtn("paused")}
    </div>
  );
}

/* ------------------------------- domain group ------------------------------ */

function DnsChips({ dns }: { dns: Dns | null }) {
  const keys = ["mx", "spf", "dkim", "dmarc"] as const;
  const unsure = new Set((dns?.indeterminate || []).map((s) => s.toLowerCase()));
  return (
    <div className="flex flex-wrap items-center gap-1">
      {keys.map((k) => {
        const tone = !dns ? "bg-ink/[0.06] text-muted" : dns[k] ? "bg-okb text-good" : unsure.has(k) ? "bg-wnb text-warn" : "bg-dgb text-bad";
        const what = !dns ? "not checked yet" : dns[k] ? "found" : unsure.has(k) ? "lookup timed out" : "missing";
        return (
          <Badge key={k} className={tone}>
            <span title={`${k.toUpperCase()} record ${what}`}>{k}</span>
          </Badge>
        );
      })}
    </div>
  );
}

function DomainGroup({
  domain,
  vendors,
  total,
  dns,
  mailboxes,
  policy,
  onOpen,
}: {
  domain: string;
  vendors: string[];
  total: number;
  dns: Dns | null;
  mailboxes: Mailbox[];
  policy: MailboxPolicy;
  onOpen: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line-soft px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-[650] tracking-[-0.01em]">{domain}</span>
          {vendors.map((v) => (
            <Badge key={v} className="bg-ink/[0.06] text-ink-soft">
              {VENDOR_LABEL[v] || v}
            </Badge>
          ))}
          <span className="text-[12px] text-muted">
            {total} mailbox{total === 1 ? "" : "es"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <DnsChips dns={dns} />
          <span className="hidden text-[11.5px] text-muted sm:inline">{dns ? `checked ${ago(dns.checkedAt)}` : "DNS not checked"}</span>
        </div>
      </div>
      <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1.6fr)_92px_116px_150px_14px] gap-4 border-b border-line-soft px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted md:grid">
        <span>Mailbox</span>
        <span>Stage</span>
        <span>Checks</span>
        <span>Inbox rate</span>
        <span>Daily limit</span>
        <span />
      </div>
      <ul>
        {mailboxes.map((m) => (
          <li key={m.id} className="border-b border-line-soft last:border-b-0">
            <MailboxRow m={m} policy={policy} onOpen={() => onOpen(m.id)} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MailboxRow({ m, policy, onOpen }: { m: Mailbox; policy: MailboxPolicy; onOpen: () => void }) {
  const stage = m.missing ? "paused" : m.stage;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-1 gap-3 px-4 py-3.5 text-left transition-colors hover:bg-hov md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.6fr)_92px_116px_150px_14px] md:items-center md:gap-4"
    >
      <div className="flex min-w-0 items-start justify-between gap-3 md:block">
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold">{m.email}</div>
          <div className="mt-0.5 truncate text-[12px] text-muted">
            {[m.name, m.provider, m.preWarmed ? "pre-warmed" : null].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="md:hidden">
          <StagePill stage={stage} />
        </span>
      </div>
      <div className="min-w-0">
        <span className="hidden md:inline-flex">
          <StagePill stage={stage} />
        </span>
        <p className="line-clamp-2 text-[12.5px] leading-snug text-muted md:mt-1">{m.reason}</p>
      </div>
      <div className="flex items-center gap-3 md:block">
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted md:hidden">Checks</span>
        <CheckDots checks={m.checks} />
      </div>
      <div className="flex items-center gap-3 md:block">
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted md:hidden">Inbox</span>
        <div className="flex items-center gap-2.5">
          <span className={cn("w-[46px] text-[13px] font-semibold tabular-nums", rateTone(m.metrics.inboxRate7, policy))}>
            {m.metrics.inboxRate7 == null ? "—" : `${m.metrics.inboxRate7}%`}
          </span>
          <Spark values={m.spark} policy={policy} />
        </div>
      </div>
      <LimitMeter m={m} />
      <svg width="8" height="12" viewBox="0 0 8 12" className="hidden text-ink/30 md:block" aria-hidden>
        <path d="M1.5 1.5L6 6l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function CheckDots({ checks }: { checks: Check[] }) {
  return (
    <div className="flex items-center gap-[5px]" role="img" aria-label={checks.map((c) => `${c.label}: ${c.state}`).join(", ")}>
      {checks.map((c) => (
        <span
          key={c.key}
          title={`${c.label}: ${c.detail}`}
          className={cn(
            "h-[9px] w-[9px] rounded-full",
            c.state === "pass" && "bg-good",
            c.state === "fail" && "bg-bad",
            c.state === "pending" && "ring-[1.5px] ring-inset ring-line-strong"
          )}
        />
      ))}
    </div>
  );
}

function Spark({ values, policy }: { values: (number | null)[]; policy: MailboxPolicy }) {
  const floor = 80;
  return (
    <svg width="56" height="20" viewBox="0 0 56 20" className="shrink-0" aria-hidden>
      {values.map((v, i) => {
        const x = i * 4;
        if (v == null) return <rect key={i} x={x} y={18} width={2.6} height={1.4} rx={0.6} className="fill-line" />;
        const h = 3 + (Math.max(0, Math.min(100, v) - floor) / (100 - floor)) * 16;
        const tone = v >= policy.minInboxRate ? "fill-accent" : v >= policy.pauseInboxRate ? "fill-warn" : "fill-bad";
        return <rect key={i} x={x} y={19.5 - h} width={2.6} height={h} rx={0.6} className={tone} />;
      })}
    </svg>
  );
}

function LimitMeter({ m }: { m: Mailbox }) {
  const sending = m.stage === "ramping" || m.stage === "active";
  const pct = m.targetLimit ? Math.min(100, (m.dailyLimit / m.targetLimit) * 100) : 0;
  const sub = m.missing
    ? "not in Instantly"
    : m.stage === "ramping"
      ? `day ${m.rampDay} · full on ${fmtDay(m.fullRampOn)}`
      : m.stage === "active"
        ? `${m.sentToday} sent today`
        : m.stage === "ready"
          ? `starts at ${m.rampStart}`
          : m.stage === "paused"
            ? "not sending"
            : m.metrics.readyEta
              ? `earliest ${fmtDay(m.metrics.readyEta)}`
              : "not sending yet";
  return (
    <div className="flex items-center gap-3 md:block">
      <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted md:hidden">Limit</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] tabular-nums">
          <span className={cn("font-semibold", !sending && "text-muted")}>{sending ? m.dailyLimit : 0}</span>
          <span className="text-muted"> / {m.targetLimit} a day</span>
        </div>
        <div className="mt-1.5 h-[5px] w-full max-w-[150px] overflow-hidden rounded-full bg-ink/[0.07]">
          <div className={cn("h-full rounded-full", m.stage === "active" ? "bg-good" : "bg-accent")} style={{ width: `${sending ? pct : 0}%` }} />
        </div>
        <div className="mt-1 truncate text-[11.5px] text-muted">{sub}</div>
      </div>
    </div>
  );
}

/* ------------------------------ sidebar cards ------------------------------ */

function RulesGlance({ policy: p, onEdit }: { policy: MailboxPolicy; onEdit: () => void }) {
  const rows: [string, string][] = [
    ["Gate", `${p.minWarmDays} days (${p.minWarmDaysPreWarmed} pre-warmed) · ${p.minInboxRate}% inbox · DNS`],
    ["Ramp", `${p.rampStart} → +${p.rampStep} a day → ${p.targetLimit}${p.autoStart ? "" : " · manual start"}`],
    ["Pause", `inbox < ${p.pauseInboxRate}% · bounces > ${p.maxBounceRate}%`],
  ];
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <Label>Rules</Label>
        <button type="button" onClick={onEdit} className="text-[12px] font-semibold text-accent hover:underline">
          Edit
        </button>
      </div>
      <dl className="mt-3 space-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[52px_minmax(0,1fr)] gap-2 text-[12.5px] leading-snug">
            <dt className="text-muted">{k}</dt>
            <dd className="text-ink-soft">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

const LEVEL_DOT: Record<string, string> = { info: "bg-inf", success: "bg-good", warn: "bg-warn", error: "bg-bad" };

function ActivityFeed({ events, onOpen }: { events: AgentEvent[]; onOpen?: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const list = all ? events : events.slice(0, 10);
  return (
    <Card className="p-4">
      <Label>Activity</Label>
      {events.length === 0 ? (
        <p className="mt-3 text-[12.5px] text-muted">Nothing yet. Stage changes, ramps and pauses show up here.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {list.map((e) => (
            <li key={e.id} className="flex gap-2.5">
              <span className={cn("mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full", LEVEL_DOT[e.level] || "bg-muted")} />
              <div className="min-w-0 flex-1">
                {onOpen && e.ref_type === "mailbox" && e.ref_id ? (
                  <button type="button" onClick={() => onOpen(e.ref_id as string)} className="text-left text-[12.5px] leading-snug text-ink-soft hover:text-ink">
                    {e.message}
                  </button>
                ) : (
                  <p className="text-[12.5px] leading-snug text-ink-soft">{e.message}</p>
                )}
                <div className="mt-0.5 text-[11px] text-muted">{ago(e.created_at)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {events.length > 10 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-3 text-[12px] font-semibold text-accent hover:underline">
          {all ? "Show less" : `Show all ${events.length}`}
        </button>
      )}
    </Card>
  );
}

/* --------------------------------- charts ---------------------------------- */

function RampStairs({ steps, doneThrough, className }: { steps: number[]; doneThrough: number; className?: string }) {
  const max = Math.max(...steps, 1);
  const n = steps.length;
  const gap = 2;
  const w = 100 / n;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className={cn("w-full", className)} aria-hidden>
      {steps.map((v, i) => {
        const h = Math.max(3, (v / max) * 38);
        const tone = i < doneThrough ? "fill-accent" : i === doneThrough ? "fill-accent" : "fill-line";
        return <rect key={i} x={i * w + gap / 2} y={40 - h} width={Math.max(0.5, w - gap)} height={h} rx={0.8} className={cn(tone, i === doneThrough && "opacity-100", i < doneThrough && "opacity-55")} />;
      })}
    </svg>
  );
}

function HealthChart({ health, target }: { health: HealthDay[]; target: number }) {
  // Fill the last 30 days, oldest first.
  const end = health.length ? health[health.length - 1].day : new Date().toISOString().slice(0, 10);
  const byDay = new Map(health.map((h) => [h.day, h]));
  const days: { day: string; h: HealthDay | undefined }[] = [];
  const endT = Date.parse(`${end}T00:00:00Z`);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(endT - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: d, h: byDay.get(d) });
  }
  const maxWarm = Math.max(10, ...days.map((d) => (d.h ? d.h.warmup_inbox + d.h.warmup_spam : 0)));
  const maxSent = Math.max(target, 10, ...days.map((d) => d.h?.campaign_sent || 0));
  const W = 10;
  const anySends = days.some((d) => (d.h?.campaign_sent || 0) > 0);
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-accent" />Warmup in inbox</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-bad" />Warmup in spam</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-inf" />Campaign sends</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-warn" />Bounced</span>
      </div>
      <svg viewBox={`0 0 ${30 * W} 132`} preserveAspectRatio="none" className="h-[132px] w-full" role="img" aria-label="Warmup placement and campaign sends, last 30 days">
        <line x1="0" x2={30 * W} y1="70.5" y2="70.5" className="stroke-line-soft" strokeWidth="1" />
        {days.map(({ day, h }, i) => {
          const x = i * W + 1.5;
          const bw = W - 3;
          const inbox = h?.warmup_inbox || 0;
          const spam = h?.warmup_spam || 0;
          const hi = (inbox / maxWarm) * 64;
          const hs = (spam / maxWarm) * 64;
          const sent = h?.campaign_sent || 0;
          const bounced = h?.bounced || 0;
          const hSent = (sent / maxSent) * 56;
          const hB = Math.min(hSent, (bounced / maxSent) * 56 + (bounced > 0 ? 1.5 : 0));
          const tip = `${fmtDay(day)}: ${inbox} inbox, ${spam} spam${sent ? ` · ${sent} sent, ${bounced} bounced` : ""}`;
          return (
            <g key={day}>
              <title>{tip}</title>
              <rect x={i * W} y={0} width={W} height={132} fill="transparent" />
              {inbox + spam === 0 ? (
                <rect x={x} y={68} width={bw} height={1.2} className="fill-line" />
              ) : (
                <>
                  <rect x={x} y={69 - hi} width={bw} height={hi} rx={1} className="fill-accent" />
                  {hs > 0 && <rect x={x} y={69 - hi - hs} width={bw} height={hs} rx={1} className="fill-bad" />}
                </>
              )}
              {sent > 0 && <rect x={x} y={74} width={bw} height={hSent} rx={1} className="fill-inf" />}
              {bounced > 0 && <rect x={x} y={74 + hSent - hB} width={bw} height={hB} rx={1} className="fill-warn" />}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted">
        <span>{fmtDay(days[0].day)}</span>
        {!anySends && <span>No campaign sends yet</span>}
        <span>{fmtDay(days[days.length - 1].day)}</span>
      </div>
    </div>
  );
}

/* ------------------------------- detail modal ------------------------------ */

function DetailModal({
  id,
  example,
  exampleDetail,
  policy,
  onClose,
  onChanged,
}: {
  id: string;
  example: boolean;
  exampleDetail: MailboxDetail | null;
  policy: MailboxPolicy;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<MailboxDetail | null>(exampleDetail);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (example) {
      setDetail(exampleDetail);
      return;
    }
    let alive = true;
    mailboxesApi
      .detail(id)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id, example, exampleDetail]);

  async function act(name: string, fn: () => Promise<{ warning: string | null; detail: MailboxDetail }>, done: string) {
    if (example) return toast("This is example data. Actions are off in the preview.");
    setBusy(name);
    try {
      const r = await fn();
      setDetail(r.detail);
      toast(r.warning ? `${done} Instantly said: ${r.warning}` : done, r.warning ? "error" : "success");
      onChanged();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  const m = detail?.mailbox;
  return (
    <Modal open onClose={onClose} title={m?.email || "Mailbox"} wide>
      {!m ? (
        error ? (
          <p className="py-8 text-center text-sm text-bad">{error}</p>
        ) : (
          <div className="flex items-center gap-2 py-10 text-muted">
            <Spinner /> Loading…
          </div>
        )
      ) : (
        <div className="space-y-5">
          <div className="-mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
            <StagePill stage={m.missing ? "paused" : m.stage} />
            <span>{[m.name, m.provider, VENDOR_LABEL[m.vendor] || m.vendor, m.preWarmed ? "pre-warmed" : null].filter(Boolean).join(" · ")}</span>
            {example && <Badge className="bg-wnb text-warn">Example</Badge>}
          </div>

          <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3", m.stage === "paused" || m.missing ? "border-dgl bg-dgb" : "border-line-soft bg-surf2")}>
            <p className={cn("max-w-[560px] text-[13px] leading-relaxed", m.stage === "paused" || m.missing ? "text-bad" : "text-ink-soft")}>{m.reason}</p>
            <div className="flex flex-wrap gap-2">
              {m.stage === "ready" && (
                <Button size="sm" loading={busy === "start"} onClick={() => act("start", () => mailboxesApi.start(m.id), "Sending started.")}>
                  Start sending
                </Button>
              )}
              {m.stage === "paused" && !m.missing && (
                <Button size="sm" loading={busy === "resume"} onClick={() => act("resume", () => mailboxesApi.resume(m.id), "Resumed. Back through the checks.")}>
                  Resume
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <Label className="mb-2.5">Readiness checks</Label>
              <ul className="space-y-2.5">
                {m.checks.map((c) => (
                  <li key={c.key} className="flex gap-2.5">
                    <CheckIcon state={c.state} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold">{c.label}</div>
                      <div className="text-[12.5px] leading-snug text-muted">{c.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <RampPanel m={m} />
          </div>

          <div>
            <Label className="mb-2.5">Last 30 days</Label>
            <HealthChart health={detail.health} target={m.targetLimit} />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Inbox rate", m.metrics.inboxRate7 == null ? "—" : `${m.metrics.inboxRate7}%`, `${m.metrics.warmupVolume7} warmup emails, 7 days`, rateTone(m.metrics.inboxRate7, policy)],
              ["Sent", m.metrics.sent7.toLocaleString(), "campaign emails, 7 days", ""],
              [
                "Bounce rate",
                m.metrics.bounceRate7 == null ? "—" : `${m.metrics.bounceRate7}%`,
                m.metrics.bounceSent ? `${m.metrics.bounceBounced} of ${m.metrics.bounceSent} since ${fmtDay(m.metrics.bounceFrom)}` : "no sends counted yet",
                m.metrics.bounceRate7 != null && m.metrics.bounceRate7 > policy.maxBounceRate ? "text-bad" : "",
              ],
              ["Replies", m.metrics.replies7.toLocaleString(), "7 days", ""],
            ].map(([k, v, sub, tone]) => (
              <div key={k} className="rounded-lg border border-line-soft bg-surf2 px-3 py-2.5">
                <div className="mono-label text-muted">{k}</div>
                <div className={cn("mt-1 text-[1.1rem] font-bold tabular-nums", tone)}>{v}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted" title={sub}>
                  {sub}
                </div>
              </div>
            ))}
          </div>

          <MailboxSettings m={m} policy={policy} example={example} onSaved={(d) => { setDetail(d); onChanged(); }} />

          <div className="flex flex-wrap gap-2 border-t border-line-soft pt-4">
            {m.stage !== "paused" && !m.missing && (
              <Button
                variant="danger"
                size="sm"
                loading={busy === "pause"}
                onClick={() => act("pause", () => mailboxesApi.pause(m.id), "Paused.")}
              >
                Pause
              </Button>
            )}
            {!m.missing &&
              (m.warmupStatus === 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy === "warmup"}
                  onClick={() => {
                    if (!example && !window.confirm(`Turn warmup off for ${m.email}? Its reputation starts to fade within days.${policy.keepWarmupOn ? " The 'keep warmup on' rule will switch it back on at the next sync." : ""}`)) return;
                    act("warmup", () => mailboxesApi.warmup(m.id, false), "Warmup turned off.");
                  }}
                >
                  Turn warmup off
                </Button>
              ) : (
                <Button variant="outline" size="sm" loading={busy === "warmup"} onClick={() => act("warmup", () => mailboxesApi.warmup(m.id, true), "Warmup turned on.")}>
                  Turn warmup on
                </Button>
              ))}
            {m.missing && (
              <Button
                variant="danger"
                size="sm"
                loading={busy === "forget"}
                onClick={async () => {
                  if (!window.confirm(`Stop tracking ${m.email} and delete its history here?`)) return;
                  setBusy("forget");
                  try {
                    await mailboxesApi.forget(m.id);
                    toast("Removed.", "success");
                    onChanged();
                    onClose();
                  } catch (e: any) {
                    toast(e.message, "error");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Stop tracking
              </Button>
            )}
          </div>

          {detail.events.length > 0 && (
            <div>
              <Label className="mb-2.5">History</Label>
              <ul className="space-y-2">
                {detail.events.slice(0, 12).map((e) => (
                  <li key={e.id} className="flex gap-2.5 text-[12.5px] leading-snug">
                    <span className={cn("mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full", LEVEL_DOT[e.level] || "bg-muted")} />
                    <span className="min-w-0 flex-1 text-ink-soft">{e.message}</span>
                    <span className="shrink-0 text-[11px] text-muted">{ago(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function CheckIcon({ state }: { state: Check["state"] }) {
  if (state === "pass")
    return (
      <span className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-okb text-good">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 5.2l2 2L8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  if (state === "fail")
    return (
      <span className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-dgb text-bad">
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
          <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
    );
  return (
    <span className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full ring-[1.5px] ring-inset ring-line-strong text-muted">
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
        <path d="M5 2.5V5l1.6 1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function RampPanel({ m }: { m: Mailbox }) {
  const steps = rampSteps(m.rampStart, m.rampStep, m.targetLimit);
  const done = m.stage === "active" ? steps.length - 1 : m.stage === "ramping" && m.rampDay ? Math.min(steps.length - 1, m.rampDay - 1) : -1;
  const caption =
    m.stage === "ramping"
      ? `Day ${m.rampDay} of ${steps.length}: ${m.dailyLimit} a day now, ${m.targetLimit} a day from ${fmtDay(m.fullRampOn)}.`
      : m.stage === "active"
        ? `Full limit reached: ${m.targetLimit} a day.`
        : m.stage === "ready"
          ? `Starts at ${m.rampStart} a day when you press Start sending, then +${m.rampStep} each day.`
          : m.stage === "paused"
            ? "Not sending. After you resume, it goes back through the checks and the ramp restarts from day 1."
            : `Starts at ${m.rampStart} a day once every check passes, then +${m.rampStep} each day.`;
  return (
    <div>
      <Label className="mb-2.5">Daily ramp</Label>
      <div className="rounded-xl border border-line-soft bg-surf2 px-3.5 pb-3 pt-3.5">
        <RampStairs steps={steps} doneThrough={done} className="h-[74px]" />
        <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-muted">
          <span>{steps[0]} a day</span>
          <span>{m.targetLimit} a day{m.targetCustom ? " (custom)" : ""}</span>
        </div>
      </div>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted">{caption}</p>
    </div>
  );
}

function MailboxSettings({
  m,
  policy,
  example,
  onSaved,
}: {
  m: Mailbox;
  policy: MailboxPolicy;
  example: boolean;
  onSaved: (d: MailboxDetail) => void;
}) {
  const initial = useMemo(
    () => ({ vendor: m.vendor, preWarmed: m.preWarmed, manualHold: m.manualHold, limit: m.targetCustom ? String(m.targetLimit) : "", notes: m.notes }),
    [m]
  );
  const [f, setF] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setF(initial), [initial]);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const canHold = m.stage === "warming" || m.stage === "ready";

  async function save() {
    if (example) return toast("This is example data. Settings are off in the preview.");
    const limit = f.limit.trim();
    if (limit && !(Number(limit) >= 1 && Number(limit) <= 200)) return toast("Daily limit must be between 1 and 200.", "error");
    setSaving(true);
    try {
      const r = await mailboxesApi.update(m.id, {
        vendor: f.vendor,
        preWarmed: f.preWarmed,
        manualHold: f.manualHold,
        targetLimit: limit ? Number(limit) : null,
        notes: f.notes,
      });
      toast(r.warning ? `Saved. Instantly said: ${r.warning}` : "Saved.", r.warning ? "error" : "success");
      onSaved(r.detail);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-line-soft p-4">
      <Label className="mb-3">Settings</Label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendor">
          <Select value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} disabled={example}>
            <option value="zapmail">Zapmail</option>
            <option value="mailforge">Mailforge</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Full daily limit" hint={`Leave empty to follow the pool rule (${policy.targetLimit} a day).`}>
          <Input inputMode="numeric" placeholder={String(policy.targetLimit)} value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value.replace(/[^\d]/g, "") })} disabled={example} />
        </Field>
      </div>
      <div className="mt-3 space-y-2">
        <Toggle
          checked={f.preWarmed}
          onChange={(v) => setF({ ...f, preWarmed: v })}
          disabled={example}
          label="Sold as pre-warmed"
          hint={`Needs ${policy.minWarmDaysPreWarmed} days of warmup here instead of ${policy.minWarmDays}.`}
        />
        <Toggle
          checked={f.manualHold}
          onChange={(v) => setF({ ...f, manualHold: v })}
          disabled={example || !canHold}
          label="Wait for me before it starts sending"
          hint={canHold ? "When it passes every check it stops at Ready until you press Start sending." : "Only applies before a mailbox starts sending."}
        />
      </div>
      <div className="mt-3">
        <Field label="Notes">
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Anything worth remembering about this mailbox" disabled={example} />
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={save} loading={saving} disabled={!dirty || example}>
          Save settings
        </Button>
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", disabled && "cursor-not-allowed opacity-60")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-[20px] w-[34px] shrink-0 rounded-full transition-colors", checked ? "bg-brand" : "bg-ink/[0.14]")}
      >
        <span className={cn("absolute top-[3px] h-[14px] w-[14px] rounded-full bg-paper shadow transition-[left]", checked ? "left-[17px]" : "left-[3px]")} />
      </button>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{label}</span>
        {hint && <span className="block text-[12px] leading-snug text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/* -------------------------------- rules modal ------------------------------ */

type NumKey = Exclude<keyof MailboxPolicy, "autoStart" | "keepWarmupOn">;

function RulesModal({
  open,
  policy,
  poolSize,
  onClose,
  onSaved,
}: {
  open: boolean;
  policy: MailboxPolicy;
  poolSize: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<Record<NumKey, string> & { autoStart: boolean; keepWarmupOn: boolean }>(() => toForm(policy));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setF(toForm(policy));
  }, [open, policy]);

  function toForm(p: MailboxPolicy) {
    const out: any = { autoStart: p.autoStart, keepWarmupOn: p.keepWarmupOn };
    for (const k of Object.keys(DEFAULT_POLICY) as (keyof MailboxPolicy)[]) if (typeof p[k] === "number") out[k] = String(p[k]);
    return out;
  }
  const num = (k: NumKey) => {
    const n = Number(f[k]);
    return Number.isFinite(n) && f[k] !== "" ? n : DEFAULT_POLICY[k];
  };
  const steps = rampSteps(num("rampStart"), num("rampStep"), num("targetLimit"));

  async function save() {
    setSaving(true);
    try {
      const body: Partial<MailboxPolicy> = { autoStart: f.autoStart, keepWarmupOn: f.keepWarmupOn };
      for (const k of Object.keys(DEFAULT_POLICY) as (keyof MailboxPolicy)[]) {
        if (k === "autoStart" || k === "keepWarmupOn") continue;
        (body as any)[k] = num(k as NumKey);
      }
      const r = await mailboxesApi.savePolicy(body);
      toast(r.warning ? `Rules saved. Instantly said: ${r.warning}` : "Rules saved. Every mailbox was re-checked.", r.warning ? "error" : "success");
      onSaved();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  const field = (k: NumKey, label: string, suffix: string) => (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] text-ink-soft">{label}</span>
      <span className="flex items-center rounded-lg border border-line bg-sunk focus-within:border-accent">
        <input
          inputMode="decimal"
          value={f[k]}
          onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, "") })}
          className="w-full min-w-0 bg-transparent px-3 py-2 text-[13.5px] tabular-nums text-ink outline-none"
        />
        <span className="shrink-0 whitespace-nowrap pr-3 text-[12px] text-muted">{suffix}</span>
      </span>
    </label>
  );

  return (
    <Modal open={open} onClose={onClose} title="Mailbox rules" wide>
      <p className="-mt-1 mb-5 text-[13px] leading-relaxed text-muted">
        These apply to every mailbox. Saving re-checks the whole pool straight away and sends any new daily limits to Instantly.
      </p>
      <div className="space-y-5">
        <section>
          <Label className="mb-3">Readiness gate</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {field("minWarmDays", "Days warming", "days")}
            {field("minWarmDaysPreWarmed", "If pre-warmed", "days")}
            {field("minInboxRate", "Inbox rate needed", "%")}
            {field("minWarmupSample", "Warmup emails needed", "/ 7 days")}
          </div>
        </section>
        <section>
          <Label className="mb-3">Ramp</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {field("rampStart", "First day", "a day")}
            {field("rampStep", "Added each day", "a day")}
            {field("targetLimit", "Full limit", "a day")}
          </div>
          <div className="mt-3 rounded-xl border border-line-soft bg-surf2 px-3.5 pb-3 pt-3">
            <RampStairs steps={steps} doneThrough={steps.length - 1} className="h-12" />
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              {steps.join(" → ")} · full speed on day {steps.length}. {poolSize} mailbox{poolSize === 1 ? "" : "es"} at full speed ≈{" "}
              <span className="font-semibold text-ink-soft">{(poolSize * num("targetLimit")).toLocaleString()} emails a day</span>.
            </p>
          </div>
          <div className="mt-3">
            <Toggle
              checked={f.autoStart}
              onChange={(v) => setF({ ...f, autoStart: v })}
              label="Start sending as soon as every check passes"
              hint="Off: mailboxes stop at Ready until you press Start sending on each one."
            />
          </div>
        </section>
        <section>
          <Label className="mb-3">Auto-pause</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {field("pauseInboxRate", "Inbox rate below", "%")}
            {field("maxBounceRate", "Bounce rate above", "%")}
            {field("minSendsForBounce", "Only after", "sends")}
          </div>
          <div className="mt-3">
            <Toggle
              checked={f.keepWarmupOn}
              onChange={(v) => setF({ ...f, keepWarmupOn: v })}
              label="Keep warmup on"
              hint="If warmup is switched off in Instantly, turn it back on at the next sync."
            />
          </div>
        </section>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-4">
        <Button variant="ghost" size="sm" onClick={() => setF(toForm(DEFAULT_POLICY))}>
          Reset to recommended
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} loading={saving}>
            Save rules
          </Button>
        </div>
      </div>
    </Modal>
  );
}
