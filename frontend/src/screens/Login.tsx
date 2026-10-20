import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { Button, Logo, Mark, ThemeButton } from "../lib/ui";

/* The DNA console sign-in gate: theme toggle top-right, lockup + mark, a
   single card, contact line underneath. Shared with first-run Setup. */
export function Gate({
  kicker,
  title,
  sub,
  children,
  foot,
}: {
  kicker: string;
  title: string;
  sub: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div className="gate">
      <div className="gtop">
        <ThemeButton />
      </div>
      <div className="gl">
        <Logo />
        <p>{kicker}</p>
      </div>
      <div className="rounded-xl border border-line-soft bg-paper px-[22px] py-5">
        <Mark />
        <h2 className="text-center text-[1.02rem] font-[650] tracking-[-0.01em]">{title}</h2>
        <p className="mb-5 mt-1 text-center text-[0.85rem] text-muted">{sub}</p>
        {children}
      </div>
      {foot && <p className="mt-4 text-center text-[0.74rem] leading-relaxed text-ink/40">{foot}</p>}
    </div>
  );
}

export const gateInput =
  "w-full rounded-lg border border-line bg-sunk px-3 py-2.5 text-[0.88rem] text-ink placeholder:text-ink/30 outline-none transition-colors focus:border-accent";

export function GateLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.09em] text-muted">{children}</div>;
}

export function GateError({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dgl bg-dgb px-3.5 py-3 text-[0.85rem] text-bad">{children}</div>;
}

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
    <Gate
      kicker="Outreach console"
      title="Sign in"
      sub="Internal access for the DNA ERP sales team."
      foot={<>Cold outreach goes out from secondary domains only — never dna.systems.</>}
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <GateLabel>Username</GateLabel>
          <input
            className={gateInput}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Your username"
            autoFocus
            autoComplete="username"
          />
        </label>
        <label className="block">
          <GateLabel>Password</GateLabel>
          <input
            type="password"
            className={gateInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            autoComplete="current-password"
          />
        </label>
        {error && <GateError>{error}</GateError>}
        <Button type="submit" loading={loading} className="w-full">
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Gate>
  );
}
