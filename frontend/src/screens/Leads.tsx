// Leads tab (Phase 6, plan §8.3) — every person the agent found, across
// campaigns: People, Companies and the Pipeline board, filters with counts,
// saved views, bulk actions, CSV in and out.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Input, PageHeader, Select, Spinner, cn, toast } from "../lib/ui";
import { ago } from "../lib/v2/core";
import { STAGE_LABEL, type ProspectStage } from "../lib/v2/campaigns";
import { leadsApi, type BuiltInView, type BulkAction, type CompanyRow, type FacetValue, type Facets, type FilterKey, type LeadFilters, type LeadList, type LeadRow, type LeadView, type SavedView } from "../lib/v2/leads";
import { EmailStatusChip, Empty, StageChip, errMsg, goTab, plural } from "./campaigns/parts";
import { Segmented } from "./targeting/controls";
import { CampaignFilter, useCampaignFilter, useCampaignList } from "./shared/CampaignFilter";
import { Menu } from "./shared/Menu";
import LeadDrawer from "./leads/LeadDrawer";
import CompanyDrawer from "./leads/CompanyDrawer";
import ImportDialog from "./leads/ImportDialog";
import Pipeline from "./leads/Pipeline";

const PAGE = 50;
const VIEW_KEY = "dnaLeadsView";
const COLS_KEY = "dnaLeadsCols";

type Col = "location" | "campaign" | "email" | "fit" | "next" | "source" | "mailbox";
const COLS: { id: Col; label: string }[] = [
  { id: "location", label: "Location" },
  { id: "campaign", label: "Campaign" },
  { id: "email", label: "Email" },
  { id: "fit", label: "Fit" },
  { id: "next", label: "Next step" },
  { id: "source", label: "Source" },
  { id: "mailbox", label: "Mailbox" },
];
const DEFAULT_COLS: Col[] = ["location", "campaign", "email", "fit", "next"];

const BUILT_IN_ORDER = ["all", "review", "ready", "progress", "sequence", "replied", "hot", "bounced", "skipped"];
const SOURCE_LABEL: Record<string, string> = { gemini: "Gemini", search: "Web search", manual: "By hand", import: "Import" };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

export default function Leads() {
  const [campaign, setCampaign] = useCampaignFilter();
  const campaigns = useCampaignList();
  const [view, setViewState] = useState<LeadView>(() => load<LeadView>(VIEW_KEY, "people"));
  const [filters, setFilters] = useState<LeadFilters>({ stage: "all" });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; dir?: "asc" | "desc" }>({ key: "updated" });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<LeadList | null>(null);
  const [facets, setFacets] = useState<Facets>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [companyDrawer, setCompanyDrawer] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [cols, setColsState] = useState<Col[]>(() => load<Col[]>(COLS_KEY, DEFAULT_COLS));
  const [saved, setSaved] = useState<SavedView[]>([]);
  const [builtIn, setBuiltIn] = useState<BuiltInView[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const setView = (v: LeadView) => {
    setViewState(v);
    store(VIEW_KEY, v);
    setOffset(0);
    setSelected(new Set());
    setAllMatching(false);
  };
  const setCols = (c: Col[]) => {
    setColsState(c);
    store(COLS_KEY, c);
  };

  // Debounced search into the filters.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === (search.trim() || undefined) ? f : { ...f, q: search.trim() || undefined })), 300);
    return () => clearTimeout(t);
  }, [search]);
  // A new filter starts at page one with nothing selected.
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
    setAllMatching(false);
  }, [campaign, filters, sort]);

  const effective: LeadFilters = useMemo(() => ({ ...filters, campaign: campaign || undefined, stage: filters.stage === "all" ? undefined : filters.stage }), [filters, campaign]);

  useEffect(() => {
    if (view === "pipeline") return;
    let alive = true;
    setLoading(true);
    leadsApi
      .list({ ...effective, view: view === "companies" ? "companies" : "people", sort: sort.key, dir: sort.dir, limit: PAGE, offset, facets: "1" })
      .then((r) => {
        if (!alive) return;
        setData(r);
        if (r.facets) setFacets(r.facets);
        setError(null);
      })
      .catch((e) => alive && setError(errMsg(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [effective, view, sort, offset, version]);

  useEffect(() => {
    leadsApi
      .views()
      .then((r) => {
        setSaved(r.views);
        setBuiltIn(r.builtIn);
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const setFilter = (k: FilterKey, v: string | number | undefined) => setFilters((f) => ({ ...f, [k]: v === "" || v === undefined ? undefined : v }));
  const activeKeys = (Object.keys(filters) as FilterKey[]).filter((k) => k !== "stage" && k !== "q" && filters[k] !== undefined && filters[k] !== "");
  const clearFilters = () => {
    setFilters({ stage: filters.stage });
    setSearch("");
  };

  /* ------------------------------ counts ------------------------------ */
  const stageCount = (stages: string[]) => (facets.stage || []).filter((x) => !stages.length || stages.includes(x.value)).reduce((n, x) => n + x.count, 0);
  const builtInViews = BUILT_IN_ORDER.map((id) => builtIn.find((b) => b.id === id)).filter(Boolean) as BuiltInView[];

  /* ------------------------------ saved views ------------------------------ */
  const applySaved = (v: SavedView) => {
    const { campaign: c, ...rest } = v.filters as Record<string, string>;
    setCampaign(c || "");
    const f: LeadFilters = { stage: rest.stage || "all" };
    for (const [k, val] of Object.entries(rest)) if (k !== "stage") (f as any)[k] = ["fitMin", "fitMax"].includes(k) ? Number(val) : val;
    setFilters(f);
    setSearch(rest.q || "");
    setView(v.view);
  };
  const saveCurrent = async (name: string) => {
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...filters, campaign: campaign || undefined })) if (v !== undefined && v !== "" && !(k === "stage" && v === "all")) f[k] = String(v);
    try {
      const r = await leadsApi.saveViews([...saved, { id: "", name, view, filters: f }]);
      setSaved(r.views);
      setNaming(null);
      toast(`Saved the view "${name}".`, "success");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const removeSaved = async (id: string) => {
    try {
      setSaved((await leadsApi.saveViews(saved.filter((v) => v.id !== id))).views);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  /* -------------------------------- bulk -------------------------------- */
  const rows = data?.view === "people" ? data.rows : [];
  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selCount = allMatching ? data?.total || 0 : selected.size;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      setAllMatching(false);
      return n;
    });
  const runBulk = async (action: BulkAction, extra: { reason?: string; campaignId?: string } = {}) => {
    if (!selCount) return;
    if (selCount > 50 && !confirm(`${action === "dnc_domain" || action === "dnc_email" ? "Add" : "Apply this to"} ${selCount.toLocaleString()} leads?`)) return;
    setBusy(action);
    try {
      const r = await leadsApi.bulk({ action, ...(allMatching ? { filter: effective } : { ids: [...selected] }), ...extra });
      const verb: Record<BulkAction, string> = { approve: "Approved", skip: "Skipped", restore: "Put back", reresearch: "Sent back to research", reverify: "Re-checking", move: "Moved", dnc_domain: "Do not contact:", dnc_email: "Do not contact:" };
      toast(action.startsWith("dnc") ? r.notes[0] || "Done." : `${verb[action]} ${plural(r.done, "lead")}.${r.notes.length ? ` ${r.notes.join(" ")}` : ""}`, r.done ? "success" : "info");
      setSelected(new Set());
      setAllMatching(false);
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const exportNow = async () => {
    setBusy("export");
    try {
      await leadsApi.exportCsv(selected.size && !allMatching ? { ids: [...selected].join(",") } : { ...effective, sort: sort.key, dir: sort.dir });
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------- header ------------------------------- */
  const header = (
    <PageHeader
      title="Leads"
      subtitle="Every person the agent found, in one list across campaigns. Filter it, act on many at once, import your own or export what you see."
      actions={
        <>
          <CampaignFilter value={campaign} onChange={setCampaign} list={campaigns} />
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} disabled={!campaigns?.length}>
            Import CSV
          </Button>
          <Button variant="outline" size="sm" loading={busy === "export"} onClick={exportNow} disabled={view === "pipeline"}>
            Export{selected.size && !allMatching ? ` ${selected.size}` : ""}
          </Button>
        </>
      }
    />
  );

  if (campaigns && !campaigns.length) {
    return (
      <div>
        {header}
        <Empty title="No leads yet" body="Leads come from campaigns: the agent finds companies, researches them and finds the right person. Start a campaign, then everyone it finds shows up here." action={<Button onClick={() => goTab("campaigns")}>Go to Campaigns</Button>} />
      </div>
    );
  }

  const facetSelect = (key: keyof Facets & FilterKey, label: string, all: string) => {
    const opts = facets[key] || [];
    const val = (filters[key] as string) || "";
    if (!opts.length && !val) return null;
    return (
      <Select value={val} onChange={(e) => setFilter(key, e.target.value)} aria-label={label} className={cn("h-8 w-auto max-w-[200px] py-0 pr-8 text-[12.5px]", val && "!border-accent text-accent")}>
        <option value="">{all}</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label} ({o.count.toLocaleString()})
          </option>
        ))}
        {val && !opts.some((o) => o.value === val) && <option value={val}>{val}</option>}
      </Select>
    );
  };
  const labelFor = (k: FilterKey): string => {
    const v = String(filters[k]);
    const fromFacet = (facets[k as keyof Facets] || []).find((o) => o.value === v)?.label;
    const names: Partial<Record<FilterKey, string>> = { segment: "Segment", country: "Country", industry: "Industry", emailStatus: "Email", source: "Source", skipRule: "Skipped", interest: "Interest", mailbox: "Mailbox", fitMin: "Fit ≥", fitMax: "Fit ≤", replied: "Replied", foundFrom: "Found from", foundTo: "Found to", sentFrom: "Sent from", sentTo: "Sent to" };
    return `${names[k] || k}: ${fromFacet || (k === "replied" ? (v === "yes" ? "yes" : "no") : v)}`;
  };

  const skipFacet = facets.skipRule || [];
  const showSkipped = view !== "pipeline" && filters.stage === "skipped" && skipFacet.length > 0;

  return (
    <div className={cn(selCount > 0 && "pb-24")}>
      {header}

      {/* view switch + search */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { id: "people", label: "People" },
            { id: "companies", label: "Companies" },
            { id: "pipeline", label: "Pipeline" },
          ]}
        />
        <div className="relative sm:w-[300px]">
          <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company, person, email, title" className="h-9 py-0 pl-9 text-[13px]" />
        </div>
      </div>

      {view !== "pipeline" && (
        <>
          {/* built-in + saved views */}
          <div className="mb-2.5 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Views">
            {builtInViews.map((b) => {
              const n = stageCount(b.stages);
              const on = (filters.stage || "all") === b.id;
              return (
                <button
                  key={b.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setFilter("stage", b.id)}
                  className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold transition-colors", on ? "bg-hov text-ink ring-1 ring-inset ring-line-strong" : "text-muted hover:bg-hov hover:text-ink")}
                >
                  {b.label}
                  <span className={cn("tabular-nums text-[11.5px] font-medium", b.id === "review" && n > 0 ? "text-warn" : "text-muted")}>{n.toLocaleString()}</span>
                </button>
              );
            })}
            {saved.length > 0 && <span className="tabsep" />}
            {saved.map((v) => (
              <span key={v.id} className="group inline-flex h-8 shrink-0 items-center rounded-lg ring-1 ring-inset ring-line-soft">
                <button type="button" onClick={() => applySaved(v)} className="h-full rounded-l-lg pl-3 pr-1.5 text-[12.5px] font-semibold text-ink-soft hover:bg-hov hover:text-ink">
                  {v.name}
                </button>
                <button type="button" aria-label={`Delete the view ${v.name}`} title="Delete this view" onClick={() => removeSaved(v.id)} className="grid h-full w-6 place-items-center rounded-r-lg text-muted opacity-60 hover:bg-hov hover:text-bad group-hover:opacity-100">
                  ×
                </button>
              </span>
            ))}
            {naming === null ? (
              <button type="button" onClick={() => setNaming("")} className="h-8 shrink-0 rounded-lg px-2.5 text-[12.5px] font-semibold text-accent hover:bg-hov">
                + Save view
              </button>
            ) : (
              <form
                className="flex shrink-0 items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (naming.trim()) saveCurrent(naming.trim());
                }}
              >
                <Input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Name this view" className="h-8 w-[160px] py-0 text-[12.5px]" />
                <Button size="sm" type="submit" disabled={!naming.trim()}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setNaming(null)}>
                  Cancel
                </Button>
              </form>
            )}
          </div>

          {/* filters */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {campaign && facetSelect("segment", "Segment", "All segments")}
            {facetSelect("country", "Country", "Any country")}
            {facetSelect("industry", "Industry", "Any industry")}
            {facetSelect("emailStatus", "Email status", "Any email status")}
            {facetSelect("source", "Source", "Any source")}
            <Button variant={more ? "outline" : "ghost"} size="sm" onClick={() => setMore(!more)}>
              {more ? "Fewer filters" : "More filters"}
            </Button>
            {activeKeys.length > 0 && (
              <button type="button" onClick={clearFilters} className="text-[12.5px] font-semibold text-muted hover:text-ink">
                Clear filters
              </button>
            )}
            {view === "people" && (
              <span className="ml-auto">
                <ColumnPicker cols={cols} onChange={setCols} />
              </span>
            )}
          </div>
          {activeKeys.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {activeKeys.map((k) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-full bg-keep1 py-[3px] pl-2.5 pr-1 text-[12px] text-accent ring-1 ring-inset ring-keepl">
                  {labelFor(k)}
                  <button type="button" aria-label="Remove filter" onClick={() => setFilter(k, undefined)} className="grid h-5 w-5 place-items-center rounded-full hover:bg-ink/10">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {more && <MoreFilters filters={filters} facets={facets} setFilter={setFilter} />}

          {showSkipped && <SkippedBreakdown values={skipFacet} active={filters.skipRule} onPick={(v) => setFilter("skipRule", filters.skipRule === v ? undefined : v)} />}
        </>
      )}

      {/* body */}
      {view === "pipeline" ? (
        <Pipeline campaign={campaign} q={filters.q || ""} version={version} onOpen={setDrawer} />
      ) : error && !data ? (
        <Empty title="Couldn't load the leads" body={error} action={<Button onClick={refresh}>Try again</Button>} />
      ) : !data ? (
        <div className="flex items-center gap-2 py-16 text-muted">
          <Spinner /> Loading leads…
        </div>
      ) : !data.rows.length ? (
        stageCount([]) === 0 && !activeKeys.length && !filters.q ? (
          <Empty
            title="No leads yet"
            body={campaign ? "This campaign hasn't found anyone yet. Start it, or run a pass from the campaign, and the people it finds show up here." : "The agent hasn't found anyone yet. Start a campaign, or import a CSV of your own contacts."}
            action={
              <>
                <Button onClick={() => goTab("campaigns")}>Go to Campaigns</Button>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  Import CSV
                </Button>
              </>
            }
          />
        ) : (
          <Empty title="No leads match" body="Try another view, or clear the filters and the search." action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>} />
        )
      ) : data.view === "people" ? (
        <Card className={cn("overflow-hidden", loading && "opacity-70")}>
          {allOnPage && !allMatching && data.total > pageIds.length && (
            <div className="border-b border-line-soft bg-keep1 px-4 py-2 text-center text-[12.5px]">
              All {pageIds.length} on this page are selected.{" "}
              <button type="button" className="font-semibold text-accent hover:underline" onClick={() => setAllMatching(true)}>
                Select all {data.total.toLocaleString()} that match
              </button>
            </div>
          )}
          {allMatching && (
            <div className="border-b border-line-soft bg-keep1 px-4 py-2 text-center text-[12.5px]">
              All {data.total.toLocaleString()} matching leads are selected.{" "}
              <button type="button" className="font-semibold text-accent hover:underline" onClick={() => (setAllMatching(false), setSelected(new Set()))}>
                Clear
              </button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.08em] text-muted">
                  <th className="w-10 px-4 py-2.5">
                    <input type="checkbox" aria-label="Select this page" checked={allOnPage} onChange={() => (allOnPage ? (setSelected(new Set()), setAllMatching(false)) : setSelected(new Set(pageIds)))} />
                  </th>
                  <Th label="Person" k="person" sort={sort} setSort={setSort} />
                  <Th label="Company" k="company" sort={sort} setSort={setSort} />
                  {cols.includes("location") && <th className="px-3 py-2.5 font-semibold">Location</th>}
                  {cols.includes("campaign") && <th className="px-3 py-2.5 font-semibold">Campaign</th>}
                  {cols.includes("email") && <th className="px-3 py-2.5 font-semibold">Email</th>}
                  {cols.includes("fit") && <Th label="Fit" k="fit" sort={sort} setSort={setSort} />}
                  <Th label="Stage" k="stage" sort={sort} setSort={setSort} />
                  {cols.includes("next") && <th className="px-3 py-2.5 font-semibold">Next step</th>}
                  {cols.includes("source") && <th className="px-3 py-2.5 font-semibold">Source</th>}
                  {cols.includes("mailbox") && <th className="px-3 py-2.5 font-semibold">Mailbox</th>}
                  <Th label="Activity" k="updated" sort={sort} setSort={setSort} right />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((p) => (
                  <PersonRow key={p.id} p={p} cols={cols} checked={allMatching || selected.has(p.id)} onCheck={() => toggle(p.id)} onOpen={() => setDrawer(p.id)} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager offset={offset} count={data.rows.length} total={data.total} setOffset={setOffset} />
        </Card>
      ) : (
        <Card className={cn("overflow-hidden", loading && "opacity-70")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.08em] text-muted">
                  <Th label="Company" k="company" sort={sort} setSort={setSort} first />
                  <th className="px-3 py-2.5 font-semibold">Location</th>
                  <th className="px-3 py-2.5 font-semibold">Industry · size</th>
                  <Th label="People" k="people" sort={sort} setSort={setSort} />
                  <th className="px-3 py-2.5 font-semibold">Campaigns</th>
                  <Th label="Furthest" k="stage" sort={sort} setSort={setSort} />
                  <th className="px-3 py-2.5 font-semibold">Best fit</th>
                  <Th label="Activity" k="updated" sort={sort} setSort={setSort} right />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((c) => (
                  <CompanyLine key={c.id} c={c} onOpen={() => setCompanyDrawer(c.id)} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager offset={offset} count={data.rows.length} total={data.total} setOffset={setOffset} noun="companies" />
        </Card>
      )}

      {/* bulk bar */}
      {selCount > 0 && view === "people" && (
        <div className="savebar fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper shadow-[0_-12px_32px_var(--shadow)]">
          <div className="w flex flex-wrap items-center gap-2 py-3">
            <span className="mr-1 text-[13px] font-semibold tabular-nums">{selCount.toLocaleString()} selected</span>
            <Button size="sm" loading={busy === "approve"} onClick={() => runBulk("approve")}>
              Approve
            </Button>
            <Button size="sm" variant="outline" loading={busy === "skip"} onClick={() => runBulk("skip", { reason: "Skipped from Leads" })}>
              Skip
            </Button>
            <Button size="sm" variant="outline" loading={busy === "restore"} onClick={() => runBulk("restore")}>
              Put back
            </Button>
            <Menu
              label="More"
              align="left"
              items={[
                { label: "Research again", hint: "Reads the websites afresh", onClick: () => runBulk("reresearch") },
                { label: "Check the addresses again", onClick: () => runBulk("reverify") },
                ...(campaigns || []).map((c) => ({ label: `Move to ${c.name}`, hint: "Only leads not yet in Instantly; they start again there", onClick: () => runBulk("move", { campaignId: c.id }) })),
                { label: "Never contact these companies", hint: "Adds the domains to do-not-contact", onClick: () => runBulk("dnc_domain", { reason: "Added from Leads" }), danger: true },
                { label: "Never email these addresses", onClick: () => runBulk("dnc_email", { reason: "Added from Leads" }), danger: true },
              ]}
            />
            <Button size="sm" variant="ghost" loading={busy === "export"} onClick={exportNow}>
              Export
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => (setSelected(new Set()), setAllMatching(false))}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {drawer && <LeadDrawer pid={drawer} onClose={() => setDrawer(null)} onChanged={refresh} />}
      {companyDrawer && <CompanyDrawer id={companyDrawer} onClose={() => setCompanyDrawer(null)} onOpenLead={(pid) => setDrawer(pid)} />}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} defaultCampaign={campaign || undefined} />
    </div>
  );
}

/* -------------------------------- pieces -------------------------------- */

function Th({ label, k, sort, setSort, right, first }: { label: string; k: string; sort: { key: string; dir?: "asc" | "desc" }; setSort: (s: { key: string; dir?: "asc" | "desc" }) => void; right?: boolean; first?: boolean }) {
  const on = sort.key === k;
  const asc = on ? sort.dir === "asc" || (!sort.dir && (k === "company" || k === "person")) : false;
  return (
    <th className={cn("py-2.5 font-semibold", first ? "px-4" : "px-3", right && "text-right")}>
      <button type="button" onClick={() => setSort({ key: k, dir: on ? (asc ? "desc" : "asc") : undefined })} className={cn("inline-flex items-center gap-1 uppercase tracking-[0.08em] hover:text-ink", on && "text-ink")}>
        {label}
        {on && <span aria-hidden>{asc ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

function PersonRow({ p, cols, checked, onCheck, onOpen }: { p: LeadRow; cols: Col[]; checked: boolean; onCheck: () => void; onOpen: () => void }) {
  return (
    <tr onClick={onOpen} className={cn("cursor-pointer border-b border-line-soft last:border-0 hover:bg-hov", checked && "bg-keep1/60")}>
      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`Select ${p.fullName || p.email || p.company}`} checked={checked} onChange={onCheck} />
      </td>
      <td className="max-w-[210px] px-3 py-2.5">
        <div className="truncate font-semibold">{p.fullName || <span className="font-normal text-muted">{p.email ? "Role address" : "No person yet"}</span>}</div>
        <div className="truncate text-[12px] text-muted">
          {p.title}
          {p.linkedinUrl && (
            <a href={p.linkedinUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-1.5 text-accent hover:underline">
              in
            </a>
          )}
        </div>
      </td>
      <td className="max-w-[210px] px-3 py-2.5">
        <div className="truncate">{p.company || p.domain}</div>
        <div className="truncate text-[12px] text-muted">
          {p.domain}
          {p.alsoIn.length > 0 && <span className="ml-1.5 text-inf" title={p.alsoIn.map((a) => a.campaignName).join(", ")}>· also in {p.alsoIn.length === 1 ? p.alsoIn[0].campaignName : `${p.alsoIn.length} campaigns`}</span>}
        </div>
      </td>
      {cols.includes("location") && <td className="max-w-[150px] truncate px-3 py-2.5 text-[12.5px] text-ink-soft">{[p.city, p.country].filter(Boolean).join(", ") || <span className="text-muted">—</span>}</td>}
      {cols.includes("campaign") && (
        <td className="max-w-[170px] px-3 py-2.5">
          <div className="truncate text-[12.5px]">{p.campaignName}</div>
          {p.segmentName && <div className="truncate text-[12px] text-muted">{p.segmentName}</div>}
        </td>
      )}
      {cols.includes("email") && (
        <td className="max-w-[220px] px-3 py-2.5">
          <div className="truncate text-[12.5px]">{p.email || <span className="text-muted">—</span>}</div>
          <EmailStatusChip status={p.emailStatus} />
        </td>
      )}
      {cols.includes("fit") && <td className="px-3 py-2.5 tabular-nums">{p.fitScore ?? <span className="text-muted">—</span>}</td>}
      <td className="max-w-[240px] px-3 py-2.5">
        <StageChip stage={p.stage} />
        {p.stageReason && (
          <div className="mt-1 truncate text-[12px] text-muted" title={p.stageReason}>
            {p.stageReason}
          </div>
        )}
      </td>
      {cols.includes("next") && <td className="max-w-[170px] truncate px-3 py-2.5 text-[12.5px] text-ink-soft">{p.nextStep?.label || <span className="text-muted">—</span>}</td>}
      {cols.includes("source") && <td className="px-3 py-2.5 text-[12.5px] text-muted">{p.leadSource ? SOURCE_LABEL[p.leadSource] : "—"}</td>}
      {cols.includes("mailbox") && <td className="max-w-[170px] truncate px-3 py-2.5 text-[12.5px] text-muted">{p.mailboxEmail || "—"}</td>}
      <td className="whitespace-nowrap px-4 py-2.5 text-right text-[12px] text-muted">{ago(p.updatedAt)}</td>
    </tr>
  );
}

function CompanyLine({ c, onOpen }: { c: CompanyRow; onOpen: () => void }) {
  return (
    <tr onClick={onOpen} className="cursor-pointer border-b border-line-soft last:border-0 hover:bg-hov">
      <td className="max-w-[260px] px-4 py-2.5">
        <div className="truncate font-semibold">{c.name || c.domain}</div>
        <div className="truncate text-[12px] text-muted">{c.domain}</div>
      </td>
      <td className="max-w-[150px] truncate px-3 py-2.5 text-[12.5px] text-ink-soft">{[c.city, c.country].filter(Boolean).join(", ") || <span className="text-muted">—</span>}</td>
      <td className="max-w-[200px] px-3 py-2.5">
        <div className="truncate text-[12.5px]">{c.industry || <span className="text-muted">—</span>}</div>
        {c.size && <div className="truncate text-[12px] text-muted">{c.size}</div>}
      </td>
      <td className="px-3 py-2.5 tabular-nums">{c.people}</td>
      <td className="max-w-[200px] px-3 py-2.5">
        <div className="truncate text-[12.5px]" title={c.campaigns.map((x) => x.name).join(", ")}>
          {c.campaigns.map((x) => x.name).join(", ")}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <StageChip stage={c.furthestStage as ProspectStage} />
      </td>
      <td className="px-3 py-2.5 tabular-nums">{c.bestFit ?? <span className="text-muted">—</span>}</td>
      <td className="whitespace-nowrap px-4 py-2.5 text-right text-[12px] text-muted">{ago(c.lastActivity)}</td>
    </tr>
  );
}

function Pager({ offset, count, total, setOffset, noun = "leads" }: { offset: number; count: number; total: number; setOffset: (n: number) => void; noun?: string }) {
  return (
    <div className="flex items-center justify-between border-t border-line-soft px-4 py-2.5 text-[12.5px] text-muted">
      <span className="tabular-nums">
        {offset + 1}–{offset + count} of {total.toLocaleString()} {noun}
      </span>
      <div className="flex gap-1.5">
        <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          Previous
        </Button>
        <Button variant="ghost" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          Next
        </Button>
      </div>
    </div>
  );
}

function ColumnPicker({ cols, onChange }: { cols: Col[]; onChange: (c: Col[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        Columns
      </Button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1.5 w-[200px] rounded-xl border border-line bg-paper p-2 shadow-[0_18px_40px_var(--shadow)]">
            {COLS.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-hov">
                <input type="checkbox" checked={cols.includes(c.id)} onChange={() => onChange(cols.includes(c.id) ? cols.filter((x) => x !== c.id) : [...cols, c.id])} />
                {c.label}
              </label>
            ))}
            <button type="button" onClick={() => onChange(DEFAULT_COLS)} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hov hover:text-ink">
              Reset to default
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MoreFilters({ filters, facets, setFilter }: { filters: LeadFilters; facets: Facets; setFilter: (k: FilterKey, v: string | number | undefined) => void }) {
  const sel = (k: FilterKey, opts: FacetValue[], any: string) => (
    <Select value={(filters[k] as string) || ""} onChange={(e) => setFilter(k, e.target.value)} className="h-8 py-0 text-[12.5px]">
      <option value="">{any}</option>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label} ({o.count})
        </option>
      ))}
    </Select>
  );
  const lab = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted";
  return (
    <Card className="mb-3 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <span className={lab}>Fit score</span>
        <div className="flex items-center gap-1.5">
          <Input type="number" min={0} max={100} value={filters.fitMin ?? ""} onChange={(e) => setFilter("fitMin", e.target.value === "" ? undefined : Number(e.target.value))} placeholder="from" className="h-8 py-0 text-[12.5px]" />
          <span className="text-muted">–</span>
          <Input type="number" min={0} max={100} value={filters.fitMax ?? ""} onChange={(e) => setFilter("fitMax", e.target.value === "" ? undefined : Number(e.target.value))} placeholder="to" className="h-8 py-0 text-[12.5px]" />
        </div>
      </div>
      <div>
        <span className={lab}>Replied</span>
        <Select value={filters.replied || ""} onChange={(e) => setFilter("replied", e.target.value)} className="h-8 py-0 text-[12.5px]">
          <option value="">Either</option>
          <option value="yes">Replied</option>
          <option value="no">Not replied</option>
        </Select>
      </div>
      <div>
        <span className={lab}>Interest</span>
        {sel("interest", facets.interest || [], "Any interest")}
      </div>
      <div>
        <span className={lab}>Mailbox</span>
        {sel("mailbox", facets.mailbox || [], "Any mailbox")}
      </div>
      <div>
        <span className={lab}>Skipped because</span>
        {sel("skipRule", facets.skipRule || [], "Any reason")}
      </div>
      <div>
        <span className={lab}>Stage</span>
        <Select value={filters.stage && STAGE_LABEL[filters.stage as ProspectStage] ? filters.stage : ""} onChange={(e) => setFilter("stage", e.target.value || "all")} className="h-8 py-0 text-[12.5px]">
          <option value="">From the view</option>
          {(facets.stage || []).map((o) => (
            <option key={o.value} value={o.value}>
              {STAGE_LABEL[o.value as ProspectStage] || o.value} ({o.count})
            </option>
          ))}
        </Select>
      </div>
      <div>
        <span className={lab}>Found between</span>
        <div className="flex items-center gap-1.5">
          <Input type="date" value={filters.foundFrom || ""} onChange={(e) => setFilter("foundFrom", e.target.value)} className="h-8 py-0 text-[12.5px]" />
          <Input type="date" value={filters.foundTo || ""} onChange={(e) => setFilter("foundTo", e.target.value)} className="h-8 py-0 text-[12.5px]" />
        </div>
      </div>
      <div>
        <span className={lab}>Sent between</span>
        <div className="flex items-center gap-1.5">
          <Input type="date" value={filters.sentFrom || ""} onChange={(e) => setFilter("sentFrom", e.target.value)} className="h-8 py-0 text-[12.5px]" />
          <Input type="date" value={filters.sentTo || ""} onChange={(e) => setFilter("sentTo", e.target.value)} className="h-8 py-0 text-[12.5px]" />
        </div>
      </div>
    </Card>
  );
}

/** "Why did we drop them?" — the skipped leads grouped by the rule that dropped them. */
function SkippedBreakdown({ values, active, onPick }: { values: FacetValue[]; active?: string; onPick: (v: string) => void }) {
  const total = values.reduce((n, v) => n + v.count, 0);
  const max = Math.max(1, ...values.map((v) => v.count));
  return (
    <Card className="mb-3 p-4">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-semibold">Why they were skipped</div>
        <div className="text-[12px] text-muted">{plural(total, "lead")} · click a reason to see them</div>
      </div>
      <div className="space-y-1.5">
        {values.map((v) => (
          <button key={v.value} type="button" onClick={() => onPick(v.value)} className={cn("grid w-full grid-cols-[minmax(0,220px)_1fr_48px] items-center gap-3 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors hover:bg-hov", active === v.value && "bg-hov")}>
            <span className={cn("truncate", active === v.value ? "font-semibold text-ink" : "text-ink-soft")}>{v.label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-sunk">
              <span className={cn("block h-full rounded-full", v.value === "__other__" ? "bg-ink/25" : "bg-warn")} style={{ width: `${(v.count / max) * 100}%` }} />
            </span>
            <span className="text-right tabular-nums text-muted">{v.count}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}
