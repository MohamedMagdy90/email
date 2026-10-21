// Agent — how the agent connects (Instantly, AI keys, verifier), how it writes
// (voice, tone, knowledge base) and how it answers replies (auto-reply mode,
// per-category rules, guardrails).
//
// Voice + rules are ONE draft with a sticky save bar (Cmd/Ctrl+S). Previews
// (the exact prompt, the rule board, the scenario tester) run against the
// unsaved draft, so every change shows its effect before it is saved.
// Connections save one at a time, and only after the key has been tested.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Card, Field, Input, PageHeader, Select, Spinner, Textarea, cn, toast } from "../lib/ui";
import { v2, type AgentSettings, type Integrations, type IntegrationsPatch, type IntegrationTarget } from "../lib/v2/core";
import {
  agentApi,
  type AgentMeta,
  type ReplyAction,
  type ReplyCategory,
  type ReplyCategoryId,
  type RulesPreview,
  type SampleKind,
  type Scenario,
  type TestResult,
  type VoicePreview,
} from "../lib/v2/agent";
import { mailboxesApi } from "../lib/v2/mailboxes";

/* -------------------------------- vocabulary -------------------------------- */

type Section = "connections" | "voice" | "replies";
const SECTION_KEY = "dnaAgentSection";

// Same bands as voicePrompt() on the server: < 34 · < 67 · rest.
const band = (n: number) => (n < 34 ? 0 : n < 67 ? 1 : 2);
const FORMALITY = ["Casual", "Conversational", "Formal"];
const WARMTH = ["Matter-of-fact", "Friendly", "Warm"];
const DIRECTNESS = ["Soft", "Clear", "Direct"];

const LENGTHS: { id: AgentSettings["tone"]["length"]; label: string; words: string; range: [number, number] }[] = [
  { id: "very_short", label: "Very short", words: "40–60 words", range: [40, 60] },
  { id: "short", label: "Short", words: "60–90 words", range: [60, 90] },
  { id: "medium", label: "Medium", words: "90–130 words", range: [90, 130] },
];

const MODES: { id: AgentSettings["autoReply"]["mode"]; title: string; body: string }[] = [
  { id: "full", title: "Fully automatic", body: "Sends every reply it is sure about. The kinds you keep for yourself still come to you." },
  { id: "safe", title: "Safe replies only", body: "Sends the low-risk ones: not now, referrals, a polite no. Drafts the rest for you to approve." },
  { id: "drafts", title: "Drafts only", body: "Writes every reply and waits. Nothing leaves until you press send." },
];
const MODE_LABEL: Record<AgentSettings["autoReply"]["mode"], string> = { full: "Fully automatic", safe: "Safe replies only", drafts: "Drafts only" };

const ACTION: Record<ReplyAction, { chip: string; cls: string; bar: string; headline: string }> = {
  send: { chip: "Sends", cls: "bg-okb text-good", bar: "bg-good", headline: "Sends it on its own" },
  draft: { chip: "Drafts", cls: "bg-inb text-inf", bar: "bg-inf", headline: "Drafts it for your approval" },
  handoff: { chip: "Comes to you", cls: "bg-wnb text-warn", bar: "bg-warn", headline: "Hands it to you" },
  silent: { chip: "No reply", cls: "bg-ink/[0.06] text-muted", bar: "bg-muted", headline: "Sends nothing" },
};

const PROVIDERS: {
  id: "gemini" | "groq" | "openrouter";
  field: keyof IntegrationsPatch;
  name: string;
  role: string;
  url: string;
  urlLabel: string;
}[] = [
  {
    id: "gemini",
    field: "geminiKey",
    name: "Google Gemini",
    role: "Writes, researches and classifies. The only one that can search the web, which campaigns need to find companies.",
    url: "https://aistudio.google.com/apikey",
    urlLabel: "aistudio.google.com/apikey",
  },
  {
    id: "groq",
    field: "groqKey",
    name: "Groq",
    role: "Fast fallback. Classifies replies first so Gemini's free quota is kept for research.",
    url: "https://console.groq.com/keys",
    urlLabel: "console.groq.com/keys",
  },
  {
    id: "openrouter",
    field: "openrouterKey",
    name: "OpenRouter",
    role: "Last resort: free open models, used only when the other two fail.",
    url: "https://openrouter.ai/settings/keys",
    urlLabel: "openrouter.ai/settings/keys",
  },
];

const goTab = (t: string) => window.dispatchEvent(new CustomEvent("dna-tab", { detail: t }));

function readSection(): Section | null {
  try {
    const s = localStorage.getItem(SECTION_KEY);
    return s === "connections" || s === "voice" || s === "replies" ? s : null;
  } catch {
    return null;
  }
}

/** Order-insensitive comparison of two drafts (hand-off list is a set). */
function sameSettings(a: AgentSettings, b: AgentSettings) {
  const norm = (s: AgentSettings) => ({ ...s, autoReply: { ...s.autoReply, handoffCategories: [...s.autoReply.handoffCategories].sort() } });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/* --------------------------------- screen ---------------------------------- */

export default function Agent() {
  const [meta, setMeta] = useState<AgentMeta | null>(null);
  const [intg, setIntg] = useState<Integrations | null>(null);
  const [saved, setSaved] = useState<AgentSettings | null>(null);
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [section, setSectionState] = useState<Section | null>(readSection);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [m, i, s] = await Promise.all([agentApi.meta(), v2.integrations(), v2.agentSettings()]);
      setMeta(m);
      setIntg(i);
      setSaved(s);
      setDraft(s);
      // First visit: start where the work is.
      setSectionState((cur) => cur ?? (i.instantly.configured && i.ai.configured ? "voice" : "connections"));
    } catch (e: any) {
      setLoadError(e.message || "Couldn't load the agent settings.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setSection(s: Section) {
    setSectionState(s);
    try {
      localStorage.setItem(SECTION_KEY, s);
    } catch {
      /* private mode */
    }
  }

  const dirty = !!draft && !!saved && !sameSettings(draft, saved);
  const update = useCallback((fn: (d: AgentSettings) => AgentSettings) => setDraft((d) => (d ? fn(d) : d)), []);

  const save = useCallback(async () => {
    if (!draft) return;
    const sent = draft;
    setSaving(true);
    try {
      const r = await v2.saveAgentSettings(sent);
      setSaved(r);
      // Keep anything typed while the save was in flight.
      setDraft((cur) => (cur && sameSettings(cur, sent) ? r : cur));
      toast("Saved. The agent uses this from its next email.", "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  // Cmd/Ctrl+S saves; leaving the page with unsaved changes asks first.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && dirty) {
        e.preventDefault();
        if (!saving) save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dirty, saving, save]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const header = (
    <PageHeader
      title="Agent"
      subtitle="What the agent is connected to, how it writes, and what it may answer on its own."
      actions={
        saved && (
          <>
            {dirty && <Badge className="bg-wnb text-warn">Unsaved</Badge>}
            <span className={cn("livep", saved.autoReply.enabled && "open")}>
              <i />
              {saved.autoReply.enabled ? `Auto-reply on · ${MODE_LABEL[saved.autoReply.mode].toLowerCase()}` : "Auto-reply off"}
            </span>
          </>
        )
      }
    />
  );

  if (loadError && !draft) {
    return (
      <div>
        {header}
        <Card className="px-6 py-10 text-center">
          <p className="text-sm text-bad">{loadError}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={load}>
            Try again
          </Button>
        </Card>
      </div>
    );
  }

  if (!meta || !intg || !draft || !section) {
    return (
      <div>
        {header}
        <div className="flex items-center gap-2 py-20 text-muted">
          <Spinner /> Loading the agent…
        </div>
      </div>
    );
  }

  return (
    <div className={cn(dirty && "pb-20")}>
      {header}
      <SectionTiles section={section} onChange={setSection} intg={intg} draft={draft} />

      <div role="tabpanel">
        {section === "connections" && <ConnectionsSection intg={intg} onChange={setIntg} />}
        {section === "voice" && (
          <VoiceSection draft={draft} update={update} meta={meta} aiReady={intg.ai.configured} onConnect={() => setSection("connections")} />
        )}
        {section === "replies" && <RepliesSection draft={draft} update={update} meta={meta} intg={intg} onConnect={() => setSection("connections")} />}
      </div>

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => saved && setDraft(saved)} />}
    </div>
  );
}

/* ------------------------------ section tiles ------------------------------ */

function SectionTiles({ section, onChange, intg, draft }: { section: Section; onChange: (s: Section) => void; intg: Integrations; draft: AgentSettings }) {
  const inst = intg.instantly.configured;
  const ai = intg.ai.configured;
  const conn = inst && ai ? "Ready" : !inst && !ai ? "Not connected" : inst ? "AI key missing" : "Instantly missing";
  const t = draft.tone;
  const ar = draft.autoReply;
  const len = LENGTHS.find((l) => l.id === t.length) || LENGTHS[1];
  const delay = ar.delayMaxMinutes > 0 ? `${ar.delayMinMinutes}–${ar.delayMaxMinutes} min delay` : "no delay";

  const tiles: { id: Section; n: string; label: string; value: string; tone?: string; sub: ReactNode }[] = [
    {
      id: "connections",
      n: "01",
      label: "Connections",
      value: conn,
      tone: inst && ai ? undefined : "text-warn",
      sub: (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {(
            [
              ["Instantly", inst],
              ["AI", ai],
              ["Verifier", intg.reacher.configured],
            ] as const
          ).map(([name, on]) => (
            <span key={name} className="inline-flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-good" : "bg-ink/25")} />
              {name}
            </span>
          ))}
        </span>
      ),
    },
    {
      id: "voice",
      n: "02",
      label: "Voice & tone",
      value: FORMALITY[band(t.formality)],
      sub: `${WARMTH[band(t.warmth)].toLowerCase()} · ${DIRECTNESS[band(t.directness)].toLowerCase()} · ${len.words}`,
    },
    {
      id: "replies",
      n: "03",
      label: "Auto-reply rules",
      value: ar.enabled ? MODE_LABEL[ar.mode] : "Off",
      tone: ar.enabled ? undefined : "text-muted",
      sub: ar.enabled ? `${ar.handoffCategories.length} kinds come to you · ${delay}` : "every reply waits for you",
    },
  ];

  // Phones scroll the tiles sideways: keep the selected one in view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    const on = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !on || el.scrollWidth <= el.clientWidth) return;
    el.scrollTo({ left: on.offsetLeft - el.offsetLeft - 4, behavior: "smooth" });
  }, [section]);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Agent settings"
      className="-mx-1 mb-5 flex snap-x gap-3 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0"
    >
      {tiles.map((x) => {
        const on = section === x.id;
        return (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(x.id)}
            className={cn(
              "hb min-w-[232px] shrink-0 snap-start cursor-pointer text-left transition-[border-color,transform] duration-150 sm:min-w-0",
              on ? "keep" : "hover:border-line-strong active:translate-y-px"
            )}
          >
            <div className="mono-label mb-2 flex items-center justify-between gap-2">
              <span>{x.label}</span>
              <span className="tabular-nums opacity-70">{x.n}</span>
            </div>
            <div className={cn("text-[1.28rem] font-bold leading-tight tracking-[-0.02em]", !on && "text-ink", x.tone)}>{x.value}</div>
            <div className="mt-2 truncate text-[12px] text-muted">{x.sub}</div>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------- connections ------------------------------- */

function ConnectionsSection({ intg, onChange }: { intg: Integrations; onChange: (i: Integrations) => void }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <InstantlyCard intg={intg} onChange={onChange} />
        <ReacherCard intg={intg} onChange={onChange} />
      </div>
      <AiCard intg={intg} onChange={onChange} />
    </div>
  );
}

function describeOk(target: IntegrationTarget, t: TestResult): string {
  if (target === "instantly") return `Instantly answered · ${t.accounts ?? 0} mailbox${t.accounts === 1 ? "" : "es"} on the account`;
  if (target === "reacher") return `Reacher answered · test check came back "${t.sample || "unknown"}"`;
  return `Answered in ${t.ms != null ? `${(t.ms / 1000).toFixed(1)} s` : "—"}${t.model ? ` · ${t.model}` : ""}`;
}

function InstantlyCard({ intg, onChange }: { intg: Integrations; onChange: (i: Integrations) => void }) {
  const on = intg.instantly.configured;
  const mb = intg.instantly.mailboxes;
  return (
    <Card className="p-5 sm:p-6">
      <Label>Sending engine</Label>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[1.05rem] font-[650] tracking-[-0.01em]">Instantly</h2>
        {on && (
          <button type="button" onClick={() => goTab("mailboxes")} className="text-[12.5px] font-semibold text-accent hover:underline">
            Open Mailboxes →
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        Sends every campaign email through your warmed mailboxes, and collects replies in its Unibox so the agent can answer them. API
        access needs the Growth plan or above.
      </p>
      <div className="mt-4 border-t border-line-soft pt-4">
        <KeyRow
          target="instantly"
          field="instantlyKey"
          name="API key"
          role={
            on ? (
              "Mailboxes sync every 30 minutes. Replies are read from the same account."
            ) : (
              <>
                In Instantly: Settings → Integrations → API keys. Create a key with the <span className="font-medium text-ink">all:all</span> scope.
              </>
            )
          }
          masked={intg.keys.instantly}
          configured={on}
          placeholder="Paste the Instantly API key"
          connectedInfo={mb ? `${mb.total} mailbox${mb.total === 1 ? "" : "es"} synced · ${mb.sending} sending` : undefined}
          removeWarning="Mailboxes stop syncing, and nothing can send or be answered."
          onChange={onChange}
          afterSave={() => {
            // Pull the mailboxes in straight away instead of waiting 30 minutes.
            mailboxesApi
              .sync()
              .then(() => v2.integrations().then(onChange))
              .catch(() => {});
          }}
        />
      </div>
    </Card>
  );
}

function AiCard({ intg, onChange }: { intg: Integrations; onChange: (i: Integrations) => void }) {
  const ai = intg.ai;
  const pct = Math.min(100, Math.round((ai.usage.calls / Math.max(1, ai.budget)) * 100));
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Label>AI</Label>
          <h2 className="mt-1.5 text-[1.05rem] font-[650] tracking-[-0.01em]">Writer, researcher and classifier</h2>
        </div>
        <div className="w-[150px] shrink-0 text-right">
          <div className="text-[1.15rem] font-bold leading-none tabular-nums">
            {ai.usage.calls.toLocaleString()}
            <span className="text-[12px] font-semibold text-muted"> / {ai.budget.toLocaleString()}</span>
          </div>
          <div className="mt-1 text-[11px] text-muted">AI calls today{ai.usage.errors ? ` · ${ai.usage.errors} failed` : ""}</div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
            <div className={cn("h-full rounded-full", pct >= 85 ? "bg-warn" : "bg-brand")} style={{ width: `${Math.max(pct, ai.usage.calls ? 2 : 0)}%` }} />
          </div>
        </div>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        The agent tries Gemini first, then Groq, then OpenRouter, so one slow or exhausted provider never stops the work. All three
        have free tiers. One key is enough to start.
      </p>
      {!ai.configured && (
        <div className="mt-3 rounded-lg border border-wnl bg-wnb px-3 py-2 text-[12.5px] leading-relaxed text-warn">
          No AI key yet, so nothing can be written, researched or answered. Gemini is the one to add first.
        </div>
      )}
      {ai.configured && !ai.canSearch && (
        <div className="mt-3 rounded-lg border border-wnl bg-wnb px-3 py-2 text-[12.5px] leading-relaxed text-warn">
          Writing and replies work. Finding new companies needs web search, and only Gemini can do that.
        </div>
      )}
      <div className="mt-4 border-t border-line-soft">
        {PROVIDERS.map((p) => (
          <div key={p.id} className="border-b border-line-soft py-4 last:border-b-0 last:pb-0">
            <KeyRow
              target={p.id}
              field={p.field}
              name={p.name}
              badge={p.id === "gemini" ? <Badge className="bg-tlb text-accent">Recommended</Badge> : undefined}
              role={p.role}
              masked={intg.keys[p.id]}
              configured={ai.providers[p.id].configured}
              placeholder={`Paste the ${p.name} key`}
              getKey={
                <>
                  Free key:{" "}
                  <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                    {p.urlLabel}
                  </a>
                </>
              }
              connectedInfo={p.id === "gemini" ? ai.providers.gemini.model : ai.providers[p.id].model}
              onChange={onChange}
            />
          </div>
        ))}
      </div>
      <AdvancedAi intg={intg} onChange={onChange} />
    </Card>
  );
}

function AdvancedAi({ intg, onChange }: { intg: Integrations; onChange: (i: Integrations) => void }) {
  const p = intg.ai.providers;
  const initial = () => ({
    geminiModel: p.gemini.model,
    geminiFastModel: p.gemini.fastModel,
    groqModel: p.groq.model,
    openrouterModel: p.openrouter.model,
    aiDailyBudget: String(intg.ai.budget),
  });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) setF(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intg, open]);

  async function save() {
    setBusy(true);
    try {
      onChange(await v2.saveIntegrations(f));
      toast("AI models and budget saved.", "success");
      setOpen(false);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-soft hover:text-ink">
        <Chevron open={open} />
        Models and daily budget
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Gemini · writing">
              <Input value={f.geminiModel} onChange={(e) => setF({ ...f, geminiModel: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="Gemini · classifying">
              <Input value={f.geminiFastModel} onChange={(e) => setF({ ...f, geminiFastModel: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="Groq">
              <Input value={f.groqModel} onChange={(e) => setF({ ...f, groqModel: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="OpenRouter">
              <Input value={f.openrouterModel} onChange={(e) => setF({ ...f, openrouterModel: e.target.value })} spellCheck={false} />
            </Field>
          </div>
          <Field label="Daily budget" hint="Most AI calls the agent may make in one day (UTC), across all providers. Work pauses until tomorrow when it is reached.">
            <Input inputMode="numeric" value={f.aiDailyBudget} onChange={(e) => setF({ ...f, aiDailyBudget: e.target.value.replace(/[^\d]/g, "") })} className="max-w-[180px] tabular-nums" />
          </Field>
          <p className="text-[12px] text-muted">Clear a model field to go back to the default.</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} loading={busy}>
              Save models
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One API key: test-before-save, replace, remove (two-step). */
function KeyRow({
  target,
  field,
  name,
  role,
  badge,
  masked,
  configured,
  placeholder,
  getKey,
  connectedInfo,
  removeWarning,
  onChange,
  afterSave,
}: {
  target: IntegrationTarget;
  field: keyof IntegrationsPatch;
  name: string;
  role: ReactNode;
  badge?: ReactNode;
  masked: string;
  configured: boolean;
  placeholder: string;
  getKey?: ReactNode;
  connectedInfo?: string;
  removeWarning?: string;
  onChange: (i: Integrations) => void;
  afterSave?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [result, setResult] = useState<{ ok: boolean; text: string; canForce?: boolean } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(t);
  }, [confirmRemove]);

  async function saveKey(force = false) {
    const k = value.trim();
    if (!k) return;
    setBusy("save");
    setResult(null);
    try {
      let detail = "";
      if (!force) {
        const t = await agentApi.test(target, { key: k });
        if (!t.ok) {
          setResult({ ok: false, text: t.error || "That key was not accepted.", canForce: true });
          return;
        }
        detail = describeOk(target, t);
      }
      const next = await v2.saveIntegrations({ [field]: k } as IntegrationsPatch);
      onChange(next);
      setValue("");
      setEditing(false);
      setResult(detail ? { ok: true, text: detail } : null);
      toast(`${name === "API key" ? "Instantly" : name} ${configured ? "key replaced" : "connected"}.`, "success");
      afterSave?.();
    } catch (e: any) {
      setResult({ ok: false, text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setResult(null);
    try {
      const t = await agentApi.test(target);
      setResult(t.ok ? { ok: true, text: describeOk(target, t) } : { ok: false, text: t.error || "The test failed." });
    } catch (e: any) {
      setResult({ ok: false, text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setBusy("remove");
    try {
      onChange(await v2.saveIntegrations({ [field]: "" } as IntegrationsPatch));
      setResult(null);
      setConfirmRemove(false);
      toast(`${name === "API key" ? "Instantly" : name} disconnected.`, "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy("");
    }
  }

  const showForm = !configured || editing;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold">{name}</span>
            {badge}
            <Badge className={configured ? "bg-okb text-good" : "bg-ink/[0.06] text-muted"}>{configured ? "Connected" : "Not connected"}</Badge>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{role}</p>
        </div>
        {configured && !editing && (
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={test} loading={busy === "test"}>
              Test
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(true);
                setResult(null);
              }}
            >
              Replace
            </Button>
            <Button size="sm" variant={confirmRemove ? "danger" : "ghost"} onClick={remove} loading={busy === "remove"} title={removeWarning}>
              {confirmRemove ? "Confirm remove" : "Remove"}
            </Button>
          </div>
        )}
      </div>

      {configured && !editing && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          <code className="rounded-md border border-line-soft bg-sunk px-2 py-0.5 font-mono text-[11.5px] text-ink-soft">{masked || "saved"}</code>
          {connectedInfo && <span>{connectedInfo}</span>}
        </div>
      )}
      {confirmRemove && removeWarning && <p className="mt-2 text-[12px] text-bad">{removeWarning}</p>}

      {showForm && (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            saveKey();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            aria-label={placeholder}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (result && !result.ok) setResult(null);
            }}
            className="font-mono sm:flex-1"
          />
          <div className="flex gap-2">
            <Button type="submit" variant={value.trim() ? "solid" : "outline"} loading={busy === "save"} disabled={!value.trim()} className="flex-1 sm:flex-none">
              {configured ? "Test & replace" : "Test & connect"}
            </Button>
            {editing && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setValue("");
                  setResult(null);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {showForm && getKey && <p className="mt-2 text-[12px] text-muted">{getKey}</p>}

      {result && <ResultLine ok={result.ok} text={result.text} onForce={result.canForce && value.trim() ? () => saveKey(true) : undefined} />}
    </div>
  );
}

function ResultLine({ ok, text, onForce }: { ok: boolean; text: string; onForce?: () => void }) {
  return (
    <div className={cn("mt-2.5 flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed", ok ? "border-okl bg-okb text-good" : "border-dgl bg-dgb text-bad")}>
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {onForce && (
        <button type="button" onClick={onForce} className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline">
          Save it anyway
        </button>
      )}
    </div>
  );
}

function ReacherCard({ intg, onChange }: { intg: Integrations; onChange: (i: Integrations) => void }) {
  const r = intg.reacher;
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(r.url);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [result, setResult] = useState<{ ok: boolean; text: string; canForce?: boolean } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(t);
  }, [confirmRemove]);

  async function save(force = false) {
    const u = url.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) {
      setResult({ ok: false, text: "Enter the full address, starting with https://" });
      return;
    }
    setBusy("save");
    setResult(null);
    try {
      let detail = "";
      if (!force) {
        const t = await agentApi.test("reacher", { url: u, secret: secret.trim() || undefined });
        if (!t.ok) {
          setResult({ ok: false, text: t.error || "Reacher didn't answer.", canForce: true });
          return;
        }
        detail = describeOk("reacher", t);
      }
      const patch: IntegrationsPatch = { reacherUrl: u };
      if (secret.trim()) patch.reacherSecret = secret.trim();
      onChange(await v2.saveIntegrations(patch));
      setEditing(false);
      setSecret("");
      setResult(detail ? { ok: true, text: detail } : null);
      toast("Verifier connected.", "success");
    } catch (e: any) {
      setResult({ ok: false, text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setResult(null);
    try {
      const t = await agentApi.test("reacher");
      setResult(t.ok ? { ok: true, text: describeOk("reacher", t) } : { ok: false, text: t.error || "The test failed." });
    } catch (e: any) {
      setResult({ ok: false, text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!confirmRemove) return setConfirmRemove(true);
    setBusy("remove");
    try {
      onChange(await v2.saveIntegrations({ reacherUrl: "", reacherSecret: "" }));
      setUrl("");
      setResult(null);
      setConfirmRemove(false);
      toast("Verifier disconnected. The built-in checks still run.", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy("");
    }
  }

  const showForm = !r.configured || editing;
  return (
    <Card className="p-5 sm:p-6">
      <Label>Email verification · optional</Label>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <h2 className="text-[1.05rem] font-[650] tracking-[-0.01em]">Reacher</h2>
        <Badge className={r.configured ? "bg-okb text-good" : "bg-ink/[0.06] text-muted"}>{r.configured ? "Connected" : "Built-in checks only"}</Badge>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        Asks the recipient's mail server whether an address exists before anything is sent. Without it, addresses get the built-in checks
        (format, MX, disposable, role), and guessed addresses that can't be confirmed are held back.
      </p>

      {r.configured && !editing && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
          <div className="min-w-0 text-[12px] text-muted">
            <code className="break-all rounded-md border border-line-soft bg-sunk px-2 py-0.5 font-mono text-[11.5px] text-ink-soft">{r.url}</code>
            <span className="ml-2">{r.hasSecret ? "secret saved" : "no secret"}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={test} loading={busy === "test"}>
              Test
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setUrl(r.url);
                setEditing(true);
                setResult(null);
              }}
            >
              Edit
            </Button>
            <Button size="sm" variant={confirmRemove ? "danger" : "ghost"} onClick={remove} loading={busy === "remove"}>
              {confirmRemove ? "Confirm remove" : "Remove"}
            </Button>
          </div>
        </div>
      )}

      {showForm && (
        <form
          className="mt-4 space-y-2.5 border-t border-line-soft pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Input
              placeholder="https://reacher.your-server.com"
              aria-label="Reacher server address"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
              className="font-mono"
            />
            <Input
              type="password"
              autoComplete="off"
              placeholder={r.hasSecret ? "Secret (blank keeps the saved one)" : "Secret header (if set)"}
              aria-label="Reacher secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" variant={url.trim() ? "solid" : "outline"} loading={busy === "save"} disabled={!url.trim()}>
              Test & save
            </Button>
            {editing && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            <span className="text-[12px] text-muted">Self-hosted, free. Needs a server where outbound port 25 is open.</span>
          </div>
        </form>
      )}
      {result && <ResultLine ok={result.ok} text={result.text} onForce={result.canForce && url.trim() ? () => save(true) : undefined} />}
    </Card>
  );
}

/* ---------------------------------- voice ---------------------------------- */

function VoiceSection({
  draft,
  update,
  meta,
  aiReady,
  onConnect,
}: {
  draft: AgentSettings;
  update: (fn: (d: AgentSettings) => AgentSettings) => void;
  meta: AgentMeta;
  aiReady: boolean;
  onConnect: () => void;
}) {
  const t = draft.tone;
  const setTone = (patch: Partial<AgentSettings["tone"]>) => update((d) => ({ ...d, tone: { ...d.tone, ...patch } }));
  const set = <K extends keyof AgentSettings>(k: K, v: AgentSettings[K]) => update((d) => ({ ...d, [k]: v }));
  const toneIsDefault = JSON.stringify(t) === JSON.stringify(meta.defaults.tone);
  const kbLines = draft.knowledgeBase.split("\n").filter((l) => l.trim()).length;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,430px)]">
      <div className="min-w-0 space-y-4">
        <Card className="p-5 sm:p-6">
          <SectionHead label="Who is writing" title="The person the emails come from" />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Sender name">
              <Input value={draft.senderName} onChange={(e) => set("senderName", e.target.value)} placeholder="e.g. Mohamed Magdy" />
            </Field>
            <Field label="Title">
              <Input value={draft.senderTitle} onChange={(e) => set("senderTitle", e.target.value)} placeholder="e.g. Partnerships, DNA ERP" />
            </Field>
            <Field label="Company">
              <Input value={draft.companyName} onChange={(e) => set("companyName", e.target.value)} />
            </Field>
            <Field label="Website">
              <Input value={draft.website} onChange={(e) => set("website", e.target.value)} spellCheck={false} />
            </Field>
          </div>
          <div className="mt-4">
            <MiniLabel>Language</MiniLabel>
            <Segmented
              value={draft.language}
              onChange={(v) => set("language", v)}
              options={[
                { id: "auto", label: "Match the prospect", sub: "Arabic if they write Arabic" },
                { id: "en", label: "Always English" },
                { id: "ar", label: "Always Arabic" },
              ]}
            />
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <SectionHead label="Tone" title="How it sounds" />
            {!toneIsDefault && (
              <Button size="sm" variant="ghost" onClick={() => setTone(structuredClone(meta.defaults.tone))}>
                Reset tone
              </Button>
            )}
          </div>
          <div className="mt-5 space-y-6">
            <Slider label="Formality" value={t.formality} onChange={(v) => setTone({ formality: v })} bands={FORMALITY} activeBand={band(t.formality)} ariaLabel="Formality" />
            <Slider label="Warmth" value={t.warmth} onChange={(v) => setTone({ warmth: v })} bands={WARMTH} activeBand={band(t.warmth)} ariaLabel="Warmth" />
            <Slider label="Directness" value={t.directness} onChange={(v) => setTone({ directness: v })} bands={DIRECTNESS} activeBand={band(t.directness)} ariaLabel="Directness" />
          </div>
          <div className="mt-6">
            <MiniLabel>Length</MiniLabel>
            <Segmented value={t.length} onChange={(v) => setTone({ length: v })} options={LENGTHS.map((l) => ({ id: l.id, label: l.label, sub: l.words }))} />
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <Field label="Style notes" hint="How it should sound, in your words.">
              <Textarea rows={4} value={t.styleNotes} onChange={(e) => setTone({ styleNotes: e.target.value })} />
            </Field>
            <Field label="Never" hint="Hard rules it may not break, in any email or reply.">
              <Textarea rows={4} value={t.avoid} onChange={(e) => setTone({ avoid: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <SectionHead label="Knowledge base" title="The only facts it may use" />
            <span className="pt-1 text-[12px] tabular-nums text-muted">
              {kbLines} fact{kbLines === 1 ? "" : "s"} · {draft.knowledgeBase.length.toLocaleString()} characters
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Used to answer questions and to describe what you sell. One fact per line works best. If a price or a feature isn't here, the
            agent says it will confirm, instead of guessing.
          </p>
          <Textarea
            rows={8}
            className="mt-3 text-[13px]"
            value={draft.knowledgeBase}
            onChange={(e) => set("knowledgeBase", e.target.value)}
            placeholder={"Pricing: …\nImplementation takes …\nCustomers in Qatar include …"}
          />
        </Card>

        <Card className="p-5 sm:p-6">
          <SectionHead label="Sign-off" title="Signature and booking link" />
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="Signature" hint="Added under every email and reply, exactly as written. Plain text.">
              <Textarea rows={4} value={draft.signature} onChange={(e) => set("signature", e.target.value)} placeholder={"Mohamed Magdy\nDNA ERP · dna.systems"} />
            </Field>
            <Field label="Booking link" hint="Offered once, when someone wants to talk. Leave empty and the agent suggests two time slots instead.">
              <Input value={draft.bookingLink} onChange={(e) => set("bookingLink", e.target.value)} placeholder="https://cal.com/…" spellCheck={false} />
            </Field>
          </div>
        </Card>
      </div>

      <div className="min-w-0 lg:sticky lg:top-[80px]">
        <VoicePreviewPanel draft={draft} meta={meta} aiReady={aiReady} onConnect={onConnect} />
      </div>
    </div>
  );
}

function VoicePreviewPanel({ draft, meta, aiReady, onConnect }: { draft: AgentSettings; meta: AgentMeta; aiReady: boolean; onConnect: () => void }) {
  const [kind, setKind] = useState<SampleKind>("first_touch");
  const [preview, setPreview] = useState<VoicePreview | null>(null);
  const [samples, setSamples] = useState<Partial<Record<SampleKind, { data: NonNullable<VoicePreview["sample"]>; key: string }>>>({});
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [showFull, setShowFull] = useState(false);

  // Everything that changes how it writes (rules don't).
  const voiceKey = JSON.stringify([
    draft.senderName,
    draft.senderTitle,
    draft.companyName,
    draft.website,
    draft.signature,
    draft.bookingLink,
    draft.knowledgeBase,
    draft.tone,
    draft.language,
  ]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      agentApi
        .voice(draft, kind)
        .then((r) => alive && setPreview(r))
        .catch(() => {});
    }, 260);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceKey, kind]);

  async function write() {
    setWriting(true);
    setWriteError("");
    try {
      const r = await agentApi.voice(draft, kind, true);
      setPreview(r);
      if (r.sample) setSamples((s) => ({ ...s, [kind]: { data: r.sample!, key: voiceKey } }));
      else setWriteError(r.error || "The AI didn't return a sample.");
    } catch (e: any) {
      setWriteError(e.message);
    } finally {
      setWriting(false);
    }
  }

  const sample = samples[kind];
  const stale = !!sample && sample.key !== voiceKey;
  const len = LENGTHS.find((l) => l.id === draft.tone.length) || LENGTHS[1];
  const p = meta.sample.prospect;

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line-soft px-5 pb-4 pt-5">
        <div className="flex items-center justify-between gap-2">
          <Label>What the agent is told</Label>
          <span className="text-[11px] text-muted">updates as you type</span>
        </div>
        <div className="mt-3 rounded-lg border border-line-soft bg-sunk p-1.5">
          {preview ? <VoiceBlock text={preview.voice} /> : <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted"><Spinner className="h-3 w-3" /> Building…</div>}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">Included in every first email, follow-up and reply it writes.</p>
      </div>

      <div className="px-5 pb-5 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Try it</Label>
          <Segmented
            compact
            value={kind}
            onChange={setKind}
            options={[
              { id: "first_touch", label: "First email" },
              { id: "reply", label: "Answer a question" },
            ]}
          />
        </div>

        {/* the made-up situation */}
        <div className="mt-3 rounded-lg border border-line-soft bg-surf2 p-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line-strong bg-sunk text-[11px] font-bold text-ink-soft">
              {p.name
                .split(" ")
                .map((w) => w[0])
                .slice(0, 2)
                .join("")}
            </span>
            <div className="min-w-0 text-[12.5px] leading-snug">
              <div className="truncate font-semibold">{p.name}</div>
              <div className="truncate text-muted">
                {p.title} · {p.company}
              </div>
            </div>
            <Badge className="ml-auto bg-ink/[0.06] text-muted">Example</Badge>
          </div>
          {kind === "first_touch" ? (
            <ul className="mt-2.5 space-y-1 text-[12px] leading-relaxed text-muted">
              {p.research.map((r) => (
                <li key={r} className="flex gap-2">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink/30" />
                  {r}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2.5 border-l-2 border-line-strong pl-3 text-[12.5px] leading-relaxed text-ink-soft">{meta.sample.inbound.body}</p>
          )}
        </div>

        {/* the result */}
        {sample ? (
          <div className={cn("mt-3 rounded-lg border border-line bg-paper transition-opacity", (stale || writing) && "opacity-55")}>
            <div className="space-y-1 border-b border-line-soft px-3.5 py-2.5 text-[12px]">
              <div className="flex gap-2">
                <span className="w-12 shrink-0 text-muted">To</span>
                <span className="truncate">{p.name}</span>
              </div>
              <div className="flex gap-2">
                <span className="w-12 shrink-0 text-muted">Subject</span>
                <span className="font-semibold">{sample.data.subject || "—"}</span>
              </div>
            </div>
            <div className="whitespace-pre-wrap px-3.5 py-3 text-[13.5px] leading-relaxed" dir="auto">
              {sample.data.body}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft px-3.5 py-2 text-[11.5px] text-muted">
              <span>
                {sample.data.model} · 1 AI call
              </span>
              <WordCount body={sample.data.body} range={len.range} />
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] leading-relaxed text-muted">
            {aiReady ? "Write a sample to hear the voice on this example." : "Connect an AI key and the agent writes this example in the voice above."}
          </div>
        )}

        {stale && !writing && <p className="mt-2 text-[12px] text-warn">You changed the voice since this was written. Write it again to compare.</p>}
        {writeError && <p className="mt-2 text-[12px] leading-relaxed text-bad">{writeError}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {aiReady ? (
            <Button size="sm" onClick={write} loading={writing}>
              {sample ? "Write it again" : "Write a sample"}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onConnect}>
              Connect an AI key
            </Button>
          )}
          <button type="button" onClick={() => setShowFull(!showFull)} aria-expanded={showFull} className="ml-auto flex items-center gap-1.5 text-[12px] font-semibold text-ink-soft hover:text-ink">
            <Chevron open={showFull} />
            Full prompt
          </button>
        </div>
        {showFull && preview && (
          <div className="mt-3 max-h-[340px] overflow-auto rounded-lg border border-line-soft bg-sunk p-3 font-mono text-[11.5px] leading-relaxed text-ink-soft">
            <div className="mono-label mb-1 text-muted">System</div>
            <pre className="whitespace-pre-wrap font-mono">{preview.system}</pre>
            <div className="mono-label mb-1 mt-3 text-muted">Message</div>
            <pre className="whitespace-pre-wrap font-mono">{preview.prompt}</pre>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The voice instructions, line by line; lines that just changed flash. */
function VoiceBlock({ text }: { text: string }) {
  const prev = useRef<string[]>([]);
  const [flash, setFlash] = useState<number[]>([]);
  const lines = useMemo(() => text.split("\n"), [text]);
  useEffect(() => {
    const before = prev.current;
    prev.current = lines;
    if (!before.length) return;
    const changed = lines.map((l, i) => (before[i] !== l ? i : -1)).filter((i) => i >= 0);
    if (!changed.length) return;
    setFlash(changed);
    const t = setTimeout(() => setFlash([]), 1100);
    return () => clearTimeout(t);
  }, [lines]);
  return (
    <div className="space-y-0.5 font-mono text-[11.5px] leading-[1.6]" dir="auto">
      {lines.map((l, i) => (
        <p key={i} className={cn("rounded-md px-2 py-1 transition-colors duration-700", flash.includes(i) ? "bg-tlb text-ink" : "text-ink-soft")}>
          {l}
        </p>
      ))}
    </div>
  );
}

function WordCount({ body, range }: { body: string; range: [number, number] }) {
  // Signature lines don't count toward the target length.
  const n = words(body);
  const within = n >= range[0] * 0.85 && n <= range[1] * 1.25;
  return (
    <span className={cn("tabular-nums", within ? "text-good" : "text-warn")} title={`Target ${range[0]}–${range[1]} words, signature included loosely`}>
      {n} words · target {range[0]}–{range[1]}
    </span>
  );
}

/* --------------------------------- replies --------------------------------- */

function RepliesSection({
  draft,
  update,
  meta,
  intg,
  onConnect,
}: {
  draft: AgentSettings;
  update: (fn: (d: AgentSettings) => AgentSettings) => void;
  meta: AgentMeta;
  intg: Integrations;
  onConnect: () => void;
}) {
  const ar = draft.autoReply;
  const setAr = (patch: Partial<AgentSettings["autoReply"]>) => update((d) => ({ ...d, autoReply: { ...d.autoReply, ...patch } }));
  const [scenario, setScenario] = useState<Scenario>({ category: "question", confidence: 0.85, autoRepliesInThread: 0 });
  const [preview, setPreview] = useState<RulesPreview | null>(null);
  const rulesKey = JSON.stringify(ar);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      agentApi
        .rules(draft, scenario)
        .then((r) => alive && setPreview(r))
        .catch(() => {});
    }, 160);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey, scenario]);

  const outcomes = useMemo(() => new Map((preview?.categories || []).map((c) => [c.id, c.outcome])), [preview]);
  const conversation = meta.categories.filter((c) => c.kind !== "silent");
  const housekeeping = meta.categories.filter((c) => c.kind === "silent");
  const counts = useMemo(() => {
    const out: Record<ReplyAction, number> = { send: 0, draft: 0, handoff: 0, silent: 0 };
    for (const c of conversation) {
      const o = outcomes.get(c.id);
      if (o) out[o.action]++;
    }
    return out;
  }, [outcomes, conversation]);

  const missing = [!intg.instantly.configured && "Instantly", !intg.ai.configured && "an AI key"].filter(Boolean) as string[];
  const rulesAreDefault = JSON.stringify({ ...ar, handoffCategories: [...ar.handoffCategories].sort() }) ===
    JSON.stringify({ ...meta.defaults.autoReply, handoffCategories: [...meta.defaults.autoReply.handoffCategories].sort() });

  function toggleHandoff(id: ReplyCategoryId, keep: boolean) {
    const set = new Set(ar.handoffCategories);
    if (keep) set.add(id);
    else set.delete(id);
    // Canonical order, so toggling back and forth isn't an "unsaved change".
    setAr({ handoffCategories: meta.categories.map((c) => c.id).filter((c) => set.has(c)) });
  }

  return (
    <div className="space-y-4">
      {missing.length > 0 && ar.enabled && ar.mode !== "drafts" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-wnl bg-wnb px-4 py-3 text-[13px] leading-relaxed text-warn">
          <span className="min-w-0 max-w-[760px]">
            <span className="font-semibold">Nothing is answered yet.</span> Auto-reply needs {missing.join(" and ")} to read and send replies.
            These rules start working the moment both are connected.
          </span>
          <Button size="sm" variant="outline" onClick={onConnect}>
            Open connections
          </Button>
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <div className="min-w-0 space-y-4">
          {/* switch + mode */}
          <Card className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <Toggle
                big
                checked={ar.enabled}
                onChange={(v) => setAr({ enabled: v })}
                label="Answer replies automatically"
                hint={ar.enabled ? "The agent reads every reply, sorts it, and acts on it within your rules." : "Off: every reply waits in the Inbox for you. Unsubscribes and bounces are still handled."}
              />
              {!rulesAreDefault && (
                <Button size="sm" variant="ghost" onClick={() => setAr(structuredClone(meta.defaults.autoReply))}>
                  Reset rules
                </Button>
              )}
            </div>
            <div className={cn("mt-5 grid gap-2.5 sm:grid-cols-3", !ar.enabled && "pointer-events-none opacity-45")} role="radiogroup" aria-label="Auto-reply mode">
              {MODES.map((m) => {
                const on = ar.mode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!ar.enabled}
                    onClick={() => setAr({ mode: m.id })}
                    className={cn(
                      "flex flex-col rounded-xl border p-3.5 text-left transition-colors",
                      on ? "border-keepl bg-keep1" : "border-line-soft bg-surf2 hover:border-line-strong"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded-full border-2", on ? "border-accent" : "border-line-strong")}>
                        {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                      </span>
                      <span className={cn("text-[13.5px] font-semibold", on && "text-accent")}>{m.title}</span>
                    </span>
                    <span className="mt-1.5 text-[12px] leading-relaxed text-muted">{m.body}</span>
                    {on && ar.enabled && preview && (
                      <span className="mt-2.5 flex flex-wrap gap-1.5 border-t border-keepl pt-2.5">
                        {(["send", "draft", "handoff"] as const)
                          .filter((a) => counts[a] > 0)
                          .map((a) => (
                            <Badge key={a} className={ACTION[a].cls}>
                              {counts[a]} {a === "send" ? "auto-sent" : a === "draft" ? "drafted" : "to you"}
                            </Badge>
                          ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </Card>

          {/* the board */}
          <Card className="overflow-hidden">
            <div className="px-5 pb-3 pt-5 sm:px-6">
              <SectionHead label="Reply by reply" title="What happens to each kind of reply" />
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                Every reply is sorted into one of these first. Switch on <span className="font-medium text-ink-soft">Keep for me</span> for
                anything you want to answer yourself.
              </p>
            </div>
            <BoardHead />
            {conversation.map((c) => (
              <CategoryRow key={c.id} c={c} outcome={outcomes.get(c.id)} keep={ar.handoffCategories.includes(c.id)} onKeep={(v) => toggleHandoff(c.id, v)} />
            ))}
            <div className="border-y border-line-soft bg-surf2 px-5 py-2 sm:px-6">
              <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Housekeeping · no email is sent</span>
            </div>
            {housekeeping.map((c) => (
              <CategoryRow key={c.id} c={c} outcome={outcomes.get(c.id)} keep={false} onKeep={() => {}} />
            ))}
          </Card>

          {/* guardrails */}
          <Card className="p-5 sm:p-6">
            <SectionHead label="Guardrails" title="Limits on what it sends alone" />
            <div className="mt-5 grid gap-6 md:grid-cols-2">
              <div>
                <MiniLabel>Auto-replies per thread</MiniLabel>
                <div className="flex items-center gap-3">
                  <Stepper value={ar.maxPerThread} min={0} max={20} onChange={(v) => setAr({ maxPerThread: v })} label="auto-replies" />
                  <p className="text-[12.5px] leading-snug text-muted">
                    {ar.maxPerThread === 0
                      ? "Never sends on its own: every reply is drafted or handed to you."
                      : `After ${ar.maxPerThread} in one conversation, the next reply comes to you.`}
                  </p>
                </div>
              </div>
              <div>
                <Slider
                  label="Confidence needed"
                  valueLabel={`${Math.round(ar.minConfidence * 100)}%`}
                  value={Math.round(ar.minConfidence * 100)}
                  min={50}
                  max={100}
                  step={5}
                  onChange={(v) => setAr({ minConfidence: v / 100 })}
                  ariaLabel="Confidence needed"
                />
                <p className="mt-2 text-[12.5px] leading-snug text-muted">
                  If it is less sure than this about what a reply means, a person decides.
                </p>
              </div>
            </div>
            <div className="mt-6 border-t border-line-soft pt-5">
              <MiniLabel>Reply delay</MiniLabel>
              <div className="grid max-w-[360px] grid-cols-2 gap-3">
                <NumField
                  label="At least"
                  suffix="min"
                  value={ar.delayMinMinutes}
                  min={0}
                  max={600}
                  onChange={(v) => setAr({ delayMinMinutes: v, delayMaxMinutes: Math.max(v, ar.delayMaxMinutes) })}
                />
                <NumField
                  label="At most"
                  suffix="min"
                  value={ar.delayMaxMinutes}
                  min={0}
                  max={1440}
                  onChange={(v) => setAr({ delayMaxMinutes: v, delayMinMinutes: Math.min(v, ar.delayMinMinutes) })}
                />
              </div>
              <DelayTimeline min={ar.delayMinMinutes} max={ar.delayMaxMinutes} />
              <p className="mt-2 text-[12.5px] leading-snug text-muted">
                {ar.delayMaxMinutes === 0
                  ? "Replies go out the moment they are written. An instant answer reads like a bot."
                  : `Each reply waits a random ${ar.delayMinMinutes === ar.delayMaxMinutes ? ar.delayMinMinutes : `${ar.delayMinMinutes}–${ar.delayMaxMinutes}`} minutes, the way a person would answer.`}
              </p>
            </div>
            <div className="mt-6 border-t border-line-soft pt-5">
              <Toggle
                checked={ar.acknowledgeNotInterested}
                onChange={(v) => setAr({ acknowledgeNotInterested: v })}
                label='Reply to "not interested"'
                hint="On: a one-line thank-you, then nothing more. Off: the sequence just stops, which most people prefer."
              />
            </div>
          </Card>
        </div>

        <div className="min-w-0 lg:sticky lg:top-[80px]">
          <ScenarioTester meta={meta} scenario={scenario} onChange={setScenario} result={preview?.scenario || null} draft={draft} />
        </div>
      </div>
    </div>
  );
}

function BoardHead() {
  return (
    <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_120px_108px] gap-4 border-y border-line-soft bg-surf2 px-6 py-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted md:grid">
      <span>Reply</span>
      <span>What the agent does</span>
      <span>Outcome</span>
      <span className="whitespace-nowrap text-right">Keep for me</span>
    </div>
  );
}

function CategoryRow({ c, outcome, keep, onKeep }: { c: ReplyCategory; outcome?: { action: ReplyAction; reason: string }; keep: boolean; onKeep: (v: boolean) => void }) {
  const a = outcome ? ACTION[outcome.action] : null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1.5 border-b border-line-soft px-5 py-3.5 transition-colors last:border-b-0 hover:bg-hov sm:px-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_120px_108px] md:items-center">
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold">{c.label}</div>
        <div className="text-[12px] leading-snug text-muted">{c.description}</div>
      </div>
      <div className="col-span-2 row-start-2 text-[12.5px] leading-snug text-ink-soft md:col-span-1 md:row-start-auto">
        {c.handling}
        {/* Phones have no hover tooltip: show WHY, but only when it says something new. */}
        {outcome && outcome.action !== "send" && !c.locked && outcome.reason !== c.handling && (
          <span className="mt-0.5 block text-[11.5px] text-muted md:hidden">{outcome.reason}</span>
        )}
      </div>
      <div className="col-start-2 row-start-1 flex flex-col items-end gap-1.5 md:col-start-auto md:row-start-auto md:items-start">
        {a ? (
          <span title={outcome!.reason}>
            <Badge className={a.cls}>{a.chip}</Badge>
          </span>
        ) : (
          <span className="h-5 w-16 animate-pulse rounded-full bg-ink/[0.06]" />
        )}
        <span className="md:hidden">
          <KeepControl c={c} keep={keep} onKeep={onKeep} />
        </span>
      </div>
      <div className="hidden justify-end md:flex">
        <KeepControl c={c} keep={keep} onKeep={onKeep} />
      </div>
    </div>
  );
}

function KeepControl({ c, keep, onKeep }: { c: ReplyCategory; keep: boolean; onKeep: (v: boolean) => void }) {
  if (c.kind === "silent") return <span className="text-[11.5px] text-muted">Automatic</span>;
  if (c.locked)
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted" title="Always comes to you">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        Always
      </span>
    );
  return <Switch checked={keep} onChange={onKeep} label={`Keep ${c.label.toLowerCase()} replies for me`} />;
}

function ScenarioTester({
  meta,
  scenario,
  onChange,
  result,
  draft,
}: {
  meta: AgentMeta;
  scenario: Scenario;
  onChange: (s: Scenario) => void;
  result: { action: ReplyAction; reason: string; delayMinutes?: [number, number] } | null;
  draft: AgentSettings;
}) {
  const cat = meta.categories.find((c) => c.id === scenario.category);
  const a = result ? ACTION[result.action] : null;
  const conf = Math.round(scenario.confidence * 100);
  return (
    <Card className="overflow-hidden">
      <div className="px-5 pb-4 pt-5">
        <Label>Try a reply</Label>
        <h3 className="mt-1.5 text-[1rem] font-[650] tracking-[-0.01em]">What would the agent do?</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Uses your unsaved changes, so you can test a rule before saving it.</p>
        <div className="mt-4 space-y-4">
          <Field label="The reply is">
            <Select value={scenario.category} onChange={(e) => onChange({ ...scenario, category: e.target.value as ReplyCategoryId })}>
              <optgroup label="Conversations">
                {meta.categories
                  .filter((c) => c.kind !== "silent")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Housekeeping">
                {meta.categories
                  .filter((c) => c.kind === "silent")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </optgroup>
            </Select>
          </Field>
          <Slider
            label="How sure the agent is"
            valueLabel={`${conf}%`}
            value={conf}
            min={0}
            max={100}
            step={5}
            onChange={(v) => onChange({ ...scenario, confidence: v / 100 })}
            marker={Math.round(draft.autoReply.minConfidence * 100)}
            markerLabel="Your confidence bar"
            ariaLabel="How sure the agent is"
          />
          <div>
            <MiniLabel>Auto-replies already sent in this thread</MiniLabel>
            <div className="flex items-center gap-3">
              <Stepper value={scenario.autoRepliesInThread} min={0} max={20} onChange={(v) => onChange({ ...scenario, autoRepliesInThread: v })} label="replies sent" />
              <span className="text-[12px] text-muted">limit {draft.autoReply.maxPerThread}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="border-t border-line-soft bg-surf2 p-4" aria-live="polite">
        {a && result ? (
          <div className="flex gap-3">
            <span className={cn("w-[3px] shrink-0 rounded-full", a.bar)} aria-hidden />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-[650] tracking-[-0.01em]">{a.headline}</span>
                <Badge className={a.cls}>{a.chip}</Badge>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{result.reason}</p>
              {cat && result.action !== "handoff" && <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{cat.handling}</p>}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <Spinner className="h-3 w-3" /> Working it out…
          </div>
        )}
      </div>
    </Card>
  );
}

function DelayTimeline({ min, max }: { min: number; max: number }) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const scale = Math.max(60, Math.ceil((hi * 1.25) / 30) * 30);
  const left = (lo / scale) * 100;
  const width = Math.max(1.4, ((hi - lo) / scale) * 100);
  const fmt = (m: number) => (m >= 120 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  return (
    <div className="mt-3 max-w-[560px]" aria-hidden>
      <div className="relative h-9 overflow-hidden rounded-lg border border-line-soft bg-surf2">
        {[0.25, 0.5, 0.75].map((f) => (
          <span key={f} className="absolute inset-y-0 w-px bg-line-soft" style={{ left: `${f * 100}%` }} />
        ))}
        <span className="absolute inset-y-0 left-0 w-[3px] bg-ink/40" />
        <span className="absolute inset-y-[6px] rounded-md border border-keepl bg-keep1 transition-[left,width] duration-200" style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted">
        <span>reply arrives</span>
        <span>{fmt(scale / 2)}</span>
        <span>{fmt(scale)}</span>
      </div>
    </div>
  );
}

/* --------------------------------- save bar -------------------------------- */

function SaveBar({ saving, onSave, onDiscard }: { saving: boolean; onSave: () => void; onDiscard: () => void }) {
  const mac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
  return (
    <div className="savebar fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper shadow-[0_-12px_32px_var(--shadow)]">
      <div className="w flex flex-wrap items-center justify-between gap-3 py-3">
        <p className="flex items-center gap-2.5 text-[13px] text-ink-soft">
          <span className="h-2 w-2 shrink-0 rounded-full bg-warn ring-4 ring-wnb" />
          Unsaved changes to the voice or the reply rules.
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button size="sm" onClick={onSave} loading={saving}>
            Save changes
            <kbd className="hidden rounded border border-current/30 px-1 font-sans text-[10.5px] font-semibold opacity-70 sm:inline">{mac ? "⌘S" : "Ctrl S"}</kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- small parts ------------------------------- */

const Label = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("text-[11px] font-semibold uppercase tracking-[0.09em] text-muted", className)}>{children}</div>
);

const MiniLabel = ({ children }: { children: ReactNode }) => <div className="mb-2 text-[12.5px] font-semibold text-ink-soft">{children}</div>;

function SectionHead({ label, title }: { label: string; title: string }) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <h2 className="mt-1.5 text-[1.05rem] font-[650] tracking-[-0.01em]">{title}</h2>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={cn("transition-transform", open && "rotate-90")} aria-hidden>
      <path d="M3.5 2l3 3-3 3" />
    </svg>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  compact,
}: {
  value: T;
  options: { id: T; label: string; sub?: string }[];
  onChange: (v: T) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      className={cn("grid gap-1 rounded-lg border border-line bg-sunk p-1", compact && "inline-grid")}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={cn(
              "min-w-0 rounded-md text-center font-semibold transition-colors",
              compact ? "px-2.5 py-1 text-[12px]" : "px-2 py-2 text-[12.5px]",
              on ? "bg-hov text-ink ring-1 ring-inset ring-line-strong" : "text-muted hover:text-ink"
            )}
          >
            <span className="block truncate">{o.label}</span>
            {o.sub && <span className="mt-0.5 block truncate text-[11px] font-normal text-muted">{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  valueLabel,
  bands,
  activeBand,
  marker,
  markerLabel,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  valueLabel?: string;
  bands?: string[];
  activeBand?: number;
  marker?: number;
  markerLabel?: string;
  ariaLabel: string;
}) {
  const pos = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
  const pct = pos(value);
  return (
    <div>
      {(label || valueLabel) && (
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-semibold">{label}</span>
          <span className="text-[12.5px] tabular-nums text-muted">{valueLabel ?? value}</span>
        </div>
      )}
      <div className="relative mx-[9px] h-[22px]">
        <div className="absolute -left-[9px] -right-[9px] top-1/2 h-[6px] -translate-y-1/2 rounded-full bg-ink/[0.1]" />
        <div className="absolute -left-[9px] top-1/2 h-[6px] -translate-y-1/2 rounded-full bg-brand" style={{ width: `calc(${pct}% + 9px)` }} />
        {bands &&
          [33.5, 66.5].map((f) => <span key={f} className="absolute top-1/2 h-[10px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded bg-paper" style={{ left: `${f}%` }} />)}
        {marker != null && (
          <span className="absolute -top-[3px] h-[28px] w-[2px] -translate-x-1/2 rounded bg-warn" style={{ left: `${pos(marker)}%` }} title={markerLabel} />
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={ariaLabel}
          aria-valuetext={valueLabel ?? (bands && activeBand != null ? `${bands[activeBand]} (${value})` : String(value))}
          className="peer absolute -left-[9px] top-0 z-10 m-0 h-full cursor-pointer opacity-0"
          style={{ width: "calc(100% + 18px)" }}
        />
        <span
          className="pointer-events-none absolute top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand bg-paper shadow-[0_1px_4px_var(--shadow)] transition-transform peer-active:scale-110 peer-focus-visible:ring-4 peer-focus-visible:ring-accent/30"
          style={{ left: `${pct}%` }}
        />
      </div>
      {bands && (
        <div className="mt-1.5 grid grid-cols-3 text-[11.5px]">
          {bands.map((b, i) => (
            <span key={b} className={cn(i === 0 ? "text-left" : i === 1 ? "text-center" : "text-right", i === activeBand ? "font-semibold text-ink" : "text-muted")}>
              {b}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  const btn = "grid h-9 w-9 place-items-center text-ink/70 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35";
  return (
    <div className="inline-flex shrink-0 items-center rounded-lg border border-line bg-sunk">
      <button type="button" className={btn} aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M2.5 6h7" />
        </svg>
      </button>
      <span className="min-w-[2.6ch] text-center text-[14px] font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button type="button" className={btn} aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M2.5 6h7M6 2.5v7" />
        </svg>
      </button>
    </div>
  );
}

function NumField({ label, value, onChange, suffix, min, max }: { label: string; value: number; onChange: (v: number) => void; suffix: string; min: number; max: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-muted">{label}</span>
      <span className="flex items-center rounded-lg border border-line bg-sunk focus-within:border-accent">
        <input
          inputMode="numeric"
          value={text}
          onChange={(e) => {
            const t = e.target.value.replace(/[^\d]/g, "");
            setText(t);
            if (t !== "") onChange(Math.min(max, Math.max(min, Number(t))));
          }}
          onBlur={() => setText(String(value))}
          className="w-full min-w-0 bg-transparent px-3 py-2 text-[13.5px] tabular-nums text-ink outline-none"
        />
        <span className="shrink-0 pr-3 text-[12px] text-muted">{suffix}</span>
      </span>
    </label>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-brand" : "bg-ink/[0.14]")}
    >
      <span className={cn("absolute top-[3px] h-[14px] w-[14px] rounded-full bg-paper shadow transition-[left]", checked ? "left-[17px]" : "left-[3px]")} />
    </button>
  );
}

function Toggle({ checked, onChange, label, hint, big }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; big?: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 basis-[280px] items-start gap-3">
      <span className="mt-0.5">
        <Switch checked={checked} onChange={onChange} label={label} />
      </span>
      <button type="button" onClick={() => onChange(!checked)} className="min-w-0 text-left">
        <span className={cn("block font-semibold", big ? "text-[15px] tracking-[-0.01em]" : "text-[13px]")}>{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{hint}</span>}
      </button>
    </div>
  );
}
