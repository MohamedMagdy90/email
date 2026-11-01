// Targeting results (plan §8.4.5): what's working. The learning loop's rules
// and waiting suggestions, each campaign's offer side by side, and the
// segments board (Testing / Working / Scaling / Paused / Searched out) with
// the numbers behind each status. One campaign, or every campaign at once.
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Badge, Button, Spinner, cn, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import { campaignsApi, type CampaignSummary } from "../../lib/v2/campaigns";
import { LOOP_LABEL, LOOP_TONE, targetingApi, type LoopStatus, type OfferCard, type ResultSegment, type SegmentRules, type TargetingResults } from "../../lib/v2/targeting";
import { Empty, errMsg, openCampaign, plural } from "../campaigns/parts";
import { Menu } from "../shared/Menu";
import { LoopStrip, RulesDialog, SPLIT_COLOR } from "./LoopRules";
import SegmentDrawer, { copyItems, statusItems } from "./SegmentDrawer";

type Filter = "all" | LoopStatus | "exhausted";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "scaling", label: "Scaling" },
  { id: "working", label: "Working" },
  { id: "testing", label: "Testing" },
  { id: "paused", label: "Paused" },
  { id: "exhausted", label: "Searched out" },
];
const ORDER: Record<LoopStatus, number> = { scaling: 0, working: 1, testing: 2, paused: 3 };
const pct = (n: number | null) => (n == null ? <span className="text-muted">—</span> : `${n}%`);
const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

/* --------------------------------- offers --------------------------------- */

const SOURCE: Record<string, [string, string]> = {
  ai: ["Learned by AI", "bg-tlb text-accent"],
  manual: ["Written by you", "bg-inb text-inf"],
  fallback: ["Basic", "bg-wnb text-warn"],
};

function OfferTile({ o, campaigns, onChanged, wide }: { o: OfferCard; campaigns: CampaignSummary[] | null; onChanged: () => void; wide?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast(msg, "success");
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const others = (campaigns || []).filter((c) => c.id !== o.campaignId);
  const learn = () => run("learn", () => campaignsApi.learnOffer(o.campaignId, o.website || "https://dna.systems"), "Learned the offer again from the website.");
  const src = o.offer ? SOURCE[o.offer.source] || SOURCE.manual : null;
  return (
    <article className="db-card flex min-w-0 flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono-label text-muted">{o.kind === "partner" ? "Partner offer" : "Customer offer"}</span>
            {src && <Badge className={src[1]}>{src[0]}</Badge>}
          </div>
          <button type="button" onClick={() => openCampaign(o.campaignId)} className="mt-1 block max-w-full truncate text-left text-[12.5px] text-muted hover:text-ink hover:underline">
            {o.campaignName}
          </button>
        </div>
        <Menu
          label="Offer"
          variant="ghost"
          items={[
            { label: "Edit in the campaign", hint: "Opens the campaign; the Offer tab has every field", onClick: () => openCampaign(o.campaignId) },
            { label: "Learn it again", hint: o.website ? `Reads ${o.website.replace(/^https?:\/\//, "")}` : "Reads the website", onClick: learn },
            ...(o.offer
              ? others.map((c) => ({
                  label: `Copy into ${c.name}`,
                  hint: "Replaces that campaign's offer",
                  onClick: () => {
                    if (confirm(`Replace the offer of "${c.name}" with this one?`)) run("copy", () => campaignsApi.update(c.id, { offer: { ...o.offer!, source: "manual" } }), `Copied the offer into ${c.name}.`);
                  },
                }))
              : []),
          ]}
        />
      </div>
      {o.offer ? (
        <>
          <div className={cn(wide && "md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:gap-8")}>
          <div className="min-w-0">
            <div className="mt-3 text-[15px] font-[650] tracking-[-0.01em]">{o.offer.product || "Untitled offer"}</div>
            {o.offer.oneLiner && <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{o.offer.oneLiner}</p>}
          </div>
          {o.offer.valueProps.length > 0 && (
            <ul className={cn("mt-3 space-y-1.5", wide && "md:mt-4")}>
              {o.offer.valueProps.slice(0, 3).map((v) => (
                <li key={v} className="flex gap-2 text-[12.5px] leading-snug text-ink-soft">
                  <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  <span className="min-w-0">{v}</span>
                </li>
              ))}
            </ul>
          )}
          </div>
          <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 pt-3 text-[11.5px] text-muted">
            {o.offer.idealCustomers.length > 0 && <span className="truncate">For {o.offer.idealCustomers.slice(0, 2).join(", ")}</span>}
            {o.offer.learnedAt && <span>learned {ago(o.offer.learnedAt)}</span>}
            {busy && <Spinner className="h-3 w-3" />}
          </div>
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-line px-4 py-5 text-center">
          <p className="text-[12.5px] text-muted">No offer yet. Every email is built on it.</p>
          <Button size="sm" className="mt-2.5" loading={busy === "learn"} onClick={learn}>
            Learn it from the website
          </Button>
        </div>
      )}
    </article>
  );
}

/* ---------------------------------- board ---------------------------------- */

function ShareBar({ share, status }: { share: number; status: LoopStatus }) {
  const color = status === "scaling" ? SPLIT_COLOR.scaling : status === "working" ? SPLIT_COLOR.working : SPLIT_COLOR.testing;
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="tabular-nums">{share ? `${share}%` : <span className="text-muted">—</span>}</span>
      <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-ink/[0.07]">
        <span className="block h-full rounded-full" style={{ width: `${Math.min(100, share)}%`, background: color }} />
      </span>
    </div>
  );
}

interface RowProps {
  s: ResultSegment;
  showCampaign: boolean;
  campaigns: CampaignSummary[] | null;
  busy: boolean;
  onOpen: () => void;
  onStatus: (st: LoopStatus) => void;
  onCopy: (campaignId: string, name: string) => void;
  onApply: () => void;
  onDismiss: () => void;
  onEdit?: () => void;
}

function rowMenu({ s, campaigns, onOpen, onEdit, onStatus, onCopy }: RowProps) {
  return [{ label: "Numbers and search log", onClick: onOpen }, onEdit ? { label: "Edit the segment", onClick: onEdit } : null, ...statusItems(s.loopStatus, onStatus), ...copyItems(campaigns, s.campaignId, onCopy)];
}

/** Phones: one card per segment instead of a sideways-scrolling table. */
function BoardCard(props: RowProps) {
  const { s, showCampaign, busy, onOpen, onApply, onDismiss } = props;
  const st = s.stats;
  const cell = (label: string, value: ReactNode, tone?: string) => (
    <div className="min-w-0">
      <div className={cn("text-[15px] font-[650] leading-none tabular-nums", tone)}>{value}</div>
      <div className="mt-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted">{label}</div>
    </div>
  );
  return (
    <article className={cn("rounded-xl border border-line-soft bg-surf2 p-3.5", s.loopStatus === "paused" && "opacity-80")}>
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-[650] leading-snug">{s.name}</div>
            <div className="mt-0.5 truncate text-[11.5px] text-muted">
              {showCampaign ? `${s.campaignName} · ` : ""}
              {s.fitScore != null ? `Fit ${s.fitScore}` : "No fit score"}
              {s.exhausted && s.searchesTotal > 0 ? " · searched out" : ""}
            </div>
          </div>
          <Badge className={cn("shrink-0", LOOP_TONE[s.loopStatus])}>{LOOP_LABEL[s.loopStatus]}</Badge>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          {cell("Found", st.found.toLocaleString())}
          {cell("Emailed", st.contacted.toLocaleString())}
          {cell("Replies", st.replyRate == null ? "—" : `${st.replyRate}%`)}
          {cell("Hot", st.positiveRate == null ? "—" : `${st.positiveRate}%`, st.positive > 0 ? "text-good" : undefined)}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-[11.5px] text-muted">
          <span className="truncate">
            {st.inTargetPct == null ? "Not researched yet" : `${st.inTargetPct}% in target`} · {s.searchesTotal ? `${st.searchesLeft} searches left` : "no searches"}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            share <ShareBar share={st.quotaShare} status={s.loopStatus} />
          </span>
        </div>
        {!s.suggestion && <p className="mt-2 line-clamp-2 text-[11.5px] leading-snug text-muted">{s.verdict}</p>}
      </button>
      {s.suggestion && (
        <div className="mt-3 rounded-lg border border-keepl bg-keep1 px-3 py-2.5">
          <div className="text-[12.5px] font-semibold">
            Suggested: <Badge className={LOOP_TONE[s.suggestion.status]}>{LOOP_LABEL[s.suggestion.status]}</Badge>
          </div>
          <p className="mt-1 text-[12px] leading-snug text-ink-soft">{s.suggestion.reason}</p>
          <div className="mt-2 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy}>
              Dismiss
            </Button>
            <Button size="sm" onClick={onApply} loading={busy}>
              Apply
            </Button>
          </div>
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-between border-t border-line-soft pt-2.5">
        <button type="button" onClick={onOpen} className="text-[12.5px] font-semibold text-accent">
          Numbers and search log
        </button>
        <Menu label="More" variant="ghost" items={rowMenu(props)} />
      </div>
    </article>
  );
}

function BoardRow(props: RowProps) {
  const { s, showCampaign, busy, onOpen, onApply, onDismiss } = props;
  const st = s.stats;
  return (
    <>
      <tr onClick={onOpen} className={cn(s.suggestion && "[&>td]:border-b-0", s.loopStatus === "paused" && "opacity-75")} title="Open the numbers and the search log">
        <td className="max-w-[300px]">
          <div className="truncate font-[600]">{s.name}</div>
          <div className="truncate text-[11.5px] text-muted" title={s.suggestion ? undefined : s.verdict}>
            {showCampaign && <span className="text-ink-soft">{s.campaignName} · </span>}
            {/* With a suggestion the reason sits right below; don't say it twice. */}
            {s.suggestion ? `${s.searchesDone} of ${s.searchesTotal} searches run${s.why ? ` · ${s.why}` : ""}` : s.verdict}
          </div>
        </td>
        <td>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className={LOOP_TONE[s.loopStatus]}>{LOOP_LABEL[s.loopStatus]}</Badge>
            {s.exhausted && s.searchesTotal > 0 && <span className="whitespace-nowrap text-[11px] text-warn">searched out</span>}
          </div>
        </td>
        <td className="r">{s.fitScore ?? <span className="text-muted">—</span>}</td>
        <td className="r">
          {st.found.toLocaleString()}
          {st.foundToday > 0 && <span className="ml-1 text-[11px] text-good">+{st.foundToday}</span>}
        </td>
        <td className={cn("r", st.inTargetPct != null && st.inTargetPct < 60 && "text-warn")} title={st.offTarget ? `${st.offTarget} skipped by a targeting rule` : undefined}>
          {pct(st.inTargetPct)}
        </td>
        <td className="r">{st.contacted.toLocaleString()}</td>
        <td className="r">{pct(st.replyRate)}</td>
        <td className={cn("r", st.positive > 0 && "font-[650] text-good")}>{pct(st.positiveRate)}</td>
        <td className="r">
          <ShareBar share={st.quotaShare} status={s.loopStatus} />
        </td>
        <td className="r" title={`${s.searchesDone} of ${s.searchesTotal} searches run`}>
          {s.searchesTotal ? st.searchesLeft.toLocaleString() : <span className="text-muted">—</span>}
        </td>
        <td className="w-[1%] whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
          <Menu label="More" variant="ghost" items={rowMenu(props)} />
        </td>
      </tr>
      {s.suggestion && (
        <tr className="cursor-default hover:[&>td]:bg-transparent" onClick={(e) => e.stopPropagation()}>
          <td colSpan={11} className="!pt-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-keepl bg-keep1 px-3 py-2">
              <span className="whitespace-nowrap text-[12.5px] font-semibold text-ink">
                Suggested: <Badge className={LOOP_TONE[s.suggestion.status]}>{LOOP_LABEL[s.suggestion.status]}</Badge>
              </span>
              <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-soft">{s.suggestion.reason}</span>
              <span className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy}>
                  Dismiss
                </Button>
                <Button size="sm" onClick={onApply} loading={busy}>
                  Apply
                </Button>
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* --------------------------------- screen --------------------------------- */

export default function Results({
  campaignId,
  campaigns,
  version = 0,
  focus,
  onEditSegment,
  onAddSegments,
  onChanged,
}: {
  /** null = every campaign */
  campaignId: string | null;
  campaigns: CampaignSummary[] | null;
  /** bump to reload (after a steer, a segment edit…) */
  version?: number;
  /** open this segment's drawer (openSegment handoff) */
  focus?: { sid: string; n: number } | null;
  onEditSegment?: (campaignId: string, segmentId: string) => void;
  onAddSegments?: () => void;
  /** a segment moved, was copied, or an offer changed */
  onChanged?: () => void;
}) {
  const [data, setData] = useState<TargetingResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(focus?.sid || null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [allBusy, setAllBusy] = useState<"apply" | "dismiss" | null>(null);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    targetingApi
      .results(campaignId || undefined)
      .then((r) => {
        if (!alive) return;
        setData(r);
        setError(null);
      })
      .catch((e) => alive && setError(errMsg(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [campaignId, version, tick]);
  useEffect(() => {
    if (focus?.sid) setOpen(focus.sid);
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = () => {
    reload();
    onChanged?.();
  };
  const rowAct = async (sid: string, fn: () => Promise<unknown>, msg: string) => {
    setRowBusy(sid);
    try {
      await fn();
      toast(msg, "success");
      changed();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setRowBusy(null);
    }
  };

  const segs = data?.segments || [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: segs.length, scaling: 0, working: 0, testing: 0, paused: 0, exhausted: 0 };
    for (const s of segs) {
      c[s.loopStatus]++;
      if (s.exhausted && s.searchesTotal > 0) c.exhausted++;
    }
    return c;
  }, [segs]);
  const rows = useMemo(
    () =>
      segs
        .filter((s) => filter === "all" || (filter === "exhausted" ? s.exhausted && s.searchesTotal > 0 : s.loopStatus === filter))
        .sort((a, b) => (b.suggestion ? 1 : 0) - (a.suggestion ? 1 : 0) || ORDER[a.loopStatus] - ORDER[b.loopStatus] || b.stats.contacted - a.stats.contacted || b.stats.found - a.stats.found),
    [segs, filter]
  );
  const suggested = segs.filter((s) => s.suggestion);
  // One set of handlers for the desktop row and the phone card.
  const rowProps = (s: ResultSegment): RowProps => ({
    s,
    showCampaign: !campaignId,
    campaigns,
    busy: rowBusy === s.id,
    onOpen: () => setOpen(s.id),
    onEdit: onEditSegment ? () => onEditSegment(s.campaignId, s.id) : undefined,
    onStatus: (st) => rowAct(s.id, () => targetingApi.setStatus(s.id, st), `Moved "${s.name}" to ${LOOP_LABEL[st]}.`),
    onCopy: (cid, name) => rowAct(s.id, () => targetingApi.duplicate(s.id, cid), cid === s.campaignId ? `Copied "${s.name}". The copy starts its searches from the beginning.` : `Copied "${s.name}" into ${name}.`),
    onApply: () => rowAct(s.id, () => targetingApi.applySuggestions([s.id]), `Moved "${s.name}" to ${LOOP_LABEL[s.suggestion!.status]}.`),
    onDismiss: () => rowAct(s.id, () => targetingApi.applySuggestions([s.id], true), "Dismissed. It comes back only if the numbers change."),
  });

  const allSuggestions = async (dismiss: boolean) => {
    setAllBusy(dismiss ? "dismiss" : "apply");
    try {
      const r = await targetingApi.applySuggestions(
        suggested.map((s) => s.id),
        dismiss
      );
      toast(dismiss ? `Dismissed ${plural(r.dismissed, "suggestion")}.` : `Applied ${plural(r.applied, "change")}.`, "success");
      changed();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setAllBusy(null);
    }
  };

  if (!data) {
    return error ? (
      <Empty title="Couldn't load the results" body={error} action={<Button onClick={reload}>Try again</Button>} />
    ) : (
      <div className="space-y-4" aria-busy="true">
        <div className="db-sk h-[104px]" />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="db-sk h-[190px]" />
          <div className="db-sk h-[190px]" />
        </div>
        <div className="db-sk h-[260px]" />
      </div>
    );
  }

  const showCampaign = !campaignId;
  const offers = data.offers;
  const rules: SegmentRules = data.rules;

  return (
    <div className={cn("space-y-5 transition-opacity", loading && "opacity-70")}>
      <LoopStrip rules={rules} suggestions={suggested.length} onEdit={() => setRulesOpen(true)} onApplyAll={() => allSuggestions(false)} onDismissAll={() => allSuggestions(true)} busy={allBusy} />

      <section className="db-card db-in" style={delay(60)}>
        <div className="db-h flex-wrap">
          <h2>Segments{showCampaign ? " across campaigns" : ""}</h2>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter segments">
            {FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0).map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-semibold transition-colors", filter === f.id ? "bg-hov text-ink ring-1 ring-inset ring-line-strong" : "text-muted hover:bg-hov hover:text-ink")}
              >
                {f.label}
                <span className="tabular-nums font-medium text-muted">{counts[f.id]}</span>
              </button>
            ))}
          </div>
        </div>
        {!segs.length ? (
          <div className="py-10 text-center">
            <div className="text-[14px] font-[650]">No segments yet</div>
            <p className="mx-auto mt-1.5 max-w-[460px] text-[12.5px] leading-relaxed text-muted">
              {showCampaign ? "Segments live inside a campaign. Pick one at the top to add them, or create a campaign first." : "Add the slices of the market this campaign goes after. Their numbers show up here as soon as they find companies."}
            </p>
            {onAddSegments && (
              <Button size="sm" className="mt-3" onClick={onAddSegments}>
                Add segments
              </Button>
            )}
          </div>
        ) : !rows.length ? (
          <p className="py-8 text-center text-[13px] text-muted">No segments with this status.</p>
        ) : (
          <div className="-mx-1 hidden overflow-x-auto px-1 md:block">
            <table className="db-tbl min-w-[980px]">
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Status</th>
                  <th className="r" title="How well it fits the offer, 0-100">
                    Fit
                  </th>
                  <th className="r">Found</th>
                  <th className="r" title="Researched companies that passed the targeting rules">
                    In target
                  </th>
                  <th className="r">Emailed</th>
                  <th className="r" title="Leads who replied ÷ leads emailed">
                    Replies
                  </th>
                  <th className="r" title="Interested, meeting or won ÷ leads emailed">
                    Hot
                  </th>
                  <th className="r" title="Share of the campaign's new leads each day, from the learning loop's split">
                    Daily share
                  </th>
                  <th className="r" title="Searches not run yet">
                    Searches left
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <BoardRow key={s.id} {...rowProps(s)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && (
          <div className="space-y-2.5 md:hidden">
            {rows.map((s) => (
              <BoardCard key={s.id} {...rowProps(s)} />
            ))}
          </div>
        )}
        {segs.length > 0 && <p className="mt-3 text-[11.5px] leading-relaxed text-muted">Rates are over leads emailed. A segment stays Testing until {rules.testUntil} of its leads were emailed, so early numbers are only a hint.</p>}
      </section>

      {offers.length > 0 && (
        <section className="db-in" style={delay(120)}>
          <div className="db-h">
            <h2>{offers.length > 1 ? "Offers" : "Offer"}</h2>
            <span className="aside">{offers.length > 1 ? "side by side" : "what every email is built on"}</span>
          </div>
          <div className={cn("grid items-stretch gap-3", offers.length > 1 && "md:grid-cols-2", offers.length > 2 && "xl:grid-cols-3")}>
            {offers.map((o) => (
              <OfferTile key={o.campaignId} o={o} campaigns={campaigns} onChanged={changed} wide={offers.length === 1} />
            ))}
          </div>
        </section>
      )}

      <RulesDialog open={rulesOpen} rules={rules} onClose={() => setRulesOpen(false)} onSaved={() => changed()} />
      {open && <SegmentDrawer sid={open} rules={rules} campaigns={campaigns} onClose={() => setOpen(null)} onChanged={changed} onEdit={onEditSegment ? (cid, sid) => (setOpen(null), onEditSegment(cid, sid)) : undefined} />}
    </div>
  );
}
