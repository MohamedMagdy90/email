import { useEffect, useRef, useState } from "react";
import { api, type AutomationStatus, type AutomationRun, type Template, type Job } from "../lib/api";
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

type Form = {
  threshold: number;
  templateIds: string[];
  templateMode: "rotate" | "split";
  category: string;
  country: string;
  perMinute: number;
  dailyLimit: number;
  cooldownMinutes: number;
  requireResend: boolean;
};

const EMPTY: Form = {
  threshold: 100, templateIds: [], templateMode: "rotate", category: "", country: "",
  perMinute: 20, dailyLimit: 300, cooldownMinutes: 60, requireResend: true,
};

export default function AutomationCard() {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  function syncForm(s: AutomationStatus) {
    setForm({
      threshold: s.config.threshold,
      templateIds: s.config.templateIds,
      templateMode: s.config.templateMode,
      category: s.config.category,
      country: s.config.country,
      perMinute: s.config.perMinute,
      dailyLimit: s.config.dailyLimit,
      cooldownMinutes: s.config.cooldownMinutes,
      requireResend: s.config.requireResend,
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

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function toggleTemplate(id: string) {
    setForm((f) => ({
      ...f,
      templateIds: f.templateIds.includes(id) ? f.templateIds.filter((x) => x !== id) : [...f.templateIds, id],
    }));
    setDirty(true);
  }

  async function save() {
    if (!form.templateIds.length) return toast("Choose at least one template for the automation to send", "error");
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

  async function runNow() {
    const ready = status?.ready ?? 0;
    if (!ready) return toast("No leads with an email are waiting in the pool", "info");
    const batch = Math.min(ready, form.threshold);
    if (!confirm(`Approve the next ${batch.toLocaleString()} lead(s) into Contacts and email them now?`)) return;
    setStarting(true);
    try {
      const r = await api.runAutomation();
      setStatus(r.status);
      toast(`Run started — ${(r.approved ?? 0).toLocaleString()} contact(s) approved and being emailed`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setStarting(false);
    }
  }

  const enabled = !!status?.config.enabled;
  const ready = status?.ready ?? 0;
  const threshold = form.threshold || status?.config.threshold || 100;
  const pct = Math.min(100, Math.round((ready / Math.max(1, threshold)) * 100));
  const isRunning = status?.lastRun?.status === "running" || !!status?.running;
  const blockers = status?.blockers ?? [];

  const state: { label: string; tone: string } = !enabled
    ? { label: "paused", tone: "bg-ink/[0.06] text-ink/50" }
    : isRunning
    ? { label: "running", tone: "bg-[#eaf3ff] text-[#2563a8]" }
    : blockers.length
    ? { label: "needs setup", tone: "bg-[#fdf6ea] text-[#8a5a12]" }
    : ready >= threshold
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
              Hands-free outreach. Once <b>{threshold.toLocaleString()}</b> discovered leads have an email, they're approved
              into Contacts and emailed with your chosen template — no clicking Approve, no picking recipients, no Send.
            </p>
          </div>
        </div>
        <Switch checked={enabled} onChange={toggleEnabled} />
      </div>

      {/* Progress to trigger */}
      <div className="border-b border-line bg-cream/50 px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13px]">
            <span className="font-clash text-xl font-semibold tabular-nums">{ready.toLocaleString()}</span>
            <span className="text-muted"> of {threshold.toLocaleString()} leads with an email are waiting</span>
          </div>
          <div className="text-[13px] text-muted">
            {isRunning ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-ink"><Spinner className="h-3 w-3" /> sending now</span>
            ) : ready >= threshold ? (
              <span className="font-medium text-good">Batch is full{enabled ? " — the next check will send it" : " — turn the automation on"}</span>
            ) : (
              <>{(threshold - ready).toLocaleString()} more to go</>
            )}
          </div>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink/[0.07]">
          <div className={cn("h-full rounded-full transition-all", pct >= 100 ? "prism-bar" : "bg-ink")} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted">
          <span>Sent today by automation: <b className="text-ink/70">{(status?.sentToday ?? 0).toLocaleString()}</b>{status?.dailyRemaining != null && <> · {status.dailyRemaining.toLocaleString()} left of the daily ceiling</>}</span>
          {status?.nextEligibleAt && new Date(status.nextEligibleAt).getTime() > Date.now() && (
            <span>Next run allowed {fmtIn(status.nextEligibleAt)}</span>
          )}
          <span>Last run: {status?.lastRun ? fmtAgo(status.lastRun.started_at) : "never"}</span>
        </div>

        {/* Live batch progress */}
        {isRunning && job && (
          <div className="mt-3 rounded-xl border border-line bg-paper px-3 py-2.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-medium">Emailing this batch…</span>
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
          <div className="text-[13px] font-semibold text-[#8a5a12]">The automation can't run yet</div>
          <ul className="mt-1 space-y-0.5 text-[12px] text-[#8a5a12]/90">
            {blockers.map((b) => <li key={b}>· {b}</li>)}
          </ul>
        </div>
      )}

      {/* Settings */}
      <div className="space-y-5 px-5 py-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Trigger at / batch size" hint="Approve + email this many at a time.">
            <Input
              type="number"
              min={1}
              value={form.threshold}
              onChange={(e) => set("threshold", Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
          <Field label="Send rate" hint="Slower is safer.">
            <Select value={form.perMinute} onChange={(e) => set("perMinute", Number(e.target.value))}>
              {RATES.map((r) => <option key={r} value={r}>{r} / minute</option>)}
            </Select>
          </Field>
          <Field label="Daily ceiling" hint="Max automated emails per day. 0 = no limit.">
            <Input
              type="number"
              min={0}
              value={form.dailyLimit}
              onChange={(e) => set("dailyLimit", Math.max(0, Number(e.target.value) || 0))}
            />
          </Field>
          <Field label="Gap between runs" hint="Stops back-to-back blasts.">
            <Select value={form.cooldownMinutes} onChange={(e) => set("cooldownMinutes", Number(e.target.value))}>
              {COOLDOWNS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
            </Select>
          </Field>
        </div>

        {/* Templates */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <div className="text-[13px] font-medium text-ink/80">Template to send</div>
            {form.templateIds.length > 1 && (
              <div className="flex rounded-full border border-line bg-cream p-0.5 text-[11px]">
                {([["rotate", "One per run"], ["split", "Alternate per recipient"]] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => set("templateMode", v)}
                    className={cn("rounded-full px-2.5 py-1 font-medium transition-colors", form.templateMode === v ? "bg-ink text-cream" : "text-ink/55 hover:text-ink")}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {templates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
              No templates yet — create one on the Templates tab first.
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {templates.map((t) => {
                const on = form.templateIds.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTemplate(t.id)}
                    className={cn(
                      "flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all",
                      on ? "border-ink bg-ink/[0.04]" : "border-line bg-white hover:border-ink/30"
                    )}
                  >
                    <span className={cn("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border text-[10px] text-cream", on ? "border-ink bg-ink" : "border-ink/25 bg-white")}>
                      {on ? "✓" : ""}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{t.name}</span>
                      <span className="block truncate text-[11px] text-muted">{t.type === "partner" ? "Partner" : "Customer"} · {t.subject}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-1 text-xs text-muted">
            {form.templateIds.length > 1
              ? form.templateMode === "split"
                ? "Both templates are used inside every batch, alternating recipient by recipient."
                : "Runs take turns: the first batch uses the first template, the next uses the second, and so on."
              : "Pick more than one to vary the email between sends — identical bulk copy is what spam filters look for."}
          </div>
        </div>

        {/* How approved contacts are filed */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Save approved contacts under" hint="The category the automation files them in.">
            <Select value={form.category} onChange={(e) => set("category", e.target.value)}>
              <option value="">No category</option>
              {cats.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Country override" hint="Leave blank to keep each lead's own country.">
            <Input value={form.country} onChange={(e) => set("country", e.target.value)} placeholder="e.g. Qatar" />
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
              Recommended. Without a key the app "sends" in dry-run and would still mark everyone as emailed — this switch
              stops the automation from quietly burning your pool.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div className="text-xs text-muted">
            {dirty ? "You have unsaved changes." : "The check runs on the server every minute — this tab can be closed."}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" loading={starting} onClick={runNow} disabled={isRunning || !ready}>
              {isRunning ? "Run in progress…" : `Run now${ready ? ` (${Math.min(ready, threshold).toLocaleString()})` : ""}`}
            </Button>
            <Button loading={saving} onClick={save} disabled={!dirty}>Save automation</Button>
          </div>
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
            It hasn't run yet. When the pool reaches {threshold.toLocaleString()}, the run and everything it did shows up here.
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

function RunRow({ r }: { r: AutomationRun }) {
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
