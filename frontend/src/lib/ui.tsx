import { useEffect, useState, type ReactNode, type ButtonHTMLAttributes } from "react";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------- useMediaQuery -------------------------- */

// Lets a screen pick a genuinely different component tree for phones — a card
// list instead of a ten-column table, say — rather than trying to make one
// markup shape serve both with visibility classes.
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    // addListener is the Safari < 14 spelling; still worth keeping.
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", on);
      else mq.removeListener(on);
    };
  }, [query]);
  return matches;
}

/** True below the lg breakpoint — the point where the shell swaps to a tab bar. */
export const useIsMobile = () => !useMediaQuery("(min-width: 1024px)");

/* --------------------------- body scroll lock ------------------------ */

// Overlays on iOS scroll the page behind them unless the body is pinned. Ref
// counted, because a modal can open a nested one.
let lockCount = 0;
function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockCount += 1;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      lockCount -= 1;
      if (lockCount === 0) document.body.style.overflow = prev;
    };
  }, [active]);
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
    "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed select-none";
  // Taller on touch: 36/44px clears the tap-target floor, and shrinks back to
  // the original 32/40 once there is a mouse.
  const sizes = {
    sm: "text-[13px] px-4 h-9 sm:px-3.5 sm:h-8",
    md: "text-sm px-5 h-11 sm:h-10",
  };
  const variants = {
    solid: "bg-ink text-cream hover:bg-ink-soft active:scale-[0.98]",
    outline: "border border-ink/25 text-ink hover:border-ink hover:bg-ink/[0.04] active:scale-[0.98]",
    ghost: "text-ink/70 hover:text-ink hover:bg-ink/[0.05] active:scale-[0.98]",
    danger: "bg-bad text-white hover:brightness-95 active:scale-[0.98]",
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
  return (
    <div className={cn("rounded-2xl border border-line bg-paper", className)}>{children}</div>
  );
}

/* ------------------------------- Badge ------------------------------ */

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        className
      )}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    new: "bg-ink/[0.06] text-ink/70",
    sent: "bg-[#eaf3ff] text-[#2563a8]",
    "sent (dry-run)": "bg-[#fef3e2] text-[#b06b16]",
    failed: "bg-[#fde8e8] text-[#c0392b]",
    unsubscribed: "bg-ink/[0.06] text-ink/45 line-through decoration-1",
    bounced: "bg-[#fde8e8] text-[#c0392b]",
    queued: "bg-ink/[0.06] text-ink/60",
    ok: "bg-[#e7f6ec] text-[#1f8b4c]",
    blocked: "bg-[#fef3e2] text-[#b06b16]",
    empty: "bg-ink/[0.06] text-ink/50",
    error: "bg-[#fde8e8] text-[#c0392b]",
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
      {label && <div className="mb-1.5 text-[13px] font-medium text-ink/80">{label}</div>}
      {children}
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </label>
  );
}

// The 16px minimum that stops iOS zooming on focus is enforced globally in
// index.css; here we only need the taller touch box.
const fieldBase =
  "w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 outline-none transition-colors focus:border-ink/50 focus:ring-2 focus:ring-ink/5";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldBase, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldBase, "resize-y leading-relaxed", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(fieldBase, "cursor-pointer appearance-none bg-white pr-9", props.className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1.5 6 6.5 11 1.5' fill='none' stroke='%23837c6f' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.85rem center",
        ...props.style,
      }}
    />
  );
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

/* ------------------------------ Tooltip ----------------------------- */

// A real tooltip, not `title=""`: the native one takes a second to appear, is
// unstyled, and never shows on a touch device. This one is CSS-only (no state,
// no portal, no measuring) and stays inside the layout — the trigger is
// `relative` and the bubble is absolutely positioned above it.
//
// On touch there is no hover, so it rides `group-focus-within` instead: tapping
// an icon button focuses it and the label appears. The width is clamped to the
// viewport so a bubble near the screen edge cannot force a sideways scroll.
export function Tooltip({
  label,
  children,
  side = "bottom",
  className,
  wide,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
  wide?: boolean;
}) {
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 rounded-xl bg-ink px-3 py-2 text-left text-[11.5px] font-normal leading-relaxed text-cream/90 shadow-xl",
          "origin-center scale-95 opacity-0 transition-all duration-150",
          "group-hover/tip:scale-100 group-hover/tip:opacity-100 group-focus-within/tip:scale-100 group-focus-within/tip:opacity-100",
          wide ? "w-64" : "w-52",
          "max-w-[calc(100vw-2rem)]",
          side === "top" ? "bottom-full mb-2" : "top-full mt-2"
        )}
      >
        {label}
      </span>
    </span>
  );
}

/* ------------------------------ Navigation -------------------------- */

// The app is a single screen with tab state, so a deep link from one screen to
// another (e.g. Discovery → Settings → Automation) goes through an event the
// shell listens for. Keeps screens decoupled without pulling in a router.
//
// `focus` carries WHAT the link was about — "stale" from the Overview's stale-
// sources metric, say — because landing on a tab that holds forty rows and
// leaving the reader to find the two that were being pointed at is not a link,
// it's a hint. The target screen claims it once, on mount, with `takeFocus`;
// it's a one-shot value so a later manual visit to the same tab is clean.
let pendingFocus: string | null = null;
export function goTo(tab: string, focus?: string) {
  pendingFocus = focus || null;
  window.dispatchEvent(new CustomEvent("dna-navigate", { detail: tab }));
}
export function takeFocus(): string | null {
  const f = pendingFocus;
  pendingFocus = null;
  return f;
}

/* -------------------------------- Modal ----------------------------- */

// Centred dialog on a desktop, bottom sheet on a phone. The sheet is capped at
// 92dvh with the body scrolling inside it, so a long form (the CSV importer,
// the contact editor) can never push its own action buttons off-screen — which
// is what happened when this was a single centred box on a 390px viewport.
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

  useScrollLock(open);

  if (!open) return null;
  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-end justify-center bg-ink/40 backdrop-blur-sm sm:items-start sm:overflow-y-auto sm:p-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "animate-sheet-up relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-line bg-paper shadow-2xl",
          "sm:mt-10 sm:max-h-none sm:rounded-3xl",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg"
        )}
      >
        <div className="prism-bar h-1.5 w-full shrink-0" />

        {/* Grab handle — sheet affordance, pointer devices don't need it. */}
        <div className="flex justify-center pt-2.5 sm:hidden">
          <span className="h-1 w-9 rounded-full bg-ink/15" />
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3.5 sm:px-6 sm:py-4">
          <h3 className="font-clash text-lg font-semibold">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink/50 transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="touch-scroll flex-1 overflow-y-auto border-t border-line px-5 py-5 pb-[calc(1.25rem+var(--sab))] sm:px-6 sm:pb-5">
          {children}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Sheet ----------------------------- */

// A lighter overlay than Modal: no title bar, no prism rule. Used for the
// mobile "More" navigation, where the content supplies its own header.
export function Sheet({
  open,
  onClose,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  useScrollLock(open);

  if (!open) return null;
  return (
    <div
      className="animate-fade-in fixed inset-0 z-[70] flex items-end justify-center bg-ink/45 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className="animate-sheet-up touch-scroll max-h-[85dvh] w-full overflow-y-auto rounded-t-3xl bg-ink pb-[calc(1rem+var(--sab))] text-cream shadow-2xl"
      >
        <div className="flex justify-center pt-3 pb-1">
          <span className="h-1 w-9 rounded-full bg-cream/25" />
        </div>
        {children}
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
    return () => { emit = () => {}; };
  }, []);
  return (
    // --nav-h is 0 unless the mobile tab bar is mounted, so on a desktop this
    // resolves to the original bottom-right corner.
    <div className="pointer-events-none fixed inset-x-3 bottom-[calc(var(--nav-h)+var(--sab)+0.75rem)] z-[80] flex flex-col items-center gap-2 lg:inset-x-auto lg:right-5 lg:bottom-5 lg:items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "animate-sheet-up pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg lg:w-auto",
            t.type === "success" && "border-good/30 bg-white text-good",
            t.type === "error" && "border-bad/30 bg-white text-bad",
            t.type === "info" && "border-line bg-ink text-cream"
          )}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
