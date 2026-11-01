// One segment's results, in a drawer (plan §8.4.5 "segment detail"): its
// numbers and what the learning loop makes of them, the definition, the
// search log (every query that ran, what came back, what was thrown away and
// by which rule) and the companies it found. Opened from the results board,
// the Dashboard and anywhere openSegment() is called.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Spinner, cn, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import type { CampaignSummary } from "../../lib/v2/campaigns";
import { LOOP_LABEL, LOOP_TONE, sizeSummary, targetingApi, type LoopStatus, type SearchLogEntry, type SegmentDetail, type SegmentRules, type SizeBand } from "../../lib/v2/targeting";
import { Chips, StageChip, errMsg, openCampaign, plural } from "../campaigns/parts";
import { Menu } from "../shared/Menu";
import LeadDrawer from "../leads/LeadDrawer";
import { Segmented } from "./controls";
import { useTaxonomy } from "./useTaxonomy";

type Tab = "overview" | "searches" | "companies";

export const STATUS_HINT: Record<LoopStatus, string> = {
  scaling: "Gets the biggest share of new leads",
  working: "Keeps its normal share",
  testing: "Small share until there are enough emails to judge",
  paused: "Stops finding and sending for it",
};

/** Menu items that move a segment to another status by hand. */
export function statusItems(cur: LoopStatus, move: (s: LoopStatus) => void) {
  return (["scaling", "working", "testing", "paused"] as LoopStatus[])
    .filter((s) => s !== cur)
    .map((s) => ({ label: s === "paused" ? "Pause it" : `Move to ${LOOP_LABEL[s]}`, hint: STATUS_HINT[s], onClick: () => move(s), danger: s === "paused" }));
}

/** Menu items that copy a segment into a campaign (its own = "(copy)"). */
export function copyItems(campaigns: CampaignSummary[] | null, fromCampaign: string, copy: (campaignId: string, name: string) => void) {
  return (campaigns || []).map((c) => ({
    label: c.id === fromCampaign ? "Copy within this campaign" : `Copy into ${c.name}`,
    hint: c.id === fromCampaign ? undefined : c.kind === "partner" ? "Partners campaign" : "Customers campaign",
    onClick: () => copy(c.id, c.name),
  }));
}

const fmtPct = (n: number | null) => (n == null ? "—" : `${n}%`);

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="min-w-0 rounded-xl border border-line-soft bg-paper px-3.5 py-3">
      <div className="mono-label truncate text-muted">{label}</div>
      <div className={cn("mt-1.5 text-[1.3rem] font-[650] leading-none tracking-[-0.02em] tabular-nums", tone === "good" && "text-good", tone === "bad" && "text-bad", tone === "warn" && "text-warn")}>{value}</div>
      {sub && <div className="mt-1.5 truncate text-[11.5px] text-muted">{sub}</div>}
    </div>
  );
}

function Def({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-dashed border-line-soft py-2.5 last:border-b-0 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-ink-soft">{children}</dd>
    </div>
  );
}

function SearchRow({ s }: { s: SearchLogEntry }) {
  const [open, setOpen] = useState(false);
  const thrown = s.rejected.reduce((n, r) => n + r.count, 0);
  return (
    <li className="border-b border-line-soft last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-hov" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <div dir="auto" className="truncate font-mono text-[12.5px] text-ink">
            {s.query}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
            {s.country && <span>{s.country}</span>}
            <span className={cn("rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.05em]", s.via === "gemini" ? "bg-tlb text-accent" : "bg-ink/[0.06] text-ink-soft")}>{s.via === "gemini" ? "Gemini" : "Web search"}</span>
            <span title={new Date(s.ranAt).toLocaleString("en-GB")}>{ago(s.ranAt)}</span>
          </div>
          {s.rejected.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {s.rejected.map((r) => (
                <span key={r.rule} className="rounded-full bg-ink/[0.05] px-2 py-px text-[11px] text-ink-soft">
                  {r.count} {r.label.toLowerCase()}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[13px] tabular-nums">
            <span className="text-muted">{s.results} →</span> <b className={cn("font-[650]", s.added > 0 ? "text-good" : "text-ink-soft")}>{s.added} new</b>
          </div>
          {thrown > 0 && <div className="mt-0.5 text-[11px] text-muted">{thrown} thrown away</div>}
        </div>
      </button>
      {open && (
        <div className="px-4 pb-3">
          {s.examples.length ? (
            <ul className="space-y-1 rounded-lg border border-line-soft bg-sunk px-3 py-2 text-[12px]">
              {s.examples.map((e, i) => (
                <li key={`${e.domain}-${i}`} className="flex gap-2">
                  <b className="shrink-0 font-semibold text-ink-soft">{e.domain || "no website"}</b>
                  <span className="min-w-0 text-muted">{e.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-muted">{s.added ? "Every result it kept went into the campaign." : "Nothing came back that wasn't already known."}</p>
          )}
        </div>
      )}
    </li>
  );
}

export default function SegmentDrawer({
  sid,
  rules,
  campaigns,
  onClose,
  onChanged,
  onEdit,
}: {
  sid: string;
  rules: SegmentRules | null;
  campaigns: CampaignSummary[] | null;
  onClose: () => void;
  /** after a status change, copy or apply */
  onChanged?: () => void;
  /** open the segment builder (shown only when given) */
  onEdit?: (campaignId: string, segmentId: string) => void;
}) {
  const tax = useTaxonomy();
  const [d, setD] = useState<SegmentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [lead, setLead] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await targetingApi.segment(sid));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [sid]);
  useEffect(() => {
    setD(null);
    setTab("overview");
    load();
  }, [load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !lead && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, lead]);

  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast(msg, "success");
      await load();
      onChanged?.();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const industries = useMemo(() => {
    if (!d) return [];
    const byId = new Map((tax?.industries || []).map((i) => [i.id, i.label]));
    const fromIds = d.segment.industryIds.map((id) => byId.get(id) || id);
    return [...fromIds, ...d.segment.industries.filter((l) => !fromIds.includes(l))];
  }, [d, tax]);

  const totals = useMemo(() => {
    const t = { results: 0, added: 0, byRule: new Map<string, { label: string; count: number }>() };
    for (const s of d?.searches || []) {
      t.results += s.results;
      t.added += s.added;
      for (const r of s.rejected) {
        const cur = t.byRule.get(r.rule);
        t.byRule.set(r.rule, { label: r.label, count: (cur?.count || 0) + r.count });
      }
    }
    return { ...t, rules: [...t.byRule.values()].sort((a, b) => b.count - a.count) };
  }, [d]);

  const seg = d?.segment;
  const st = d?.stats;
  const tabs: { id: Tab; label: string; sub?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "searches", label: "Search log", sub: d ? String(d.searches.length) : undefined },
    { id: "companies", label: "Companies", sub: d ? String(d.companies.length) : undefined },
  ];

  return (
    <div className="fixed inset-0 z-[55] flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/45" onClick={onClose} />
      <aside className="drawer-in relative flex h-full w-full max-w-[640px] flex-col border-l border-line bg-cream shadow-2xl" aria-label="Segment">
        <div className="border-b border-line-soft bg-paper px-5 pb-3 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mono-label mb-1 text-muted">Segment</div>
              <div className="truncate text-[17px] font-[650] tracking-[-0.015em]">{seg ? seg.name : error ? "Couldn't load it" : "Loading…"}</div>
              {d && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                  <Badge className={LOOP_TONE[d.segment.loopStatus]}>{LOOP_LABEL[d.segment.loopStatus]}</Badge>
                  {d.segment.exhausted && <Badge className="bg-wnb text-warn">Searched out</Badge>}
                  {d.segment.fitScore != null && <span>Fit {d.segment.fitScore}</span>}
                  <span className="text-ink/30">·</span>
                  <button type="button" className="truncate hover:text-ink hover:underline" onClick={() => openCampaign(d.campaign.id)}>
                    {d.campaign.name}
                  </button>
                </div>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
          {d && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <Segmented size="sm" value={tab} onChange={setTab} options={tabs} />
              <div className="flex flex-wrap gap-1.5">
                <Menu label="Status" items={statusItems(d.segment.loopStatus, (s) => act("status", () => targetingApi.setStatus(sid, s), `Moved "${d.segment.name}" to ${LOOP_LABEL[s]}.`))} />
                <Menu label="Copy" items={copyItems(campaigns, d.campaign.id, (cid, name) => act("copy", () => targetingApi.duplicate(sid, cid), cid === d.campaign.id ? "Copied. The copy starts its searches from the beginning." : `Copied into ${name}. Its searches start from the beginning.`))} />
                {onEdit && (
                  <Button variant="ghost" size="sm" onClick={() => onEdit(d.campaign.id, sid)}>
                    Edit
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {!d ? (
          <div className="flex items-center gap-2 p-6 text-[13px] text-muted">
            {error ? (
              <>
                {error}{" "}
                <Button size="sm" variant="ghost" onClick={load}>
                  Try again
                </Button>
              </>
            ) : (
              <>
                <Spinner /> Loading…
              </>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {d.segment.suggestion && (
              <div className="mb-4 rounded-xl border border-keepl bg-keep1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink">The learning loop suggests: {LOOP_LABEL[d.segment.suggestion.status]}</span>
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{d.segment.suggestion.reason}</p>
                <div className="mt-2.5 flex gap-1.5">
                  <Button size="sm" loading={busy === "apply"} disabled={!!busy} onClick={() => act("apply", () => targetingApi.applySuggestions([sid]), `Moved "${d.segment.name}" to ${LOOP_LABEL[d.segment.suggestion!.status]}.`)}>
                    Apply
                  </Button>
                  <Button size="sm" variant="ghost" loading={busy === "dismiss"} disabled={!!busy} onClick={() => act("dismiss", () => targetingApi.applySuggestions([sid], true), "Dismissed. It's suggested again only if the numbers change it.")}>
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {tab === "overview" && st && seg && (
              <div className="space-y-5">
                <section>
                  {d.verdict !== d.segment.suggestion?.reason && <p className="text-[13px] leading-relaxed text-ink-soft">{d.verdict}</p>}
                  {d.segment.statusReason && d.segment.statusReason !== d.verdict && <p className="mt-1 text-[12px] text-muted">Current status: {d.segment.statusReason}</p>}
                  {rules && st.contacted < rules.testUntil && (
                    <div className="mt-3">
                      <div className="mb-1 flex justify-between text-[11.5px] text-muted">
                        <span>Emailed before it can be judged</span>
                        <span className="tabular-nums">
                          {st.contacted} / {rules.testUntil}
                        </span>
                      </div>
                      <div className="db-meter">
                        <i style={{ width: `${Math.min(100, (st.contacted / rules.testUntil) * 100)}%` }} />
                      </div>
                    </div>
                  )}
                </section>
                <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  <Stat label="Found" value={st.found.toLocaleString()} sub={st.foundToday ? `+${st.foundToday} today` : "companies"} />
                  <Stat label="In target" value={fmtPct(st.inTargetPct)} sub={st.offTarget ? `${st.offTarget} skipped by a rule` : `of ${st.researched} researched`} tone={st.inTargetPct != null && st.inTargetPct < 60 ? "warn" : undefined} />
                  <Stat label="Emailed" value={st.contacted.toLocaleString()} sub="leads contacted" />
                  <Stat label="Replies" value={fmtPct(st.replyRate)} sub={plural(st.replies, "reply", "replies")} />
                  <Stat label="Hot" value={fmtPct(st.positiveRate)} sub={plural(st.positive, "hot lead")} tone={st.positive > 0 ? "good" : undefined} />
                  <Stat label="Bounces" value={fmtPct(st.bounceRate)} sub={plural(st.bounced, "bounce")} tone={rules && st.bounceRate != null && st.bounceRate > rules.pauseBounceRate ? "bad" : undefined} />
                </section>
                <section>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Definition</div>
                  <dl>
                    <Def label="Industry">{industries.length ? <Chips items={industries} tone="bg-keep1 text-accent" /> : <span className="text-warn">None picked</span>}</Def>
                    <Def label="Where">
                      {seg.countries.length || Object.keys(seg.cities).length
                        ? (seg.countries.length ? seg.countries : Object.keys(seg.cities)).map((c) => (seg.cities[c]?.length ? `${c} (${seg.cities[c].join(", ")})` : c)).join(" · ")
                        : "The whole market"}
                    </Def>
                    <Def label="Size">{seg.sizeBands || seg.minBranches ? sizeSummary((seg.sizeBands as SizeBand[]) || [], seg.minBranches) : "The market's size"}</Def>
                    <Def label="Who">{seg.titlesOverride ? seg.titles.join(" → ") : "The market's titles"}</Def>
                    {(seg.signals.must.length > 0 || seg.signals.mustNot.length > 0) && (
                      <Def label="Signals">
                        {seg.signals.must.length > 0 && <span>Mentions {seg.signals.must.join(", ")}</span>}
                        {seg.signals.must.length > 0 && seg.signals.mustNot.length > 0 && <span className="text-muted"> · </span>}
                        {seg.signals.mustNot.length > 0 && <span className="text-bad">never {seg.signals.mustNot.join(", ")}</span>}
                      </Def>
                    )}
                    <Def label="Searches">
                      {seg.searchesDone} of {seg.searchesTotal} run · {seg.queriesAuto ? "built automatically" : "written by hand"}
                      <div className="db-meter mt-1.5 max-w-[260px]">
                        <i style={{ width: `${seg.searchesTotal ? Math.min(100, (seg.searchesDone / seg.searchesTotal) * 100) : 0}%` }} />
                      </div>
                    </Def>
                    {seg.why && <Def label="Why">{seg.why}</Def>}
                  </dl>
                </section>
              </div>
            )}

            {tab === "searches" &&
              (d.searches.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
                  <div className="text-[14px] font-[650]">No searches yet</div>
                  <p className="mx-auto mt-1.5 max-w-[420px] text-[12.5px] leading-relaxed text-muted">The agent runs this segment's searches while the campaign works. Each one is logged here: what came back, what was added, and what was thrown away and why.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-xl border border-line-soft bg-paper px-4 py-3">
                    <div className="text-[13px]">
                      <b className="font-[650] tabular-nums">{plural(d.searches.length, "search", "searches")}</b>
                      <span className="text-muted">
                        {" "}
                        · {totals.results.toLocaleString()} results · <span className="text-good">{totals.added.toLocaleString()} new</span>
                        {totals.results ? ` (${Math.round((totals.added / totals.results) * 100)}% kept)` : ""}
                      </span>
                    </div>
                    {totals.rules.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {totals.rules.map((r) => (
                          <span key={r.label} className="rounded-full bg-ink/[0.05] px-2.5 py-[3px] text-[11.5px] text-ink-soft">
                            {r.count} {r.label.toLowerCase()}
                          </span>
                        ))}
                      </div>
                    )}
                    {d.searches.length >= 100 && <p className="mt-2 text-[11.5px] text-muted">Showing the last 100.</p>}
                  </div>
                  <ul className="overflow-hidden rounded-xl border border-line-soft bg-paper">
                    {d.searches.map((s) => (
                      <SearchRow key={s.id} s={s} />
                    ))}
                  </ul>
                  <p className="text-[11.5px] text-muted">Click a search to see examples of what it threw away.</p>
                </div>
              ))}

            {tab === "companies" &&
              (d.companies.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
                  <div className="text-[14px] font-[650]">No companies yet</div>
                  <p className="mx-auto mt-1.5 max-w-[420px] text-[12.5px] leading-relaxed text-muted">Companies this segment finds show up here with how far each one got.</p>
                </div>
              ) : (
                <ul className="overflow-hidden rounded-xl border border-line-soft bg-paper">
                  {d.companies.map((p) => (
                    <li key={p.id} className="border-b border-line-soft last:border-b-0">
                      <button type="button" onClick={() => setLead(p.id)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hov">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold">{p.company || p.domain}</div>
                          <div className="truncate text-[12px] text-muted">{[p.fullName && `${p.fullName}${p.title ? `, ${p.title}` : ""}`, p.domain, [p.city, p.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</div>
                          {p.stageReason && (p.stage === "skipped" || p.stage === "failed") && <div className="mt-0.5 truncate text-[11.5px] text-warn">{p.stageReason}</div>}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <StageChip stage={p.stage} />
                          {p.fitScore != null && <span className="text-[11px] tabular-nums text-muted">fit {p.fitScore}</span>}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        )}
      </aside>
      {lead && <LeadDrawer pid={lead} onClose={() => setLead(null)} onChanged={load} />}
    </div>
  );
}
