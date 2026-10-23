// Small controls for the targeting screens: pickable chips, a chip input, a
// ranked list (titles in priority order), a quiet segmented control and the
// card block every section sits in. DNA console tokens only.
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/ui";

export const CHIP = "inline-flex min-h-[30px] items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors";
export const CHIP_OFF = "bg-ink/[0.04] text-ink-soft ring-1 ring-inset ring-line-soft hover:bg-hov hover:text-ink";
export const CHIP_ON = "bg-keep1 text-accent ring-1 ring-inset ring-keepl";
export const CHIP_BAD = "bg-dgb text-bad ring-1 ring-inset ring-dgl";

function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
      <path d="M2 5.2l2 2L8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Cross({ className }: { className?: string }) {
  return (
    <svg width="9" height="9" viewBox="0 0 8 8" aria-hidden className={cn("shrink-0", className)}>
      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A set of toggle chips. `tone="bad"` for exclusions. */
export function Pick<T extends string>({
  options,
  value,
  onChange,
  tone = "on",
  disabled,
  render,
}: {
  options: { id: T; label: string; title?: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  tone?: "on" | "bad";
  disabled?: boolean;
  render?: (o: { id: T; label: string }, on: boolean) => ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])}
            className={cn(CHIP, on ? (tone === "bad" ? CHIP_BAD : CHIP_ON) : CHIP_OFF, disabled && "pointer-events-none opacity-50")}
          >
            {on && (tone === "bad" ? <Cross /> : <Check />)}
            {render ? render(o, on) : o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Type and press Enter (or comma) to add; click a chip's x to remove. */
export function ChipInput({ value, onChange, placeholder, tone = "on", max = 40 }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; tone?: "on" | "bad" | "plain"; max?: number }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase()) && next.length < max) next.push(p);
    onChange(next);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (text.trim()) add(text);
    } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
  };
  const chipTone = tone === "bad" ? CHIP_BAD : tone === "plain" ? "bg-ink/[0.06] text-ink-soft" : CHIP_ON;
  return (
    <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-lg border border-line bg-sunk px-2 py-1.5 focus-within:border-accent">
      {value.map((v) => (
        <span key={v} className={cn(CHIP, chipTone, "min-h-[26px] pl-2.5 pr-1.5")}>
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} className="grid h-5 w-5 place-items-center rounded-full opacity-70 hover:bg-ink/10 hover:opacity-100">
            <Cross />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => text.trim() && add(text)}
        placeholder={value.length ? "" : placeholder}
        className="min-w-[140px] flex-1 bg-transparent px-1 py-1 text-[13px] text-ink outline-none placeholder:text-ink/30"
      />
    </div>
  );
}

/** Titles in priority order: move up / down, remove, add. */
export function RankedList({ value, onChange, placeholder, disabled }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState("");
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () => {
    const t = text.trim();
    if (t && !value.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...value, t]);
    setText("");
  };
  const btn = "grid h-7 w-7 place-items-center rounded-md text-ink/50 transition-colors hover:bg-hov hover:text-ink disabled:pointer-events-none disabled:opacity-25";
  return (
    <div className={cn(disabled && "pointer-events-none opacity-55")}>
      <ol className="overflow-hidden rounded-lg border border-line-soft">
        {value.map((t, i) => (
          <li key={t} className="flex items-center gap-2 border-b border-line-soft bg-paper px-2 py-1 last:border-b-0">
            <span className="w-5 text-center text-[11px] font-bold tabular-nums text-muted">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{t}</span>
            <button type="button" className={btn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${t} up`}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M2 6.5L5 3.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button type="button" className={btn} disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${t} down`}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M2 3.5L5 6.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button type="button" className={btn} onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
              <Cross />
            </button>
          </li>
        ))}
        {!value.length && <li className="px-3 py-2.5 text-[12.5px] text-muted">No titles yet.</li>}
      </ol>
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder || "Add a title, e.g. Finance Manager"}
          className="min-w-0 flex-1 rounded-lg border border-line bg-sunk px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink/30 focus:border-accent"
        />
        <button type="button" onClick={add} disabled={!text.trim()} className="rounded-lg border border-line-strong px-3 text-[12.5px] font-semibold text-ink/75 hover:bg-hov hover:text-ink disabled:opacity-40">
          Add
        </button>
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: { id: T; label: string; sub?: string }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" className="inline-flex flex-wrap gap-1 rounded-lg border border-line bg-sunk p-1">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={cn("rounded-md text-left font-semibold transition-colors", size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[12.5px]", on ? "bg-hov text-ink ring-1 ring-inset ring-line-strong" : "text-muted hover:text-ink")}
          >
            {o.label}
            {o.sub && <span className="ml-1.5 font-normal text-muted">{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** One labelled area inside a card. */
export function Block({ label, hint, right, children, className }: { label: string; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("py-4 first:pt-0 last:pb-0", className)}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-[13px] font-semibold">{label}</div>
        {right}
      </div>
      {hint && <p className="-mt-1 mb-2.5 text-[12px] leading-relaxed text-muted">{hint}</p>}
      {children}
    </div>
  );
}

export function CardHead({ n, title, sub, right }: { n: string; title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-line-soft pb-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 font-mono text-[11px] font-semibold tabular-nums text-accent">{n}</span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-[650] tracking-[-0.01em]">{title}</h3>
          {sub && <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{sub}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

/** "Same as the market" vs "Narrow it" for a segment field. */
export function Inherit({ inherit, onChange, inheritLabel, ownLabel, summary }: { inherit: boolean; onChange: (inherit: boolean) => void; inheritLabel: string; ownLabel: string; summary?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        size="sm"
        value={inherit ? "inherit" : "own"}
        onChange={(v) => onChange(v === "inherit")}
        options={[
          { id: "inherit", label: inheritLabel },
          { id: "own", label: ownLabel },
        ]}
      />
      {inherit && summary && <span className="text-[12px] text-muted">{summary}</span>}
    </div>
  );
}
