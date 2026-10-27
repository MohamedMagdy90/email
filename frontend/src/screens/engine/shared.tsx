// Small pieces shared by the own-engine screens (Agent connections, Mailboxes, Campaigns).
import { useState, type ReactNode } from "react";
import { Badge, cn, toast } from "../../lib/ui";
import { takeStoredOAuthResult, type OAuthResult, type Provider } from "../../lib/v2/engine";

export const EngineLabel = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("text-[11px] font-semibold uppercase tracking-[0.09em] text-muted", className)}>{children}</div>
);

/** A value to paste somewhere else (redirect URI, DNS record), with a copy button. */
export function CopyField({ value, label, mono = true, className }: { value: string; label?: string; mono?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API blocked (iframe / http): fall back to a hidden textarea.
      const t = document.createElement("textarea");
      t.value = value;
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing else to try */
      }
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }
  return (
    <div className={cn("min-w-0", className)}>
      {label && <div className="mb-1 text-[11.5px] font-medium text-muted">{label}</div>}
      <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-line bg-sunk">
        <code className={cn("min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap px-3 py-2 text-[12.5px] text-ink [scrollbar-width:thin]", mono ? "font-mono" : "")}>{value}</code>
        <button
          type="button"
          onClick={copy}
          className={cn("shrink-0 border-l border-line px-3 text-[12px] font-semibold transition-colors", copied ? "bg-okb text-good" : "text-ink-soft hover:bg-hov hover:text-ink")}
          aria-label={`Copy ${label || "value"}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** Neutral provider mark: no third-party logos, just a lettered tile in the provider's register. */
export function ProviderMark({ provider, size = 28 }: { provider: Provider | "instantly" | "own"; size?: number }) {
  const map = {
    google: { letter: "G", cls: "bg-okb text-good ring-okl" },
    microsoft: { letter: "M", cls: "bg-inb text-inf ring-line" },
    instantly: { letter: "I", cls: "bg-wnb text-warn ring-wnl" },
    own: { letter: "@", cls: "bg-tlb text-accent ring-keepl" },
  } as const;
  const m = map[provider];
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-lg font-mono font-bold ring-1 ring-inset", m.cls)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
      aria-hidden
    >
      {m.letter}
    </span>
  );
}

/* --------------------------- inbox-test results --------------------------- */

export const RESULT_META: Record<string, { label: string; cell: string; chip: string }> = {
  inbox: { label: "Inbox", cell: "bg-good", chip: "bg-okb text-good" },
  other_tab: { label: "Other tab", cell: "bg-good/55", chip: "bg-okb text-good" },
  other: { label: "Other folder", cell: "bg-good/55", chip: "bg-okb text-good" },
  spam: { label: "Spam", cell: "bg-bad", chip: "bg-dgb text-bad" },
  missing: { label: "Missing", cell: "bg-bad/60", chip: "bg-dgb text-bad" },
  pending: { label: "Waiting", cell: "bg-ink/[0.14]", chip: "bg-ink/[0.06] text-muted" },
  failed: { label: "Couldn't send", cell: "bg-warn", chip: "bg-wnb text-warn" },
};

export function ResultChip({ result }: { result: string }) {
  const m = RESULT_META[result] || { label: result, chip: "bg-ink/[0.06] text-muted" };
  return <Badge className={m.chip}>{m.label}</Badge>;
}

/** Inbox-test rate tone, against the gate (pass) and the auto-pause line. */
export function placementTone(rate: number | null | undefined, pass: number, pause: number) {
  if (rate == null) return "text-muted";
  if (rate >= pass) return "text-good";
  if (rate >= pause) return "text-warn";
  return "text-bad";
}

/** 7 tiny day bars of inbox-test rate (null = no tests that day). */
export function PlacementBars({ days, pass, pause, className }: { days: { day: string; rate: number | null; tests: number }[]; pass: number; pause: number; className?: string }) {
  return (
    <div className={cn("flex h-5 items-end gap-[3px]", className)} role="img" aria-label={days.map((d) => `${d.day}: ${d.rate == null ? "no tests" : `${d.rate}%`}`).join(", ")}>
      {days.map((d) => (
        <span
          key={d.day}
          title={`${d.day}: ${d.rate == null ? "no tests" : `${d.rate}% in the inbox (${d.tests} test${d.tests === 1 ? "" : "s"})`}`}
          className={cn("w-[5px] rounded-[2px]", d.rate == null ? "bg-ink/[0.1]" : d.rate >= pass ? "bg-good" : d.rate >= pause ? "bg-warn" : "bg-bad")}
          style={{ height: d.rate == null ? 4 : Math.max(4, Math.round((d.rate / 100) * 20)) }}
        />
      ))}
    </div>
  );
}

/** Announce a sign-in that finished as a full-page redirect (popup blocked). Call once on mount. */
export function announceStoredOAuth(onResult?: (r: OAuthResult) => void) {
  const r = takeStoredOAuthResult();
  if (!r) return;
  toast(r.message, r.ok ? "success" : "error");
  onResult?.(r);
}
