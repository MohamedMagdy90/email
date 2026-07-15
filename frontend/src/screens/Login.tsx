import { useState } from "react";
import { api } from "../lib/api";
import { Button, Input } from "../lib/ui";

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.login(username.trim(), password);
      onSuccess();
    } catch (err: any) {
      setError(err?.message || "Login failed");
      setLoading(false);
    }
  }

  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-ink px-4">
      {/* prism glow */}
      <div className="prism-bar pointer-events-none absolute -top-32 left-1/2 h-64 w-[520px] -translate-x-1/2 rounded-full opacity-20 blur-3xl" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="prism-bar mb-4 grid h-12 w-12 place-items-center rounded-2xl">
            <span className="font-clash text-lg font-bold text-ink">D</span>
          </div>
          <h1 className="font-clash text-2xl font-semibold tracking-tight text-cream">DNA Outreach</h1>
          <p className="mono-label mt-1 text-cream/40">Sign in to continue</p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur"
        >
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-cream/75">Username</div>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                autoFocus
                autoComplete="username"
                className="border-white/10 bg-white/[0.04] text-cream placeholder:text-cream/30 focus:border-white/30 focus:ring-white/5"
              />
            </div>
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-cream/75">Password</div>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                autoComplete="current-password"
                className="border-white/10 bg-white/[0.04] text-cream placeholder:text-cream/30 focus:border-white/30 focus:ring-white/5"
              />
            </div>

            {error && (
              <div className="rounded-xl border border-bad/30 bg-bad/10 px-3.5 py-2.5 text-[13px] text-[#ff9b8f]">
                {error}
              </div>
            )}

            <Button
              type="submit"
              loading={loading}
              className="w-full bg-cream text-ink hover:bg-cream/90"
            >
              Sign in
            </Button>
          </div>
        </form>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-cream/30">
          Authorized access only. Cold outreach — send from secondary domains, never your primary.
        </p>
      </div>
    </div>
  );
}
