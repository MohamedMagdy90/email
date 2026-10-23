// A small dropdown: a button that opens a list of actions. Closes on pick,
// outside click and Escape. DNA console surfaces.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/ui";

export interface MenuItem {
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function Menu({ label, items, align = "right", variant = "outline", size = "sm", className }: { label: ReactNode; items: (MenuItem | null | false)[]; align?: "left" | "right"; variant?: "outline" | "ghost"; size?: "sm" | "md"; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const list = items.filter(Boolean) as MenuItem[];
  if (!list.length) return null;
  return (
    <div ref={ref} className={cn("relative inline-block", className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg font-semibold transition-colors",
          size === "sm" ? "h-8 px-3 text-[12.5px]" : "h-10 px-4 text-[13.5px]",
          variant === "outline" ? "border border-line-strong text-ink/75 hover:bg-hov hover:text-ink" : "text-ink/70 hover:bg-hov hover:text-ink",
          open && "bg-hov text-ink"
        )}
      >
        {label}
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden className={cn("transition-transform", open && "rotate-180")}>
          <path d="M2 3.5L5 6.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="menu" className={cn("absolute z-50 mt-1.5 min-w-[220px] overflow-hidden rounded-xl border border-line bg-paper py-1 shadow-[0_18px_40px_var(--shadow)]", align === "right" ? "right-0" : "left-0")}>
          {list.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={cn("block w-full px-3.5 py-2 text-left transition-colors hover:bg-hov disabled:pointer-events-none disabled:opacity-40", it.danger ? "text-bad" : "text-ink")}
            >
              <span className="block text-[13px] font-medium">{it.label}</span>
              {it.hint && <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
