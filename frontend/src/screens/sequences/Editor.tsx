// The sequence editor for one campaign: the steps on a timeline (left) and a
// live preview on a real lead (right), one draft with a sticky save bar, the
// starter library, per-step numbers and "rewrite unsent leads".
// Used by the Sequences tab, the campaign's Sequence tab and the wizard.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, Modal, Select, Spinner, Textarea, cn, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import {
  ANGLE_HINT,
  ANGLE_LABEL,
  MAX_STEPS,
  VARIABLES,
  dayOf,
  newStep,
  sequencesApi,
  type Sequence,
  type SequenceDetail,
  type SequenceLanguage,
  type SequencePreview,
  type SequenceStep,
  type StarterTemplate,
  type StepAngle,
  type StepStats,
} from "../../lib/v2/sequences";
import { errMsg, goTab, plural } from "../campaigns/parts";
import { Switch } from "../campaigns/parts";
import { CHIP, CHIP_OFF, CHIP_ON, Segmented } from "../targeting/controls";

type Draft = Pick<Sequence, "name" | "language" | "steps">;
const ANGLES = Object.keys(ANGLE_LABEL) as StepAngle[];

let tplCache: Promise<{ templates: StarterTemplate[]; angleInstructions: Record<StepAngle, string> }> | null = null;
const loadTemplates = () => (tplCache ||= sequencesApi.templates().catch((e) => ((tplCache = null), Promise.reject(e))));

export default function SequenceEditor({ campaignId, inline, saveLabel = "Save sequence", onSaved }: { campaignId: string; inline?: boolean; saveLabel?: string; onSaved?: (d: SequenceDetail) => void }) {
  const [detail, setDetail] = useState<SequenceDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stats, setStats] = useState<StepStats[] | null>(null);
  const [statsSource, setStatsSource] = useState<"instantly" | "ours">("ours");
  const [defaults, setDefaults] = useState<Record<StepAngle, string> | null>(null);
  const [templates, setTemplates] = useState<StarterTemplate[]>([]);
  const [library, setLibrary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = (d: SequenceDetail) => {
    setDetail(d);
    setDraft({ name: d.sequence.name, language: d.sequence.language, steps: d.sequence.steps });
  };
  const load = useCallback(async () => {
    try {
      adopt(await sequencesApi.get(campaignId));
      setError(null);
      sequencesApi
        .stats(campaignId)
        .then((s) => {
          setStats(s.contacted ? s.steps : null);
          setStatsSource(s.source);
        })
        .catch(() => setStats(null));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [campaignId]);
  useEffect(() => {
    load();
    loadTemplates()
      .then((t) => {
        setTemplates(t.templates);
        setDefaults(t.angleInstructions);
      })
      .catch(() => {});
  }, [load]);

  const dirty = !!detail && !!draft && JSON.stringify({ name: detail.sequence.name, language: detail.sequence.language, steps: detail.sequence.steps }) !== JSON.stringify(draft);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await sequencesApi.save(campaignId, draft);
      adopt(r);
      onSaved?.(r);
      if (!r.changed) toast("Saved.", "success");
      else toast(`Saved as version ${r.sequence.version}.${r.instantlyUpdate === "patched" ? " The Instantly campaign was updated." : r.instantlyUpdate === "failed" ? " Instantly couldn't be updated; see Activity." : ""}`, "success");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };
  // Cmd/Ctrl+S and leaving with unsaved changes.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (inline) return;
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && dirty) {
        e.preventDefault();
        if (!saving) saveRef.current();
      }
    };
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", leave);
    };
  }, [dirty, saving, inline]);

  const rewrite = async () => {
    setRewriting(true);
    try {
      const r = await sequencesApi.rewriteUnsent(campaignId);
      toast(`${plural(r.rewritten, "lead")} sent back to the writer for version ${r.version}.`, "success");
      await load();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setRewriting(false);
    }
  };

  if (!detail || !draft) {
    return <div className="flex items-center gap-2 py-16 text-muted">{error ? <span className="text-bad">{error}</span> : <><Spinner /> Loading the sequence…</>}</div>;
  }

  const setStep = (i: number, patch: Partial<SequenceStep>) => setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    // Position rules: the first email has no delay, its own subject and no booking link.
    const fixed = steps.map((s, k) => (k === 0 ? { ...s, delayDays: 0, newThread: true, bookingLink: false } : { ...s, delayDays: s.delayDays || 3 }));
    setDraft({ ...draft, steps: fixed });
  };
  const add = () => {
    const s = newStep(draft.steps.length);
    if (defaults) s.instructions = defaults[s.angle];
    setDraft({ ...draft, steps: [...draft.steps, s] });
  };
  const remove = (i: number) => {
    if (draft.steps.length === 1) return;
    const steps = draft.steps.filter((_, j) => j !== i).map((s, k) => (k === 0 ? { ...s, delayDays: 0, newThread: true, bookingLink: false } : s));
    setDraft({ ...draft, steps });
  };
  const days = dayOf(draft.steps);
  const statFor = (i: number) => stats?.[i] || null;

  return (
    <div className={cn(dirty && !inline && "pb-20")}>
      {/* status */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-soft bg-paper px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
          <Badge className="bg-tlb text-accent">Version {detail.sequence.version}</Badge>
          <span>saved {ago(detail.sequence.updatedAt)}</span>
          <span>· {plural(draft.steps.length, "step")} over {days[days.length - 1]} days</span>
          {detail.inInstantly > 0 && <span>· {plural(detail.inInstantly, "lead")} already in Instantly</span>}
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            size="sm"
            value={draft.language}
            onChange={(v: SequenceLanguage) => setDraft({ ...draft, language: v })}
            options={[
              { id: "auto", label: "Auto language" },
              { id: "en", label: "English" },
              { id: "ar", label: "Arabic" },
            ]}
          />
          <Button variant="outline" size="sm" onClick={() => setLibrary(true)}>
            Starter library
          </Button>
        </div>
      </div>

      {detail.stale > 0 && !dirty && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-wnl bg-wnb px-4 py-3">
          <p className="text-[13px] text-warn">
            {plural(detail.stale, "lead")} waiting for review or Instantly {detail.stale === 1 ? "was" : "were"} written with an older version. They keep that copy unless you rewrite them.
          </p>
          <Button size="sm" variant="outline" loading={rewriting} onClick={rewrite}>
            Rewrite {detail.stale === 1 ? "it" : `those ${detail.stale}`}
          </Button>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">
        {/* timeline */}
        <div>
          <ol className="relative">
            {draft.steps.map((s, i) => (
              <li key={s.id} className="relative pl-12">
                {/* rail */}
                <span className="absolute left-[17px] top-0 h-full w-px bg-line" aria-hidden />
                <span className={cn("absolute left-0 top-4 grid h-9 w-9 place-items-center rounded-full border text-[11px] font-bold tabular-nums", i === 0 ? "border-keepl bg-keep1 text-accent" : "border-line-strong bg-paper text-ink-soft")}>
                  D{days[i]}
                </span>
                {i > 0 && (
                  <div className="flex items-center gap-2 pb-2 pt-1 text-[12px] text-muted">
                    Wait
                    <Input
                      type="number"
                      min={1}
                      max={30}
                      value={s.delayDays}
                      onChange={(e) => setStep(i, { delayDays: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })}
                      className="h-7 w-[64px] px-2 py-0 text-center text-[12.5px]"
                      aria-label={`Days before follow-up ${i}`}
                    />
                    days after the previous email
                  </div>
                )}
                <StepCard
                  s={s}
                  i={i}
                  total={draft.steps.length}
                  stat={statFor(i)}
                  statsSource={statsSource}
                  bookingLink={detail.bookingLink}
                  defaults={defaults}
                  onChange={(p) => setStep(i, p)}
                  onMove={(d) => move(i, d)}
                  onRemove={() => remove(i)}
                />
                <div className="h-4" />
              </li>
            ))}
          </ol>
          <div className="pl-12">
            <Button variant="outline" size="sm" onClick={add} disabled={draft.steps.length >= MAX_STEPS}>
              {draft.steps.length >= MAX_STEPS ? `${MAX_STEPS} steps at most` : "Add a follow-up"}
            </Button>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              Every lead gets these steps; the AI writes each one for that lead from the research. Changes apply to leads written from now on — {detail.active ? `the ${plural(detail.active, "lead")} going through Instantly keep the copy they have` : "nothing has gone out yet"}.
            </p>
          </div>
          {detail.versions.length > 1 && (
            <div className="mt-5 pl-12 text-[12px] text-muted">
              <span className="font-semibold text-ink-soft">History:</span>{" "}
              {detail.versions.slice(0, 6).map((v, i) => (
                <span key={v.version}>
                  {i > 0 && " · "}v{v.version} ({v.steps} steps, {ago(v.createdAt)})
                </span>
              ))}
            </div>
          )}
        </div>

        {/* preview */}
        <div className="xl:sticky xl:top-[84px] xl:self-start">
          <PreviewPanel campaignId={campaignId} detail={detail} draft={draft} dirty={dirty} />
        </div>
      </div>

      {/* save */}
      {inline ? (
        <div className="mt-5 flex justify-end gap-2 border-t border-line-soft pt-4">
          {dirty && (
            <Button variant="ghost" onClick={() => adopt(detail)}>
              Undo changes
            </Button>
          )}
          <Button loading={saving} onClick={async () => (dirty ? save() : onSaved?.(detail))}>
            {saveLabel}
          </Button>
        </div>
      ) : (
        dirty && (
          <div className="savebar fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper shadow-[0_-12px_32px_var(--shadow)]">
            <div className="w flex flex-wrap items-center justify-between gap-3 py-3">
              <p className="flex items-center gap-2.5 text-[13px] text-ink-soft">
                <span className="h-2 w-2 shrink-0 rounded-full bg-warn ring-4 ring-wnb" />
                Unsaved changes to the sequence of "{detail.campaign.name}". Saving creates version {detail.sequence.version + 1}.
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => adopt(detail)} disabled={saving}>
                  Discard
                </Button>
                <Button size="sm" onClick={save} loading={saving}>
                  {saveLabel}
                </Button>
              </div>
            </div>
          </div>
        )
      )}

      <Modal open={library} onClose={() => setLibrary(false)} title="Starter sequences" wide>
        <p className="mb-3 text-[13px] text-muted">Pick one to replace the steps in the editor. Nothing is saved until you press Save.</p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                if (dirty && !confirm("Replace your unsaved changes with this starter?")) return;
                setDraft({ ...draft, language: t.language, steps: t.steps.map((s) => ({ ...s, id: Math.random().toString(36).slice(2, 10) })) });
                setLibrary(false);
              }}
              className="rounded-xl border border-line-soft bg-paper p-4 text-left transition-colors hover:border-keepl hover:bg-keep1"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[14px] font-semibold">{t.name}</div>
                {t.kind !== "any" && <Badge className="bg-ink/[0.06] text-muted">{t.kind}s</Badge>}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{t.description}</p>
              <div className="mt-2.5 flex flex-wrap gap-1">
                {t.steps.map((s, i) => (
                  <span key={i} className="rounded-full bg-ink/[0.05] px-2 py-[2px] text-[11px] text-ink-soft">
                    D{dayOf(t.steps)[i]} · {s.kind === "template" ? "template" : ANGLE_LABEL[s.angle]}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------- step card ------------------------------- */

function StepCard({
  s,
  i,
  total,
  stat,
  statsSource,
  bookingLink,
  defaults,
  onChange,
  onMove,
  onRemove,
}: {
  s: SequenceStep;
  i: number;
  total: number;
  stat: StepStats | null;
  statsSource: "instantly" | "ours";
  bookingLink: string;
  defaults: Record<StepAngle, string> | null;
  onChange: (p: Partial<SequenceStep>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const insert = (v: string) => {
    const el = bodyRef.current;
    const token = `{{${v}}}`;
    if (!el) return onChange({ body: `${s.body}${token}` });
    const a = el.selectionStart ?? s.body.length;
    const b = el.selectionEnd ?? s.body.length;
    onChange({ body: s.body.slice(0, a) + token + s.body.slice(b) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };
  const iconBtn = "grid h-7 w-7 place-items-center rounded-md text-ink/50 transition-colors hover:bg-hov hover:text-ink disabled:pointer-events-none disabled:opacity-25";
  const usesThread = i === 0 || s.newThread;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-[650] tracking-[-0.01em]">{i === 0 ? "First email" : `Follow-up ${i}`}</span>
          {stat && (
            <span className="text-[12px] text-muted" title={statsSource === "instantly" ? "From Instantly's step analytics" : "From this console's records"}>
              {stat.sent.toLocaleString()} sent · {plural(stat.replies, "reply", "replies")}
              {stat.replyRate != null && <b className={cn("ml-1 font-semibold", stat.replyRate >= 5 ? "text-good" : "text-ink-soft")}>{stat.replyRate}%</b>}
              {stat.bounced + stat.unsubscribed > 0 && <span className="text-warn"> · {stat.bounced + stat.unsubscribed} left here</span>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Segmented
            size="sm"
            value={s.kind}
            onChange={(k) => onChange({ kind: k })}
            options={[
              { id: "ai", label: "AI writes it" },
              { id: "template", label: "Template" },
            ]}
          />
          <button type="button" className={iconBtn} disabled={i === 0} onClick={() => onMove(-1)} aria-label="Move up">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 6.5L5 3.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          <button type="button" className={iconBtn} disabled={i === total - 1} onClick={() => onMove(1)} aria-label="Move down">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5L5 6.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          <button type="button" className={iconBtn} disabled={total === 1} onClick={onRemove} aria-label="Remove step">
            <svg width="10" height="10" viewBox="0 0 8 8"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>

      {s.kind === "ai" ? (
        <div className="mt-3 space-y-3">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Angle</div>
            <div className="flex flex-wrap gap-1.5">
              {ANGLES.map((a) => (
                <button
                  key={a}
                  type="button"
                  title={ANGLE_HINT[a]}
                  aria-pressed={s.angle === a}
                  onClick={() => onChange({ angle: a, ...(defaults && (!s.instructions.trim() || s.instructions === defaults[s.angle]) ? { instructions: defaults[a] } : {}) })}
                  className={cn(CHIP, s.angle === a ? CHIP_ON : CHIP_OFF)}
                >
                  {ANGLE_LABEL[a]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">What this email must do</div>
            <Textarea rows={3} value={s.instructions} onChange={(e) => onChange({ instructions: e.target.value })} placeholder={defaults?.[s.angle] || "In plain words, what this email should say"} dir="auto" />
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {usesThread && <Input value={s.subject} onChange={(e) => onChange({ subject: e.target.value })} placeholder="Subject, e.g. {{company}} and month-end" dir="auto" />}
          <Textarea ref={bodyRef} rows={7} value={s.body} onChange={(e) => onChange({ body: e.target.value })} placeholder="Hi {{first_name}}, …" dir="auto" className="font-[450]" />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] text-muted">Insert:</span>
            {VARIABLES.map((v) => (
              <button key={v} type="button" onClick={() => insert(v)} className="rounded-md border border-line bg-sunk px-2 py-[2px] font-mono text-[11px] text-ink-soft hover:bg-hov hover:text-ink">
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          <p className="text-[11.5px] leading-relaxed text-muted">Fixed text for every lead. Only {"{{observation}}"} is written by the AI — one sentence about their company.</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line-soft pt-3 text-[12.5px]">
        {s.kind === "ai" && (
          <label className="flex items-center gap-2 text-ink-soft">
            At most
            <Input type="number" min={25} max={250} value={s.maxWords} onChange={(e) => onChange({ maxWords: Math.max(25, Math.min(250, Number(e.target.value) || 25)) })} className="h-7 w-[70px] px-2 py-0 text-center text-[12.5px]" />
            words
          </label>
        )}
        {i > 0 && (
          <Segmented
            size="sm"
            value={s.newThread ? "new" : "same"}
            onChange={(v) => onChange({ newThread: v === "new" })}
            options={[
              { id: "same", label: "Same thread" },
              { id: "new", label: "New subject" },
            ]}
          />
        )}
        {i > 0 ? (
          <span className="flex items-center gap-2 text-ink-soft" title={bookingLink ? bookingLink : "Set a booking link in the Agent tab first"}>
            <Switch checked={s.bookingLink && !!bookingLink} disabled={!bookingLink} onChange={(v) => onChange({ bookingLink: v })} label="Booking link allowed" />
            Booking link
            {!bookingLink && (
              <button type="button" className="text-[12px] font-semibold text-accent hover:underline" onClick={() => goTab("agent")}>
                set one
              </button>
            )}
          </span>
        ) : (
          <span className="text-[12px] text-muted">First emails never carry links.</span>
        )}
      </div>
    </Card>
  );
}

/* -------------------------------- preview -------------------------------- */

function PreviewPanel({ campaignId, detail, draft, dirty }: { campaignId: string; detail: SequenceDetail; draft: Draft; dirty: boolean }) {
  const [lead, setLead] = useState<string>(detail.previewLeads[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<SequencePreview | null>(null);
  const templateOnly = draft.steps.every((s) => s.kind === "template") && !draft.steps.some((s) => /\{\{\s*observation\s*\}\}/.test(`${s.subject} ${s.body}`));
  const canWrite = detail.ai || templateOnly;
  const run = async () => {
    setBusy(true);
    try {
      setOut(await sequencesApi.preview(campaignId, { prospectId: lead || undefined, sequence: draft }));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const days = dayOf(draft.steps);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line-soft px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13.5px] font-semibold">Preview on a real lead</div>
          {dirty && <span className="text-[11.5px] text-warn">with your unsaved changes</span>}
        </div>
        <div className="mt-2 flex gap-2">
          <Select value={lead} onChange={(e) => setLead(e.target.value)} className="h-8 py-0 text-[12.5px]" aria-label="Lead to preview">
            <option value="">Sample prospect (fictional, Doha)</option>
            {detail.previewLeads.map((l) => (
              <option key={l.id} value={l.id}>
                {[l.name, l.company].filter(Boolean).join(" · ") || "Lead"} ({l.stage})
              </option>
            ))}
          </Select>
          <Button size="sm" loading={busy} disabled={!canWrite} onClick={run}>
            {out ? "Write again" : "Write it"}
          </Button>
        </div>
        {!canWrite && (
          <p className="mt-2 text-[12px] text-muted">
            The preview writes real emails, which needs an AI key.{" "}
            <button type="button" className="font-semibold text-accent hover:underline" onClick={() => goTab("agent")}>
              Connect one
            </button>
          </p>
        )}
      </div>
      <div className="max-h-[calc(100vh-260px)] space-y-3 overflow-y-auto px-4 py-4">
        {!out ? (
          <p className="text-[12.5px] leading-relaxed text-muted">Writes every step for the lead you pick, exactly as the agent would — with word counts and the guardrail notes. Nothing is saved or sent.</p>
        ) : out.error ? (
          <p className="rounded-lg border border-dgl bg-dgb px-3 py-2 text-[12.5px] text-bad">{out.error}</p>
        ) : (
          <>
            {out.lead && (
              <p className="text-[12px] text-muted">
                For <b className="font-semibold text-ink-soft">{out.lead.name || "the team"}</b>
                {out.lead.company ? ` at ${out.lead.company}` : ""}
                {out.lead.sample ? " (fictional)" : ""}
              </p>
            )}
            {out.emails.map((e, i) => (
              <div key={i} className="rounded-lg border border-line-soft bg-sunk px-3.5 py-3" dir={out.language === "ar" ? "rtl" : undefined}>
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted" dir="ltr">
                  <span className="font-semibold uppercase tracking-[0.08em]">Day {days[i] ?? "?"}</span>
                  {e.kind === "template" && <Badge className="bg-ink/[0.06] text-muted">template</Badge>}
                  <span className={cn("ml-auto tabular-nums", e.words > e.maxWords + (i === 0 ? 25 : 20) ? "font-semibold text-warn" : "")}>
                    {e.words}/{e.maxWords} words
                  </span>
                </div>
                {e.subject ? <div className="text-[13px] font-semibold">{e.subject}</div> : i > 0 && <div className="text-[12px] italic text-muted" dir="ltr">Same thread (Re: …)</div>}
                <div className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-soft">{e.body}</div>
              </div>
            ))}
            {out.warnings.length > 0 && (
              <ul className="space-y-1 text-[12px] text-warn">
                {out.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
