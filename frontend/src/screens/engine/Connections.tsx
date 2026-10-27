// Agent → Connections, own engine:
//   OwnMailboxesCard  the Google / Microsoft sign-in apps our mailboxes use
//   TestInboxesCard   the seed inboxes every mailbox sends one test a day to
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Card, Field, Input, Modal, Select, Spinner, cn, toast } from "../../lib/ui";
import { PROVIDER_LABEL, SEED_LABEL, callbackUrl, engineApi, signInWithProvider, type Connection, type EngineStatus, type Provider, type Seed } from "../../lib/v2/engine";
import { CopyField, EngineLabel, ProviderMark, announceStoredOAuth } from "./shared";

const goTab = (t: string) => window.dispatchEvent(new CustomEvent("dna-tab", { detail: t }));

/** One loader for both cards so they never disagree about what is connected. */
export function useEngineStatus() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setStatus(await engineApi.status());
      setError("");
    } catch (e: any) {
      setError(e.message || "Couldn't load the mail accounts.");
    }
  }, []);
  useEffect(() => {
    load();
    announceStoredOAuth(() => load());
  }, [load]);
  return { status, error, reload: load };
}

/* ------------------------------ sign-in apps ------------------------------ */

const SETUP: Record<Provider, { title: string; steps: ReactNode[]; idLabel: string; idHint: string; secretLabel: string }> = {
  google: {
    title: "Google Workspace",
    idLabel: "Client ID",
    idHint: "Ends in .apps.googleusercontent.com",
    secretLabel: "Client secret",
    steps: [
      <>
        Sign in to <span className="font-medium text-ink">console.cloud.google.com</span> as the admin of the NEW Workspace account (the one your
        sending domain is on), create a project and enable the <span className="font-medium text-ink">Gmail API</span>.
      </>,
      <>
        OAuth consent screen: user type <span className="font-medium text-ink">Internal</span>. No Google review, and sign-ins don't expire
        every week.
      </>,
      <>
        Credentials → Create credentials → OAuth client ID → <span className="font-medium text-ink">Web application</span>. Add the redirect URI
        below under "Authorized redirect URIs".
      </>,
      "Paste the client ID and client secret here.",
    ],
  },
  microsoft: {
    title: "Microsoft 365",
    idLabel: "Application (client) ID",
    idHint: "A 36-character ID from the app's Overview page",
    secretLabel: "Client secret value",
    steps: [
      <>
        In <span className="font-medium text-ink">entra.microsoft.com</span> (the NEW Microsoft 365 account): App registrations → New
        registration. Platform <span className="font-medium text-ink">Web</span>, with the redirect URI below.
      </>,
      <>
        API permissions → Microsoft Graph → Delegated: <span className="font-medium text-ink">Mail.Send, Mail.ReadWrite, offline_access, User.Read</span>.
        Then "Grant admin consent".
      </>,
      <>Certificates &amp; secrets → New client secret. Copy the secret's VALUE (shown once), not its ID.</>,
      "Paste the application ID and the secret value here.",
    ],
  },
};

export function OwnMailboxesCard({ status, error, reload }: ReturnType<typeof useEngineStatus>) {
  return (
    <Card className="p-5 sm:p-6">
      <EngineLabel>Sending engine</EngineLabel>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[1.05rem] font-[650] tracking-[-0.01em]">
          Your own mailboxes
          <Badge className="bg-okb text-good">Recommended</Badge>
        </h2>
        {status && status.ownMailboxes > 0 && (
          <button type="button" onClick={() => goTab("mailboxes")} className="text-[12.5px] font-semibold text-accent hover:underline">
            Open Mailboxes →
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        Send from Google Workspace and Microsoft 365 mailboxes you own, through the Gmail API and Microsoft Graph. Replies, bounces and inbox tests
        are read with the same sign-in. Each provider needs one sign-in app, made once in that account.
      </p>

      {status?.secretWarning && (
        <div className="mt-4 rounded-lg border border-wnl bg-wnb px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn">{status.secretWarning}</div>
      )}

      <div className="mt-4 border-t border-line-soft pt-4">
        {!status ? (
          error ? (
            <div className="flex items-center justify-between gap-3 text-[13px] text-bad">
              {error}
              <Button variant="outline" size="sm" onClick={reload}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <Spinner /> Loading…
            </div>
          )
        ) : (
          <div className="space-y-3">
            <CopyField label="Redirect URI (add it to both apps)" value={callbackUrl(status.callbackPath)} />
            {(["google", "microsoft"] as Provider[]).map((p) => (
              <ProviderApp key={p} provider={p} conn={status.connections.find((c) => c.provider === p) || null} onChanged={reload} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function ProviderApp({ provider, conn, onChanged }: { provider: Provider; conn: Connection | null; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const s = SETUP[provider];

  async function addMailbox() {
    if (!conn) return;
    setBusy("add");
    try {
      const r = await signInWithProvider({ connectionId: conn.id, purpose: "mailbox" });
      if (r) toast(r.message, r.ok ? "success" : "error");
      onChanged();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!conn || !window.confirm(`Remove the ${s.title} sign-in app?`)) return;
    setBusy("remove");
    try {
      await engineApi.deleteConnection(conn.id);
      toast("Sign-in app removed.", "success");
      onChanged();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-line-soft bg-surf2">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <ProviderMark provider={provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
            {s.title}
            {conn ? (
              conn.status === "ok" ? (
                <Badge className="bg-okb text-good">App saved</Badge>
              ) : (
                <Badge className="bg-dgb text-bad">Problem</Badge>
              )
            ) : (
              <Badge className="bg-ink/[0.06] text-muted">Not set up</Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">
            {conn
              ? `${conn.mailboxes} mailbox${conn.mailboxes === 1 ? "" : "es"} · ${conn.seeds} test inbox${conn.seeds === 1 ? "" : "es"} · ${conn.clientId.slice(0, 18)}…`
              : "Make the sign-in app once, then add as many mailboxes as you like."}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {conn ? (
            <>
              <Button size="sm" onClick={addMailbox} loading={busy === "add"}>
                Add mailbox
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Set up
            </Button>
          )}
        </div>
      </div>
      {conn?.lastError && <p className="border-t border-line-soft px-3.5 py-2 text-[12.5px] leading-relaxed text-bad">{conn.lastError}</p>}

      <AppModal
        open={editing}
        provider={provider}
        conn={conn}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
        onRemove={conn ? remove : undefined}
        removing={busy === "remove"}
      />
    </div>
  );
}

function AppModal({
  open,
  provider,
  conn,
  onClose,
  onSaved,
  onRemove,
  removing,
}: {
  open: boolean;
  provider: Provider;
  conn: Connection | null;
  onClose: () => void;
  onSaved: () => void;
  onRemove?: () => void;
  removing?: boolean;
}) {
  const s = SETUP[provider];
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (open) {
      setClientId(conn?.clientId || "");
      setSecret("");
      setErr("");
    }
  }, [open, conn]);

  async function save() {
    setSaving(true);
    setErr("");
    try {
      await engineApi.saveConnection(conn ? { id: conn.id, clientId: clientId.trim(), clientSecret: secret.trim() || undefined } : { provider, clientId: clientId.trim(), clientSecret: secret.trim() });
      toast(conn ? "Sign-in app updated." : `${s.title} sign-in app saved. Now add a mailbox.`, "success");
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`${s.title} sign-in app`} wide>
      <ol className="-mt-1 space-y-3">
        {s.steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-line-strong bg-sunk text-[11px] font-bold tabular-nums text-ink-soft">{i + 1}</span>
            <div className="min-w-0 flex-1 pt-px text-[13px] leading-relaxed text-muted">
              {step}
              {i === (provider === "google" ? 2 : 0) && <CopyField className="mt-2" value={callbackUrl()} />}
            </div>
          </li>
        ))}
      </ol>
      <form
        className="mt-5 grid gap-3 border-t border-line-soft pt-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label={s.idLabel} hint={s.idHint}>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" data-1p-ignore data-lpignore="true" data-bwignore spellCheck={false} />
        </Field>
        <Field label={s.secretLabel} hint={conn ? "Leave empty to keep the saved secret." : "Stored encrypted. Never shown again."}>
          <Input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            placeholder={conn ? "••••••••" : ""}
          />
        </Field>
        {err && <p className="text-[12.5px] leading-relaxed text-bad sm:col-span-2">{err}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
          {onRemove ? (
            <Button type="button" variant="ghost" size="sm" onClick={onRemove} loading={removing} className="text-bad">
              Remove app
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving} disabled={!clientId.trim() || (!conn && !secret.trim())}>
              Save app
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------- test inboxes ------------------------------- */

export function TestInboxesCard({ status, reload }: ReturnType<typeof useEngineStatus>) {
  const [imapOpen, setImapOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const seeds = status?.seeds || [];
  const conns = status?.connections || [];

  async function signInSeed(conn: Connection) {
    setBusy(`seed-${conn.id}`);
    try {
      const r = await signInWithProvider({ connectionId: conn.id, purpose: "seed" });
      if (r) toast(r.message, r.ok ? "success" : "error");
      reload();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function act(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    try {
      await fn();
      if (done) toast(done, "success");
      reload();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  const hasBusiness = seeds.some((s) => s.provider === "workspace" && s.enabled) && seeds.some((s) => s.provider === "m365" && s.enabled);

  return (
    <Card className="p-5 sm:p-6">
      <EngineLabel>Deliverability</EngineLabel>
      <h2 className="mt-1.5 text-[1.05rem] font-[650] tracking-[-0.01em]">Test inboxes</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        Every mailbox sends each test inbox one real email a day, and we look where it landed: inbox, other tab, spam or nowhere. That decides
        when a mailbox may start sending, and pauses it if mail starts going to spam. Use inboxes on accounts SEPARATE from your senders.
      </p>
      {status && !hasBusiness && (
        <div className="mt-3 rounded-lg border border-keepl bg-keep1 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-soft">
          Best results: one <span className="font-semibold">Google Workspace</span> and one <span className="font-semibold">Microsoft 365</span> test
          inbox (they count double). An existing dna.systems mailbox can be one of them.
        </div>
      )}

      <div className="mt-4 border-t border-line-soft pt-4">
        {seeds.length > 0 && (
          <ul className="mb-4 divide-y divide-line-soft overflow-hidden rounded-xl border border-line-soft">
            {seeds.map((s) => (
              <SeedRow
                key={s.id}
                s={s}
                busy={busy}
                onTest={() =>
                  act(`test-${s.id}`, async () => {
                    const r = await engineApi.testSeed(s.id);
                    if (!r.ok) throw new Error(r.error || "Couldn't reach the test inbox.");
                  }, "Test inbox answered.")
                }
                onToggle={() => act(`tog-${s.id}`, () => engineApi.updateSeed(s.id, { enabled: !s.enabled }))}
                onDelete={() => window.confirm(`Remove the test inbox ${s.email}?`) && act(`del-${s.id}`, () => engineApi.deleteSeed(s.id), "Test inbox removed.")}
              />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          {conns.map((c) => (
            <Button key={c.id} variant="outline" size="sm" loading={busy === `seed-${c.id}`} onClick={() => signInSeed(c)}>
              Sign in a {c.provider === "microsoft" ? "Microsoft 365" : "Google"} test inbox
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setImapOpen(true)}>
            Add over IMAP
          </Button>
        </div>
        {conns.length === 0 && status && (
          <p className="mt-2 text-[12px] leading-relaxed text-muted">Save a Google or Microsoft sign-in app above to sign test inboxes in. Gmail / Outlook.com can use IMAP.</p>
        )}
      </div>

      <ImapModal open={imapOpen} onClose={() => setImapOpen(false)} onSaved={() => (setImapOpen(false), reload())} />
    </Card>
  );
}

function SeedRow({ s, busy, onTest, onToggle, onDelete }: { s: Seed; busy: string | null; onTest: () => void; onToggle: () => void; onDelete: () => void }) {
  const rate = s.last7.tests ? Math.round((s.last7.inbox / s.last7.tests) * 100) : null;
  return (
    <li className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5", !s.enabled && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{s.email}</span>
          <Badge className={s.provider === "workspace" || s.provider === "m365" ? "bg-tlb text-accent" : "bg-ink/[0.06] text-ink-soft"}>{SEED_LABEL[s.provider] || s.provider}</Badge>
          {s.status !== "ok" && <Badge className="bg-dgb text-bad">Can't reach</Badge>}
          {!s.enabled && <Badge className="bg-ink/[0.06] text-muted">Off</Badge>}
        </div>
        <div className="mt-0.5 text-[12px] text-muted">
          {s.lastError
            ? s.lastError
            : s.last7.tests
              ? `${s.last7.tests} tests in 7 days · ${rate}% inbox · ${s.last7.spam} spam · ${s.last7.missing} missing`
              : "No tests yet. They start within the hour."}
        </div>
      </div>
      <div className="flex gap-1.5">
        <Button variant="ghost" size="sm" onClick={onTest} loading={busy === `test-${s.id}`}>
          Test
        </Button>
        <Button variant="ghost" size="sm" onClick={onToggle} loading={busy === `tog-${s.id}`}>
          {s.enabled ? "Turn off" : "Turn on"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} loading={busy === `del-${s.id}`} className="text-bad">
          Remove
        </Button>
      </div>
    </li>
  );
}

const IMAP_HOSTS: Record<string, string> = { gmail: "imap.gmail.com", outlook: "outlook.office365.com" };

function ImapModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ email: "", host: "", port: "993", password: "", preset: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (open) {
      setF({ email: "", host: "", port: "993", password: "", preset: "" });
      setErr("");
    }
  }, [open]);

  async function save() {
    setSaving(true);
    setErr("");
    try {
      await engineApi.addImapSeed({ email: f.email.trim(), host: f.host.trim(), port: Number(f.port) || 993, password: f.password });
      toast("Test inbox connected.", "success");
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a test inbox over IMAP">
      <p className="-mt-1 mb-4 text-[13px] leading-relaxed text-muted">
        For a personal Gmail or Outlook.com inbox. Gmail needs 2-step verification and an <span className="font-medium text-ink">app password</span>{" "}
        (myaccount.google.com → Security → App passwords). The password is stored encrypted.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Email address">
          <Input
            type="email"
            value={f.email}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            onChange={(e) => {
              const email = e.target.value;
              const preset = /@(gmail|googlemail)\.com$/i.test(email) ? "gmail" : /@(outlook|hotmail|live)\./i.test(email) ? "outlook" : "";
              setF((x) => ({ ...x, email, preset, host: preset && (!x.host || Object.values(IMAP_HOSTS).includes(x.host)) ? IMAP_HOSTS[preset] : x.host }));
            }}
          />
        </Field>
        <Field label="Provider">
          <Select value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value, host: IMAP_HOSTS[e.target.value] || f.host })}>
            <option value="">Other</option>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook.com</option>
          </Select>
        </Field>
        <Field label="IMAP server">
          <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="imap.example.com" spellCheck={false} />
        </Field>
        <Field label="Port">
          <Input inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/[^\d]/g, "") })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Password (app password for Gmail)">
            <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore />
          </Field>
        </div>
        {err && <p className="text-[12.5px] leading-relaxed text-bad sm:col-span-2">{err}</p>}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={saving} disabled={!f.email.trim() || !f.host.trim() || !f.password}>
            Connect
          </Button>
        </div>
      </form>
    </Modal>
  );
}
