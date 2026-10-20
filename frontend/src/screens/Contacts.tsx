import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Contact, type CompanyCount, type CompanyMode } from "../lib/api";
import { Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, StatusPill, Textarea, toast, cn } from "../lib/ui";
import { downloadCsv, parseContacts, CONTACTS_TEMPLATE, type ParsedContact } from "../lib/csv";
import Crawler from "./Crawler";

const FILTERS = ["all", "new", "sent", "unsubscribed", "bounced"];
const PAGE_SIZES = [25, 50, 100];

// Company filter. `exact` = one company (picked from the list or clicked in the
// table); `contains` = every company whose name contains the typed text.
type CompanyPick = { value: string; mode: CompanyMode };
const NO_COMPANY = "__none__";

function companyLabel(p: CompanyPick) {
  if (p.value === NO_COMPANY) return "No company";
  return p.mode === "contains" ? `contains “${p.value}”` : p.value;
}
// Reads after a count: "12 contacts at Acme Trading".
function companyScope(p: CompanyPick) {
  if (p.value === NO_COMPANY) return "with no company";
  return p.mode === "contains" ? `at companies containing “${p.value}”` : `at ${p.value}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// Compact relative time for the "Last opened" column.
function timeAgo(iso?: string | null) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [categories, setCategories] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [company, setCompany] = useState<CompanyPick | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [crawlOpen, setCrawlOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);

  // Keyset pagination: `cursor` fetches the current page, `prevStack` remembers
  // the cursors used to get here so "Prev" works. `reloadTick` forces a refetch
  // of the current page after a mutation.
  const [pageSize, setPageSize] = useState(50);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // History of cursors so "Prev" can walk back. Only ever mutated via the setter.
  const [, setPrevStack] = useState<(string | undefined)[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const headerCbRef = useRef<HTMLInputElement>(null);

  // The one filter object every list / export / bulk-by-filter call sends, so
  // "Delete all N" removes exactly the rows the table is showing.
  const filterArgs = {
    status: filter,
    q: search,
    category: categoryFilter,
    company: company?.value,
    companyMode: company?.mode,
  };
  const otherFilters = filter !== "all" || categoryFilter !== "all" || !!search.trim();

  async function loadCategories() {
    try { setCategories((await api.getCategories()).categories || []); } catch { /* ignore */ }
  }
  useEffect(() => { loadCategories(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await api.getContacts({ ...filterArgs, limit: pageSize, cursor });
      setContacts(r.contacts);
      setTotal(r.total);
      setFilteredTotal(r.filteredTotal);
      setNextCursor(r.nextCursor);
      if (!selectAllMatching) {
        setSelected((prev) => {
          const visible = new Set(r.contacts.map((c) => c.id));
          return new Set([...prev].filter((id) => visible.has(id)));
        });
      }
      const c: Record<string, number> = {};
      for (const row of r.counts) c[row.status] = row.n;
      setCounts(c);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, search, categoryFilter, company, pageSize, cursor, reloadTick]);

  // Reset to the first page whenever the result set changes (filter/search/size).
  function resetPaging() {
    setCursor(undefined);
    setPrevStack([]);
    setPageIndex(0);
    setSelected(new Set());
    setSelectAllMatching(false);
  }
  // Refetch the current page after a mutation, snapping back to page one so newly
  // added rows (sorted newest-first) are visible and stale cursors can't linger.
  function refreshFromStart() {
    setCursor(undefined);
    setPrevStack([]);
    setPageIndex(0);
    setSelected(new Set());
    setSelectAllMatching(false);
    setReloadTick((t) => t + 1);
  }
  function reloadCurrent() { setReloadTick((t) => t + 1); }

  function changeFilter(f: string) { setFilter(f); resetPaging(); }
  function changeCategory(v: string) { setCategoryFilter(v); resetPaging(); }
  function changeSearch(v: string) { setSearch(v); resetPaging(); }
  function changeCompany(v: CompanyPick | null) { setCompany(v); resetPaging(); }
  function changePageSize(n: number) { setPageSize(n); resetPaging(); }
  function clearFilters() {
    setFilter("all");
    setCategoryFilter("all");
    setSearch("");
    setCompany(null);
    resetPaging();
  }

  function nextPage() {
    if (!nextCursor || loading) return;
    setPrevStack((s) => [...s, cursor]);
    setCursor(nextCursor);
    setPageIndex((i) => i + 1);
    if (!selectAllMatching) setSelected(new Set());
  }
  function prevPage() {
    if (pageIndex === 0 || loading) return;
    setPrevStack((s) => {
      const copy = [...s];
      const prev = copy.pop();
      setCursor(prev);
      return copy;
    });
    setPageIndex((i) => Math.max(0, i - 1));
    if (!selectAllMatching) setSelected(new Set());
  }

  const pageAllSelected = contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const headerChecked = selectAllMatching || pageAllSelected;
  const selectionCount = selectAllMatching ? filteredTotal : selected.size;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const rangeStart = contacts.length ? pageIndex * pageSize + 1 : 0;
  const rangeEnd = pageIndex * pageSize + contacts.length;
  const canOfferAllMatching = pageAllSelected && !selectAllMatching && filteredTotal > contacts.length;

  useEffect(() => {
    if (headerCbRef.current) {
      headerCbRef.current.indeterminate = !selectAllMatching && selected.size > 0 && !pageAllSelected;
    }
  }, [selected, pageAllSelected, selectAllMatching]);

  function toggleAll() {
    if (headerChecked) {
      setSelected(new Set());
      setSelectAllMatching(false);
    } else {
      setSelected(new Set(contacts.map((c) => c.id)));
    }
  }
  function toggle(id: string) {
    setSelectAllMatching(false);
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  // Delete EVERY contact matching the current filters, resolved server-side with
  // the same WHERE the list uses — not just the rows loaded on this page.
  async function deleteMatching() {
    const count = filteredTotal;
    if (!count) return;
    const scope = company
      ? ` ${companyScope(company)}${otherFilters ? " (within your other filters)" : ""}`
      : otherFilters ? " matching your filters" : " — your ENTIRE contact list";
    if (!confirm(`Delete all ${plural(count, "contact")}${scope}? This cannot be undone.`)) return;
    try {
      const r = await api.deleteContactsMatching(filterArgs);
      toast(`Deleted ${plural(r.deleted ?? count, "contact")}${company ? ` ${companyScope(company)}` : ""}`, "success");
      // Nothing is left under that company, so drop the filter rather than
      // leaving an empty table behind.
      if (company) setCompany(null);
      refreshFromStart();
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  async function removeSelected() {
    if (selectAllMatching) return deleteMatching();
    const count = selected.size;
    if (!count) return;
    if (!confirm(`Delete ${plural(count, "contact")}? This cannot be undone.`)) return;
    try {
      await api.deleteContacts([...selected]);
      toast(`Deleted ${plural(count, "contact")}`, "success");
      refreshFromStart();
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  async function applyCategory(cat: string) {
    const count = selectionCount;
    if (!count) return;
    try {
      if (selectAllMatching) await api.setContactsCategory(cat, { all: true, ...filterArgs });
      else await api.setContactsCategory(cat, { ids: [...selected] });
      toast(`Set category on ${count.toLocaleString()} contact(s)`, "success");
      setSelected(new Set());
      setSelectAllMatching(false);
      reloadCurrent();
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  async function exportCsv() {
    try {
      const csv = await api.exportContacts(filterArgs);
      if (!csv.trim() || csv.split("\n").length <= 1) return toast("Nothing to export", "info");
      downloadCsv("contacts.csv", csv);
      toast("Exported", "success");
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  const stats = useMemo(
    () => [
      { label: "Total", value: total },
      { label: "New", value: counts.new || 0 },
      { label: "Sent", value: counts.sent || 0 },
      { label: "Unsubscribed", value: counts.unsubscribed || 0 },
    ],
    [total, counts]
  );

  return (
    <div>
      <Header
        title="Contacts"
        subtitle="Find, import, and manage the companies you'll reach out to."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              Import CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              Add manually
            </Button>
            <Button size="sm" onClick={() => setCrawlOpen(true)}>
              Find emails
            </Button>
          </>
        }
      />

      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="px-4 py-3.5">
            <div className="font-clash text-2xl font-semibold">{s.value.toLocaleString()}</div>
            <div className="mono-label mt-0.5 text-muted">{s.label}</div>
          </Card>
        ))}
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-line bg-paper p-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => changeFilter(f)}
              className={cn(
                "rounded-full px-3 py-1 text-[13px] font-medium capitalize transition-colors",
                filter === f ? "bg-hov text-ink ring-1 ring-inset ring-line-strong" : "text-ink/55 hover:text-ink"
              )}
            >
              {f}
            </button>
          ))}
        </div>
        {categories.length > 0 && (
          <Select
            value={categoryFilter}
            onChange={(e) => changeCategory(e.target.value)}
            className="h-9 w-44"
          >
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="__none__">Uncategorized</option>
          </Select>
        )}
        <CompanyFilter
          value={company}
          onChange={changeCompany}
          status={filter}
          category={categoryFilter}
          refreshKey={reloadTick}
        />
        <div className="ml-auto flex items-center gap-2">
          {selectionCount > 0 && (
            <>
              {categories.length > 0 && (
                <BulkCategory categories={categories} onApply={applyCategory} />
              )}
              {/* bulk-set assigns a category; clearing is done via Edit */}
              <Button variant="danger" size="sm" onClick={removeSelected}>
                Delete {selectionCount.toLocaleString()}
              </Button>
            </>
          )}
          <Input
            placeholder="Search email or company…"
            value={search}
            onChange={(e) => changeSearch(e.target.value)}
            className="h-9 w-64"
          />
        </div>
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        {/* Select-all-matching banner */}
        {selectAllMatching ? (
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-line bg-ink/[0.03] px-4 py-2 text-[13px]">
            <span className="text-ink/70">
              All <span className="font-semibold text-ink">{filteredTotal.toLocaleString()}</span>{" "}
              {filteredTotal === 1 ? "contact" : "contacts"}{" "}
              {company ? <span className="font-semibold text-ink">{companyScope(company)}</span> : "matching your filters"}{" "}
              {filteredTotal === 1 ? "is" : "are"} selected.
            </span>
            <Button variant="danger" size="sm" className="h-7 px-3" onClick={deleteMatching}>
              Delete all {filteredTotal.toLocaleString()}
            </Button>
            <button
              onClick={() => { setSelectAllMatching(false); setSelected(new Set()); }}
              className="font-semibold text-ink underline underline-offset-2 hover:opacity-70"
            >
              Clear selection
            </button>
          </div>
        ) : company && !loading ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-ink/[0.03] px-4 py-2.5 text-[13px]">
            <span className="mono-label rounded-full bg-brand px-2 py-0.5 text-[10px] text-onbrand">Company</span>
            <span className="min-w-0 text-ink/70">
              <span className="font-semibold text-ink">{plural(filteredTotal, "contact")}</span>{" "}
              <span className="font-semibold text-ink">{companyScope(company)}</span>
              {otherFilters && <span className="text-muted"> · within your other filters</span>}
            </span>
            <button
              onClick={() => changeCompany(null)}
              className="text-ink/50 underline underline-offset-2 hover:text-ink"
            >
              Clear
            </button>
            {filteredTotal > 0 && (
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7 px-3" onClick={() => setSelectAllMatching(true)}>
                  Select all {filteredTotal.toLocaleString()}
                </Button>
                <Button variant="danger" size="sm" className="h-7 px-3" onClick={deleteMatching}>
                  Delete all {filteredTotal.toLocaleString()}
                </Button>
              </div>
            )}
          </div>
        ) : canOfferAllMatching ? (
          <div className="flex flex-wrap items-center justify-center gap-1.5 border-b border-line bg-ink/[0.03] px-4 py-2 text-[13px]">
            <span className="text-ink/70">
              All <span className="font-semibold text-ink">{contacts.length}</span> on this page are selected.
            </span>
            <button
              onClick={() => setSelectAllMatching(true)}
              className="font-semibold text-ink underline underline-offset-2 hover:opacity-70"
            >
              Select all {filteredTotal.toLocaleString()} matching
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted">
            <Spinner /> Loading…
          </div>
        ) : contacts.length === 0 ? (
          total > 0 ? <NoMatches onClear={clearFilters} /> : <Empty onFind={() => setCrawlOpen(true)} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left mono-label text-muted">
                    <th className="w-10 px-4 py-3">
                      <input ref={headerCbRef} type="checkbox" checked={headerChecked} onChange={toggleAll} className="accent-brand" />
                    </th>
                    <th className="px-2 py-3">Email</th>
                    <th className="px-2 py-3">Company</th>
                    <th className="px-2 py-3">Phone</th>
                    <th className="px-2 py-3">Country</th>
                    <th className="px-2 py-3">Category</th>
                    <th className="px-2 py-3">Type</th>
                    <th className="px-2 py-3">Status</th>
                    <th className="px-2 py-3">Last opened</th>
                    <th className="w-12 px-2 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => {
                    const isSel = selectAllMatching || selected.has(c.id);
                    return (
                      <tr key={c.id} className="group border-b border-line-soft last:border-0 hover:bg-ink/[0.015]">
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={isSel}
                            onChange={() => toggle(c.id)}
                            className="accent-brand"
                          />
                        </td>
                        <td className="px-2 py-2.5 font-medium">{c.email}</td>
                        <td className="px-2 py-2.5 text-ink/70">
                          {c.company ? (
                            <button
                              type="button"
                              onClick={() => changeCompany({ value: c.company as string, mode: "exact" })}
                              title={`Show only contacts at ${c.company}`}
                              className="max-w-[240px] truncate text-left underline-offset-2 decoration-ink/30 transition-colors hover:text-ink hover:underline"
                            >
                              {c.company}
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-ink/70">
                          {c.phone ? <span className="tabular-nums">{c.phone}</span> : <span className="text-muted">—</span>}
                        </td>
                        <td className="px-2 py-2.5 text-ink/70">{c.country || "—"}</td>
                        <td className="px-2 py-2.5">
                          {c.category ? (
                            <span className="inline-flex items-center rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] font-medium text-ink/70">{c.category}</span>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          <span className="text-xs text-muted">{c.role_based ? "role" : "personal"}</span>
                        </td>
                        <td className="px-2 py-2.5">
                          <StatusPill status={c.status} />
                        </td>
                        <td className="px-2 py-2.5">
                          {c.last_opened_at ? (
                            <span className="inline-flex items-center gap-1.5 text-xs">
                              <span className="h-1.5 w-1.5 rounded-full bg-good" />
                              <span className="text-ink/70" title={new Date(c.last_opened_at).toLocaleString()}>
                                {timeAgo(c.last_opened_at)}
                              </span>
                              {(c.open_count || 0) > 1 && (
                                <span className="text-muted tabular-nums">·{c.open_count}×</span>
                              )}
                              {(c.click_count || 0) > 0 && (
                                <span
                                  className="rounded bg-good/10 px-1 text-[10px] font-medium text-good"
                                  title={c.last_clicked_at ? `Last clicked ${timeAgo(c.last_clicked_at)}` : "Clicked"}
                                >
                                  click
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <button
                            onClick={() => setEditing(c)}
                            className="rounded-md px-2 py-1 text-xs font-medium text-ink/50 opacity-0 transition-opacity hover:bg-ink/[0.06] hover:text-ink group-hover:opacity-100"
                            title="Edit contact"
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination footer */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[13px]">
              <div className="text-muted">
                Showing <span className="font-medium text-ink">{rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}</span>{" "}
                of <span className="font-medium text-ink">{filteredTotal.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-muted">
                  <span>Per page</span>
                  <Select value={String(pageSize)} onChange={(e) => changePageSize(Number(e.target.value))} className="h-8 w-[72px]">
                    {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </Select>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={prevPage} disabled={pageIndex === 0 || loading}>
                    Prev
                  </Button>
                  <span className="min-w-[84px] text-center text-muted">Page {pageIndex + 1} / {totalPages.toLocaleString()}</span>
                  <Button variant="outline" size="sm" onClick={nextPage} disabled={!nextCursor || loading}>
                    Next
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </Card>

      <AddModal open={addOpen} onClose={() => setAddOpen(false)} onDone={refreshFromStart} categories={categories} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={refreshFromStart} />
      <Crawler open={crawlOpen} onClose={() => setCrawlOpen(false)} onAdded={refreshFromStart} />
      {editing && (
        <EditModal
          key={editing.id}
          contact={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); reloadCurrent(); }}
        />
      )}
    </div>
  );
}

/* ------------------------------- Header ----------------------------- */

export function Header({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  // Rendered into the DNA shell's title row (see PageHeader in lib/ui).
  return <PageHeader title={title} subtitle={subtitle} actions={actions} />;
}

function Empty({ onFind }: { onFind: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="prism-bar h-1.5 w-16 rounded-full opacity-60" />
      <div className="font-clash text-lg font-semibold">No contacts yet</div>
      <p className="max-w-sm text-sm text-muted">
        Crawl company websites to discover public emails, import a CSV, or add contacts by hand.
      </p>
      <Button size="sm" onClick={onFind} className="mt-1">
        Find emails
      </Button>
    </div>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="font-clash text-lg font-semibold">No contacts match these filters</div>
      <p className="max-w-sm text-sm text-muted">Try another company, status or category, or clear the filters.</p>
      <Button size="sm" variant="outline" onClick={onClear} className="mt-1">
        Clear filters
      </Button>
    </div>
  );
}

/* --------------------------- Company filter ------------------------- */

// Searchable company picker. Lists every company on file (scoped to the
// current status/category tab) with how many contacts each has; typing offers
// "any company containing …" on top, which catches spelling variants like
// "Acme Trading" and "ACME Trading W.L.L." in one go.
const COMPANY_LIST_LIMIT = 50;

interface CompanyOption {
  key: string;
  pick: CompanyPick | null; // null = clear the filter
  label: React.ReactNode;
  n?: number;
}

function highlightMatch(name: string, term: string): React.ReactNode {
  if (!term) return name;
  const i = name.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return name;
  return (
    <>
      {name.slice(0, i)}
      <mark className="rounded-[3px] bg-wnb text-ink">{name.slice(i, i + term.length)}</mark>
      {name.slice(i + term.length)}
    </>
  );
}

function CompanyFilter({
  value,
  onChange,
  status,
  category,
  refreshKey,
}: {
  value: CompanyPick | null;
  onChange: (v: CompanyPick | null) => void;
  status: string;
  category: string;
  refreshKey: number;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [data, setData] = useState<{
    companies: CompanyCount[];
    totalCompanies: number;
    matching: number;
    noCompany: number;
  } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const term = text.trim();

  // Fetch while open; debounce typing.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.getContactCompanies({ status, category, search: term, limit: COMPANY_LIST_LIMIT });
        if (alive) setData(r);
      } catch {
        if (alive) setData(null);
      } finally {
        if (alive) setBusy(false);
      }
    }, term ? 200 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [open, term, status, category, refreshKey]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Reset the keyboard cursor whenever the list changes.
  useEffect(() => { setActive(0); }, [term, open]);

  const options: CompanyOption[] = [];
  if (term) {
    if ((data?.matching ?? 0) > 0) {
      options.push({
        key: "contains",
        pick: { value: term, mode: "contains" },
        label: <>Any company containing <span className="font-semibold">“{term}”</span></>,
        n: data?.matching,
      });
    }
  } else if (value) {
    options.push({ key: "all", pick: null, label: <span className="text-ink/60">All companies</span> });
  }
  for (const c of data?.companies || []) {
    options.push({
      key: `c:${c.company.toLowerCase()}`,
      pick: { value: c.company, mode: "exact" },
      label: highlightMatch(c.company, term),
      n: c.n,
    });
  }
  if (!term && (data?.noCompany ?? 0) > 0) {
    options.push({
      key: "none",
      pick: { value: NO_COMPANY, mode: "exact" },
      label: <span className="italic text-ink/60">No company</span>,
      n: data?.noCompany,
    });
  }

  // Keep the keyboard-highlighted row in view.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const isCurrent = (p: CompanyPick | null) =>
    p === null
      ? !value
      : !!value && value.mode === p.mode && value.value.toLowerCase() === p.value.toLowerCase();

  function choose(o: CompanyOption) {
    onChange(o.pick);
    setOpen(false);
    setText("");
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[active];
      if (o) choose(o);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const shown = data?.companies.length ?? 0;
  const totalCompanies = data?.totalCompanies ?? 0;

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value ? `Company: ${companyLabel(value)}` : "Filter by company"}
        className={cn(
          "flex h-9 w-56 items-center gap-2 rounded-xl border pl-3 text-left text-sm transition-colors",
          value ? "border-brand bg-brand pr-9 text-onbrand" : "border-line bg-sunk pr-3 text-ink hover:border-ink/30"
        )}
      >
        <span className={cn("mono-label shrink-0 text-[10px]", value ? "text-onbrand/55" : "text-muted")}>Company</span>
        <span className="min-w-0 flex-1 truncate">
          {value ? companyLabel(value) : <span className="text-muted">All</span>}
        </span>
        {!value && (
          <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-muted" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label="Clear company filter"
          title="Clear company filter"
          className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-[11px] text-onbrand/70 transition-colors hover:bg-onbrand/15 hover:text-onbrand"
        >
          ✕
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_22px_48px_-20px_rgba(11,11,11,0.35)]">
          <div className="border-b border-line p-2">
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search companies…"
              className="w-full rounded-lg bg-ink/[0.04] px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted/80 focus:bg-ink/[0.065]"
            />
          </div>

          <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto py-1">
            {options.map((o, i) => {
              const current = isCurrent(o.pick);
              return (
                <button
                  key={o.key}
                  type="button"
                  role="option"
                  aria-selected={current}
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors",
                    i === active ? "bg-ink/[0.06]" : "",
                    o.key === "contains" && "border-b border-line-soft"
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", current ? "bg-brand" : "bg-ink/10")} />
                  <span className={cn("min-w-0 flex-1 truncate", current && "font-semibold")}>{o.label}</span>
                  {o.n != null && <span className="shrink-0 tabular-nums text-xs text-muted">{o.n.toLocaleString()}</span>}
                </button>
              );
            })}
            {options.length === 0 && (
              <div className="flex items-center justify-center gap-2 px-3 py-7 text-center text-[13px] text-muted">
                {busy ? (
                  <><Spinner className="h-3.5 w-3.5" /> Loading companies…</>
                ) : term ? (
                  <>No company matches “{term}”</>
                ) : (
                  <>No companies on file yet</>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 text-[11px] text-muted">
            <span className="truncate">
              {data
                ? totalCompanies > shown
                  ? `Top ${shown} of ${plural(totalCompanies, "company", "companies")} — type to narrow`
                  : `${plural(totalCompanies, "company", "companies")}${term ? " match" : ""}`
                : "\u00a0"}
            </span>
            <span className="hidden shrink-0 sm:inline">↑↓ · Enter</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- Add modal ---------------------------- */

function BulkCategory({ categories, onApply }: { categories: string[]; onApply: (cat: string) => void }) {
  const [val, setVal] = useState("");
  return (
    <Select
      value={val}
      onChange={(e) => {
        const v = e.target.value;
        setVal("");
        if (v) onApply(v);
      }}
      className="h-8 w-40 text-[13px]"
    >
      <option value="">Set category…</option>
      {categories.map((c) => <option key={c} value={c}>{c}</option>)}
    </Select>
  );
}

// Free-form category picker: choose an existing category or type a new one.
function CategoryField({ value, onChange, categories }: { value: string; onChange: (v: string) => void; categories: string[] }) {
  return (
    <Field label="Category" hint={categories.length ? undefined : "Add categories in Settings to build a list."}>
      <Select value={categories.includes(value) || !value ? value : "__custom__"} onChange={(e) => onChange(e.target.value === "__custom__" ? value : e.target.value)}>
        <option value="">None</option>
        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        {value && !categories.includes(value) && <option value={value}>{value}</option>}
      </Select>
    </Field>
  );
}

function AddModal({ open, onClose, onDone, categories }: { open: boolean; onClose: () => void; onDone: () => void; categories: string[] }) {
  const [f, setF] = useState({ email: "", company: "", country: "", industry: "", category: "", phone: "" });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.email.includes("@")) return toast("Enter a valid email", "error");
    setBusy(true);
    try {
      await api.addContact(f);
      toast("Contact added", "success");
      setF({ email: "", company: "", country: "", industry: "", category: "", phone: "" });
      onDone();
      onClose();
    } catch (e: any) {
      toast(e.message === "duplicate" ? "That email already exists" : e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add contact">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email">
            <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@company.com" />
          </Field>
          <Field label="Phone" hint="Optional — mobile preferred">
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+974 5012 3456" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company">
            <Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          </Field>
          <Field label="Country">
            <Input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Industry">
            <Input value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} />
          </Field>
          <CategoryField value={f.category} onChange={(v) => setF({ ...f, category: v })} categories={categories} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={submit}>Add contact</Button>
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------- Import modal --------------------------- */

function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo<ParsedContact[]>(() => (csv.trim() ? parseContacts(csv) : []), [csv]);
  const valid = parsed.filter((r) => r.valid && !r.duplicate);
  const invalid = parsed.filter((r) => !r.valid);
  const dupes = parsed.filter((r) => r.valid && r.duplicate);

  function reset() {
    setCsv("");
    setFileName("");
    if (fileRef.current) fileRef.current.value = "";
  }
  function close() {
    reset();
    onClose();
  }

  function readFile(file: File) {
    if (!/\.(csv|txt)$/i.test(file.name)) return toast("Please choose a .csv file", "error");
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result || ""));
      setFileName(file.name);
    };
    reader.onerror = () => toast("Could not read that file", "error");
    reader.readAsText(file);
  }

  function downloadTemplate() {
    downloadCsv("contacts-template.csv", CONTACTS_TEMPLATE);
    toast("Template downloaded", "success");
  }

  async function submit() {
    if (!valid.length) return toast("No valid rows to import", "error");
    setBusy(true);
    try {
      // upsert=true: existing contacts are UPDATED (status preserved), new ones added.
      const r = await api.bulkContacts(
        valid.map((c) => ({
          email: c.email,
          company: c.company || undefined,
          country: c.country || undefined,
          industry: c.industry || undefined,
          category: c.category || undefined,
          phone: c.phone || undefined,
          source: "csv",
        })),
        true
      );
      const parts = [`${r.added} added`];
      if (r.updated) parts.push(`${r.updated} updated`);
      if (r.skipped) parts.push(`${r.skipped} unchanged`);
      toast(parts.join(" · "), "success");
      reset();
      onDone();
      onClose();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Import contacts from CSV" wide>
      <div className="space-y-5">
        {/* Step 1 — template */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-ink/[0.02] px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="mono-label mt-0.5 rounded-md bg-brand px-1.5 py-0.5 text-onbrand">01</span>
            <div>
              <div className="text-[13px] font-semibold text-ink">Get the template</div>
              <div className="text-xs text-muted">Download it, fill in your contacts in Excel or Google Sheets, then upload it below.</div>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={downloadTemplate}>Download template</Button>
        </div>

        {/* Step 2 — upload / paste */}
        <div>
          <div className="mb-2 flex items-center gap-3">
            <span className="mono-label rounded-md bg-brand px-1.5 py-0.5 text-onbrand">02</span>
            <div className="text-[13px] font-semibold text-ink">Upload or paste your data</div>
          </div>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) readFile(f);
            }}
            onClick={() => fileRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
              dragOver ? "border-brand bg-brand/[0.04]" : "border-line hover:border-ink/40 hover:bg-ink/[0.02]"
            )}
          >
            <div className="prism-bar h-1 w-10 rounded-full opacity-60" />
            <div className="text-[13px] font-medium text-ink">
              {fileName ? `Loaded ${fileName}` : "Drop a CSV file here, or click to browse"}
            </div>
            <div className="text-xs text-muted">Columns: email, company, country, industry, category, phone</div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }}
            />
          </div>

          <details className="mt-2">
            <summary className="cursor-pointer select-none text-xs font-medium text-ink/55 hover:text-ink">
              or paste CSV manually
            </summary>
            <Textarea
              rows={6}
              value={csv}
              onChange={(e) => { setCsv(e.target.value); setFileName(""); }}
              placeholder={"email,company,country,industry,category,phone\ninfo@acme.com,Acme Trading,Qatar,Trading,Customer,+974 4432 4853"}
              className="mt-2 font-mono text-xs"
            />
          </details>
        </div>

        {/* Step 3 — preview */}
        {parsed.length > 0 && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="mono-label rounded-md bg-brand px-1.5 py-0.5 text-onbrand">03</span>
              <div className="text-[13px] font-semibold text-ink">Review</div>
              <div className="ml-1 flex flex-wrap gap-1.5">
                <Chip tone="good">{valid.length} ready</Chip>
                {dupes.length > 0 && <Chip tone="muted">{dupes.length} duplicate in file</Chip>}
                {invalid.length > 0 && <Chip tone="bad">{invalid.length} invalid</Chip>}
              </div>
            </div>
            <div className="max-h-56 overflow-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-paper">
                  <tr className="border-b border-line text-left mono-label text-muted">
                    <th className="px-3 py-2">Email</th>
                    <th className="px-2 py-2">Company</th>
                    <th className="px-2 py-2">Phone</th>
                    <th className="px-2 py-2">Category</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.slice(0, 200).map((r, i) => {
                    const bad = !r.valid;
                    const dup = r.valid && r.duplicate;
                    return (
                      <tr key={i} className={cn("border-b border-line-soft last:border-0", bad && "bg-bad/[0.05]", dup && "bg-ink/[0.02]")}>
                        <td className="px-3 py-1.5">
                          <span className={cn("font-medium", bad && "text-bad", dup && "text-muted line-through")}>
                            {r.email || <span className="italic text-bad">missing</span>}
                          </span>
                          {bad && <span className="ml-2 text-[11px] text-bad">invalid</span>}
                          {dup && <span className="ml-2 text-[11px] text-muted">dup</span>}
                        </td>
                        <td className="px-2 py-1.5 text-ink/70">{r.company || "—"}</td>
                        <td className="px-2 py-1.5 text-ink/70 tabular-nums">{r.phone || "—"}</td>
                        <td className="px-2 py-1.5 text-ink/70">{r.category || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {parsed.length > 200 && (
              <div className="mt-1 text-xs text-muted">Showing first 200 of {parsed.length} rows.</div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {csv.trim() ? (
            <button onClick={reset} className="text-xs font-medium text-ink/50 underline hover:text-ink">Clear</button>
          ) : (
            <span className="text-xs text-muted">Existing contacts are updated (their status is kept); new ones are added.</span>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button loading={busy} onClick={submit} disabled={!valid.length}>
              Import {valid.length || ""} contact{valid.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Chip({ tone, children }: { tone: "good" | "bad" | "muted"; children: React.ReactNode }) {
  const cls =
    tone === "good"
      ? "bg-okb text-good"
      : tone === "bad"
      ? "bg-dgb text-bad"
      : "bg-ink/[0.06] text-ink/55";
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", cls)}>{children}</span>;
}

/* ---------------------------- Edit modal ---------------------------- */

function EditModal({ contact, categories, onClose, onDone }: { contact: Contact; categories: string[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    email: contact.email,
    company: contact.company || "",
    country: contact.country || "",
    industry: contact.industry || "",
    category: contact.category || "",
    phone: contact.phone || "",
    status: contact.status,
  });
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!f.email.includes("@")) return toast("Enter a valid email", "error");
    setBusy(true);
    try {
      await api.updateContact(contact.id, f);
      toast("Contact updated", "success");
      onDone();
    } catch (e: any) {
      toast(e.message === "duplicate" ? "Another contact already uses that email" : e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit contact">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email">
            <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Phone" hint="Optional — mobile preferred">
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+974 5012 3456" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company">
            <Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          </Field>
          <Field label="Country">
            <Input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Industry">
            <Input value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} />
          </Field>
          <CategoryField value={f.category} onChange={(v) => setF({ ...f, category: v })} categories={categories} />
        </div>
        <Field label="Status" hint="Set to unsubscribed to permanently exclude from sends.">
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="new">new</option>
            <option value="sent">sent</option>
            <option value="unsubscribed">unsubscribed</option>
            <option value="bounced">bounced</option>
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={save}>Save changes</Button>
        </div>
      </div>
    </Modal>
  );
}
