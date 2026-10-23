// Small shared pieces for the Campaigns screen.
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Field, Textarea, cn } from "../../lib/ui";
import { STAGE_LABEL, type CampaignReadiness, type CampaignStatus, type Funnel, type ProspectStage } from "../../lib/v2/campaigns";

export const goTab = (t: string) => window.dispatchEvent(new CustomEvent("dna-tab", { detail: t }));
/** Open one campaign in the Campaigns tab (from Leads, Dashboard, Targeting…). */
export const openCampaign = (id: string) => {
  try {
    localStorage.setItem("dnaCampaignOpen", id);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent("dna-open-campaign", { detail: id }));
  goTab("campaigns");
};
/** Open one thread in the Inbox tab. */
export const openThread = (id: string) => {
  try {
    localStorage.setItem("dnaInboxOpen", id);
  } catch {
    /* private mode */
  }
  goTab("inbox");
};
export const QUIET = "bg-hov text-ink ring-1 ring-inset ring-line-strong";
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const errMsg = (e: unknown) => String((e as any)?.message || e || "Something went wrong");

export const STAGE_TONE: Record<ProspectStage, string> = {
  found: "bg-ink/[0.06] text-muted",
  researched: "bg-inb text-inf",
  contact_found: "bg-inb text-inf",
  verified: "bg-tlb text-accent",
  written: "bg-wnb text-warn",
  approved: "bg-tlb text-accent",
  queued: "bg-pub text-puf",
  sent: "bg-okb text-good",
  replied: "bg-okb text-good",
  interested: "bg-okb text-good",
  meeting: "bg-okb text-good",
  won: "bg-okb text-good",
  lost: "bg-ink/[0.06] text-muted",
  unsubscribed: "bg-dgb text-bad",
  bounced: "bg-dgb text-bad",
  skipped: "bg-ink/[0.06] text-muted",
  failed: "bg-dgb text-bad",
};

export function StageChip({ stage }: { stage: ProspectStage }) {
  return <Badge className={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Badge>;
}

const STATUS_TONE: Record<CampaignStatus, string> = {
  draft: "bg-ink/[0.06] text-muted",
  active: "bg-okb text-good",
  paused: "bg-wnb text-warn",
  archived: "bg-ink/[0.06] text-muted",
};
const STATUS_LABEL: Record<CampaignStatus, string> = { draft: "Draft", active: "Running", paused: "Paused", archived: "Archived" };

export function StatusChip({ status, working }: { status: CampaignStatus; working?: boolean }) {
  if (status === "active")
    return (
      <span className="livep open">
        <i />
        {working ? "Working" : "Running"}
      </span>
    );
  return <Badge className={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function EmailStatusChip({ status }: { status: string | null }) {
  if (!status) return null;
  const tone = status === "valid" ? "bg-okb text-good" : status === "catch_all" ? "bg-wnb text-warn" : status === "unknown" ? "bg-ink/[0.06] text-muted" : "bg-dgb text-bad";
  return <Badge className={tone}>{status === "catch_all" ? "catch-all" : status}</Badge>;
}

/* ------------------------------- funnel ------------------------------- */

const ORDER: ProspectStage[] = ["found", "researched", "contact_found", "verified", "written", "approved", "queued", "sent", "replied", "interested", "meeting", "won"];

/** How many leads got at least as far as `stage` (exits are not counted past where they left). */
export function reached(f: Funnel, stage: ProspectStage): number {
  const i = ORDER.indexOf(stage);
  return ORDER.slice(i).reduce((n, s) => n + (f[s] || 0), 0);
}
export const replies = (f: Funnel) => (f.replied || 0) + (f.interested || 0) + (f.meeting || 0) + (f.won || 0) + (f.lost || 0) + (f.unsubscribed || 0);

export function MiniFunnel({ funnel }: { funnel: Funnel }) {
  const cells: [string, number][] = [
    ["Found", funnel.total],
    ["Verified", reached(funnel, "verified")],
    ["Written", reached(funnel, "written")],
    ["Sent", reached(funnel, "sent")],
    ["Replies", replies(funnel)],
  ];
  const max = Math.max(1, funnel.total);
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {cells.map(([label, n]) => (
        <div key={label} className="min-w-0">
          <div className="h-1 overflow-hidden rounded-full bg-ink/[0.07]">
            <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(n ? 6 : 0, (n / max) * 100)}%` }} />
          </div>
          <div className="mt-1.5 text-[15px] font-bold leading-none tabular-nums">{n.toLocaleString()}</div>
          <div className="mt-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ readiness ----------------------------- */

export function ReadinessStrip({ r }: { r: CampaignReadiness }) {
  const items: { ok: boolean; warn?: boolean; label: string; sub: string; tab: string }[] = [
    { ok: r.ai, label: "AI key", sub: r.ai ? `${r.budgetRemaining.toLocaleString()} calls left today` : "Needed to research, score and write", tab: "agent" },
    { ok: r.aiSearch, warn: !r.aiSearch, label: "Gemini search", sub: r.aiSearch ? "Finds companies and people" : "Free search is slow without it", tab: "agent" },
    { ok: r.reacher, warn: !r.reacher, label: "Email verifier", sub: r.reacher ? "Guessed addresses are checked" : "Guesses wait until connected", tab: "agent" },
    { ok: r.instantly, label: "Instantly", sub: r.instantly ? "Connected" : "Needed to send", tab: "agent" },
    {
      ok: r.mailboxes.sending > 0,
      warn: r.mailboxes.total > 0 && r.mailboxes.sending === 0,
      label: "Sending mailboxes",
      sub: r.mailboxes.sending ? `${r.mailboxes.sending} sending · ${r.mailboxes.dailyCapacity}/day` : r.mailboxes.total ? `${r.mailboxes.total} warming up` : "None connected yet",
      tab: "mailboxes",
    },
  ];
  return (
    <div className="mb-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          onClick={() => !it.ok && goTab(it.tab)}
          className={cn("flex min-w-0 items-start gap-2.5 rounded-xl border border-line-soft bg-paper px-3.5 py-3 text-left transition-colors", !it.ok && "hover:bg-hov")}
          title={it.ok ? undefined : `Open the ${it.tab === "agent" ? "Agent" : "Mailboxes"} tab`}
        >
          <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", it.ok ? "bg-good" : it.warn ? "bg-warn" : "bg-bad")} />
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold">{it.label}</span>
            <span className="block truncate text-[12px] text-muted">{it.sub}</span>
            {!it.ok && <span className="mt-0.5 block text-[12px] font-semibold text-accent">Connect</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------- inputs ------------------------------- */

/** A list edited as one item per line. Keeps its own text so typing a blank line works. */
export function LinesField({ label, hint, value, onChange, rows = 3, placeholder }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => {
    const parsed = text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (parsed.join("\n") !== value.join("\n")) setText(value.join("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.join("\n")]);
  return (
    <Field label={label} hint={hint}>
      <Textarea
        rows={rows}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean));
        }}
      />
    </Field>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-brand" : "bg-ink/[0.14]")}
    >
      <span className={cn("absolute top-[3px] h-[14px] w-[14px] rounded-full bg-paper shadow transition-[left]", checked ? "left-[17px]" : "left-[3px]")} />
    </button>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5">
        <Switch checked={checked} onChange={onChange} label={label} />
      </span>
      <button type="button" onClick={() => onChange(!checked)} className="min-w-0 text-left">
        <span className="block text-[13px] font-semibold">{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{hint}</span>}
      </button>
    </div>
  );
}

export function Chips({ items, tone = "bg-ink/[0.05] text-ink-soft" }: { items: string[]; tone?: string }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t) => (
        <span key={t} className={cn("rounded-full px-2 py-[2px] text-[11.5px]", tone)}>
          {t}
        </span>
      ))}
    </div>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">{children}</div>
      {right}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <div className="text-[15px] font-[650] tracking-[-0.01em]">{title}</div>
      <div className="mx-auto mt-1.5 max-w-[520px] text-[13px] leading-relaxed text-muted">{body}</div>
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}
