import { useState } from "react";
import { api } from "../lib/api";
import { Button } from "../lib/ui";
import { Gate, GateError, GateLabel, gateInput } from "./Login";

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

  return (
    <Gate
      kicker="First-run setup"
      title="Create your account"
      sub="This sets the login for the outreach console. You can change it later in Settings."
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <GateLabel>Username</GateLabel>
          <input className={gateInput} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Choose a username" autoFocus autoComplete="username" />
        </label>
        <label className="block">
          <GateLabel>Password</GateLabel>
          <input type="password" className={gateInput} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" />
        </label>
        <label className="block">
          <GateLabel>Confirm password</GateLabel>
          <input type="password" className={gateInput} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" />
        </label>
        {error && <GateError>{error}</GateError>}
        <Button type="submit" loading={loading} className="w-full">
          {loading ? "Creating…" : "Create account & sign in"}
        </Button>
      </form>
    </Gate>
  );
}
