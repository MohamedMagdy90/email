import { useEffect, useRef, useState } from "react";
import { api, type FollowUpStatus, type FollowUpRun, type FollowUpRung, type FollowUpStepConfig, type Template, type Job } from "../lib/api";
import { Button, Card, Field, Input, Select, Spinner, toast, cn } from "../lib/ui";

/* ------------------------------- shape --------------------------------- */

type Ladder = FollowUpStepConfig[];

type Form = {
  maxEmails: number;
  noOpen: Ladder;
  noClick: Ladder;
  perMinute: number;
  dailyLimit: number;
  batchSize: number;
  lookbackDays: number;
  requireResend: boolean;
};

const EMPTY: Form = {
  maxEmails: 3,
  noOpen: [{ templateId: "", delayHours: 48 }, { templateId: "", delayHours: 96 }],
  noClick: [{ templateId: "", delayHours: 48 }, { templateId: "", delayHours: 96 }],
  perMinute: 20,
  dailyLimit: 200,
  batchSize: 100,
  lookbackDays: 30,
  requireResend: true,
};

const RATES = [10, 20, 40, 60];

// Common waits, in hours. Anything else can be typed straight into the box.
const DELAYS: { v: number; label: string }[] = [
  { v: 6, label: "6 hours" },
  { v: 12, label: "12 hours" },
  { v: 24, label: "1 day" },
  { v: 48, label: "2 days" },
  { v: 72, label: "3 days" },
  { v: 96, label: "4 days" },
  { v: 120, label: "5 days" },
  { v: 168, label: "1 week" },
  { v: 336, label: "2 weeks" },
];

// The two ladders, in the words the user thinks in.
const BRANCHES = [
  {
    key: "noOpen" as const,
    branch: "no_open" as const,
    title: "They never opened it",
    blurb: "The subject line didn't land. Send a different angle — a new subject beats a repeat.",
    accent: "text-[#b06b16]",
    chip: "bg-[#fdf6ea] text-[#8a5a12]",
    rail: "bg-[#e6a33c]",
  },
  {
    key: "noClick" as const,
    branch: "no_click" as const,
    title: "They opened, but never clicked",
    blurb: "They read it and did nothing. This one is warm — give them a reason to act.",
    accent: "text-[#2563a8]",
    chip: "bg-[#eaf3ff] text-[#2563a8]",
    rail: "bg-[#5b9bd8]",
  },
];

export default function FollowUpCard() {
  const [status, setStatus] = useState<FollowUpStatus | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [showDue, setShowDue] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  function syncForm(s: FollowUpStatus) {
    setForm({
      maxEmails: s.config.maxEmails,
      noOpen: s.config.noOpen.map((x) => ({ ...x })),
      noClick: s.config.noClick.map((x) => ({ ...x })),
      perMinute: s.config.perMinute,
      dailyLimit: s.config.dailyLimit,
      batchSize: s.config.batchSize,
      lookbackDays: s.config.lookbackDays,
      requireResend: s.config.requireResend,
    });
  }

  async function load(resetForm = false) {
    try {
      const s = await api.getFollowUp();
      setStatus(s);
      if (resetForm || !dirtyRef.current) syncForm(s);
    } catch { /* ignore — the poller retries */ }
  }

  useEffect(() => {
    load(true);
    api.getTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
    const t = window.setInterval(() => load(), 8000);
    return () => clearInterval(t);
  }, []);

  // Follow a running pass so the progress bar is real, not a spinner.
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

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function setRung(key: "noOpen" | "noClick", idx: number, patch: Partial<FollowUpStepConfig>) {
    setForm((f) => {
      const next = f[key].map((s, i) => (i === idx ? { ...s, ...patch } : s));
      return { ...f, [key]: next };
    });
    setDirty(true);
  }

  async function save() {
    const anyTemplate =
      form.noOpen.some((s, i) => s.templateId && i + 1 < form.maxEmails) ||
      form.noClick.some((s, i) => s.templateId && i + 1 < form.maxEmails);
    if (!anyTemplate) return toast("Choose a template for at least one rung of the ladder", "error");
    setSaving(true);
    try {
      const s = await api.saveFollowUp(form);
      setStatus(s);
      syncForm(s);
      setDirty(false);
      toast("Follow-up ladder saved", "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(on: boolean) {
    try {
      const s = await api.saveFollowUp({ enabled: on });
      setStatus(s);
      if (!dirty) syncForm(s);
      toast(on ? "Follow-ups are on — nobody gets one email and silence" : "Follow-ups paused", on ? "success" : "info");
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  async function runNow() {
    const due = status?.dueNow ?? 0;
    if (!due) return toast("Nothing is due yet — everyone is still inside their wait", "info");
    const batch = Math.min(due, form.batchSize);
    if (!confirm(`Send ${batch.toLocaleString()} follow-up email(s) now?`)) return;
    setStarting(true);
    try {
      const r = await api.runFollowUp();
      setStatus(r.status);
      toast(`Pass started — ${(r.queued ?? 0).toLocaleString()} follow-up(s) going out`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setStarting(false);
    }
  }

  const enabled = !!status?.config.enabled;
  const dueNow = status?.dueNow ?? 0;
  const waiting = status?.waiting ?? 0;
  const isRunning = status?.lastRun?.status === "running" || !!status?.running;
  const blockers = status?.blockers ?? [];
  const rungOf = (branch: string, step: number): FollowUpRung | undefined =>
    status?.rungs.find((r) => r.branch === branch && r.step === step);

  const state: { label: string; tone: string } = !enabled
    ? { label: "paused", tone: "bg-ink/[0.06] text-ink/50" }
    : isRunning
    ? { label: "sending", tone: "bg-[#eaf3ff] text-[#2563a8]" }
    : blockers.length
    ? { label: "needs setup", tone: "bg-[#fdf6ea] text-[#8a5a12]" }
    : dueNow > 0
    ? { label: "sending shortly", tone: "bg-[#e7f6ec] text-[#1f8b4c]" }
    : { label: "watching", tone: "bg-[#e7f6ec] text-[#1f8b4c]" };

  return (
    <Card className="overflow-hidden">
      {/* Head */}
      <div className="flex flex-col gap-4 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className={cn("mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl font-clash text-[15px]", enabled ? "bg-good/15 text-good" : "bg-ink/[0.06] text-ink/40")}>
            ↻
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-clash text-lg font-semibold">Follow-up ladder</h3>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", state.tone)}>{state.label}</span>
            </div>
            <p className="mt-0.5 max-w-xl text-[13px] leading-relaxed text-muted">
              One email and silence is not outreach. Every contact you email is watched: no open gets a different
              subject, an open with no click gets a different ask — up to <b>{form.maxEmails}</b> emails in total,
              then it stops. A click ends the sequence.
            </p>
          </div>
        </div>
        <Switch checked={enabled} onChange={toggleEnabled} />
      </div>

      {/* Live numbers */}
      <div className="border-b border-line bg-cream/50 px-5 py-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat n={dueNow} label="due right now" tone={dueNow ? "text-good" : undefined} />
          <Stat n={waiting} label="inside their wait" />
          <Stat n={status?.totals.retries ?? 0} label="retries sent" />
          <Stat
            n={status?.totals.opened ?? 0}
            label="retries opened"
            sub={status?.totals.retries ? `${Math.round(((status.totals.opened || 0) / status.totals.retries) * 100)}% of retries` : undefined}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted">
          <span>Sent today: <b className="text-ink/70">{(status?.sentToday ?? 0).toLocaleString()}</b>{status?.dailyRemaining != null && <> · {status.dailyRemaining.toLocaleString()} left of the daily ceiling</>}</span>
          <span>Last pass: {status?.lastRun ? fmtAgo(status.lastRun.started_at) : "never"}</span>
          {!!status?.unconfigured && (
            <span className="text-[#8a5a12]">{status.unconfigured.toLocaleString()} waiting on a rung with no template</span>
          )}
          {dueNow > 0 && (
            <button type="button" onClick={() => setShowDue((v) => !v)} className="font-medium text-ink/70 underline underline-offset-2 hover:text-ink">
              {showDue ? "hide who's next" : "see who's next"}
            </button>
          )}
        </div>

        {showDue && !!status?.dueSample?.length && (
          <div className="mt-2 space-y-1 rounded-xl border border-line bg-paper px-3 py-2.5">
            {status.dueSample.map((d) => (
              <div key={d.email + d.step} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="truncate font-medium">{d.email}</span>
                <span className="shrink-0 text-muted">
                  retry {d.step} · {d.branch === "no_click" ? "opened, no click" : "never opened"}
                </span>
              </div>
            ))}
            {dueNow > status.dueSample.length && (
              <div className="pt-0.5 text-[11px] text-muted">+ {(dueNow - status.dueSample.length).toLocaleString()} more</div>
            )}
          </div>
        )}

        {isRunning && job && (
          <div className="mt-3 rounded-xl border border-line bg-paper px-3 py-2.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="inline-flex items-center gap-1.5 font-medium"><Spinner className="h-3 w-3" /> Sending follow-ups…</span>
              <span className="tabular-nums text-muted">{job.processed}/{job.total}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
              <div className="prism-bar h-full transition-all" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Blockers */}
      {enabled && blockers.length > 0 && (
        <div className="border-b border-line bg-[#fdf6ea] px-5 py-3">
          <div className="text-[13px] font-semibold text-[#8a5a12]">Follow-ups can't go out yet</div>
          <ul className="mt-1 space-y-0.5 text-[12px] text-[#8a5a12]/90">
            {blockers.map((b) => <li key={b}>· {b}</li>)}
          </ul>
        </div>
      )}

      {/* The ladder */}
      <div className="space-y-5 px-5 py-5">
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-ink/[0.03] px-3.5 py-3">
          <span className="text-[13px] font-medium text-ink/80">Maximum emails per contact</span>
          <div className="flex rounded-full border border-line bg-white p-0.5 text-[12px]">
            {[2, 3].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => set("maxEmails", n)}
                className={cn("rounded-full px-3 py-1 font-medium transition-colors", form.maxEmails === n ? "bg-ink text-cream" : "text-ink/55 hover:text-ink")}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="text-xs text-muted">
            The first email plus {form.maxEmails - 1} retr{form.maxEmails - 1 === 1 ? "y" : "ies"}. Hard ceiling — nobody ever gets a {form.maxEmails + 1}
            {form.maxEmails + 1 === 3 ? "rd" : "th"}.
          </span>
        </div>

        {/* The original email — the rung everything hangs off */}
        <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-3.5 py-3">
          <Rung n={1} tone="bg-ink text-cream" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium">The email you already send</div>
            <div className="text-[12px] text-muted">Any campaign or automated send. What happens next depends on what they do with it.</div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {BRANCHES.map((b) => (
            <div key={b.key} className="rounded-2xl border border-line bg-white">
              <div className="flex items-start gap-2.5 border-b border-line-soft px-4 py-3">
                <span className={cn("mt-1 h-8 w-1 shrink-0 rounded-full", b.rail)} />
                <div>
                  <div className="text-[13px] font-semibold">{b.title}</div>
                  <div className="text-[12px] leading-relaxed text-muted">{b.blurb}</div>
                </div>
              </div>

              <div className="space-y-3 px-4 py-4">
                {form[b.key].map((rung, i) => {
                  const step = i + 1;
                  const off = step + 1 > form.maxEmails;
                  const live = rungOf(b.branch, step);
                  return (
                    <div key={step} className={cn("rounded-xl border px-3.5 py-3 transition-opacity", off ? "border-dashed border-line opacity-45" : "border-line bg-paper")}>
                      <div className="mb-2.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Rung n={step + 1} tone={off ? "bg-ink/10 text-ink/40" : b.chip} />
                          <span className="text-[12px] font-medium">
                            {step === 1 ? "First retry" : "Second retry"}
                            {off && <span className="ml-1.5 text-muted">— off at a {form.maxEmails}-email ceiling</span>}
                          </span>
                        </div>
                        {!off && !!live && (live.due > 0 || live.waiting > 0) && (
                          <span className="shrink-0 text-[11px] text-muted">
                            {live.due > 0 && <b className="text-good">{live.due.toLocaleString()} due</b>}
                            {live.due > 0 && live.waiting > 0 && " · "}
                            {live.waiting > 0 && `${live.waiting.toLocaleString()} waiting`}
                          </span>
                        )}
                      </div>

                      <div className="grid gap-2.5 sm:grid-cols-[1fr_auto]">
                        <Field label="Template">
                          <Select
                            value={rung.templateId}
                            disabled={off}
                            onChange={(e) => setRung(b.key, i, { templateId: e.target.value })}
                          >
                            <option value="">Don't send this one</option>
                            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </Select>
                        </Field>
                        <Field label={step === 1 ? "Wait after email 1" : "Wait after the first retry"}>
                          <div className="flex gap-1.5">
                            <Select
                              className="w-[7.5rem]"
                              value={DELAYS.some((d) => d.v === rung.delayHours) ? rung.delayHours : "custom"}
                              disabled={off}
                              onChange={(e) => {
                                if (e.target.value === "custom") return;
                                setRung(b.key, i, { delayHours: Number(e.target.value) });
                              }}
                            >
                              {DELAYS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
                              {!DELAYS.some((d) => d.v === rung.delayHours) && <option value="custom">{rung.delayHours}h</option>}
                            </Select>
                            <Input
                              type="number"
                              min={1}
                              className="w-[5rem]"
                              value={rung.delayHours}
                              disabled={off}
                              onChange={(e) => setRung(b.key, i, { delayHours: Math.max(1, Number(e.target.value) || 1) })}
                              title="Hours"
                            />
                          </div>
                        </Field>
                      </div>

                      {!off && rung.templateId && !!live?.sent && (
                        <div className="mt-2 border-t border-line-soft pt-2 text-[11px] text-muted">
                          {live.sent.toLocaleString()} sent · {live.opened.toLocaleString()} opened
                          {live.clicked ? ` · ${live.clicked.toLocaleString()} clicked` : ""}
                          {live.nextDueAt && <> · next {fmtIn(live.nextDueAt)}</>}
                        </div>
                      )}
                      {!off && !rung.templateId && (
                        <div className="mt-2 text-[11px] text-muted">
                          No template = this rung is skipped, and the sequence ends here.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Guard rails */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Send rate" hint="Slower is safer.">
            <Select value={form.perMinute} onChange={(e) => set("perMinute", Number(e.target.value))}>
              {RATES.map((r) => <option key={r} value={r}>{r} / minute</option>)}
            </Select>
          </Field>
          <Field label="Daily ceiling" hint="Max follow-ups per day. 0 = no limit.">
            <Input
              type="number"
              min={0}
              value={form.dailyLimit}
              onChange={(e) => set("dailyLimit", Math.max(0, Number(e.target.value) || 0))}
            />
          </Field>
          <Field label="Per pass" hint="Most one sweep will send at once.">
            <Input
              type="number"
              min={1}
              value={form.batchSize}
              onChange={(e) => set("batchSize", Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
          <Field label="Only chase the last" hint="Older sequences are left alone.">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={form.lookbackDays}
                onChange={(e) => set("lookbackDays", Math.max(1, Number(e.target.value) || 1))}
              />
              <span className="shrink-0 text-[13px] text-muted">days</span>
            </div>
          </Field>
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
              Recommended. Without a key the app "sends" in dry-run and would still count those retries as delivered,
              walking everyone up the ladder without a single real email going out.
            </span>
          </span>
        </label>

        {!status?.trackingReady && (
          <div className="rounded-xl border border-[#e6a33c]/40 bg-[#fdf6ea] px-3.5 py-3 text-[12px] leading-relaxed text-[#8a5a12]">
            <b>Set the App URL first.</b> The ladder reads opens from the tracking pixel and clicks from the wrapped
            links, and both need a public URL for this app's backend. Without it every contact looks like a
            non-opener, so add it under <b>Resend</b> above before switching this on.
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div className="text-xs text-muted">
            {dirty ? "You have unsaved changes." : "Checked on the server every 5 minutes — this tab can be closed."}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" loading={starting} onClick={runNow} disabled={isRunning || !dueNow}>
              {isRunning ? "Pass in progress…" : `Send due now${dueNow ? ` (${Math.min(dueNow, form.batchSize).toLocaleString()})` : ""}`}
            </Button>
            <Button loading={saving} onClick={save} disabled={!dirty}>Save ladder</Button>
          </div>
        </div>
      </div>

      {/* Pass history */}
      <div className="border-t border-line">
        <div className="flex items-center justify-between px-5 py-3">
          <div className="mono-label text-muted">Recent passes</div>
          {status?.lastRun && <div className="text-[11px] text-muted">Last pass {fmtAgo(status.lastRun.started_at)}</div>}
        </div>
        {!status?.runs?.length ? (
          <div className="px-5 pb-5 text-[13px] text-muted">
            No follow-up has gone out yet. Once a contact passes their wait without opening (or without clicking),
            the pass that chases them shows up here.
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

/* -------------------------------- bits --------------------------------- */

function Stat({ n, label, sub, tone }: { n: number; label: string; sub?: string; tone?: string }) {
  return (
    <div>
      <div className={cn("font-clash text-xl font-semibold tabular-nums", tone)}>{n.toLocaleString()}</div>
      <div className="text-[12px] text-muted">{label}</div>
      {sub && <div className="text-[11px] text-muted/80">{sub}</div>}
    </div>
  );
}

function Rung({ n, tone }: { n: number; tone: string }) {
  return (
    <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-lg text-[11px] font-semibold", tone)}>
      {n}
    </span>
  );
}

function RunRow({ r }: { r: FollowUpRun }) {
  const tone: Record<string, string> = {
    done: "bg-[#e7f6ec] text-[#1f8b4c]",
    running: "bg-[#eaf3ff] text-[#2563a8]",
    error: "bg-[#fde8e8] text-[#c0392b]",
    skipped: "bg-ink/[0.06] text-ink/50",
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", tone[r.status] || "bg-ink/[0.06] text-ink/60")}>
        {r.status === "running" ? "sending" : r.status}
      </span>
      <span className="text-[13px] font-medium tabular-nums">{fmtAgo(r.started_at)}</span>
      <span className="rounded-md bg-ink/[0.05] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/45">
        {r.trigger === "manual" ? "manual" : "auto"}
      </span>
      <span className="flex-1 truncate text-[12px] text-muted">
        {r.status === "skipped"
          ? r.note
          : <>
              sent <b className="text-ink/70">{r.sent.toLocaleString()}</b>
              {r.failed ? <> · <span className="text-bad">{r.failed.toLocaleString()} failed</span></> : null}
              {r.skipped ? <> · {r.skipped.toLocaleString()} skipped</> : null}
              {" · "}{r.no_open.toLocaleString()} never opened · {r.no_click.toLocaleString()} opened, no click
              {r.retry2 ? <> · {r.retry2.toLocaleString()} on their last chance</> : null}
              {r.template_names ? <> · “{r.template_names}”</> : null}
            </>}
      </span>
      {r.error && <span className="w-full truncate text-[11px] text-bad sm:w-auto">{r.error}</span>}
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-good" : "bg-ink/15")}
      aria-pressed={checked}
    >
      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", checked ? "left-[22px]" : "left-0.5")} />
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
