// The learning loop's rules (plan §8.4.5): when a segment stops Testing, what
// makes it Scaling or Paused, how each day's new leads are split between the
// statuses, and whether the loop only suggests or applies on its own.
// One set of rules for every campaign (setting `segment_rules`).
import { useEffect, useState, type ReactNode } from "react";
import { Button, Modal, cn, toast } from "../../lib/ui";
import { targetingApi, type SegmentRules } from "../../lib/v2/targeting";
import { errMsg } from "../campaigns/parts";
import { Segmented } from "./controls";

export const SPLIT_COLOR = { scaling: "var(--okf)", working: "var(--acb)", testing: "var(--mut3)" } as const;

/** "Testing until 50 emailed · Scaling at 2% hot or 5% replies · Paused after 100 with no hot lead, or bounces over 4%" */
export function rulesSummary(r: SegmentRules): string {
  return `Testing until ${r.testUntil} emailed · Scaling at ${r.scalePositiveRate}% hot or ${r.scaleReplyRate}% replies · Paused with no hot lead after ${r.pauseAfter}, or bounces over ${r.pauseBounceRate}%`;
}

/** The daily split as one stacked bar with its legend. */
export function QuotaSplit({ quota, className }: { quota: SegmentRules["quota"]; className?: string }) {
  const parts = (["scaling", "working", "testing"] as const).filter((k) => quota[k] > 0);
  return (
    <div className={className}>
      <div className="flex h-2 overflow-hidden rounded-full bg-ink/[0.07]" role="img" aria-label={`Scaling ${quota.scaling}%, Working ${quota.working}%, Testing ${quota.testing}%`}>
        {parts.map((k) => (
          <span key={k} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${quota[k]}%`, background: SPLIT_COLOR[k] }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
        {(["scaling", "working", "testing"] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-2 w-2 rounded-[3px]" style={{ background: SPLIT_COLOR[k] }} />
            {k === "scaling" ? "Scaling" : k === "working" ? "Working" : "Testing"} <b className="font-semibold tabular-nums text-ink-soft">{quota[k]}%</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Num({ value, onChange, suffix, min = 0, max = 100, step = 1, label }: { value: number; onChange: (n: number) => void; suffix: string; min?: number; max?: number; step?: number; label: string }) {
  return (
    <label className="inline-flex h-9 items-center rounded-lg border border-line bg-sunk focus-within:border-accent">
      <input
        type="number"
        inputMode="decimal"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
        className="w-[68px] bg-transparent px-2.5 text-right text-[13px] tabular-nums text-ink outline-none"
      />
      <span className="pr-2.5 text-[12px] text-muted">{suffix}</span>
    </label>
  );
}

function Rule({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-5 gap-y-2 border-b border-line-soft py-3.5 last:border-b-0 sm:grid-cols-[150px_minmax(0,1fr)]">
      <div>
        <div className="text-[13px] font-semibold">{title}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{hint}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px] text-ink-soft">{children}</div>
    </div>
  );
}

export function RulesDialog({ open, rules, onClose, onSaved }: { open: boolean; rules: SegmentRules; onClose: () => void; onSaved: (r: SegmentRules) => void }) {
  const [d, setD] = useState<SegmentRules>(rules);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setD(rules);
  }, [open, rules]);
  const set = <K extends keyof SegmentRules>(k: K, v: SegmentRules[K]) => setD((x) => ({ ...x, [k]: v }));
  const setQ = (k: keyof SegmentRules["quota"], v: number) => setD((x) => ({ ...x, quota: { ...x.quota, [k]: v } }));
  const sum = Math.round(((d.quota.scaling || 0) + (d.quota.working || 0) + (d.quota.testing || 0)) * 10) / 10;
  const nums = [d.testUntil, d.scalePositiveRate, d.scaleReplyRate, d.pauseAfter, d.pauseBounceRate, d.quota.scaling, d.quota.working, d.quota.testing];
  const valid = nums.every((n) => Number.isFinite(n) && n >= 0) && sum === 100;
  const dirty = JSON.stringify(d) !== JSON.stringify(rules);

  async function save() {
    setBusy(true);
    try {
      const r = await targetingApi.saveRules(d);
      onSaved(r);
      toast(r.mode === "auto" ? "Saved. The loop now applies its changes on its own." : "Saved. Changes the rules call for wait for your Apply.", "success");
      onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Learning loop rules" wide>
      <p className="-mt-1 mb-2 text-[13px] leading-relaxed text-muted">
        After each sync the loop compares every segment's numbers with these rules. They apply to every campaign. Segments you paused by hand are never touched, and a segment the loop paused only comes back when you move it.
      </p>
      <div>
        <Rule title="Who decides">
          <Segmented
            value={d.mode}
            onChange={(v) => set("mode", v)}
            options={[
              { id: "suggest", label: "Suggest, I apply" },
              { id: "auto", label: "Apply automatically" },
            ]}
          />
          <span className="basis-full text-[12px] text-muted">{d.mode === "suggest" ? "A change shows as an Apply chip with the numbers behind it. Nothing moves until you press it." : "The loop moves segments itself and writes why in the activity feed."}</span>
        </Rule>
        <Rule title="Testing" hint="Too few emails to judge.">
          Until <Num label="Emails before judging" value={d.testUntil} onChange={(n) => set("testUntil", n)} suffix="emailed" min={10} max={1000} /> leads in the segment were emailed.
        </Rule>
        <Rule title="Scaling" hint="Gets the biggest share of new leads.">
          When hot leads reach <Num label="Hot-lead rate for Scaling" value={d.scalePositiveRate} onChange={(n) => set("scalePositiveRate", n)} suffix="%" step={0.5} /> or replies reach <Num label="Reply rate for Scaling" value={d.scaleReplyRate} onChange={(n) => set("scaleReplyRate", n)} suffix="%" step={0.5} />
        </Rule>
        <Rule title="Paused" hint="Stops finding and sending for it.">
          With no hot lead after <Num label="Emails with no hot lead before pausing" value={d.pauseAfter} onChange={(n) => set("pauseAfter", n)} suffix="emailed" min={10} max={5000} /> or bounces over <Num label="Bounce rate that pauses" value={d.pauseBounceRate} onChange={(n) => set("pauseBounceRate", n)} suffix="%" step={0.5} />
        </Rule>
        <Rule title="Working" hint="Everything in between.">
          <span className="text-muted">Past testing, not paused, not yet at the Scaling numbers.</span>
        </Rule>
        <Rule title="Daily split" hint="Of each day's new leads, in finding and in sending order.">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[3px]" style={{ background: SPLIT_COLOR.scaling }} />
            Scaling <Num label="Scaling share" value={d.quota.scaling} onChange={(n) => setQ("scaling", n)} suffix="%" />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[3px]" style={{ background: SPLIT_COLOR.working }} />
            Working <Num label="Working share" value={d.quota.working} onChange={(n) => setQ("working", n)} suffix="%" />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[3px]" style={{ background: SPLIT_COLOR.testing }} />
            Testing <Num label="Testing share" value={d.quota.testing} onChange={(n) => setQ("testing", n)} suffix="%" />
          </span>
          <div className="basis-full">
            {sum === 100 ? (
              <QuotaSplit quota={d.quota} className="max-w-[420px]" />
            ) : (
              <p className="text-[12px] font-semibold text-warn">
                Adds up to {Number.isFinite(sum) ? sum : "?"}%. Make it 100%.
              </p>
            )}
            <p className="mt-1.5 text-[11.5px] text-muted">A status with no segments in it hands its share to the others.</p>
          </div>
        </Rule>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="text-[12.5px] font-semibold text-muted hover:text-ink" onClick={() => setD({ testUntil: 50, scalePositiveRate: 2, scaleReplyRate: 5, pauseAfter: 100, pauseBounceRate: 4, mode: d.mode, quota: { scaling: 60, working: 30, testing: 10 } })}>
          Reset to the defaults
        </button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid || !dirty}>
            Save rules
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The strip above the board: who decides, the rules in one line, the split. */
export function LoopStrip({ rules, suggestions, onEdit, onApplyAll, onDismissAll, busy }: { rules: SegmentRules; suggestions: number; onEdit: () => void; onApplyAll: () => void; onDismissAll: () => void; busy: "apply" | "dismiss" | null }) {
  return (
    <section className="db-card db-in grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono-label text-muted">Learning loop</span>
          <span className={cn("rounded-full px-2 py-[2px] text-[10.5px] font-bold uppercase tracking-[0.05em]", rules.mode === "auto" ? "bg-tlb text-accent" : "bg-ink/[0.06] text-ink-soft")}>{rules.mode === "auto" ? "Applies on its own" : "Suggests, you apply"}</span>
          <button type="button" onClick={onEdit} className="text-[12px] font-semibold text-accent hover:underline">
            Rules
          </button>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{rulesSummary(rules)}.</p>
        {suggestions > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-lg border border-keepl bg-keep1 px-3 py-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-good shadow-[0_0_0_3px_var(--okb)]" />
            <span className="text-[13px] font-semibold text-ink">
              {suggestions} segment change{suggestions === 1 ? "" : "s"} suggested
            </span>
            <span className="text-[12px] text-muted">Each one shows its numbers in the board below.</span>
            <span className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={onDismissAll} loading={busy === "dismiss"} disabled={!!busy}>
                Dismiss all
              </Button>
              <Button size="sm" onClick={onApplyAll} loading={busy === "apply"} disabled={!!busy}>
                Apply all
              </Button>
            </span>
          </div>
        )}
      </div>
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Each day's new leads</div>
        <QuotaSplit quota={rules.quota} />
      </div>
    </section>
  );
}
