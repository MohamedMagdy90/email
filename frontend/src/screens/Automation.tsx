import { useEffect, useRef, useState } from "react";
import {
  api,
  type Audience,
  type AutomationLaneConfig,
  type AutomationLaneStatus,
  type AutomationStatus,
  type AutomationRun,
  type CountryRule,
  type ScheduleConfig,
  type ScheduleCountryStatus,
  type SendWindow,
  type Template,
  type Job,
} from "../lib/api";
import { Button, Card, Field, Input, Select, Spinner, Tooltip, toast, cn } from "../lib/ui";

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

/* ---------------------------- sending windows -------------------------- */

// Local weekdays, Sunday first — the Gulf working week starts there, and half
// this app's pool is in the Gulf.
const DAYS: { v: number; label: string; full: string }[] = [
  { v: 0, label: "S", full: "Sunday" },
  { v: 1, label: "M", full: "Monday" },
  { v: 2, label: "T", full: "Tuesday" },
  { v: 3, label: "W", full: "Wednesday" },
  { v: 4, label: "T", full: "Thursday" },
  { v: 5, label: "F", full: "Friday" },
  { v: 6, label: "S", full: "Saturday" },
];

const NO_COUNTRY = "__none__";
const countryLabel = (c: string) => (c === NO_COUNTRY ? "No country on file" : c);

/** 540 → "09:00", for an <input type="time">. */
function toTime(min: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(min || 0)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
/** "09:00" → 540. */
function fromTime(v: string): number {
  const [h, m] = String(v || "").split(":").map((x) => Number(x) || 0);
  return Math.max(0, Math.min(1439, h * 60 + m));
}
function describeDays(days: number[]): string {
  if (!days.length) return "never";
  if (days.length === 7) return "every day";
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous && sorted.length > 2) return `${DAYS[sorted[0]].full.slice(0, 3)}–${DAYS[sorted[sorted.length - 1]].full.slice(0, 3)}`;
  return sorted.map((d) => DAYS[d].full.slice(0, 3)).join(", ");
}
function describeWindow(w: SendWindow): string {
  return `${toTime(w.start)}–${toTime(w.end)} · ${describeDays(w.days)}`;
}

type LaneForm = AutomationLaneConfig;

// A country mapped to null means "drop the override and go back to the default"
// — that's what the server's patch shape expects, so the form carries it too.
type ScheduleForm = Omit<ScheduleConfig, "countries"> & {
  countries: Record<string, CountryRule | null>;
};

type Form = {
  customer: LaneForm;
  partner: LaneForm;
  perMinute: number;
  dailyLimit: number;
  cooldownMinutes: number;
  requireResend: boolean;
  schedule: ScheduleForm;
};

const EMPTY_LANE = (threshold: number, enabled: boolean): LaneForm => ({
  enabled,
  threshold,
  templateIds: [],
  templateMode: "rotate",
  category: "",
  country: "",
});

const EMPTY_SCHEDULE: ScheduleForm = {
  enabled: true,
  window: { start: 9 * 60, end: 17 * 60, days: [1, 2, 3, 4, 5] },
  countries: {},
  fallbackTimezone: "Asia/Qatar",
  sendUnknown: true,
};

const EMPTY: Form = {
  customer: EMPTY_LANE(100, true),
  partner: EMPTY_LANE(50, false),
  perMinute: 20,
  dailyLimit: 300,
  cooldownMinutes: 60,
  requireResend: true,
  schedule: EMPTY_SCHEDULE,
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
    const sc = s.schedule?.config;
    setForm({
      customer: readLane(s.config.customer, EMPTY.customer),
      partner: readLane(s.config.partner, EMPTY.partner),
      perMinute: s.config.perMinute ?? EMPTY.perMinute,
      dailyLimit: s.config.dailyLimit ?? EMPTY.dailyLimit,
      cooldownMinutes: s.config.cooldownMinutes ?? EMPTY.cooldownMinutes,
      requireResend: s.config.requireResend ?? EMPTY.requireResend,
      schedule: sc
        ? {
            enabled: sc.enabled,
            window: { ...sc.window, days: [...sc.window.days] },
            countries: Object.fromEntries(Object.entries(sc.countries || {}).map(([k, v]) => [k, { ...v }])),
            fallbackTimezone: sc.fallbackTimezone,
            sendUnknown: sc.sendUnknown,
          }
        : { ...EMPTY_SCHEDULE, window: { ...EMPTY_SCHEDULE.window }, countries: {} },
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

  function set<K extends keyof Omit<Form, "customer" | "partner" | "schedule">>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function setLane(a: Audience, patch: Partial<LaneForm>) {
    setForm((f) => ({ ...f, [a]: { ...f[a], ...patch } }));
    setDirty(true);
  }

  /* ---- sending windows ---- */

  function setWindow(patch: Partial<SendWindow>) {
    setForm((f) => ({ ...f, schedule: { ...f.schedule, window: { ...f.schedule.window, ...patch } } }));
    setDirty(true);
  }
  function setSendUnknown(on: boolean) {
    setForm((f) => ({ ...f, schedule: { ...f.schedule, sendUnknown: on } }));
    setDirty(true);
  }
  // null = drop the override and fall back to the default window.
  function setCountryRule(country: string, rule: CountryRule | null) {
    setForm((f) => ({ ...f, schedule: { ...f.schedule, countries: { ...f.schedule.countries, [country]: rule } } }));
    setDirty(true);
  }
  /** The rule in play for a country: the local edit, else what the server says. */
  function ruleFor(c: ScheduleCountryStatus): CountryRule | null {
    const local = form.schedule.countries[c.country];
    if (local !== undefined) return local;
    return c.custom || c.paused ? { ...c.window, paused: c.paused } : null;
  }
  function windowOf(c: ScheduleCountryStatus): SendWindow {
    const r = ruleFor(c);
    return {
      start: r?.start ?? form.schedule.window.start,
      end: r?.end ?? form.schedule.window.end,
      days: r?.days ?? c.window.days,
    };
  }

  // The schedule switch saves on the spot, like the lane switches — flipping it
  // is a decision, not a draft.
  async function toggleSchedule(on: boolean) {
    setForm((f) => ({ ...f, schedule: { ...f.schedule, enabled: on } }));
    try {
      const s = await api.saveAutomation({ schedule: { enabled: on } });
      setStatus(s);
      toast(
        on ? "Sending windows on — batches wait for each country's working hours" : "Sending windows off — batches go out as soon as a pool is full",
        on ? "success" : "info"
      );
    } catch (e: any) {
      toast(e.message, "error");
    }
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
    if (!form.schedule.window.days.length) {
      return toast("Pick at least one day for the sending window, or switch windows off", "error");
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

        {/* When it's allowed to send — per country, in that country's own clock */}
        <ScheduleBlock
          form={form.schedule}
          live={status?.schedule}
          onToggle={toggleSchedule}
          onWindow={setWindow}
          onCountry={setCountryRule}
          onSendUnknown={setSendUnknown}
          ruleFor={ruleFor}
          windowOf={windowOf}
        />

        {/* Guard rails — shared, because both lanes send from the same domains */}
        <div>
          <div className="mb-2 text-[12px] font-medium text-ink/70">
            Guard rails <span className="font-normal text-muted">— shared by both lanes; they protect the same sending domains.</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Send rate" hint="Per domain — total scales with how many are active. Slower is safer.">
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
            className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-ink"
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
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
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

/* --------------------------- sending windows ---------------------------- */

// The fix for "it emailed everyone at midnight".
//
// A pool that spans Qatar, Jordan, the UK and Singapore has no single "good
// time" — 9am is four different moments. So the window is expressed once, in
// local terms, and every country is judged against its OWN clock. The list
// below shows that clock live, which is the only way to make the rule legible:
// you can see that it is 02:14 in Doha and understand instantly why nothing is
// going out.
function ScheduleBlock({
  form, live, onToggle, onWindow, onCountry, onSendUnknown, ruleFor, windowOf,
}: {
  form: ScheduleForm;
  live?: AutomationStatus["schedule"];
  onToggle: (on: boolean) => void;
  onWindow: (patch: Partial<SendWindow>) => void;
  onCountry: (country: string, rule: CountryRule | null) => void;
  onSendUnknown: (on: boolean) => void;
  ruleFor: (c: ScheduleCountryStatus) => CountryRule | null;
  windowOf: (c: ScheduleCountryStatus) => SendWindow;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const countries = live?.countries ?? [];
  const on = form.enabled;

  function toggleDay(days: number[], d: number): number[] {
    return days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b);
  }

  return (
    <div className={cn("rounded-2xl border transition-colors", on ? "border-line bg-white" : "border-dashed border-line bg-white/60")}>
      {/* head */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl text-[15px]", on ? "bg-ink text-cream" : "bg-ink/[0.06] text-ink/40")}>
            ◷
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">Sending window</span>
              {on ? (
                <span className="rounded-full bg-[#e7f6ec] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#1f8b4c]">
                  {describeWindow(form.window)}
                </span>
              ) : (
                <span className="rounded-full bg-[#fdf6ea] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#8a5a12]">
                  any time, day or night
                </span>
              )}
            </div>
            <div className="mt-0.5 max-w-xl text-[12px] leading-relaxed text-muted">
              Batches only go out inside working hours — measured in <b>each country's own time zone</b>, so a Qatari
              lead is emailed at 9am in Doha and a British one at 9am in London. Everyone else waits for their morning
              instead of arriving at 3am.
            </div>
          </div>
        </div>
        <Switch small checked={on} onChange={onToggle} />
      </div>

      {on && (
        <div className="space-y-4 px-4 py-4">
          {/* the default window */}
          <div className="grid gap-3 sm:grid-cols-[auto_auto_1fr] sm:items-end">
            <Field label="From" hint="Local time">
              <Input
                type="time"
                className="w-[8.5rem] sm:w-[7.5rem]"
                value={toTime(form.window.start)}
                onChange={(e) => onWindow({ start: fromTime(e.target.value) })}
              />
            </Field>
            <Field label="Until" hint="Local time">
              <Input
                type="time"
                className="w-[8.5rem] sm:w-[7.5rem]"
                value={toTime(form.window.end)}
                onChange={(e) => onWindow({ end: fromTime(e.target.value) })}
              />
            </Field>
            <Field label="Days" hint="Countries on a Sun–Thu week get that by default; this is the fallback.">
              <div className="flex flex-wrap gap-1">
                {DAYS.map((d) => {
                  const active = form.window.days.includes(d.v);
                  return (
                    <button
                      key={d.v}
                      type="button"
                      title={d.full}
                      onClick={() => onWindow({ days: toggleDay(form.window.days, d.v) })}
                      className={cn(
                        "h-9 w-9 rounded-xl border text-[12px] font-semibold transition-all",
                        active ? "border-ink bg-ink text-cream" : "border-line bg-white text-ink/40 hover:border-ink/30"
                      )}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>

          {/* live, per country */}
          {countries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line px-4 py-4 text-center text-[12px] text-muted">
              No emailable leads in the pool yet. Once discovery finds some, every country they're in appears here with
              its own clock and its own window.
            </div>
          ) : (
            <div>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[12px] font-medium text-ink/70">
                  Right now <span className="font-normal text-muted">— {live?.sendable?.toLocaleString() ?? 0} lead(s) can be emailed, {live?.holding?.toLocaleString() ?? 0} waiting for their window</span>
                </div>
                <div className="text-[11px] text-muted">Click a country to give it its own hours</div>
              </div>

              <div className="divide-y divide-line-soft overflow-hidden rounded-xl border border-line">
                {countries.map((c) => {
                  const rule = ruleFor(c);
                  const w = windowOf(c);
                  const paused = rule?.paused === true;
                  const custom = !!rule && !paused;
                  const expanded = open === c.country;
                  const unknown = c.country === NO_COUNTRY;
                  const held = unknown && !form.sendUnknown;
                  return (
                    <div key={c.country} className={cn("bg-white", expanded && "bg-cream/40")}>
                      <button
                        type="button"
                        onClick={() => setOpen(expanded ? null : c.country)}
                        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-cream/50"
                      >
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            paused || held ? "bg-ink/25" : c.open ? "bg-good" : "bg-[#e0b354]"
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13px] font-medium">{countryLabel(c.country)}</span>
                            <span className="shrink-0 text-[11px] tabular-nums text-muted">
                              {c.ready.toLocaleString()} ready
                            </span>
                            {custom && (
                              <span className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink/50">
                                custom
                              </span>
                            )}
                            {(paused || held) && (
                              <span className="shrink-0 rounded-md bg-[#fdf6ea] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#8a5a12]">
                                held
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-muted">
                            {describeWindow(w)} · {c.timezone.replace(/_/g, " ")}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-clash text-[15px] font-semibold tabular-nums">{c.localTime}</span>
                          <span className={cn("block text-[10.5px]", paused || held ? "text-ink/40" : c.open ? "text-good" : "text-muted")}>
                            {paused || held ? "paused" : c.open ? "open now" : c.nextOpenAt ? `opens ${fmtIn(c.nextOpenAt)}` : "never opens"}
                          </span>
                        </span>
                      </button>

                      {expanded && (
                        <div className="space-y-3 border-t border-line-soft px-3.5 py-3">
                          {unknown ? (
                            <label className="flex items-start gap-2.5 text-[12px]">
                              <input
                                type="checkbox"
                                checked={form.sendUnknown}
                                onChange={(e) => onSendUnknown(e.target.checked)}
                                className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-ink"
                              />
                              <span>
                                Email leads with no country on file
                                <span className="block text-[11px] text-muted">
                                  There's no clock to obey, so they'd be sent on{" "}
                                  <b className="text-ink/70">{form.fallbackTimezone.replace(/_/g, " ")}</b> time. Uncheck to
                                  hold them until someone fills the country in.
                                </span>
                              </span>
                            </label>
                          ) : (
                            <>
                              <div className="grid gap-3 sm:grid-cols-[auto_auto_1fr] sm:items-end">
                                <Field label="From">
                                  <Input
                                    type="time"
                                    className="w-[8.5rem] sm:w-[7.5rem]"
                                    value={toTime(w.start)}
                                    onChange={(e) => onCountry(c.country, { ...w, start: fromTime(e.target.value), paused })}
                                  />
                                </Field>
                                <Field label="Until">
                                  <Input
                                    type="time"
                                    className="w-[8.5rem] sm:w-[7.5rem]"
                                    value={toTime(w.end)}
                                    onChange={(e) => onCountry(c.country, { ...w, end: fromTime(e.target.value), paused })}
                                  />
                                </Field>
                                <Field label="Days">
                                  <div className="flex flex-wrap gap-1">
                                    {DAYS.map((d) => {
                                      const active = w.days.includes(d.v);
                                      return (
                                        <button
                                          key={d.v}
                                          type="button"
                                          title={d.full}
                                          onClick={() => onCountry(c.country, { ...w, days: toggleDay(w.days, d.v), paused })}
                                          className={cn(
                                            "h-8 w-8 rounded-lg border text-[11px] font-semibold transition-all",
                                            active ? "border-ink bg-ink text-cream" : "border-line bg-white text-ink/40 hover:border-ink/30"
                                          )}
                                        >
                                          {d.label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </Field>
                              </div>

                              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
                                <span>
                                  {c.customerReady.toLocaleString()} customer · {c.partnerReady.toLocaleString()} partner
                                  {" · "}local time is {c.localTime} in {c.timezone.replace(/_/g, " ")}
                                </span>
                                <span className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => onCountry(c.country, paused ? { ...w } : { ...w, paused: true })}
                                    className="font-medium text-ink/70 underline underline-offset-2 hover:text-ink"
                                  >
                                    {paused ? "Resume this country" : "Hold this country"}
                                  </button>
                                  {(custom || paused) && (
                                    <button
                                      type="button"
                                      onClick={() => onCountry(c.country, null)}
                                      className="font-medium text-ink/70 underline underline-offset-2 hover:text-ink"
                                    >
                                      Use the default
                                    </button>
                                  )}
                                </span>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="text-[11px] leading-relaxed text-muted">
            <b className="text-ink/60">Run now</b> ignores the window — that's you deciding to send. The follow-up
            ladder below obeys it too.
          </div>
        </div>
      )}
    </div>
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
  // `ready` is everything this lane holds; `readyNow` is the part whose country
  // is actually inside its sending window. The trigger counts the second one,
  // so that's what the bar has to draw — otherwise a full bar would sit there
  // not firing and look broken.
  const ready = live?.readyNow ?? live?.ready ?? 0;
  const total = live?.ready ?? 0;
  const asleep = Math.max(0, total - ready);
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
          {asleep > 0 && (
            <span className="text-[#8a5a12]">
              +{asleep.toLocaleString()} outside their sending window
              {live?.windowOpensAt ? ` — first opens ${fmtIn(live.windowOpensAt)}` : ""}
            </span>
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

        <Tooltip
          side="top"
          wide
          className="w-full"
          label="A manual run ignores the trigger count, the cooldown AND the sending window — it takes the oldest leads in the pool and emails them right now."
        >
          <Button variant="outline" size="sm" loading={starting} onClick={onRun} disabled={busy || !total} className="w-full">
            {busy ? "Run in progress…" : `Run now${total ? ` (${Math.min(total, threshold).toLocaleString()})` : ""}`}
          </Button>
        </Tooltip>
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
