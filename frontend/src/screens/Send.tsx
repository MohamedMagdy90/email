import { useEffect, useRef, useState } from "react";
import { api, type Contact, type Domain, type Job, type Template } from "../lib/api";
import { Button, Card, Field, Select, Spinner, StatusPill, toast, cn } from "../lib/ui";
import { Header } from "./Contacts";

export default function Send() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [resendOn, setResendOn] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [templateId, setTemplateId] = useState("");
  const [filter, setFilter] = useState("new");
  const [perMinute, setPerMinute] = useState(20);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [job, setJob] = useState<Job | null>(null);
  const pollRef = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const running = job?.status === "running";

  async function loadContacts(status: string) {
    const r = await api.getContacts({ status, limit: 1000 });
    setContacts(r.contacts);
    setSelected(new Set(r.contacts.map((c) => c.id)));
  }

  useEffect(() => {
    (async () => {
      const [t, d, s] = await Promise.all([api.getTemplates(), api.getDomains(), api.getSettings()]);
      setTemplates(t.templates);
      setDomains(d.domains);
      setResendOn(s.resendConfigured);
      if (t.templates[0]) setTemplateId(t.templates[0].id);
      setLoaded(true);
    })();
  }, []);

  useEffect(() => { loadContacts(filter); }, [filter]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [job?.logs?.length]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function toggle(id: string) {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  }
  const allSelected = contacts.length > 0 && selected.size === contacts.length;

  async function start() {
    if (!templateId) return toast("Choose a template", "error");
    if (!selected.size) return toast("Select at least one contact", "error");
    if (!confirm(`Send to ${selected.size} contact(s)?${resendOn ? "" : "\n\nNo Resend key set — this will be a DRY RUN (nothing actually sends)."}`)) return;
    try {
      const { jobId } = await api.startSend({ templateId, contactIds: [...selected], perMinute });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        const j = await api.getSend(jobId).catch(() => null);
        if (j) {
          setJob(j);
          if (j.status !== "running" && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      }, 800);
      setJob(await api.getSend(jobId));
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  const template = templates.find((t) => t.id === templateId);

  return (
    <div>
      <Header title="Send" subtitle="Pick a template, choose who to reach, and send at a safe pace." />

      {/* Banners */}
      {loaded && templates.length === 0 && (
        <Banner tone="warn">
          You don't have any templates yet. Create one on the <b>Templates</b> tab before you can send.
        </Banner>
      )}
      {!resendOn && (
        <Banner tone="warn">
          No Resend API key set — sends run in <b>dry-run</b> mode (nothing is delivered). Add your key in Settings to send for real.
        </Banner>
      )}
      {resendOn && domains.length === 0 && (
        <Banner tone="info">
          No sending domains configured. We'll use Resend's test sender — add a verified secondary domain in Settings for real outreach.
        </Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        {/* Left: setup */}
        <div className="space-y-4">
          <Card className="space-y-4 p-5">
            <Field label="Template">
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Select a template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.type === "partner" ? "◆ " : "● "}{t.name}</option>
                ))}
              </Select>
            </Field>

            <Field label="Send rate" hint="Slower is safer for deliverability.">
              <Select value={perMinute} onChange={(e) => setPerMinute(Number(e.target.value))}>
                <option value={10}>10 / minute (safest)</option>
                <option value={20}>20 / minute</option>
                <option value={40}>40 / minute</option>
                <option value={60}>60 / minute</option>
              </Select>
            </Field>

            <div className="rounded-xl bg-ink/[0.03] p-3 text-[13px]">
              <div className="flex justify-between"><span className="text-muted">Selected</span><span className="font-medium">{selected.size}</span></div>
              <div className="mt-1 flex justify-between"><span className="text-muted">Active domains</span><span className="font-medium">{domains.filter((d) => d.active).length}</span></div>
            </div>

            <Button className="w-full" onClick={start} disabled={running || !selected.size}>
              {running ? <><Spinner className="h-4 w-4" /> Sending…</> : `Send to ${selected.size || 0}`}
            </Button>
          </Card>

          {template && (
            <Card className="p-4">
              <div className="mono-label mb-2 text-muted">Preview subject</div>
              <div className="text-sm font-medium">{template.subject}</div>
            </Card>
          )}

          {/* Progress */}
          {job && (
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-medium">
                  {running ? "Sending…" : job.status === "error" ? <span className="text-bad">Error</span> : <span className="text-good">Complete</span>}
                </span>
                <span className="text-muted">{job.processed}/{job.total}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-ink/[0.07]">
                <div className="prism-bar h-full transition-all" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
              </div>
              {job.result && (
                <div className="flex gap-3 text-xs text-muted">
                  <span>sent {job.result.sent}</span>
                  <span>failed {job.result.failed}</span>
                  <span>skipped {job.result.skipped}</span>
                </div>
              )}
              <div ref={logRef} className="h-24 overflow-y-auto rounded-lg bg-ink px-2.5 py-2 font-mono text-[11px] leading-relaxed text-cream/80">
                {(job.logs || []).map((l, i) => (
                  <div key={i} className={cn(l.level === "sent" && "text-[#7ee7a6]", l.level === "fail" && "text-[#ff9a8a]", l.level === "warn" && "text-[#ffcf7a]")}>{l.msg}</div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Right: recipients */}
        <Card className="flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex rounded-full border border-line bg-cream p-1">
              {["new", "all"].map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cn("rounded-full px-3 py-1 text-[13px] font-medium capitalize", filter === f ? "bg-ink text-cream" : "text-ink/55")}>{f}</button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(contacts.map((c) => c.id)))} className="accent-ink" />
              Select all
            </label>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            {contacts.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted">No contacts in this view.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id} className="border-b border-line-soft last:border-0 hover:bg-ink/[0.015]">
                      <td className="w-8 px-4 py-2.5">
                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="accent-ink" />
                      </td>
                      <td className="px-1 py-2.5 font-medium">{c.email}</td>
                      <td className="px-1 py-2.5 text-ink/60">{c.company || "—"}</td>
                      <td className="px-2 py-2.5 text-right"><StatusPill status={c.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  return (
    <div className={cn(
      "mb-5 rounded-xl border px-4 py-3 text-[13px]",
      tone === "warn" ? "border-[#f0d9b5] bg-[#fdf6ea] text-[#8a5a12]" : "border-[#bcd7f5] bg-[#eef5fd] text-[#245b91]"
    )}>
      {children}
    </div>
  );
}
