// One lead, in a drawer: who, where it is, what happened (events and the email
// thread on one timeline), the emails, the research, and every action.
// Used by the Leads tab, the Pipeline board and the campaign view.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Input, Select, Spinner, Textarea, cn, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import { campaignsApi, STAGE_LABEL } from "../../lib/v2/campaigns";
import { leadsApi, PIPELINE_COLUMNS, type LeadDetail, type PipelineStage } from "../../lib/v2/leads";
import { EmailSteps } from "../campaigns/Leads";
import { EmailStatusChip, SectionLabel, StageChip, errMsg, openCampaign, openThread, plural } from "../campaigns/parts";
import { Segmented } from "../targeting/controls";
import { Menu } from "../shared/Menu";
import { useCampaignList } from "../shared/CampaignFilter";

const PRE_CONTACT = ["found", "researched", "contact_found", "verified", "written", "approved"];
const PRE_INSTANTLY = [...PRE_CONTACT, "skipped", "failed"];
const CONTACTED = ["queued", "sent", "replied", "interested", "meeting", "won", "lost"];
const EDITABLE = ["verified", "written", "approved"];

type DrawerTab = "overview" | "timeline" | "emails" | "research";

const initials = (s: string) => (s.trim().split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("") || "?").toUpperCase();
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

export default function LeadDrawer({ pid, onClose, onChanged }: { pid: string; onClose: () => void; onChanged?: () => void }) {
  const [p, setP] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DrawerTab>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ fullName: string; title: string; email: string } | null>(null);
  const campaigns = useCampaignList();

  const load = useCallback(async () => {
    try {
      setP((await leadsApi.get(pid)).lead);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [pid]);
  useEffect(() => {
    setP(null);
    setTab("overview");
    setEdit(null);
    setMoveTo(null);
    load();
  }, [load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const act = async (key: string, fn: () => Promise<unknown>, msg?: string | ((r: any) => string)) => {
    setBusy(key);
    try {
      const r = await fn();
      if (msg) toast(typeof msg === "function" ? msg(r) : msg, "success");
      await load();
      onChanged?.();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const bulk = (key: string, body: Parameters<typeof leadsApi.bulk>[0], ok: string) =>
    act(key, () => leadsApi.bulk(body), (r: any) => (r.done ? ok : r.notes?.[0] || "Nothing changed."));

  const timeline = useMemo(() => {
    if (!p) return [];
    const items: { at: string; kind: "event" | "mail"; key: string; node: any }[] = [];
    for (const e of p.events) items.push({ at: e.created_at, kind: "event", key: `e${e.id}`, node: e });
    for (const m of p.thread?.messages || []) items.push({ at: m.sentAt || "", kind: "mail", key: `m${m.id}`, node: m });
    return items.sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [p]);

  const tabs: { id: DrawerTab; label: string; sub?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "timeline", label: "Timeline", sub: timeline.length ? String(timeline.length) : undefined },
    { id: "emails", label: "Emails", sub: p?.emails ? String(p.emails.steps.length) : undefined },
    { id: "research", label: "Research" },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/45 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="drawer-in relative flex h-full w-full max-w-[620px] flex-col border-l border-line bg-cream shadow-2xl">
        {/* head */}
        <div className="flex items-start justify-between gap-3 border-b border-line-soft bg-paper px-5 py-4">
          <div className="min-w-0">
            <div className="mono-label mb-1 text-muted">Lead</div>
            <div className="truncate text-[17px] font-[650] tracking-[-0.015em]">{p ? p.company || p.domain || "Unknown company" : "Loading…"}</div>
            {p?.website && (
              <a href={p.website} target="_blank" rel="noreferrer" className="text-[12.5px] text-accent hover:underline">
                {p.domain}
              </a>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {!p ? (
          <div className="flex items-center gap-2 p-6 text-muted">{error ? <span className="text-bad">{error}</span> : <><Spinner /> Loading…</>}</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* identity + actions */}
            <div className="border-b border-line-soft px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="ib-av lg">{initials(p.fullName || p.email || p.company || "?")}</div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-semibold">
                    {p.fullName || "No named person"}
                    {p.title && <span className="font-normal text-muted">, {p.title}</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px]">
                    <span className="text-ink-soft">{p.email || "No address yet"}</span>
                    <EmailStatusChip status={p.emailStatus} />
                    {p.linkedinUrl && (
                      <a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        LinkedIn
                      </a>
                    )}
                  </div>
                </div>
                {PRE_CONTACT.includes(p.stage) && !edit && (
                  <button type="button" className="shrink-0 text-[12px] font-semibold text-accent hover:underline" onClick={() => setEdit({ fullName: p.fullName || "", title: p.title || "", email: p.email || "" })}>
                    Edit
                  </button>
                )}
              </div>
              {edit && (
                <div className="mt-3 space-y-2 rounded-lg border border-line-soft bg-paper p-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} placeholder="Name" aria-label="Name" />
                    <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Title" aria-label="Title" />
                  </div>
                  <Input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} placeholder="Email" aria-label="Email" />
                  <p className="text-[12px] text-muted">A new address is checked again before anything is sent.</p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      loading={busy === "person"}
                      onClick={() =>
                        act("person", async () => {
                          await campaignsApi.updateProspect(p.campaignId, p.id, { fullName: edit.fullName, title: edit.title, ...(edit.email.trim() && edit.email.trim() !== p.email ? { email: edit.email.trim() } : {}) });
                          setEdit(null);
                        }, "Saved.")
                      }
                    >
                      Save
                    </Button>
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <StageChip stage={p.stage} />
                <button type="button" onClick={() => openCampaign(p.campaign.id)} className="rounded-full bg-ink/[0.05] px-2 py-[2px] text-[11.5px] text-ink-soft hover:bg-hov hover:text-ink">
                  {p.campaign.name}
                </button>
                {p.segmentName && <span className="rounded-full bg-ink/[0.05] px-2 py-[2px] text-[11.5px] text-muted">{p.segmentName}</span>}
                {p.alsoIn.map((a) => (
                  <span key={a.campaignId} className="rounded-full bg-inb px-2 py-[2px] text-[11.5px] text-inf" title={`Stage there: ${a.stage}`}>
                    also in {a.campaignName}
                  </span>
                ))}
              </div>
              {p.stageReason && <p className="mt-2.5 text-[13px] leading-relaxed text-ink-soft">{p.stageReason}</p>}
              {p.lastError && <p className="mt-1 text-[12.5px] text-bad">Last error: {p.lastError}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {p.stage === "written" && (
                  <Button size="sm" loading={busy === "approve"} onClick={() => bulk("approve", { action: "approve", ids: [p.id] }, "Approved.")}>
                    Approve
                  </Button>
                )}
                {["skipped", "failed"].includes(p.stage) && (
                  <Button size="sm" variant="outline" loading={busy === "restore"} onClick={() => bulk("restore", { action: "restore", ids: [p.id] }, "Put back into the pipeline.")}>
                    Put back
                  </Button>
                )}
                {p.thread && (
                  <Button size="sm" variant="outline" onClick={() => openThread(p.thread!.id)}>
                    Open in Inbox
                  </Button>
                )}
                <Menu
                  label="More"
                  align="left"
                  items={[
                    PRE_CONTACT.includes(p.stage) && { label: "Skip this lead", hint: "It leaves the pipeline; you can put it back.", onClick: () => bulk("skip", { action: "skip", ids: [p.id], reason: "From the lead panel" }, "Skipped."), danger: true },
                    PRE_INSTANTLY.includes(p.stage) && { label: "Research again", hint: "Reads the website afresh, then runs the pipeline again.", onClick: () => bulk("rr", { action: "reresearch", ids: [p.id] }, "Back to research.") },
                    PRE_INSTANTLY.includes(p.stage) && !!p.email && { label: "Check the address again", onClick: () => bulk("rv", { action: "reverify", ids: [p.id] }, "Checking the address again.") },
                    PRE_INSTANTLY.includes(p.stage) && { label: "Move to another campaign…", onClick: () => setMoveTo("") },
                    { label: "Never contact this company", hint: p.domain || undefined, onClick: () => bulk("dncd", { action: "dnc_domain", ids: [p.id], reason: "From the lead panel" }, "Added to do-not-contact."), danger: true },
                    !!p.email && { label: "Never email this address", hint: p.email || undefined, onClick: () => bulk("dnce", { action: "dnc_email", ids: [p.id], reason: "From the lead panel" }, "Added to do-not-contact."), danger: true },
                  ]}
                />
              </div>
              {moveTo !== null && (
                <div className="mt-3 flex flex-col gap-2 rounded-lg border border-line-soft bg-paper p-3 sm:flex-row sm:items-center">
                  <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="h-9 py-0 text-[13px]">
                    <option value="">Pick a campaign…</option>
                    {(campaigns || []).filter((c) => c.id !== p.campaign.id).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={!moveTo} loading={busy === "move"} onClick={() => bulk("move", { action: "move", ids: [p.id], campaignId: moveTo }, "Moved. It starts again in that campaign.").then(() => setMoveTo(null))}>
                      Move
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setMoveTo(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* tabs */}
            <nav className="flex gap-1 border-b border-line-soft px-3">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn("-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-[12.5px] font-semibold transition-colors", tab === t.id ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
                >
                  {t.label}
                  {t.sub && <span className="text-[11px] font-normal text-muted">{t.sub}</span>}
                </button>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              {tab === "overview" && <Overview p={p} busy={busy} act={act} />}
              {tab === "timeline" && (
                <div className="space-y-3">
                  {p.thread && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-soft bg-paper px-3 py-2 text-[12.5px]">
                      <span className="min-w-0 truncate text-ink-soft">
                        Thread: <b className="font-semibold text-ink">{p.thread.subject || "(no subject)"}</b> · {plural(p.thread.messages.length, "email")}
                      </span>
                      <button type="button" className="font-semibold text-accent hover:underline" onClick={() => openThread(p.thread!.id)}>
                        Open in Inbox
                      </button>
                    </div>
                  )}
                  {!timeline.length && <p className="text-[13px] text-muted">Found {ago(p.createdAt)}. Nothing else has happened yet.</p>}
                  {timeline.map((it) =>
                    it.kind === "mail" ? (
                      <div key={it.key} className={cn("ib-mail !min-w-0 !max-w-full", it.node.direction === "in" ? "in" : "out", it.node.direction === "out" && it.node.sentBy === "agent" && "ai")}>
                        <div className="mh">
                          <b>{it.node.direction === "in" ? p.fullName || it.node.from || "Them" : it.node.sentBy === "agent" ? "Agent" : "You"}</b>
                          {it.node.step && <span>step {it.node.step}</span>}
                          {it.node.autoReply && <Badge className="bg-ink/[0.06] text-muted">auto-reply</Badge>}
                          {it.node.classification && <Badge className="bg-inb text-inf">{it.node.classification.replace(/_/g, " ")}</Badge>}
                          <time>{ago(it.node.sentAt)}</time>
                        </div>
                        {it.node.subject && <div className="ms">{it.node.subject}</div>}
                        <div className="mb">{it.node.body.length > 900 ? `${it.node.body.slice(0, 900)}…` : it.node.body}</div>
                      </div>
                    ) : (
                      <div key={it.key} className="flex gap-2.5 text-[12.5px]">
                        <span className={cn("mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full", it.node.level === "warn" || it.node.level === "error" ? "bg-warn" : it.node.level === "success" ? "bg-good" : "bg-ink/30")} />
                        <span className="min-w-0 flex-1 leading-snug text-ink-soft">{it.node.message}</span>
                        <span className="shrink-0 whitespace-nowrap text-muted">{ago(it.node.created_at)}</span>
                      </div>
                    )
                  )}
                </div>
              )}
              {tab === "emails" && <Emails p={p} act={act} busy={busy} />}
              {tab === "research" && <Research p={p} />}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

/* ------------------------------- overview ------------------------------- */

function Overview({ p, busy, act }: { p: LeadDetail; busy: string | null; act: (k: string, fn: () => Promise<unknown>, m?: string) => Promise<void> }) {
  const [notes, setNotes] = useState(p.notes || "");
  const [saved, setSaved] = useState(false);
  useEffect(() => setNotes(p.notes || ""), [p.id, p.notes]);
  const steps = p.emails?.steps || [];
  const sentCount = p.stage === "queued" ? 0 : CONTACTED.includes(p.stage) || ["bounced", "unsubscribed"].includes(p.stage) ? Math.max(1, p.lastStep || 1) : 0;

  return (
    <div className="space-y-6">
      {CONTACTED.includes(p.stage) && p.stage !== "queued" && (
        <section>
          <SectionLabel>Pipeline</SectionLabel>
          <Segmented
            size="sm"
            value={(PIPELINE_COLUMNS.some((c) => c.id === p.stage) ? p.stage : "") as PipelineStage}
            options={PIPELINE_COLUMNS.map((c) => ({ id: c.id, label: c.label }))}
            onChange={(s) => act("stage", () => leadsApi.setStage(p.id, s), `Moved to ${PIPELINE_COLUMNS.find((c) => c.id === s)?.label}.`)}
          />
          <p className="mt-1.5 text-[12px] text-muted">Overrides how the Inbox read the reply, and updates the lead's status in Instantly.</p>
        </section>
      )}

      {steps.length > 0 && (
        <section>
          <SectionLabel right={p.nextStep ? <span className="text-[12px] text-accent">{p.nextStep.label}</span> : null}>Sequence</SectionLabel>
          <ol className="relative space-y-0">
            {steps.map((s, i) => {
              const n = i + 1;
              const sent = n <= sentCount;
              const next = p.nextStep?.step === n;
              const replied = p.repliedStep === n;
              return (
                <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
                  {i < steps.length - 1 && <span className="absolute left-[7px] top-[18px] h-[calc(100%-14px)] w-px bg-line" />}
                  <span className={cn("relative mt-1 grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border", sent ? "border-brand bg-brand" : next ? "border-accent bg-keep1" : "border-line-strong bg-paper")}>
                    {sent && <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 5.2l2 2L8 3" fill="none" stroke="var(--acf)" strokeWidth="1.8" strokeLinecap="round" /></svg>}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">
                      {i === 0 ? "First email" : `Follow-up ${i}`}
                      <span className="ml-2 text-[12px] font-normal text-muted">{i === 0 ? "day 0" : `+${s.delayDays} day${s.delayDays === 1 ? "" : "s"}`}</span>
                    </div>
                    <div className="truncate text-[12.5px] text-muted">
                      {sent ? (i === 0 && p.sentAt ? `Sent ${day(p.sentAt)}` : n === sentCount && p.lastStepAt ? `Sent ${day(p.lastStepAt)}` : "Sent") : next ? p.nextStep?.at ? `Due ${day(p.nextStep.at)}` : "Next" : i === 0 ? s.subject : "Waiting"}
                      {replied && <span className="ml-2 font-semibold text-good">replied to this one</span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {(p.fitScore != null || p.targetNotes) && (
        <section>
          <SectionLabel>Fit</SectionLabel>
          <div className="flex items-start gap-3">
            {p.fitScore != null && <div className={cn("text-[1.6rem] font-bold leading-none tabular-nums", p.fitScore >= 70 ? "text-accent" : p.fitScore >= 50 ? "text-warn" : "text-bad")}>{p.fitScore}</div>}
            <div className="min-w-0 text-[13px] leading-relaxed text-ink-soft">
              {p.fitReason}
              {p.targetNotes && <div className="mt-1 text-[12px] text-warn">{p.targetNotes}</div>}
            </div>
          </div>
        </section>
      )}

      <section>
        <SectionLabel>Address</SectionLabel>
        <div className="space-y-1 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span>{p.email || "No address yet"}</span>
            <EmailStatusChip status={p.emailStatus} />
            {p.emailSource && <span className="text-[12px] text-muted">{p.emailSource === "published" ? "published on the site" : p.emailSource === "pattern" ? "from the name pattern" : p.emailSource === "role" ? "role address" : p.emailSource === "import" ? "imported from a file" : "entered by hand"}</span>}
          </div>
          {p.verify?.reasons?.length ? <div className="text-[12px] text-muted">{p.verify.reasons.join(" · ")}</div> : null}
          {p.verify && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(
                [
                  ["MX", p.verify.checks.mx],
                  ["Not disposable", !p.verify.checks.disposable],
                  ["Personal (not role)", !p.verify.checks.role],
                  ["Company domain", !p.verify.checks.free],
                ] as [string, boolean][]
              ).map(([l, okk]) => (
                <span key={l} className={cn("rounded-full px-2 py-[2px] text-[11px]", okk ? "bg-okb text-good" : "bg-wnb text-warn")}>
                  {l}
                </span>
              ))}
              {p.verify.checks.smtp && <span className="rounded-full bg-inb px-2 py-[2px] text-[11px] text-inf">SMTP {p.verify.checks.smtp}</span>}
            </div>
          )}
        </div>
      </section>

      <section>
        <SectionLabel right={saved ? <span className="text-[12px] text-good">Saved</span> : null}>Notes</SectionLabel>
        <Textarea
          rows={3}
          value={notes}
          placeholder="Anything worth remembering about this lead. Only you see this."
          onChange={(e) => {
            setNotes(e.target.value);
            setSaved(false);
          }}
          onBlur={async () => {
            if (notes === (p.notes || "")) return;
            try {
              await leadsApi.setNotes(p.id, notes);
              setSaved(true);
            } catch (e) {
              toast(errMsg(e), "error");
            }
          }}
        />
      </section>

      <section className="text-[12px] text-muted">
        Found {ago(p.createdAt)}
        {p.leadSource ? ` by ${p.leadSource === "gemini" ? "Gemini search" : p.leadSource === "search" ? "web search" : p.leadSource === "import" ? "a file import" : "hand"}` : ""} · {STAGE_LABEL[p.stage]} since {ago(p.updatedAt)}
        {busy === "stage" && <Spinner className="ml-2 h-3 w-3" />}
      </section>
    </div>
  );
}

/* -------------------------------- emails -------------------------------- */

function Emails({ p, act, busy }: { p: LeadDetail; act: (k: string, fn: () => Promise<unknown>, m?: string) => Promise<void>; busy: string | null }) {
  const [rewrite, setRewrite] = useState<string | null>(null);
  if (!p.emails) {
    return (
      <p className="text-[13px] text-muted">
        {p.stage === "verified" ? (p.ai ? "Waiting to be written in the next pass." : "Waiting for an AI key to write them.") : CONTACTED.includes(p.stage) ? "The copy for this lead isn't stored." : "Written once the lead is verified and scored."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <EmailSteps emails={p.emails} editable={EDITABLE.includes(p.stage)} onSave={async (steps) => act("copy", () => campaignsApi.updateProspect(p.campaignId, p.id, { steps }), "Copy saved.")} />
      {EDITABLE.includes(p.stage) && p.ai && (
        <div className="border-t border-line-soft pt-3">
          {rewrite === null ? (
            <Button variant="outline" size="sm" onClick={() => setRewrite("")}>
              Rewrite…
            </Button>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={rewrite} onChange={(e) => setRewrite(e.target.value)} placeholder="Optional: what to change, e.g. shorter, more formal, mention ZATCA" />
              <Button
                size="sm"
                loading={busy === "rw"}
                onClick={() =>
                  act("rw", async () => {
                    await campaignsApi.rewrite(p.campaignId, p.id, rewrite || undefined);
                    setRewrite(null);
                  }, "Rewritten.")
                }
              >
                Rewrite
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- research ------------------------------- */

function Research({ p }: { p: LeadDetail }) {
  const r = p.research;
  if (!r.researchedAt) return <p className="text-[13px] text-muted">Not researched yet. It happens in the next pass.</p>;
  return (
    <div className="space-y-4 text-[13px]">
      {r.researchStatus === "blocked" && <p className="text-warn">The site couldn't be read (it blocks automated visits).</p>}
      {r.researchStatus === "partial" && <p className="text-muted">Basic read only. The AI goes deeper once a key is connected.</p>}
      {r.description && <p className="leading-relaxed text-ink-soft">{r.description}</p>}
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
        {(
          [
            ["Industry", p.industry],
            ["Size", r.sizeHint],
            ["Location", [p.city, p.country].filter(Boolean).join(", ")],
            ["Phone", r.phone],
            ["Researched", ago(r.researchedAt)],
          ] as [string, string | null][]
        )
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="text-ink-soft">{v}</dd>
            </div>
          ))}
      </dl>
      {r.hooks.length > 0 && (
        <div>
          <SectionLabel>Hooks</SectionLabel>
          <ul className="list-disc space-y-1 pl-5 text-ink-soft">
            {r.hooks.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      {r.people.length > 0 && (
        <div>
          <SectionLabel>People on the site</SectionLabel>
          <ul className="space-y-0.5 text-ink-soft">
            {r.people.map((x) => (
              <li key={x.name}>
                {x.name}
                {x.title ? <span className="text-muted">, {x.title}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.emailsOnSite.length > 0 && <div className="text-[12.5px] text-muted">Addresses on the site: {r.emailsOnSite.join(", ")}</div>}
      {r.sources.length > 0 && (
        <div className="text-[12px] text-muted">
          Read:{" "}
          {r.sources.map((s, i) => (
            <span key={s}>
              {i > 0 && " · "}
              <a href={s} target="_blank" rel="noreferrer" className="hover:underline">
                {s.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}
              </a>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
