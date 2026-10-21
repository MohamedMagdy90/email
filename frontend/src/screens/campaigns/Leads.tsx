// Review queue, leads table and the lead panel.
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, Select, Spinner, Textarea, cn, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import { campaignsApi, STAGE_LABEL, type CampaignDetail, type ProspectDetail, type ProspectEmails, type ProspectRow, type StageGroup } from "../../lib/v2/campaigns";
import { EmailStatusChip, Empty, QUIET, SectionLabel, StageChip, errMsg, plural } from "./parts";

/* --------------------------- email steps view -------------------------- */

export function EmailSteps({ emails, editable, onSave }: { emails: ProspectEmails; editable?: boolean; onSave?: (steps: { subject: string; body: string }[]) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ subject: string; body: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (draft) {
    return (
      <div className="space-y-3">
        {draft.map((s, i) => (
          <div key={i} className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{i === 0 ? "First email" : `Follow-up ${i}`}</div>
            {i === 0 && <Input value={s.subject} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, subject: e.target.value } : d)))} placeholder="Subject" />}
            <Textarea rows={i === 0 ? 8 : 5} value={s.body} dir={emails.language === "ar" ? "rtl" : undefined} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, body: e.target.value } : d)))} />
          </div>
        ))}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave?.(draft);
                setDraft(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save copy
          </Button>
        </div>
      </div>
    );
  }
  const [first, ...rest] = emails.steps;
  return (
    <div className="space-y-3" dir={emails.language === "ar" ? "rtl" : undefined}>
      {first && (
        <div className="rounded-lg border border-line-soft bg-sunk px-4 py-3">
          <div className="text-[13.5px] font-semibold">{first.subject}</div>
          <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{first.body}</div>
        </div>
      )}
      {rest.length > 0 && (
        <div>
          <button type="button" onClick={() => setOpen(!open)} className="text-[12.5px] font-semibold text-accent hover:underline" dir="ltr">
            {open ? "Hide" : "Show"} {plural(rest.length, "follow-up")}
          </button>
          {open && (
            <div className="mt-2 space-y-2">
              {rest.map((s, i) => (
                <div key={i} className="rounded-lg border border-line-soft px-4 py-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted" dir="ltr">
                    Follow-up {i + 1} · after {plural(s.delayDays, "day")}
                  </div>
                  <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{s.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {emails.warnings.length > 0 && (
        <ul className="space-y-1 text-[12px] text-warn" dir="ltr">
          {emails.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {editable && (
        <div dir="ltr">
          <Button variant="ghost" size="sm" onClick={() => setDraft(emails.steps.map((s) => ({ subject: s.subject, body: s.body })))}>
            Edit copy
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- review ------------------------------- */

export function ReviewTab({ c, version, onChanged, onOpenLead }: { c: CampaignDetail; version: number; onChanged: () => void; onOpenLead: (id: string) => void }) {
  const [rows, setRows] = useState<ProspectRow[] | null>(null);
  const [details, setDetails] = useState<Record<string, ProspectDetail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rewriteFor, setRewriteFor] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");

  const load = useCallback(async () => {
    const r = await campaignsApi.prospects(c.id, { stage: "review", limit: 20 });
    setRows(r.prospects);
    const next: Record<string, ProspectDetail> = {};
    await Promise.all(r.prospects.map(async (p) => (next[p.id] = (await campaignsApi.prospect(c.id, p.id)).prospect)));
    setDetails(next);
  }, [c.id]);

  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, [load, version]);

  const act = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (msg) toast(msg, "success");
      await load();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  if (!rows) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted">
        <Spinner /> Loading the review queue…
      </div>
    );
  }
  if (!rows.length) {
    return (
      <Empty
        title="Nothing to review"
        body={
          c.settings.reviewFirst
            ? "Written emails show up here before they go out. The agent writes them once a lead is researched, verified and scored."
            : "Review is off for this campaign: emails that pass the checks go straight to Instantly. Turn it on in Settings to approve them first."
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          {plural(c.reviewCount, "email")} waiting. Approved emails go to Instantly within today's limit{c.status !== "active" ? " once the campaign is started" : ""}.
        </p>
        <Button size="sm" loading={busy === "all"} onClick={() => act("all", () => campaignsApi.approve(c.id, { all: true }), `Approved ${plural(c.reviewCount, "email")}.`)}>
          Approve all {c.reviewCount}
        </Button>
      </div>
      {rows.map((p) => {
        const d = details[p.id];
        return (
          <Card key={p.id} className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <button type="button" className="min-w-0 text-left" onClick={() => onOpenLead(p.id)}>
                <div className="text-[14.5px] font-[650] tracking-[-0.01em] hover:underline">{p.company || p.domain}</div>
                <div className="mt-0.5 text-[12.5px] text-muted">
                  {[p.fullName, p.title].filter(Boolean).join(", ") || "Role address"} · {p.email} {p.city || p.country ? `· ${[p.city, p.country].filter(Boolean).join(", ")}` : ""}
                </div>
              </button>
              <div className="flex items-center gap-1.5">
                <EmailStatusChip status={p.emailStatus} />
                {p.fitScore != null && <Badge className="bg-tlb text-accent">Fit {p.fitScore}</Badge>}
              </div>
            </div>
            {p.fitReason && <p className="mt-2 text-[12.5px] text-ink-soft">{p.fitReason}</p>}
            <div className="mt-3">
              {d?.emails ? (
                <EmailSteps emails={d.emails} editable onSave={async (steps) => act(`edit-${p.id}`, () => campaignsApi.updateProspect(c.id, p.id, { steps }), "Copy saved.")} />
              ) : (
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  <Spinner /> Loading the emails…
                </div>
              )}
            </div>
            {rewriteFor === p.id && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Optional: what to change, e.g. shorter, mention ZATCA, more formal" />
                <Button
                  size="sm"
                  loading={busy === `rw-${p.id}`}
                  onClick={() =>
                    act(`rw-${p.id}`, async () => {
                      await campaignsApi.rewrite(c.id, p.id, instruction || undefined);
                      setRewriteFor(null);
                      setInstruction("");
                    }, "Rewritten.")
                  }
                >
                  Rewrite
                </Button>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line-soft pt-3">
              <Button size="sm" loading={busy === `ok-${p.id}`} onClick={() => act(`ok-${p.id}`, () => campaignsApi.approve(c.id, { ids: [p.id] }), "Approved.")}>
                Approve
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRewriteFor(rewriteFor === p.id ? null : p.id)} disabled={!c.readiness.ai}>
                Rewrite…
              </Button>
              <Button variant="ghost" size="sm" className="text-bad" loading={busy === `skip-${p.id}`} onClick={() => act(`skip-${p.id}`, () => campaignsApi.skip(c.id, { ids: [p.id], reason: "Rejected in review" }), "Skipped.")}>
                Skip
              </Button>
            </div>
          </Card>
        );
      })}
      {c.reviewCount > rows.length && <p className="text-center text-[12.5px] text-muted">Showing the first {rows.length}. Approve or skip these to see the rest.</p>}
    </div>
  );
}

/* -------------------------------- leads ------------------------------- */

const GROUPS: { id: StageGroup; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pipeline", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "outreach", label: "Outreach" },
  { id: "replies", label: "Replies" },
  { id: "excluded", label: "Skipped" },
];
const PAGE = 50;

export function LeadsTab({ c, version, group, setGroup, onOpenLead }: { c: CampaignDetail; version: number; group: StageGroup; setGroup: (g: StageGroup) => void; onOpenLead: (id: string) => void }) {
  const [segment, setSegment] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ prospects: ProspectRow[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setOffset(0), [group, segment, query]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    campaignsApi
      .prospects(c.id, { stage: group, segment: segment || undefined, q: query || undefined, limit: PAGE, offset })
      .then((r) => alive && setData(r))
      .catch((e) => toast(errMsg(e), "error"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [c.id, group, segment, query, offset, version]);

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex gap-1 overflow-x-auto">
          {GROUPS.map((g) => (
            <button key={g.id} type="button" onClick={() => setGroup(g.id)} className={cn("h-8 shrink-0 rounded-lg px-3 text-[12.5px] font-semibold transition-colors", group === g.id ? QUIET : "text-muted hover:bg-hov hover:text-ink")}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="flex flex-1 gap-2 lg:justify-end">
          <Select value={segment} onChange={(e) => setSegment(e.target.value)} className="h-8 max-w-[220px] py-0 text-[12.5px]">
            <option value="">All segments</option>
            {c.segmentList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company, person, email" className="h-8 max-w-[260px] py-0 text-[12.5px]" />
        </div>
      </div>
      {!data ? (
        <div className="flex items-center gap-2 py-16 text-muted">
          <Spinner /> Loading leads…
        </div>
      ) : !data.prospects.length ? (
        <Empty
          title={c.funnel.total ? "No leads match" : "No leads yet"}
          body={c.funnel.total ? "Try another filter or clear the search." : c.status === "active" ? "The agent is searching. New companies show up here within a few minutes." : "Start the campaign, or run one pass from the header, to find the first companies."}
        />
      ) : (
        <Card className={cn("overflow-hidden", loading && "opacity-70")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.08em] text-muted">
                  <th className="px-4 py-2.5 font-semibold">Company</th>
                  <th className="px-3 py-2.5 font-semibold">Person</th>
                  <th className="px-3 py-2.5 font-semibold">Email</th>
                  <th className="px-3 py-2.5 font-semibold">Fit</th>
                  <th className="px-3 py-2.5 font-semibold">Stage</th>
                  <th className="px-4 py-2.5 font-semibold">Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.prospects.map((p) => (
                  <tr key={p.id} onClick={() => onOpenLead(p.id)} className="cursor-pointer border-b border-line-soft last:border-0 hover:bg-hov">
                    <td className="max-w-[240px] px-4 py-2.5">
                      <div className="truncate font-semibold">{p.company || p.domain}</div>
                      <div className="truncate text-[12px] text-muted">{p.domain}{p.segmentName ? ` · ${p.segmentName}` : ""}</div>
                    </td>
                    <td className="max-w-[200px] px-3 py-2.5">
                      <div className="truncate">{p.fullName || <span className="text-muted">—</span>}</div>
                      <div className="truncate text-[12px] text-muted">{p.title}</div>
                    </td>
                    <td className="max-w-[230px] px-3 py-2.5">
                      <div className="truncate">{p.email || <span className="text-muted">—</span>}</div>
                      <EmailStatusChip status={p.emailStatus} />
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">{p.fitScore ?? <span className="text-muted">—</span>}</td>
                    <td className="max-w-[260px] px-3 py-2.5">
                      <StageChip stage={p.stage} />
                      {p.stageReason && <div className="mt-1 truncate text-[12px] text-muted" title={p.stageReason}>{p.stageReason}</div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-[12px] text-muted">{ago(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line-soft px-4 py-2.5 text-[12.5px] text-muted">
            <span className="tabular-nums">
              {offset + 1}-{offset + data.prospects.length} of {data.total.toLocaleString()}
            </span>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </Button>
              <Button variant="ghost" size="sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------ lead panel ----------------------------- */

const EDITABLE = ["verified", "written", "approved"];
const CONTACTED = ["queued", "sent", "replied", "interested", "meeting", "won", "lost", "unsubscribed", "bounced"];

export function LeadPanel({ c, pid, onClose, onChanged }: { c: CampaignDetail; pid: string; onClose: () => void; onChanged: () => void }) {
  const [p, setP] = useState<ProspectDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ fullName: string; title: string; email: string } | null>(null);

  useEffect(() => {
    setP(null);
    setEdit(null);
    campaignsApi
      .prospect(c.id, pid)
      .then((r) => setP(r.prospect))
      .catch((e) => toast(errMsg(e), "error"));
  }, [c.id, pid]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast(msg, "success");
      setP((await campaignsApi.prospect(c.id, pid)).prospect);
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-[560px] flex-col border-l border-line-soft bg-cream shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-line-soft px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-[16px] font-[650] tracking-[-0.01em]">{p ? p.company || p.domain : "Lead"}</div>
            {p?.website && (
              <a href={p.website} target="_blank" rel="noreferrer" className="text-[12.5px] text-accent hover:underline">
                {p.domain}
              </a>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        {!p ? (
          <div className="flex items-center gap-2 p-6 text-muted">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <StageChip stage={p.stage} />
                {p.segmentName && <span className="text-[12px] text-muted">{p.segmentName}</span>}
              </div>
              {p.stageReason && <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{p.stageReason}</p>}
              {p.lastError && <p className="mt-1 text-[12.5px] text-bad">Last error: {p.lastError}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {["skipped", "failed"].includes(p.stage) ? (
                  <Button size="sm" variant="outline" loading={busy === "restore"} onClick={() => act("restore", () => campaignsApi.restore(c.id, { ids: [p.id] }), "Put back into the pipeline.")}>
                    Put back
                  </Button>
                ) : (
                  !CONTACTED.includes(p.stage) && (
                    <Button size="sm" variant="ghost" className="text-bad" loading={busy === "skip"} onClick={() => act("skip", () => campaignsApi.skip(c.id, { ids: [p.id] }), "Skipped.")}>
                      Skip this lead
                    </Button>
                  )
                )}
                {p.stage === "written" && (
                  <Button size="sm" loading={busy === "approve"} onClick={() => act("approve", () => campaignsApi.approve(c.id, { ids: [p.id] }), "Approved.")}>
                    Approve
                  </Button>
                )}
              </div>
            </div>

            <section>
              <SectionLabel right={!CONTACTED.includes(p.stage) && !edit ? <button type="button" className="text-[12px] font-semibold text-accent hover:underline" onClick={() => setEdit({ fullName: p.fullName || "", title: p.title || "", email: p.email || "" })}>Edit</button> : null}>
                Person
              </SectionLabel>
              {edit ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Name">
                      <Input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} />
                    </Field>
                    <Field label="Title">
                      <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="Email" hint="A new address is checked again before anything is sent.">
                    <Input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEdit(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      loading={busy === "person"}
                      onClick={() =>
                        act("person", async () => {
                          await campaignsApi.updateProspect(c.id, p.id, { fullName: edit.fullName, title: edit.title, ...(edit.email.trim() && edit.email.trim() !== p.email ? { email: edit.email.trim() } : {}) });
                          setEdit(null);
                        }, "Saved.")
                      }
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1 text-[13px]">
                  <div className="font-semibold">{p.fullName || "No named person"}{p.title ? <span className="font-normal text-muted">, {p.title}</span> : null}</div>
                  {p.linkedinUrl && (
                    <a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="text-[12.5px] text-accent hover:underline">
                      LinkedIn profile
                    </a>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{p.email || "No address yet"}</span>
                    <EmailStatusChip status={p.emailStatus} />
                    {p.emailSource && <span className="text-[12px] text-muted">{p.emailSource === "published" ? "published on the site" : p.emailSource === "pattern" ? "from the name pattern" : p.emailSource === "role" ? "role address" : "entered by hand"}</span>}
                  </div>
                  {p.verify?.reasons?.length ? <div className="text-[12px] text-muted">{p.verify.reasons.join(" · ")}</div> : null}
                </div>
              )}
            </section>

            {p.fitScore != null && (
              <section>
                <SectionLabel>Fit</SectionLabel>
                <div className="flex items-start gap-3">
                  <div className="text-[1.5rem] font-bold leading-none tabular-nums">{p.fitScore}</div>
                  <p className="text-[13px] leading-relaxed text-ink-soft">{p.fitReason}</p>
                </div>
              </section>
            )}

            <section>
              <SectionLabel right={p.research.researchedAt ? <span className="text-[12px] text-muted">{ago(p.research.researchedAt)}</span> : null}>Research</SectionLabel>
              {!p.research.researchedAt ? (
                <p className="text-[13px] text-muted">Not researched yet.</p>
              ) : (
                <div className="space-y-3 text-[13px]">
                  {p.research.researchStatus === "blocked" && <p className="text-warn">The site couldn't be read (it blocks automated visits).</p>}
                  {p.research.researchStatus === "partial" && <p className="text-muted">Basic read only. The AI goes deeper once a key is connected.</p>}
                  {p.research.description && <p className="leading-relaxed text-ink-soft">{p.research.description}</p>}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
                    {p.industry && <span>{p.industry}</span>}
                    {p.research.sizeHint && <span>{p.research.sizeHint}</span>}
                    {(p.city || p.country) && <span>{[p.city, p.country].filter(Boolean).join(", ")}</span>}
                    {p.research.phone && <span>{p.research.phone}</span>}
                  </div>
                  {p.research.hooks.length > 0 && (
                    <div>
                      <div className="mb-1 text-[12px] font-semibold">Hooks</div>
                      <ul className="list-disc space-y-1 pl-5 text-ink-soft">
                        {p.research.hooks.map((h) => (
                          <li key={h}>{h}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {p.research.people.length > 0 && (
                    <div>
                      <div className="mb-1 text-[12px] font-semibold">People on the site</div>
                      <ul className="space-y-0.5 text-ink-soft">
                        {p.research.people.map((x) => (
                          <li key={x.name}>
                            {x.name}
                            {x.title ? <span className="text-muted">, {x.title}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {p.research.emailsOnSite.length > 0 && <div className="text-[12.5px] text-muted">Addresses on the site: {p.research.emailsOnSite.join(", ")}</div>}
                  {p.research.sources.length > 0 && (
                    <div className="text-[12px] text-muted">
                      Read:{" "}
                      {p.research.sources.map((s, i) => (
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
              )}
            </section>

            <section>
              <SectionLabel>Emails</SectionLabel>
              {p.emails ? (
                <EmailSteps emails={p.emails} editable={EDITABLE.includes(p.stage)} onSave={async (steps) => act("copy", () => campaignsApi.updateProspect(c.id, p.id, { steps }), "Copy saved.")} />
              ) : (
                <p className="text-[13px] text-muted">{p.stage === "verified" ? (c.readiness.ai ? "Waiting to be written in the next pass." : "Waiting for an AI key to write them.") : "Written once the lead is verified and scored."}</p>
              )}
            </section>

            <section>
              <SectionLabel>History</SectionLabel>
              {p.events.length ? (
                <ul className="space-y-2">
                  {p.events.map((e) => (
                    <li key={e.id} className="text-[12.5px]">
                      <span className="text-muted">{ago(e.created_at)}</span> · <span className={e.level === "warn" || e.level === "error" ? "text-warn" : "text-ink-soft"}>{e.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">Found {ago(p.createdAt)}. {STAGE_LABEL[p.stage]} since {ago(p.updatedAt)}.</p>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
