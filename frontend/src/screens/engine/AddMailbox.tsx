// Mailboxes → "Add mailbox": sign a Google Workspace / Microsoft 365 mailbox in.
import { useEffect, useState } from "react";
import { Button, Input, Modal, Spinner, cn, toast } from "../../lib/ui";
import { PROVIDER_LABEL, engineApi, signInWithProvider, type Connection } from "../../lib/v2/engine";
import { ProviderMark } from "./shared";

/** Opens Agent → Connections (the section is remembered by the Agent screen). */
export function openConnections() {
  try {
    localStorage.setItem("dnaAgentSection", "connections");
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent("dna-tab", { detail: "agent" }));
}

export function AddMailboxModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setHint("");
    setError("");
    setConns(null);
    engineApi
      .status()
      .then((s) => setConns(s.connections))
      .catch((e) => setError(e.message));
  }, [open]);

  async function signIn(c: Connection) {
    setBusy(c.id);
    try {
      const r = await signInWithProvider({ connectionId: c.id, purpose: "mailbox", loginHint: hint.trim() || null });
      if (r) {
        toast(r.message, r.ok ? "success" : "error");
        if (r.ok) {
          onAdded();
          onClose();
        }
      }
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a mailbox">
      <p className="-mt-1 text-[13px] leading-relaxed text-muted">
        Sign the mailbox in once. It starts on the readiness checks (DNS, domain age, inbox tests) and only sends campaign email after it passes,
        at 5 a day, climbing slowly.
      </p>

      {!conns ? (
        error ? (
          <p className="mt-5 text-[13px] text-bad">{error}</p>
        ) : (
          <div className="mt-6 flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> Loading…
          </div>
        )
      ) : conns.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-line px-5 py-6 text-center">
          <h4 className="text-[14px] font-[650]">First, a sign-in app</h4>
          <p className="mx-auto mt-1.5 max-w-[400px] text-[12.5px] leading-relaxed text-muted">
            Google and Microsoft each need a sign-in app, made once in the account your mailboxes live in. The steps take about five minutes.
          </p>
          <Button
            size="sm"
            className="mt-4"
            onClick={() => {
              onClose();
              openConnections();
            }}
          >
            Set up sign-in apps
          </Button>
        </div>
      ) : (
        <>
          <label className="mt-5 block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Mailbox address (optional)</span>
            <Input
              type="email"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="sara@your-sending-domain.com"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
            />
            <span className="mt-1.5 block text-xs leading-relaxed text-muted">Pre-fills the sign-in page, so you don't sign in as yourself by mistake.</span>
          </label>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {(["google", "microsoft"] as const).map((p) => {
              const c = conns.find((x) => x.provider === p);
              return (
                <button
                  key={p}
                  type="button"
                  disabled={!c || !!busy}
                  onClick={() => c && signIn(c)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                    c ? "border-line hover:border-accent hover:bg-hov" : "cursor-not-allowed border-dashed border-line opacity-60"
                  )}
                >
                  <ProviderMark provider={p} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-semibold">Sign in with {p === "google" ? "Google" : "Microsoft"}</span>
                    <span className="block truncate text-[12px] text-muted">{c ? PROVIDER_LABEL[p] : "Sign-in app not set up"}</span>
                  </span>
                  {busy === c?.id && <Spinner />}
                </button>
              );
            })}
          </div>
          <ul className="mt-5 space-y-1.5 border-t border-line-soft pt-4 text-[12.5px] leading-relaxed text-muted">
            {[
              "Use a mailbox on a spare domain, never dna.systems.",
              "A real person's name and photo, and a signature with the company name and address.",
              "The sign-in window may open behind this one; finish it there and come back.",
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink/25" />
                {t}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
