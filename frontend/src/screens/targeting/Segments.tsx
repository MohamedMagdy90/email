// Segments inside the market: a structured builder (industry, where, size,
// who, signals, searches), the segment card, and the live sample preview.
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Field, Input, Modal, Select, Spinner, Textarea, cn, toast } from "../../lib/ui";
import { campaignsApi, type CampaignDetail, type Segment, type SegmentInput } from "../../lib/v2/campaigns";
import { sizeSummary, targetingApi, type QueryPreview, type SegmentPreview, type SizeBand, type Taxonomy, type TargetMarket } from "../../lib/v2/targeting";
import { Chips, Empty, LinesField, Switch, errMsg, plural } from "../campaigns/parts";
import { Block, ChipInput, Inherit, Pick, RankedList } from "./controls";

/* -------------------------------- draft -------------------------------- */

interface Draft {
  name: string;
  why: string;
  industryIds: string[];
  custom: string[];
  narrowWhere: boolean;
  countries: string[];
  cities: Record<string, string[]>;
  ownSize: boolean;
  sizeBands: SizeBand[];
  minBranches: number | null;
  ownTitles: boolean;
  titles: string[];
  must: string[];
  mustNot: string[];
  manual: boolean;
  queries: string[];
  fitScore: number | null;
}

function toDraft(seg: Segment | null, tax: Taxonomy, market: TargetMarket): Draft {
  const labels = new Set(tax.industries.map((i) => i.label.toLowerCase()));
  return {
    name: seg?.name || "",
    why: seg?.why || "",
    industryIds: seg?.industryIds || [],
    custom: (seg?.industries || []).filter((l) => !labels.has(l.toLowerCase())),
    narrowWhere: !!seg && (seg.countries.length > 0 || Object.keys(seg.cities || {}).length > 0),
    countries: seg?.countries || [],
    cities: seg?.cities || {},
    ownSize: !!seg && (seg.sizeBands != null || seg.minBranches != null),
    sizeBands: (seg?.sizeBands as SizeBand[] | null) || market.sizeBands,
    minBranches: seg?.minBranches ?? null,
    ownTitles: !!seg?.titlesOverride,
    titles: seg?.titlesOverride ? seg.titles : market.titles,
    must: seg?.signals?.must || [],
    mustNot: seg?.signals?.mustNot || [],
    manual: !!seg && !seg.queriesAuto,
    queries: seg?.queries || [],
    fitScore: seg?.fitScore ?? null,
  };
}

function toInput(d: Draft): SegmentInput {
  return {
    name: d.name.trim(),
    why: d.why.trim(),
    industryIds: d.industryIds,
    industries: d.custom,
    countries: d.narrowWhere ? d.countries : [],
    cities: d.narrowWhere ? d.cities : {},
    sizeBands: d.ownSize ? d.sizeBands : null,
    minBranches: d.ownSize ? d.minBranches : null,
    titlesOverride: d.ownTitles,
    titles: d.ownTitles ? d.titles : [],
    signals: { must: d.must, mustNot: d.mustNot },
    queriesAuto: !d.manual,
    ...(d.manual ? { queries: d.queries } : {}),
    fitScore: d.fitScore,
  };
}

function whereSummary(market: TargetMarket, countries: string[], cities: Record<string, string[]>): string {
  const list = countries.length ? countries : market.countries;
  return list.map((c) => (cities[c]?.length ? `${c} (${cities[c].join(", ")})` : market.cities[c]?.length ? `${c} (${market.cities[c].join(", ")})` : c)).join(" · ");
}

/* ------------------------------- builder ------------------------------- */

export function SegmentBuilder({
  c,
  tax,
  market,
  seg,
  onSaved,
  onCancel,
}: {
  c: CampaignDetail;
  tax: Taxonomy;
  market: TargetMarket;
  seg: Segment | null;
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(() => toDraft(seg, tax, market));
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [qp, setQp] = useState<QueryPreview | null>(null);
  const [qpLoading, setQpLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const kindIndustries = tax.industries.filter((i) => i.kind === c.kind);
  const shown = filter.trim() ? kindIndustries.filter((i) => i.label.toLowerCase().includes(filter.trim().toLowerCase()) || d.industryIds.includes(i.id)) : kindIndustries;

  // Live preview of the searches this segment will run.
  const key = JSON.stringify([d.industryIds, d.custom, d.narrowWhere, d.countries, d.cities]);
  useEffect(() => {
    if (d.manual) return;
    let alive = true;
    setQpLoading(true);
    const t = setTimeout(() => {
      targetingApi
        .queries(c.id, toInput(d))
        .then((r) => alive && setQp(r))
        .catch(() => alive && setQp(null))
        .finally(() => alive && setQpLoading(false));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, d.manual, c.id]);

  const whereCountries = d.countries.length ? d.countries : market.countries;

  async function save() {
    if (!d.name.trim()) return toast("Give the segment a name", "error");
    if (!d.manual && !d.industryIds.length && !d.custom.length) return toast("Pick at least one industry, or write the searches by hand", "error");
    if (d.manual && !d.queries.length) return toast("Add at least one search", "error");
    setBusy(true);
    try {
      if (seg) await campaignsApi.updateSegment(c.id, seg.id, toInput(d));
      else await campaignsApi.addSegment(c.id, toInput(d));
      toast(seg ? "Segment saved." : "Segment added.", "success");
      await onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden border-keepl">
      <div className="border-b border-line-soft bg-surf2 px-5 py-3.5 sm:px-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">{seg ? "Edit segment" : "New segment"}</div>
        <div className="mt-0.5 text-[12.5px] text-muted">A slice of the market: an industry, maybe narrower places or size, and the people to reach.</div>
      </div>
      <div className="grid gap-x-8 px-5 py-5 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0 divide-y divide-line-soft">
          <Block label="Name">
            <Input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Food distributors in Riyadh" autoFocus={!seg} />
          </Block>
          <Block label="Industry" hint={c.kind === "partner" ? "The kinds of partner to look for." : "Pick one to three. Searches are built from these."}>
            {kindIndustries.length > 12 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter industries" className="mb-2.5 h-9 py-0 text-[12.5px]" />}
            <Pick options={shown.map((i) => ({ id: i.id, label: i.label, title: i.example ? `Searches like "${i.example} Riyadh"` : undefined }))} value={d.industryIds} onChange={(v) => set("industryIds", v)} />
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] text-muted">Not in the list? Type your own</div>
              <ChipInput value={d.custom} onChange={(v) => set("custom", v)} placeholder="e.g. cold storage" tone="plain" max={6} />
            </div>
          </Block>
          <Block label="Where">
            <Inherit inherit={!d.narrowWhere} onChange={(inh) => set("narrowWhere", !inh)} inheritLabel="The whole market" ownLabel="Narrow it" summary={whereSummary(market, [], {})} />
            {d.narrowWhere && (
              <div className="mt-3 space-y-3">
                <Pick options={market.countries.map((x) => ({ id: x, label: x }))} value={d.countries} onChange={(v) => set("countries", v)} />
                {whereCountries.map((country) => {
                  const allowed = market.cities[country]?.length ? market.cities[country] : tax.countries.find((x) => x.name === country)?.cities.map((x) => x.name) || [];
                  if (!allowed.length) return null;
                  return (
                    <div key={country} className="rounded-lg border border-line-soft bg-surf2 p-3">
                      <div className="mb-2 flex justify-between text-[12.5px]">
                        <span className="font-semibold">{country}</span>
                        <span className="text-muted">{d.cities[country]?.length ? `${d.cities[country].length} picked` : market.cities[country]?.length ? "Market's cities" : "Whole country"}</span>
                      </div>
                      <Pick
                        options={allowed.map((x) => ({ id: x, label: x }))}
                        value={d.cities[country] || []}
                        onChange={(v) => {
                          const cities = { ...d.cities };
                          if (v.length) cities[country] = v;
                          else delete cities[country];
                          set("cities", cities);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Block>
          <Block label="Size">
            <Inherit inherit={!d.ownSize} onChange={(inh) => set("ownSize", !inh)} inheritLabel="The market's size" ownLabel="Different size" summary={sizeSummary(market.sizeBands, market.minBranches)} />
            {d.ownSize && (
              <div className="mt-3 space-y-2.5">
                <Pick options={tax.sizeBands.map((b) => ({ id: b, label: `${b} staff` }))} value={d.sizeBands} onChange={(v) => set("sizeBands", v as SizeBand[])} />
                <label className="flex max-w-[220px] items-center rounded-lg border border-line bg-sunk focus-within:border-accent">
                  <span className="shrink-0 pl-3 text-[12px] text-muted">At least</span>
                  <input
                    inputMode="numeric"
                    value={d.minBranches ?? ""}
                    onChange={(e) => set("minBranches", e.target.value.replace(/\D/g, "") ? Number(e.target.value.replace(/\D/g, "")) : null)}
                    placeholder="—"
                    className="w-full min-w-0 bg-transparent px-2 py-2 text-[13px] tabular-nums text-ink outline-none"
                  />
                  <span className="shrink-0 pr-3 text-[12px] text-muted">branches</span>
                </label>
              </div>
            )}
          </Block>
        </div>

        <div className="min-w-0 divide-y divide-line-soft border-t border-line-soft pt-4 lg:border-t-0 lg:pt-0">
          <Block label="Who to contact">
            <Inherit inherit={!d.ownTitles} onChange={(inh) => setD((x) => ({ ...x, ownTitles: !inh, titles: !inh && !x.titles.length ? market.titles : x.titles }))} inheritLabel="The market's list" ownLabel="Own order" summary={market.titles.slice(0, 3).join(", ") + (market.titles.length > 3 ? "…" : "")} />
            {d.ownTitles && (
              <div className="mt-3">
                <RankedList value={d.titles} onChange={(v) => set("titles", v)} />
              </div>
            )}
          </Block>
          <Block label="Signals on the website" hint="Optional. Added to the market's keyword rules for this segment only.">
            <div className="space-y-2">
              <ChipInput value={d.must} onChange={(v) => set("must", v)} placeholder="Should mention, e.g. cold chain" />
              <ChipInput value={d.mustNot} onChange={(v) => set("mustNot", v)} placeholder="Must not mention" tone="bad" />
            </div>
          </Block>
          <Block
            label="Searches"
            right={
              <button type="button" onClick={() => setD((x) => ({ ...x, manual: !x.manual, queries: !x.manual && !x.queries.length && qp ? qp.queries : x.queries }))} className="text-[12px] font-semibold text-accent hover:underline">
                {d.manual ? "Build them automatically" : "Write them by hand"}
              </button>
            }
          >
            {d.manual ? (
              <LinesField label="One search per line" hint='Each should return company websites, e.g. "food distributor Riyadh".' value={d.queries} onChange={(v) => set("queries", v)} rows={6} />
            ) : !d.industryIds.length && !d.custom.length ? (
              <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-muted">Pick an industry and the searches appear here.</p>
            ) : (
              <div className="rounded-lg border border-line-soft bg-sunk p-3">
                <div className="mb-2 flex items-center justify-between text-[12px]">
                  <span className="font-semibold">{qp ? `${plural(qp.queries.length, "search", "searches")} · ${plural(qp.searches, "run")}` : "Building…"}</span>
                  {qpLoading && <Spinner className="h-3 w-3 text-muted" />}
                </div>
                <ul className="space-y-1 font-mono text-[11.5px] leading-relaxed text-ink-soft">
                  {(showAll ? qp?.queries || [] : (qp?.queries || []).slice(0, 7)).map((x) => (
                    <li key={x} dir="auto" className="truncate">
                      {x}
                    </li>
                  ))}
                </ul>
                {qp && qp.queries.length > 7 && (
                  <button type="button" onClick={() => setShowAll(!showAll)} className="mt-1.5 text-[12px] font-semibold text-accent hover:underline">
                    {showAll ? "Show fewer" : `Show all ${qp.queries.length}`}
                  </button>
                )}
                <p className="mt-2 text-[11.5px] leading-relaxed text-muted">English and Arabic, for every city. Searches already run are never repeated when this list changes.</p>
              </div>
            )}
          </Block>
          <Block label="Fit and why">
            <div className="grid gap-2.5 sm:grid-cols-[110px_minmax(0,1fr)]">
              <Input inputMode="numeric" placeholder="Fit 0-100" value={d.fitScore ?? ""} onChange={(e) => set("fitScore", e.target.value.replace(/\D/g, "") ? Math.min(100, Number(e.target.value.replace(/\D/g, ""))) : null)} className="tabular-nums" />
              <Textarea rows={2} value={d.why} onChange={(e) => set("why", e.target.value)} placeholder="Why these companies need what you sell. The writer uses it as the angle." />
            </div>
          </Block>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line-soft bg-surf2 px-5 py-3 sm:px-6">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" loading={busy} onClick={save}>
          {seg ? "Save segment" : "Add segment"}
        </Button>
      </div>
    </Card>
  );
}

/* -------------------------------- preview ------------------------------- */

function SamplePreview({ c, seg, onAdded }: { c: CampaignDetail; seg: Segment; onAdded: () => Promise<void> | void }) {
  const [data, setData] = useState<SegmentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const run = () => {
    setData(null);
    setError(null);
    targetingApi
      .preview(c.id, seg.id)
      .then(setData)
      .catch((e) => setError(errMsg(e)));
  };
  useEffect(run, [c.id, seg.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="rounded-lg border border-dgl bg-dgb px-3 py-2.5 text-[12.5px] text-bad">{error}</p>;
  if (!data)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line-soft bg-sunk px-3 py-4 text-[12.5px] text-muted">
        <Spinner className="h-3.5 w-3.5" /> Running two of its searches… (nothing is saved)
      </div>
    );
  const passing = data.companies.filter((x) => x.ok && x.domain);
  return (
    <div className="rounded-lg border border-line-soft bg-sunk">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-3 py-2.5">
        <div className="text-[12.5px]">
          <b className="font-semibold tabular-nums">{data.passed}</b> of {data.total} in target · {data.searches.map((s) => `"${s.query}" ${s.results}`).join(" · ")}
        </div>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={run}>
            Again
          </Button>
          {passing.length > 0 && (
            <Button
              size="sm"
              loading={adding}
              onClick={async () => {
                setAdding(true);
                try {
                  const r = await campaignsApi.addCompanies(c.id, { segmentId: seg.id, domains: passing.map((x) => x.domain!) });
                  toast(`Added ${plural(r.added, "company", "companies")}. Research and the full checks run next.`, "success");
                  await onAdded();
                } catch (e) {
                  toast(errMsg(e), "error");
                } finally {
                  setAdding(false);
                }
              }}
            >
              Add the {passing.length} in target
            </Button>
          )}
        </div>
      </div>
      {data.companies.length ? (
        <ul className="divide-y divide-line-soft">
          {data.companies.map((x) => (
            <li key={x.website} className="flex items-start gap-3 px-3 py-2">
              <span className={cn("mt-[5px] h-2 w-2 shrink-0 rounded-full", x.ok ? "bg-good" : x.already ? "bg-inf" : x.rule ? "bg-warn" : "bg-ink/25")} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                  <span className="font-semibold">{x.name || x.domain}</span>
                  <span className="text-muted">{[x.domain, x.city, x.country].filter(Boolean).join(" · ")}</span>
                </div>
                {x.reason && <div className="text-[11.5px] text-muted">{x.reason}</div>}
              </div>
              <Badge className={x.ok ? "bg-okb text-good" : x.already ? "bg-inb text-inf" : x.rule ? "bg-wnb text-warn" : "bg-ink/[0.06] text-muted"}>{x.ok ? "In target" : x.already ? "Already in" : x.rule ? "Outside" : "Filtered"}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-4 text-[12.5px] text-muted">No companies came back.</p>
      )}
      <div className="space-y-0.5 border-t border-line-soft px-3 py-2 text-[11.5px] leading-relaxed text-muted">
        {data.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
        <p>{data.checkedLater}</p>
      </div>
    </div>
  );
}

/* --------------------------------- card --------------------------------- */

export function SegmentTile({
  c,
  tax,
  market,
  seg,
  onEdit,
  reload,
}: {
  c: CampaignDetail;
  tax: Taxonomy;
  market: TargetMarket;
  seg: Segment;
  onEdit: () => void;
  reload: () => Promise<void>;
}) {
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const labels = useMemo(() => {
    const byId = new Map(tax.industries.map((i) => [i.id, i.label]));
    const fromIds = seg.industryIds.map((id) => byId.get(id) || id);
    return [...fromIds, ...seg.industries.filter((l) => !fromIds.includes(l))];
  }, [seg, tax]);
  const pct = seg.searchesTotal ? Math.round((seg.searchesDone / seg.searchesTotal) * 100) : 0;
  const titles = seg.titlesOverride ? seg.titles : market.titles;
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (msg) toast(msg, "success");
      await reload();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className={cn("p-4 sm:p-5", !seg.enabled && "opacity-70")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[14.5px] font-[650] tracking-[-0.01em]">{seg.name}</h4>
            {seg.fitScore != null && <Badge className="bg-tlb text-accent">Fit {seg.fitScore}</Badge>}
            {!seg.enabled && <Badge className="bg-ink/[0.06] text-muted">Off</Badge>}
            {seg.exhausted && seg.enabled && seg.searchesTotal > 0 && <Badge className="bg-wnb text-warn">Searches used up</Badge>}
          </div>
          {seg.why && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{seg.why}</p>}
        </div>
        <Switch checked={seg.enabled} disabled={busy} onChange={(v) => act(() => campaignsApi.updateSegment(c.id, seg.id, { enabled: v }))} label={seg.enabled ? "Turn segment off" : "Turn segment on"} />
      </div>

      <dl className="mt-3.5 grid gap-x-5 gap-y-2.5 text-[12.5px] sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Industry</dt>
          <dd>{labels.length ? <Chips items={labels} tone="bg-keep1 text-accent" /> : <span className="text-warn">None picked: no searches can be built</span>}</dd>
        </div>
        <div>
          <dt className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Where</dt>
          <dd className="text-ink-soft">{whereSummary(market, seg.countries, seg.cities)}</dd>
        </div>
        <div>
          <dt className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Size</dt>
          <dd className="text-ink-soft">{seg.sizeBands || seg.minBranches ? sizeSummary((seg.sizeBands as SizeBand[]) || market.sizeBands, seg.minBranches) : `${sizeSummary(market.sizeBands, market.minBranches)} (market)`}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Who {seg.titlesOverride ? "" : "(market)"}</dt>
          <dd className="text-ink-soft">{titles.slice(0, 4).join(" → ")}{titles.length > 4 ? " …" : ""}</dd>
        </div>
      </dl>

      <div className="mt-3.5">
        <div className="mb-1 flex items-center justify-between text-[11.5px] text-muted">
          <span>
            Searches {seg.searchesDone} of {seg.searchesTotal} run · {seg.queriesAuto ? "built automatically" : "written by hand"}
          </span>
          <span className="tabular-nums">{seg.found} found</span>
        </div>
        <div className="h-[5px] overflow-hidden rounded-full bg-ink/[0.07]">
          <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {preview && (
        <div className="mt-3.5">
          <SamplePreview c={c} seg={seg} onAdded={reload} />
        </div>
      )}

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
        <div className="flex gap-4 text-[12px] tabular-nums text-ink-soft">
          <span>
            <b className="text-ink">{seg.sent}</b> sent
          </span>
          <span>
            <b className="text-ink">{seg.replies}</b> replies
          </span>
          <span>
            <b className="text-good">{seg.positive}</b> positive
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setPreview(!preview)} disabled={!seg.searchesTotal}>
            {preview ? "Hide sample" : "Find sample companies"}
          </Button>
          {!seg.queriesAuto && seg.industryIds.length > 0 && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => targetingApi.regenerate(c.id, seg.id), "Searches rebuilt from the industry and places.")}>
              Rebuild searches
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-bad"
            disabled={busy}
            onClick={() => {
              if (confirm(`Delete the segment "${seg.name}"? Leads it already found stay in the campaign.`)) act(() => campaignsApi.deleteSegment(c.id, seg.id), "Segment deleted.");
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------- section ------------------------------- */

export function SegmentsSection({ c, tax, market, reload }: { c: CampaignDetail; tax: Taxonomy; market: TargetMarket; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState(false);
  const segs = c.segmentList;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[640px] text-[13px] leading-relaxed text-muted">
          Each segment is a slice of the market. The agent walks its searches, adds the companies it finds, and checks each one against the market after research.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setPaste(true)}>
            Add companies
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing("new")} disabled={editing === "new"}>
            New segment
          </Button>
          <Button
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await campaignsApi.proposeSegments(c.id, segs.length ? 3 : 4);
                toast(r.warning || `Added ${plural(r.segments.length, "suggested segment")}.`, r.warning ? "info" : "success");
                await reload();
              } catch (e) {
                toast(errMsg(e), "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Suggest segments
          </Button>
        </div>
      </div>
      {editing === "new" && (
        <SegmentBuilder
          c={c}
          tax={tax}
          market={market}
          seg={null}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
      {!segs.length && editing !== "new" ? (
        <Empty title="No segments yet" body="Ask for suggestions based on the offer and the market, or build one: pick an industry and the searches are written for you." />
      ) : (
        <div className="grid items-start gap-3 xl:grid-cols-2">
          {segs.map((s) =>
            editing === s.id ? (
              <div key={s.id} className="xl:col-span-2">
                <SegmentBuilder
                  c={c}
                  tax={tax}
                  market={market}
                  seg={s}
                  onCancel={() => setEditing(null)}
                  onSaved={async () => {
                    setEditing(null);
                    await reload();
                  }}
                />
              </div>
            ) : (
              <SegmentTile key={s.id} c={c} tax={tax} market={market} seg={s} onEdit={() => setEditing(s.id)} reload={reload} />
            )
          )}
        </div>
      )}
      {paste && <AddCompanies c={c} onClose={() => setPaste(false)} onDone={reload} />}
    </div>
  );
}

/* ---------------------------- add companies ---------------------------- */

export function AddCompanies({ c, onClose, onDone }: { c: CampaignDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [seg, setSeg] = useState(c.segmentList.find((s) => s.enabled)?.id || "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; skipped: { domain: string; reason: string }[] } | null>(null);
  return (
    <Modal open onClose={onClose} title="Add companies by hand">
      {result ? (
        <div className="space-y-3">
          <p className="text-[13.5px]">
            Added <b>{plural(result.added, "company", "companies")}</b>. They go through the same research, target check and review as the rest.
          </p>
          {result.skipped.length > 0 && (
            <ul className="max-h-[240px] space-y-1 overflow-y-auto rounded-lg border border-line-soft bg-sunk px-3 py-2 text-[12.5px]">
              {result.skipped.map((s) => (
                <li key={s.domain}>
                  <b>{s.domain}</b> <span className="text-muted">— {s.reason}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Websites or domains" hint="One per line. Directories, social pages and do-not-contact domains are dropped.">
            <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={"alpha-trading.com\nhttps://www.beta-foods.sa"} />
          </Field>
          <Field label="Segment">
            <Select value={seg} onChange={(e) => setSeg(e.target.value)}>
              <option value="">No segment (market rules only)</option>
              {c.segmentList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await campaignsApi.addCompanies(c.id, { segmentId: seg || undefined, domains: text.split(/\n+/).map((s) => s.trim()).filter(Boolean) });
                  setResult(r);
                  await onDone();
                } catch (e) {
                  toast(errMsg(e), "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
