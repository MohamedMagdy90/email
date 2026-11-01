// Targeting for ONE campaign: what's working (results board + learning loop),
// the market (with a save bar and a re-check of the leads already found), the
// segments inside it, and who never to contact, with steer-by-chat above the
// results and the segments. Used by the Targeting tab and the campaign view;
// the new-campaign wizard uses MarketEditor and SegmentsSection directly.
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Spinner, cn, toast } from "../../lib/ui";
import type { CampaignDetail } from "../../lib/v2/campaigns";
import { targetingApi, type MarketView, type RecheckResult, type SkipRule, type Taxonomy, type TargetMarket } from "../../lib/v2/targeting";
import { errMsg, plural } from "../campaigns/parts";
import { useCampaignList } from "../shared/CampaignFilter";
import MarketForm from "./MarketForm";
import NeverContact from "./NeverContact";
import Results from "./Results";
import { SegmentsSection } from "./Segments";
import SteerBox from "./Steer";
import { useTaxonomy } from "./useTaxonomy";

export { useTaxonomy };

export type TargetingSection = "results" | "market" | "segments" | "never";

function ruleSummary(skipped: Partial<Record<SkipRule, number>>, labels: Record<SkipRule, string>): string {
  return (Object.entries(skipped) as [SkipRule, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${n} ${labels[r].toLowerCase()}`)
    .join(" · ");
}

/** The market editor with its own save bar; calls onSaved with the fresh view. */
export function MarketEditor({
  c,
  tax,
  onSaved,
  saveLabel = "Save market",
  inline,
}: {
  c: CampaignDetail;
  tax: Taxonomy;
  onSaved?: (v: MarketView) => void;
  saveLabel?: string;
  /** Wizard: a normal button row instead of the sticky bar. */
  inline?: boolean;
}) {
  const [view, setView] = useState<MarketView | null>(null);
  const [draft, setDraft] = useState<TargetMarket | null>(null);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<RecheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const v = await targetingApi.market(c.id);
    setView(v);
    setDraft(v.market);
  }, [c.id]);
  useEffect(() => {
    load().catch((e) => toast(errMsg(e), "error"));
  }, [load]);

  const dirty = !!view && !!draft && JSON.stringify(view.market) !== JSON.stringify(draft);

  const runCheck = async (apply: boolean) => {
    setChecking(true);
    try {
      const r = await targetingApi.recheck(c.id, { apply });
      if (apply) {
        toast(`Re-checked: ${plural(r.wouldSkip, "lead")} skipped, ${r.wouldRestore} brought back.`, "success");
        setCheck(null);
        const v = await targetingApi.market(c.id);
        setView(v);
        onSaved?.(v);
      } else setCheck(r);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.countries.length) return toast("Pick at least one country", "error");
    if (!draft.titles.length) return toast("Add at least one decision-maker title", "error");
    setSaving(true);
    try {
      const v = await targetingApi.saveMarket(c.id, draft);
      setView(v);
      setDraft(v.market);
      toast(v.regenerated ? `Saved. Searches rebuilt for ${plural(v.regenerated, "segment")}.` : "Saved.", "success");
      onSaved?.(v);
      // Does the change affect leads already found?
      const r = await targetingApi.recheck(c.id, { apply: false });
      setCheck(r.wouldSkip || r.wouldRestore ? r : null);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl+S
  useEffect(() => {
    if (inline) return;
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && dirty) {
        e.preventDefault();
        if (!saving) save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  if (!view || !draft) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted">
        <Spinner /> Loading the market…
      </div>
    );
  }
  const skippedText = ruleSummary(view.skipped, tax.skipRules);

  return (
    <div className={cn(dirty && !inline && "pb-20")}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-soft bg-paper px-4 py-3">
        <p className="min-w-0 text-[12.5px] leading-relaxed text-muted">
          {skippedText ? (
            <>
              <span className="font-semibold text-ink">Skipped by these rules so far:</span> {skippedText}.
            </>
          ) : (
            "Every company found is checked against these rules right after it's researched, before any person search, score or email."
          )}
        </p>
        <Button variant="outline" size="sm" loading={checking && !check} onClick={() => runCheck(false)}>
          Check the leads already found
        </Button>
      </div>

      {check && (
        <Card className="mb-4 border-wnl px-4 py-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 text-[13px] leading-relaxed">
              {check.wouldSkip || check.wouldRestore ? (
                <>
                  <b className="font-semibold">
                    {check.wouldSkip ? `${plural(check.wouldSkip, "lead")} already found ${check.wouldSkip === 1 ? "is" : "are"} now outside the target` : ""}
                    {check.wouldSkip && check.wouldRestore ? ", and " : ""}
                    {check.wouldRestore ? `${plural(check.wouldRestore, "lead")} skipped earlier ${check.wouldRestore === 1 ? "is" : "are"} back inside` : ""}.
                  </b>
                  {check.wouldSkip > 0 && (
                    <span className="text-muted">
                      {" "}
                      ({(Object.entries(check.byRule) as [SkipRule, number][]).map(([r, n]) => `${n} ${tax.skipRules[r].toLowerCase()}`).join(", ")})
                    </span>
                  )}
                  <ul className="mt-1.5 space-y-0.5 text-[12px] text-muted">
                    {check.samples.slice(0, 5).map((s) => (
                      <li key={s.prospectId}>
                        <span className={s.action === "skip" ? "text-warn" : "text-good"}>{s.action === "skip" ? "Skip" : "Back"}</span> · {s.company} — {s.reason.replace(/^Outside the target: /, "")}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <span className="text-muted">Checked {plural(check.checked, "lead")}: all of them fit the current target.</span>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCheck(null)}>
                {check.wouldSkip || check.wouldRestore ? "Keep them as they are" : "Close"}
              </Button>
              {(check.wouldSkip > 0 || check.wouldRestore > 0) && (
                <Button size="sm" loading={checking} onClick={() => runCheck(true)}>
                  Apply
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      <MarketForm tax={tax} value={draft} onChange={setDraft} kind={view.kind} agent={view.agent} />

      {inline ? (
        <div className="mt-4 flex justify-end gap-2">
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(view.market)}>
              Undo changes
            </Button>
          )}
          <Button loading={saving} onClick={save}>
            {saveLabel}
          </Button>
        </div>
      ) : (
        dirty && (
          <div className="savebar fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper shadow-[0_-12px_32px_var(--shadow)]">
            <div className="w flex flex-wrap items-center justify-between gap-3 py-3">
              <p className="flex items-center gap-2.5 text-[13px] text-ink-soft">
                <span className="h-2 w-2 shrink-0 rounded-full bg-warn ring-4 ring-wnb" />
                Unsaved changes to the target market of "{c.name}".
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDraft(view.market)} disabled={saving}>
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
    </div>
  );
}

export default function TargetingPanel({
  c,
  reload,
  onCampaign,
  initial,
  focus,
  edit,
}: {
  c: CampaignDetail;
  reload: () => Promise<void>;
  onCampaign?: (c: CampaignDetail) => void;
  /** default: Results once the campaign has segments, else Market */
  initial?: TargetingSection;
  /** open this segment's numbers + search log (openSegment handoff) */
  focus?: { sid: string; n: number } | null;
  /** open this segment in the builder (Edit on the all-campaigns board) */
  edit?: { sid: string; n: number } | null;
}) {
  const tax = useTaxonomy();
  const campaigns = useCampaignList();
  const [section, setSection] = useState<TargetingSection>(edit ? "segments" : focus ? "results" : initial || (c.segmentList.length ? "results" : "market"));
  // Edit from the results board opens the builder in Segments.
  const [editSeg, setEditSeg] = useState<{ sid: string | "new"; n: number } | null>(edit || null);
  // Bumped after a steer or an edit so the board re-reads its numbers.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (focus) setSection("results");
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadAll = async () => {
    await reload();
    setVersion((v) => v + 1);
  };
  const enabled = c.segmentList.filter((s) => s.enabled).length;
  const tabs: { id: TargetingSection; label: string; sub: string }[] = [
    { id: "results", label: "Results", sub: c.segmentList.length ? "what's working" : "no segments yet" },
    { id: "market", label: "Market", sub: `${c.market.countries.length} countr${c.market.countries.length === 1 ? "y" : "ies"}` },
    { id: "segments", label: "Segments", sub: c.segmentList.length ? `${enabled} on` : "none yet" },
    { id: "never", label: "Never contact", sub: "every campaign" },
  ];
  const editFromBoard = (_cid: string, sid: string | "new") => {
    setEditSeg({ sid, n: Date.now() });
    setSection("segments");
    window.scrollTo({ top: 0 });
  };

  if (!tax) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted">
        <Spinner /> Loading…
      </div>
    );
  }
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Targeting">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={section === t.id}
            onClick={() => setSection(t.id)}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold transition-colors",
              section === t.id ? "bg-hov text-ink ring-1 ring-inset ring-line-strong" : "text-muted hover:bg-hov hover:text-ink"
            )}
          >
            {t.label}
            <span className="hidden font-normal text-muted sm:inline">{t.sub}</span>
          </button>
        ))}
      </div>
      {(section === "results" || section === "segments") && <SteerBox c={c} onApplied={reloadAll} />}
      {section === "results" && <Results campaignId={c.id} campaigns={campaigns} version={version} focus={focus} onEditSegment={editFromBoard} onAddSegments={() => editFromBoard(c.id, "new")} onChanged={() => reload()} />}
      {section === "market" && <MarketEditor c={c} tax={tax} onSaved={() => reloadAll()} />}
      {section === "segments" && <SegmentsSection key={editSeg?.n || 0} c={c} tax={tax} market={c.market} reload={reloadAll} initialEditing={editSeg?.sid ?? null} />}
      {section === "never" && <NeverContact c={c} onCampaignSaved={onCampaign} />}
    </div>
  );
}
