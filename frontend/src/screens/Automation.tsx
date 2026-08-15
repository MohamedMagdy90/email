import { useEffect, useRef, useState } from "react";
import {
  api,
  type Audience,
  type AutomationLaneConfig,
  type AutomationLaneStatus,
  type AutomationStatus,
  type AutomationRun,
  type Template,
  type Job,
} from "../lib/api";
import { Button, Card, Field, Input, Select, Spinner, toast, cn } from "../lib/ui";

const RATES = [10, 20, 40, 60];
const COOLDOWNS: { v: number; label: string }[] = [
  { v: 0, label: "No wait — fire as soon as the pool is full" },
  { v: 15, label: "At least 15 minutes apart" },
  { v: 30, label: "At least 30 minutes apart" },
  { v: 60, label: "At least 1 hour apart" },
  { v: 180, label: "At least 3 hours apart" },
  { v: 360, label: "At least 6 hours apart" },
  { v: 720, label: "At least 12 hours apart" },
  { v: 1440, label: "Once a day at most" },
];

// The two pipelines, in the words the user thinks in. A discovery source is
// tagged with one of these, and its leads never cross over.
const LANES: {
  key: Audience;
  title: string;
  blurb: string;
  chip: string;
  rail: string;
}[] = [
  {
    key: "customer",
    title: "Customers",
    blurb: "Companies you sell DNA ERP to. Fed by every discovery source tagged Customer.",
    chip: "bg-[#fdeae6] text-[#c0341a]",
    rail: "bg-[#ff5a36]",
  },
  {
    key: "partner",
    title: "Partners",
    blurb: "Accounting firms, IT providers, consultancies — the Makers program pitch.",
    chip: "bg-[#e4f3ec] text-[#127055]",
    rail: "bg-[#1c8a68]",
  },
];

type LaneForm = AutomationLaneConfig;

type Form = {
  customer: LaneForm;
  partner: LaneForm;
  perMinute: number;
  dailyLimit: number;
  cooldownMinutes: number;
  requireResend: boolean;
};

const EMPTY_LANE = (threshold: number, enabled: boolean): LaneForm => ({
  enabled,
  threshold,
  templateIds: [],
  templateMode: "rotate",
  category: "",
  country: "",
});

const EMPTY: Form = {
  customer: EMPTY_LANE(100, true),
  partner: EMPTY_LANE(50, false),
  perMinute: 20,
  dailyLimit: 300,
  cooldownMinutes: 60,
  requireResend: true,
};

// Read one lane out of whatever the server sent. A backend mid-redeploy (or an
// older one) has no lanes at all, and the card must show its defaults rather
// than blow up on `undefined.templateIds` — the whole Settings screen would go
// with it.
function readLane(v: AutomationLaneConfig | undefined, fallback: LaneForm): LaneForm {
  if (!v) return { ...fallback, templateIds: [...fallback.templateIds] };
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : fallback.enabled,
    threshold: Number(v.threshold) || fallback.threshold,
    templateIds: Array.isArray(v.templateIds) ? [...v.templateIds] : [],
    templateMode: v.templateMode === "split" ? "split" : "rotate",
    category: v.category || "",
    country: v.country || "",
  };
}

export default function AutomationCard() {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState<Audience | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  function syncForm(s: AutomationStatus) {
    setForm({
      customer: readLane(s.config.customer, EMPTY.customer),
      partner: readLane(s.config.partner, EMPTY.partner),
      perMinute: s.config.perMinute ?? EMPTY.perMinute,
      dailyLimit: s.config.dailyLimit ?? EMPTY.dailyLimit,
      cooldownMinutes: s.config.cooldownMinutes ?? EMPTY.cooldownMinutes,
      requireResend: s.config.requireResend ?? EMPTY.requireResend,
    });
  }

  async function load(resetForm = false) {
    try {
      const s = await api.getAutomation();
      setStatus(s);
      if (resetForm || !dirtyRef.current) syncForm(s);
    } catch { /* ignore — the poller retries */ }
  }

  useEffect(() => {
    load(true);
    api.getTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
    api.getCategories().then((r) => setCats(r.categories || [])).catch(() => {});
    const t = window.setInterval(() => load(), 6000);
    return () => clearInterval(t);
  }, []);

  // While a batch is streaming out, follow the live send job for a real progress bar.
  const liveJobId = status?.lastRun?.status === "running" ? status.lastRun.job_id : null;
  useEffect(() => {
    if (!liveJobId) { setJob(null); return; }
    let alive = true;
    const tick = async () => {
      const j = await api.getSend(liveJobId).catch(() => null);
      if (alive && j) setJob(j);
    };
    tick();
    const t = window.setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [liveJobId]);

  function set<K extends keyof Omit<Form, "customer" | "partner">>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function setLane(a: Audience, patch: Partial<LaneForm>) {
    setForm((f) => ({ ...f, [a]: { ...f[a], ...patch } }));
    setDirty(true);
  }

  function toggleTemplate(a: Audience, id: string) {
    setForm((f) => {
      const cur = f[a].templateIds;
      return { ...f, [a]: { ...f[a], templateIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } };
    });
    setDirty(true);
  }

  async function save() {
    // A lane that is switched ON with nothing to send is the one mistake that
    // silently does nothing, so it's refused here rather than on the server.
    for (const l of LANES) {
      if (form[l.key].enabled && !form[l.key].templateIds.length) {
        return toast(`Choose at least one template for the ${l.title.toLowerCase()} lane, or switch it off`, "error");
      }
    }
    setSaving(true);
    try {
      const s = await api.saveAutomation(form);
      setStatus(s);
      syncForm(s);
      setDirty(false);
      toast("Automation settings saved", "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(on: boolean) {
    try {
      const s = await api.saveAutomation({ enabled: on });
      setStatus(s);
      if (!dirty) syncForm(s);
      toast(on ? "Automation is on — it will approve and send on its own" : "Automation paused", on ? "success" : "info");
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  // The lane switch saves on the spot (like the master switch), so pausing one
  // audience never depends on remembering to press Save.
  async function toggleLane(a: Audience, on: boolean) {
    setForm((f) => ({ ...f, [a]: { ...f[a], enabled: on } }));
    try {
      const s = await api.saveAutomation({ [a]: { enabled: on } } as any);
      setStatus(s);
      const label = a === "partner" ? "Partner" : "Customer";
      toast(on ? `${label} lane is on` : `${label} lane paused`, on ? "success" : "info");
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  async function runNow(a: Audience) {
    const lane = laneStatus(a);
    const ready = lane?.ready ?? 0;
    const label = a === "partner" ? "partner" : "customer";
    if (!ready) return toast(`No ${label} leads with an email are waiting in the pool`, "info");
    const batch = Math.min(ready, form[a].threshold);
    if (!confirm(`Approve the next ${batch.toLocaleString()} ${label} lead(s) into Contacts and email them now?`)) return;
    setStarting(a);
    try {
      const r = await api.runAutomation(a);
      setStatus(r.status);
      toast(`Run started — ${(r.approved ?? 0).toLocaleString()} contact(s) approved and being emailed`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setStarting(null);
    }
  }

  const laneStatus = (a: Audience): AutomationLaneStatus | undefined =>
    status?.lanes?.find((l) => l.audience === a);

  const enabled = !!status?.config.enabled;
  const isRunning = status?.lastRun?.status === "running" || !!status?.running;
  const blockers = status?.blockers ?? [];
  const liveLanes = LANES.filter((l) => form[l.key].enabled);
  const readyAll = status?.ready ?? 0;
  const anyFull = LANES.some((l) => {
    const s = laneStatus(l.key);
    return form[l.key].enabled && s && s.ready >= form[l.key].threshold;
  });

  const state: { label: string; tone: string } = !enabled
    ? { label: "paused", tone: "bg-ink/[0.06] text-ink/50" }
    : isRunning
    ? { label: "running", tone: "bg-[#eaf3ff] text-[#2563a8]" }
    : blockers.length
    ? { label: "needs setup", tone: "bg-[#fdf6ea] text-[#8a5a12]" }
    : anyFull
    ? { label: "firing shortly", tone: "bg-[#e7f6ec] text-[#1f8b4c]" }
    : { label: "watching", tone: "bg-[#e7f6ec] text-[#1f8b4c]" };

  return (
    <Card className="overflow-hidden">
      {/* Head */}
      <div className="flex flex-col gap-4 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className={cn("mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl font-clash text-[15px]", enabled ? "bg-good/15 text-good" : "bg-ink/[0.06] text-ink/40")}>
            ⚡
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-clash text-lg font-semibold">Automation</h3>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", state.tone)}>{state.label}</span>
            </div>
            <p className="mt-0.5 max-w-xl text-[13px] leading-relaxed text-muted">
              Hands-free outreach, run as <b>two separate pipelines</b>. Discovery tags every source Customer or
              Partner; each lane below approves its own leads into Contacts and emails them with its own template —
              so the two pitches can never be crossed.
            </p>
          </div>
        </div>
        <Switch checked={enabled} onChange={toggleEnabled} />
      </div>

      {/* Shared numbers */}
      <div className="border-b border-line bg-cream/50 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted">
          <span>
            <b className="text-ink/70">{readyAll.toLocaleString()}</b> lead(s) with an email waiting across both lanes
          </span>
          <span>Sent today: <b className="text-ink/70">{(status?.sentToday ?? 0).toLocaleString()}</b>{status?.dailyRemaining != null && <> · {status.dailyRemaining.toLocaleString()} left of the shared daily ceiling</>}</span>
          <span>Last run: {status?.lastRun ? `${fmtAgo(status.lastRun.started_at)} (${laneName(status.lastRun.audience)})` : "never"}</span>
          {enabled && !liveLanes.length && <span className="text-[#8a5a12]">Both lanes are switched off — nothing will send.</span>}
        </div>

        {/* Live batch progress */}
        {isRunning && job && (
          <div className="mt-3 rounded-xl border border-line bg-paper px-3 py-2.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Spinner className="h-3 w-3" /> Emailing the {laneName(status?.lastRun?.audience)} batch…
              </span>
              <span className="tabular-nums text-muted">{job.processed}/{job.total}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
              <div className="prism-bar h-full transition-all" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Blockers that stop both lanes */}
      {enabled && blockers.length > 0 && (
        <div className="border-b border-line bg-[#fdf6ea] px-5 py-3">
          <div className="text-[13px] font-semibold text-[#8a5a12]">The automation can't run yet</div>
          <ul className="mt-1 space-y-0.5 text-[12px] text-[#8a5a12]/90">
            {blockers.map((b) => <li key={b}>· {b}</li>)}
          </ul>
        </div>
      )}

      {/* The two lanes */}
      <div className="space-y-5 px-5 py-5">
        <div className="grid gap-4 lg:grid-cols-2">
          {LANES.map((l) => (
            <LaneCard
              key={l.key}
              meta={l}
              form={form[l.key]}
              live={laneStatus(l.key)}
              templates={templates}
              cats={cats}
              masterOn={enabled}
              starting={starting === l.key}
              busy={isRunning}
              onToggle={(on) => toggleLane(l.key, on)}
              onPatch={(p) => setLane(l.key, p)}
              onToggleTemplate={(id) => toggleTemplate(l.key, id)}
              onRun={() => runNow(l.key)}
            />
          ))}
        </div>

        {/* Guard rails — shared, because both lanes send from the same domains */}
        <div>
          <div className="mb-2 text-[12px] font-medium text-ink/70">
            Guard rails <span className="font-normal text-muted">— shared by both lanes; they protect the same sending domains.</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Send rate" hint="Slower is safer.">
              <Select value={form.perMinute} onChange={(e) => set("perMinute", Number(e.target.value))}>
                {RATES.map((r) => <option key={r} value={r}>{r} / minute</option>)}
              </Select>
            </Field>
            <Field label="Daily ceiling" hint="Both lanes combined. 0 = no limit.">
              <Input
                type="number"
                min={0}
                value={form.dailyLimit}
                onChange={(e) => set("dailyLimit", Math.max(0, Number(e.target.value) || 0))}
              />
            </Field>
            <Field label="Gap between runs" hint="Counted per lane.">
              <Select value={form.cooldownMinutes} onChange={(e) => set("cooldownMinutes", Number(e.target.value))}>
                {COOLDOWNS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
              </Select>
            </Field>
          </div>
        </div>

        <label className="flex items-start gap-2.5 rounded-xl bg-ink/[0.03] px-3.5 py-3 text-[13px]">
          <input
            type="checkbox"
            checked={form.requireResend}
            onChange={(e) => set("requireResend", e.target.checked)}
            className="mt-0.5 accent-ink"
          />
          <span>
            Only run when Resend is connected
            <span className="block text-xs text-muted">
              Recommended. Without a key the app "sends" in dry-run and would still mark everyone as emailed — this switch
              stops the automation from quietly burning your pool.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div className="text-xs text-muted">
            {dirty ? "You have unsaved changes." : "The check runs on the server every minute — this tab can be closed."}
          </div>
          <Button loading={saving} onClick={save} disabled={!dirty}>Save automation</Button>
        </div>
      </div>

      {/* Run history */}
      <div className="border-t border-line">
        <div className="flex items-center justify-between px-5 py-3">
          <div className="mono-label text-muted">Recent runs</div>
          {status?.lastRun && <div className="text-[11px] text-muted">Last run {fmtAgo(status.lastRun.started_at)}</div>}
        </div>
        {!status?.runs?.length ? (
          <div className="px-5 pb-5 text-[13px] text-muted">
            It hasn't run yet. When a lane's pool reaches its trigger, the run and everything it did shows up here.
          </div>
        ) : (
          <div className="divide-y divide-line-soft border-t border-line-soft">
            {status.runs.map((r) => <RunRow key={r.id} r={r} />)}
          </div>
        )}
      </div>
    </Card>
  );
}

/* -------------------------------- lane --------------------------------- */

function LaneCard({
  meta, form, live, templates, cats, masterOn, starting, busy, onToggle, onPatch, onToggleTemplate, onRun,
}: {
  meta: { key: Audience; title: string; blurb: string; chip: string; rail: string };
  form: LaneForm;
  live?: AutomationLaneStatus;
  templates: Template[];
  cats: string[];
  masterOn: boolean;
  starting: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onPatch: (patch: Partial<LaneForm>) => void;
  onToggleTemplate: (id: string) => void;
  onRun: () => void;
}) {
  const ready = live?.ready ?? 0;
  const threshold = form.threshold || 1;
  const pct = Math.min(100, Math.round((ready / threshold) * 100));
  const off = !form.enabled;
  // Templates written for THIS audience first — picking the partner pitch for
  // the customer lane is the expensive mistake this ordering avoids.
  const sorted = [...templates].sort((a, b) => {
    const am = a.type === meta.key ? 0 : 1;
    const bm = b.type === meta.key ? 0 : 1;
    return am - bm || a.name.localeCompare(b.name);
  });

  return (
    <div className={cn("rounded-2xl border bg-white transition-opacity", off ? "border-dashed border-line opacity-70" : "border-line")}>
      {/* head */}
      <div className="flex items-start gap-2.5 border-b border-line-soft px-4 py-3">
        <span className={cn("mt-1 h-8 w-1 shrink-0 rounded-full", off ? "bg-ink/15" : meta.rail)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">{meta.title}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", off ? "bg-ink/[0.06] text-ink/45" : meta.chip)}>
              {off ? "off" : live?.running ? "sending" : "on"}
            </span>
          </div>
          <div className="text-[12px] leading-relaxed text-muted">{meta.blurb}</div>
        </div>
        <Switch small checked={form.enabled} onChange={onToggle} />
      </div>

      {/* progress to trigger */}
      <div className="border-b border-line-soft px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px]">
            <span className="font-clash text-lg font-semibold tabular-nums">{ready.toLocaleString()}</span>
            <span className="text-muted"> of {threshold.toLocaleString()} with an email</span>
          </div>
          <div className="text-[12px] text-muted">
            {live?.running ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-ink"><Spinner className="h-3 w-3" /> sending now</span>
            ) : ready >= threshold ? (
              <span className="font-medium text-good">Batch is full</span>
            ) : (
              <>{(threshold - ready).toLocaleString()} to go</>
            )}
          </div>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
          <div className={cn("h-full rounded-full transition-all", pct >= 100 ? "prism-bar" : off ? "bg-ink/25" : "bg-ink")} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted">
          <span>{(live?.sentToday ?? 0).toLocaleString()} sent today</span>
          <span>Last run: {live?.lastRun ? fmtAgo(live.lastRun.started_at) : "never"}</span>
          {live?.nextEligibleAt && new Date(live.nextEligibleAt).getTime() > Date.now() && (
            <span>Next allowed {fmtIn(live.nextEligibleAt)}</span>
          )}
        </div>
      </div>

      {/* settings */}
      <div className="space-y-3.5 px-4 py-4">
        <Field label="Trigger at / batch size" hint="Approve + email this many at a time.">
          <Input
            type="number"
            min={1}
            value={form.threshold}
            onChange={(e) => onPatch({ threshold: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <div className="text-[13px] font-medium text-ink/80">Template to send</div>
            {form.templateIds.length > 1 && (
              <div className="flex rounded-full border border-line bg-cream p-0.5 text-[11px]">
                {([["rotate", "One per run"], ["split", "Alternate"]] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => onPatch({ templateMode: v })}
                    className={cn("rounded-full px-2.5 py-1 font-medium transition-colors", form.templateMode === v ? "bg-ink text-cream" : "text-ink/55 hover:text-ink")}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {templates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[12px] text-muted">
              No templates yet — create one on the Templates tab first.
            </div>
          ) : (
            <div className="max-h-52 space-y-2 overflow-y-auto pr-0.5">
              {sorted.map((t) => {
                const on = form.templateIds.includes(t.id);
                const matches = t.type === meta.key;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onToggleTemplate(t.id)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all",
                      on ? "border-ink bg-ink/[0.04]" : "border-line bg-white hover:border-ink/30"
                    )}
                  >
                    <span className={cn("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border text-[10px] text-cream", on ? "border-ink bg-ink" : "border-ink/25 bg-white")}>
                      {on ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{t.name}</span>
                        {!matches && (
                          <span className="shrink-0 rounded-md bg-[#fdf6ea] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#8a5a12]" title={`This template is written for ${t.type === "partner" ? "partners" : "customers"}`}>
                            {t.type === "partner" ? "partner" : "customer"} copy
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-muted">{t.subject}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-1 text-[11px] text-muted">
            {form.templateIds.length > 1
              ? form.templateMode === "split"
                ? "Both are used inside every batch, alternating recipient by recipient."
                : "Runs take turns: one template per run."
              : "Pick more than one to vary the email — identical bulk copy is what spam filters look for."}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Save contacts under" hint="Category for this lane.">
            <Select value={form.category} onChange={(e) => onPatch({ category: e.target.value })}>
              <option value="">No category</option>
              {cats.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Country override" hint="Blank = each lead's own.">
            <Input value={form.country} onChange={(e) => onPatch({ country: e.target.value })} placeholder="e.g. Qatar" />
          </Field>
        </div>

        {form.enabled && !!live?.blockers?.length && (
          <div className="rounded-xl bg-[#fdf6ea] px-3 py-2 text-[11px] leading-relaxed text-[#8a5a12]">
            {live.blockers.map((b) => <div key={b}>· {b}</div>)}
          </div>
        )}
        {!masterOn && (
          <div className="text-[11px] text-muted">The master switch above is off, so this lane is idle.</div>
        )}

        <Button variant="outline" size="sm" loading={starting} onClick={onRun} disabled={busy || !ready} className="w-full">
          {busy ? "Run in progress…" : `Run now${ready ? ` (${Math.min(ready, threshold).toLocaleString()})` : ""}`}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------- bits --------------------------------- */

const laneName = (a?: string | null) => (String(a || "customer") === "partner" ? "partner" : "customer");

function RunRow({ r }: { r: AutomationRun }) {
  const tone: Record<string, string> = {
    done: "bg-[#e7f6ec] text-[#1f8b4c]",
    running: "bg-[#eaf3ff] text-[#2563a8]",
    error: "bg-[#fde8e8] text-[#c0392b]",
    skipped: "bg-ink/[0.06] text-ink/50",
  };
  const partner = laneName(r.audience) === "partner";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", tone[r.status] || "bg-ink/[0.06] text-ink/60")}>
        {r.status === "running" ? "sending" : r.status}
      </span>
      <span
        className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", partner ? "bg-[#e4f3ec] text-[#127055]" : "bg-[#fdeae6] text-[#c0341a]")}
        title={partner ? "Partner lane — the Makers program pitch" : "Customer lane — the DNA ERP pitch"}
      >
        {partner ? "partner" : "customer"}
      </span>
      <span className="text-[13px] font-medium tabular-nums">{fmtAgo(r.started_at)}</span>
      <span className="rounded-md bg-ink/[0.05] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/45">
        {r.trigger === "manual" ? "manual" : "auto"}
      </span>
      <span className="flex-1 truncate text-[12px] text-muted">
        {r.status === "skipped"
          ? r.note
          : <>
              approved <b className="text-ink/70">{r.contacts_added.toLocaleString()}</b> · sent{" "}
              <b className="text-ink/70">{r.sent.toLocaleString()}</b>
              {r.failed ? <> · <span className="text-bad">{r.failed.toLocaleString()} failed</span></> : null}
              {r.skipped ? <> · {r.skipped.toLocaleString()} skipped</> : null}
              {r.template_names ? <> · “{r.template_names}”</> : null}
            </>}
      </span>
      {r.error && <span className="w-full truncate text-[11px] text-bad sm:w-auto">{r.error}</span>}
    </div>
  );
}

function Switch({ checked, onChange, small }: { checked: boolean; onChange: (v: boolean) => void; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "relative shrink-0 rounded-full transition-colors",
        small ? "h-5 w-9" : "h-6 w-11",
        checked ? "bg-good" : "bg-ink/15"
      )}
      aria-pressed={checked}
    >
      <span
        className={cn(
          "absolute rounded-full bg-white shadow transition-all",
          small ? "top-0.5 h-4 w-4" : "top-0.5 h-5 w-5",
          checked ? (small ? "left-[18px]" : "left-[22px]") : "left-0.5"
        )}
      />
    </button>
  );
}

function fmtIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
