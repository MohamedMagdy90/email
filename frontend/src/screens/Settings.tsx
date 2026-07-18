import { useEffect, useState } from "react";
import { api, type Domain } from "../lib/api";
import { Button, Card, Field, Input, Modal, toast, Badge, cn } from "../lib/ui";
import { Header } from "./Contacts";

export default function Settings() {
  const [resendKey, setResendKey] = useState("");
  const [resendOn, setResendOn] = useState(false);
  const [appUrl, setAppUrl] = useState("");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [editing, setEditing] = useState<Domain | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  async function load() {
    const [s, d] = await Promise.all([api.getSettings(), api.getDomains()]);
    setResendOn(s.resendConfigured);
    setAppUrl(s.appUrl || "");
    setDomains(d.domains);
  }
  useEffect(() => { load(); }, []);

  async function saveKey() {
    setSavingKey(true);
    try {
      await api.saveSettings({ resend_api_key: resendKey || undefined, app_url: appUrl });
      toast("Settings saved", "success");
      setResendKey("");
      load();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSavingKey(false);
    }
  }

  async function sendTest() {
    if (!testTo.includes("@")) return toast("Enter a valid email to send the test to", "error");
    setTesting(true);
    try {
      const r = await api.sendTestEmail(testTo.trim());
      toast(`Test sent from ${r.from}`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setTesting(false);
    }
  }

  async function removeDomain(d: Domain) {
    if (!confirm(`Remove ${d.domain}?`)) return;
    await api.deleteDomain(d.id);
    toast("Removed", "success");
    load();
  }
  async function resetCounts() {
    await api.resetCounts();
    toast("Daily counts reset", "success");
    load();
  }

  return (
    <div>
      <Header title="Settings" subtitle="Connect Resend and manage your sending domains." />

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Resend */}
        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="font-clash text-lg font-semibold">Resend</div>
            <Badge className={resendOn ? "bg-[#e7f6ec] text-[#1f8b4c]" : "bg-[#fdf6ea] text-[#8a5a12]"}>
              {resendOn ? "connected" : "not connected"}
            </Badge>
          </div>
          <Field label="Resend API key" hint={resendOn ? "A key is already saved. Enter a new one to replace it." : "Get it from resend.com → API Keys."}>
            <Input type="password" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder="re_xxxxxxxx" />
          </Field>
          <Field label="App URL" hint="Public URL of THIS app's backend — used for unsubscribe & open-tracking links. e.g. https://your-api.up.railway.app">
            <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://your-api.up.railway.app" />
          </Field>
          <div className="flex justify-end">
            <Button loading={savingKey} onClick={saveKey}>Save</Button>
          </div>

          <div className="border-t border-line pt-4">
            <Field label="Send a test email" hint={resendOn ? "Uses your first active domain (or Resend's test sender)." : "Save a Resend API key first to enable test sends."}>
              <div className="flex gap-2">
                <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@youremail.com" disabled={!resendOn} />
                <Button variant="outline" loading={testing} onClick={sendTest} disabled={!resendOn}>Send test</Button>
              </div>
            </Field>
          </div>
        </Card>

        {/* Deliverability tips */}

        <Card className="space-y-3 p-5">
          <div className="font-clash text-lg font-semibold">Stay out of spam</div>
          <ul className="space-y-2 text-[13px] text-ink/75">
            <Tip>Send from <b>secondary domains</b> (e.g. dna-erp.com) — never your primary dna.systems.</Tip>
            <Tip>Set <b>SPF, DKIM &amp; DMARC</b> on each domain in Resend.</Tip>
            <Tip>Keep a <b>daily cap</b> per domain and a slow send rate.</Tip>
            <Tip>Keep lists clean &amp; targeted — complaints are what get accounts suspended.</Tip>
          </ul>
        </Card>
      </div>

      {/* Domains */}
      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <div className="font-clash text-lg font-semibold">Sending domains</div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={resetCounts}>Reset daily counts</Button>
            <Button size="sm" onClick={() => setEditing({ id: "", domain: "", from_name: "DNA Systems", from_email: "", daily_cap: 40, sent_today: 0, active: true })}>Add domain</Button>
          </div>
        </div>

        {domains.length === 0 ? (
          <Card className="py-12 text-center text-sm text-muted">
            No domains yet. Add a verified secondary domain to rotate sends across.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {domains.map((d) => (
              <Card key={d.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-clash text-base font-semibold">{d.domain}</div>
                    <div className="text-[13px] text-muted">{d.from_name} &lt;{d.from_email}&gt;</div>
                  </div>
                  <Badge className={d.active ? "bg-[#e7f6ec] text-[#1f8b4c]" : "bg-ink/[0.06] text-ink/50"}>
                    {d.active ? "active" : "paused"}
                  </Badge>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="mb-1 flex justify-between text-xs text-muted">
                      <span>Today</span><span>{d.sent_today}/{d.daily_cap}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
                      <div className={cn("h-full rounded-full", d.sent_today >= d.daily_cap ? "bg-bad" : "bg-ink")} style={{ width: `${Math.min(100, (d.sent_today / Math.max(1, d.daily_cap)) * 100)}%` }} />
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEditing(d)}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-bad" onClick={() => removeDomain(d)}>Delete</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Account */}
      <div className="mt-8">
        <div className="mb-3 font-clash text-lg font-semibold">Account</div>
        <AccountCard />
      </div>

      {editing && (
        <DomainModal
          key={editing.id || "new"}
          domain={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function AccountCard() {
  const [current, setCurrent] = useState("");
  const [username, setUsername] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!current) return toast("Enter your current password to confirm changes", "error");
    if (next && next !== confirm) return toast("New passwords don't match", "error");
    if (next && next.length < 6) return toast("New password must be at least 6 characters", "error");
    if (!username.trim() && !next) return toast("Nothing to change", "info");
    setBusy(true);
    try {
      const r = await api.updateAccount({
        currentPassword: current,
        username: username.trim() || undefined,
        newPassword: next || undefined,
      });
      toast(`Account updated${username.trim() ? ` — username is now "${r.username}"` : ""}`, "success");
      setCurrent(""); setUsername(""); setNext(""); setConfirm("");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <p className="text-[13px] text-muted">
        Change your login username or password. Enter your current password to confirm.
      </p>
      <Field label="Current password">
        <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" autoComplete="current-password" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="New username" hint="Leave blank to keep it.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="New username" autoComplete="username" />
        </Field>
        <Field label="New password" hint="Leave blank to keep it.">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password" autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat new password" autoComplete="new-password" />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button loading={busy} onClick={save}>Update account</Button>
      </div>
    </Card>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="prism-text font-bold">›</span>
      <span>{children}</span>
    </li>
  );
}

function DomainModal({ domain, onClose, onSaved }: { domain: Domain; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(domain);
  const [busy, setBusy] = useState(false);

  // Resolve what the From email will actually be saved as (auto-append domain if the
  // user typed only a mailbox like "no-reply").
  const resolvedFrom =
    d.from_email && !d.from_email.includes("@") && d.domain
      ? `${d.from_email.trim()}@${d.domain.trim()}`
      : d.from_email.trim();
  const fromValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resolvedFrom);

  function completeEmail() {
    if (d.from_email && !d.from_email.includes("@") && d.domain) {
      setD((s) => ({ ...s, from_email: `${s.from_email.trim()}@${s.domain.trim()}` }));
    }
  }

  async function save() {
    if (!d.domain.trim()) return toast("Domain is required", "error");
    if (!fromValid) return toast("Enter a full From email like no-reply@" + (d.domain || "yourdomain.com"), "error");
    setBusy(true);
    try {
      const payload = { ...d, from_email: resolvedFrom };
      if (d.id) await api.updateDomain(d.id, payload);
      else await api.saveDomain(payload);
      toast("Saved", "success");
      onSaved();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={d.id ? "Edit domain" : "Add sending domain"}>
      <div className="space-y-4">
        <Field label="Domain" hint="A domain you've verified in Resend (SPF/DKIM added).">
          <Input value={d.domain} onChange={(e) => setD({ ...d, domain: e.target.value })} placeholder="dna-erp.com" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From name">
            <Input value={d.from_name} onChange={(e) => setD({ ...d, from_name: e.target.value })} placeholder="Solution ERP" />
          </Field>
          <Field label="Daily cap">
            <Input type="number" value={d.daily_cap} onChange={(e) => setD({ ...d, daily_cap: Number(e.target.value) })} />
          </Field>
        </div>
        <Field
          label="From email"
          hint={
            d.from_email && !d.from_email.includes("@") && d.domain
              ? `Will be saved as ${resolvedFrom}`
              : "The full address emails are sent from — must be on the verified domain above."
          }
        >
          <Input
            value={d.from_email}
            onChange={(e) => setD({ ...d, from_email: e.target.value })}
            onBlur={completeEmail}
            placeholder="no-reply@dna-erp.com"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} className="accent-ink" />
          Active (include in rotation)
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={save}>Save domain</Button>
        </div>
      </div>
    </Modal>
  );
}
