import { useState } from "react";
import { api } from "../lib/api";

export default function Setup({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (username.trim().length < 3) return setError("Username must be at least 3 characters.");
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setLoading(true);
    try {
      await api.setup(username.trim(), password);
      onSuccess();
    } catch (err: any) {
      setError(err?.message || "Setup failed");
      setLoading(false);
    }
  }

  const inputCls =
    "w-full rounded-xl border border-white/15 bg-white/[0.06] px-3.5 py-2.5 text-sm text-cream placeholder:text-cream/35 outline-none transition-colors focus:border-white/40 focus:ring-2 focus:ring-white/10";

  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-ink px-4">
      <div className="prism-bar pointer-events-none absolute -top-32 left-1/2 h-64 w-[520px] -translate-x-1/2 rounded-full opacity-20 blur-3xl" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="prism-bar mb-4 grid h-12 w-12 place-items-center rounded-2xl">
            <span className="font-clash text-lg font-bold text-ink">D</span>
          </div>
          <h1 className="font-clash text-2xl font-semibold tracking-tight text-cream">Create your account</h1>
          <p className="mono-label mt-1 text-cream/40">First-run setup</p>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur">
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-cream/75">Username</div>
              <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Choose a username" autoFocus autoComplete="username" />
            </div>
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-cream/75">Password</div>
              <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" />
            </div>
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-cream/75">Confirm password</div>
              <input type="password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" />
            </div>

            {error && (
              <div className="rounded-xl border border-[#ff6b5c]/30 bg-[#ff6b5c]/10 px-3.5 py-2.5 text-[13px] text-[#ff9b8f]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-cream px-5 text-sm font-medium text-ink transition-all hover:bg-cream/90 active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? "Creating…" : "Create account & sign in"}
            </button>
          </div>
        </form>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-cream/30">
          This sets the login for your outreach app. You can change it later in Settings.
        </p>
      </div>
    </div>
  );
}
