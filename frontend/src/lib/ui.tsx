import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------- Theme ------------------------------ */
// Same storage key as the DNA partner / support / leads consoles, so a choice
// made in one console carries across all of them.
const THEME_KEY = "dnaConsoleTheme";
export type Theme = "dark" | "light";

function readTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    if (next === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    const m = document.querySelector("meta[name=theme-color]");
    if (m) m.setAttribute("content", next === "light" ? "#ffffff" : "#08090c");
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode */
    }
    setTheme(next);
    window.dispatchEvent(new Event("dna-theme"));
  }
  return [theme, toggle];
}

export function ThemeButton() {
  const [theme, toggle] = useTheme();
  return (
    <button
      type="button"
      className="thm"
      onClick={toggle}
      title={theme === "light" ? "Switch to dark" : "Switch to light"}
      aria-label="Toggle theme"
    >
      {theme === "light" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
  );
}

/* ------------------------------- Brand ------------------------------ */
// Two lockups, because the wordmark is flat artwork and a white one on a white
// bar is simply not there. Same CDN assets the DNA consoles use. Note the trap
// in the file names: "LOGO WHITE" is for DARK backgrounds.
const CDN = "https://cdn.prod.website-files.com/68e4c743eb76166243370915/";
const LOGO_ON_DARK = `${CDN}69123414da75b6704bfd2fcb_fcf9466bf59ac185fd19416b940845d4_DNA%20ERP%20LOGO%20WHITE%20RTM.webp`;
const LOGO_ON_LIGHT = `${CDN}6a0f22616e46406ad3bbc46a_DNA%20ERP%20Logo-dark.webp`;

export function Logo({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const h = () => setTheme(readTheme());
    window.addEventListener("dna-theme", h);
    return () => window.removeEventListener("dna-theme", h);
  }, []);
  return <img className={cn("logo", className)} src={theme === "light" ? LOGO_ON_LIGHT : LOGO_ON_DARK} alt="DNA ERP" />;
}

export function Mark() {
  return (
    <span className="mk">
      <img src="/dna-mark.png" alt="" />
    </span>
  );
}

/* ---------------------------- Page header --------------------------- */
// The DNA shell owns the title row (bar -> title/subtitle/actions -> tabs ->
// view). Each screen still declares its own header; it is portalled into the
// slot the shell renders above the tabs.
export const HeadSlot = createContext<HTMLElement | null>(null);

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  const slot = useContext(HeadSlot);
  const content = (
    <div className="head-row">
      <div className="min-w-0">
        <h1>{title}</h1>
        {subtitle && <p className="sub">{subtitle}</p>}
      </div>
      {actions && <div className="hacts">{actions}</div>}
    </div>
  );
  if (!slot) return null;
  return createPortal(content, slot);
}

/* ------------------------------- Button ----------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "solid" | "outline" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

export function Button({
  variant = "solid",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed select-none whitespace-nowrap";
  const sizes = { sm: "text-[12.5px] px-3 h-8", md: "text-[13.5px] px-[18px] h-10" };
  const variants = {
    // .button — accent fill
    solid: "bg-brand text-onbrand hover:bg-brand-hover",
    // .gh — quiet outline
    outline: "border border-line-strong bg-transparent text-ink/75 hover:bg-hov hover:text-ink",
    ghost: "bg-transparent text-ink/70 hover:bg-hov hover:text-ink",
    // .rj — danger outline
    danger: "border border-dgl bg-transparent text-bad hover:bg-dgb",
  };
  return (
    <button
      className={cn(base, sizes[size], variants[variant], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

/* -------------------------------- Card ------------------------------ */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-line-soft bg-paper", className)}>{children}</div>;
}

/* ------------------------------- Badge ------------------------------ */

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-[2px] text-[10.5px] font-bold uppercase leading-[1.6] tracking-[0.05em]",
        className
      )}
    >
      {children}
    </span>
  );
}

// Every status has a foreground AND a background (console rule).
export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    new: "bg-tlb text-accent",
    sent: "bg-inb text-inf",
    "sent (dry-run)": "bg-wnb text-warn",
    failed: "bg-dgb text-bad",
    unsubscribed: "bg-ink/[0.06] text-muted line-through decoration-1",
    bounced: "bg-dgb text-bad",
    queued: "bg-ink/[0.06] text-ink/60",
    ok: "bg-okb text-good",
    blocked: "bg-wnb text-warn",
    empty: "bg-ink/[0.06] text-muted",
    error: "bg-dgb text-bad",
  };
  return <Badge className={map[status] || "bg-ink/[0.06] text-ink/70"}>{status}</Badge>;
}

/* ------------------------------- Fields ----------------------------- */

export function Field({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      {label && (
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">{label}</div>
      )}
      {children}
      {hint && <div className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</div>}
    </label>
  );
}

const fieldBase =
  "w-full rounded-lg border border-line bg-sunk px-3 py-2.5 text-[13.5px] text-ink placeholder:text-ink/30 outline-none transition-colors focus:border-accent";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldBase, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldBase, "resize-y leading-relaxed", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(fieldBase, "cursor-pointer pr-8", props.className)} />;
}

/* ------------------------------- Spinner ---------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent",
        className || "h-4 w-4"
      )}
    />
  );
}

/* -------------------------------- Modal ----------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        className={cn(
          "relative mt-4 w-full rounded-[14px] border border-line bg-paper shadow-[0_24px_60px_var(--shadow)] sm:mt-10",
          wide ? "max-w-[820px]" : "max-w-[560px]"
        )}
      >
        <div className="flex items-center justify-between px-[22px] pb-1 pt-5">
          <h3 className="text-[1.02rem] font-[650] tracking-[-0.01em]">{title}</h3>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line-strong text-ink/60 transition-colors hover:bg-hov hover:text-ink"
            aria-label="Close"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>
        <div className="px-[22px] pb-5 pt-3">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------- Toaster ---------------------------- */

type Toast = { id: number; msg: string; type: "info" | "success" | "error" };
let toasts: Toast[] = [];
let emit: () => void = () => {};

export function toast(msg: string, type: Toast["type"] = "info") {
  const t: Toast = { id: Math.random(), msg, type };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, 3600);
}

export function Toaster() {
  const [, force] = useState(0);
  useEffect(() => {
    emit = () => force((n) => n + 1);
    return () => {
      emit = () => {};
    };
  }, []);
  const t = toasts[toasts.length - 1];
  if (!t) return null;
  return (
    <div
      key={t.id}
      role="status"
      className={cn(
        "toast border",
        t.type === "success" && "border-okl bg-okb text-good",
        t.type === "error" && "border-dgl bg-dgb text-bad",
        t.type === "info" && "border-line bg-paper text-ink"
      )}
    >
      {t.msg}
    </div>
  );
}
