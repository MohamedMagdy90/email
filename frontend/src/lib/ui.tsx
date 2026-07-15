import { useEffect, useState, type ReactNode, type ButtonHTMLAttributes } from "react";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
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
  const sizes = { sm: "text-[13px] px-3.5 h-8", md: "text-sm px-5 h-10" };
  const variants = {
    solid: "bg-ink text-cream hover:bg-ink-soft active:scale-[0.98]",
    outline: "border border-ink/25 text-ink hover:border-ink hover:bg-ink/[0.04]",
    ghost: "text-ink/70 hover:text-ink hover:bg-ink/[0.05]",
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

const fieldBase =
  "w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 outline-none transition-colors focus:border-ink/50 focus:ring-2 focus:ring-ink/5";

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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8">
      <div
        className={cn(
          "relative mt-4 w-full rounded-3xl border border-line bg-paper shadow-2xl sm:mt-10",
          wide ? "max-w-3xl" : "max-w-lg"
        )}
      >
        <div className="prism-bar h-1 rounded-t-3xl" />
        <div className="flex items-center justify-between px-6 py-4">
          <h3 className="font-clash text-lg font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-ink/50 transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="border-t border-line px-6 py-5">{children}</div>
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
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-lg",
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
