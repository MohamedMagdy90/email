import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AdoptableSummary, type Contact } from "../lib/api";
import { Button, Card, Field, Input, Modal, Select, Spinner, StatusPill, Textarea, toast, cn } from "../lib/ui";
import { downloadCsv, parseContacts, CONTACTS_TEMPLATE, type ParsedContact } from "../lib/csv";
import Crawler from "./Crawler";

const FILTERS = ["all", "new", "sent", "unsubscribed", "bounced"];
const PAGE_SIZES = [25, 50, 100];

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

  async function loadCategories() {
    try { setCategories((await api.getCategories()).categories || []); } catch { /* ignore */ }
  }
  useEffect(() => { loadCategories(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await api.getContacts({ status: filter, q: search, category: categoryFilter, limit: pageSize, cursor });
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
  }, [filter, search, categoryFilter, pageSize, cursor, reloadTick]);

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
  function changePageSize(n: number) { setPageSize(n); resetPaging(); }

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

  const filterArgs = { status: filter, q: search, category: categoryFilter };

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

  async function removeSelected() {
    const count = selectionCount;
    if (!count) return;
    if (!confirm(`Delete ${count.toLocaleString()} contact(s)? This cannot be undone.`)) return;
    try {
      if (selectAllMatching) await api.deleteContactsMatching(filterArgs);
      else await api.deleteContacts([...selected]);
      toast(`Deleted ${count.toLocaleString()} contact(s)`, "success");
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

      <UnreachableBanner onDone={refreshFromStart} />

      {/* Toolbar — stacked on a phone (search first, because that is what you
          reach for), one row from lg up exactly as before. */}
      <div className="mb-3 space-y-2 lg:flex lg:flex-wrap lg:items-center lg:gap-2 lg:space-y-0">
        <Input
          type="search"
          placeholder="Search email or company…"
          value={search}
          onChange={(e) => changeSearch(e.target.value)}
          className="w-full lg:order-3 lg:ml-auto lg:h-9 lg:w-64"
        />

        <div className="-mx-4 overflow-x-auto px-4 no-scrollbar lg:order-1 lg:mx-0 lg:overflow-visible lg:px-0">
          <div className="inline-flex rounded-full border border-line bg-paper p-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => changeFilter(f)}
                className={cn(
                  "shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium capitalize transition-colors lg:px-3 lg:py-1",
                  filter === f ? "bg-ink text-cream" : "text-ink/55 hover:text-ink"
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {categories.length > 0 && (
          <Select
            value={categoryFilter}
            onChange={(e) => changeCategory(e.target.value)}
            className="w-full lg:order-2 lg:h-9 lg:w-44"
          >
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="__none__">Uncategorized</option>
          </Select>
        )}

        {selectionCount > 0 && (
          <div className="flex items-center gap-2 lg:order-4">
            {categories.length > 0 && (
              <BulkCategory categories={categories} onApply={applyCategory} />
            )}
            {/* bulk-set assigns a category; clearing is done via Edit */}
            <Button variant="danger" size="sm" onClick={removeSelected} className="flex-1 lg:flex-none">
              Delete {selectionCount.toLocaleString()}
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        {/* Select-all-matching banner */}
        {selectAllMatching ? (
          <div className="flex flex-wrap items-center justify-center gap-1.5 border-b border-line bg-ink/[0.03] px-4 py-2 text-[13px]">
            <span className="text-ink/70">
              All <span className="font-semibold text-ink">{filteredTotal.toLocaleString()}</span> contacts matching your filters are selected.
            </span>
            <button
              onClick={() => { setSelectAllMatching(false); setSelected(new Set()); }}
              className="font-semibold text-ink underline underline-offset-2 hover:opacity-70"
            >
              Clear selection
            </button>
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
          <Empty onFind={() => setCrawlOpen(true)} />
        ) : (
          <>
            {/* Phone / tablet: one card per contact. Ten columns cannot be made
                to work at 390px, and a sideways-scrolling table is not a fix —
                the columns that matter (who, where, state) go up top and the
                rest reads underneath. */}
            <ul className="divide-y divide-line-soft lg:hidden">
              <li className="flex items-center gap-3 border-b border-line bg-ink/[0.02] px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={headerChecked}
                  onChange={toggleAll}
                  aria-label="Select all on this page"
                  className="h-[18px] w-[18px] accent-ink"
                />
                <span className="text-[13px] text-ink/70">
                  {headerChecked ? "Deselect all" : "Select all on page"}
                </span>
                <span className="mono-label ml-auto text-muted">{contacts.length}</span>
              </li>
              {contacts.map((c) => (
                <ContactCard
                  key={c.id}
                  contact={c}
                  selected={selectAllMatching || selected.has(c.id)}
                  onToggle={() => toggle(c.id)}
                  onEdit={() => setEditing(c)}
                />
              ))}
            </ul>

            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left mono-label text-muted">
                    <th className="w-10 px-4 py-3">
                      <input ref={headerCbRef} type="checkbox" checked={headerChecked} onChange={toggleAll} className="h-[18px] w-[18px] accent-ink" />
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
                            className="accent-ink"
                          />
                        </td>
                        <td className="px-2 py-2.5 font-medium">{c.email}</td>
                        <td className="px-2 py-2.5 text-ink/70">{c.company || "—"}</td>
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
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5 border-t border-line px-4 py-3 text-[13px]">
              <div className="text-muted">
                Showing <span className="font-medium text-ink">{rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}</span>{" "}
                of <span className="font-medium text-ink">{filteredTotal.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 text-muted">
                <span className="hidden sm:inline">Per page</span>
                <Select
                  value={String(pageSize)}
                  onChange={(e) => changePageSize(Number(e.target.value))}
                  className="h-9 w-[74px] py-0 sm:h-8"
                  aria-label="Rows per page"
                >
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </div>
              <div className="flex w-full items-center gap-1.5 sm:w-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={prevPage}
                  disabled={pageIndex === 0 || loading}
                  className="flex-1 sm:flex-none"
                >
                  Prev
                </Button>
                <span className="min-w-[84px] shrink-0 text-center text-muted">
                  Page {pageIndex + 1} / {totalPages.toLocaleString()}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={nextPage}
                  disabled={!nextCursor || loading}
                  className="flex-1 sm:flex-none"
                >
                  Next
                </Button>
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
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="font-clash text-[26px] font-semibold leading-tight tracking-tight sm:text-3xl">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted sm:text-sm">{subtitle}</p>}
      </div>
      {actions && (
        // Four buttons will not fit across a 390px screen. Rather than let them
        // wrap into a ragged block, they become a swipeable rail that bleeds to
        // both edges — the same trick the filter pills use below.
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 no-scrollbar [&>*]:shrink-0 sm:mx-0 sm:overflow-visible sm:px-0">
          {actions}
        </div>
      )}
    </div>
  );
}

/* --------------------------- Contact card --------------------------- */

// The sub-lg row. Tapping the body opens the editor, which is the mobile
// equivalent of the Edit button that appears on hover in the table; the
// checkbox stays a separate target so selecting never opens anything.
function ContactCard({
  contact: c,
  selected,
  onToggle,
  onEdit,
}: {
  contact: Contact;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const meta = [c.country, c.role_based ? "role" : "personal"].filter(Boolean);
  return (
    <li className={cn("flex gap-3 px-4 py-3 transition-colors", selected && "bg-ink/[0.03]")}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select ${c.email}`}
        className="mt-1 h-[18px] w-[18px] shrink-0 accent-ink"
      />
      <button onClick={onEdit} className="min-w-0 flex-1 text-left active:opacity-70">
        <div className="flex items-start justify-between gap-2">
          <span className="truncate text-[14px] font-medium">{c.email}</span>
          <span className="shrink-0">
            <StatusPill status={c.status} />
          </span>
        </div>

        <div className="mt-0.5 truncate text-[13px] text-ink/70">{c.company || "—"}</div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
          {c.category && (
            <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 font-medium text-ink/70">
              {c.category}
            </span>
          )}
          {c.phone && <span className="tabular-nums">{c.phone}</span>}
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
          {c.last_opened_at && (
            <span className="inline-flex items-center gap-1 text-ink/60">
              <span className="h-1.5 w-1.5 rounded-full bg-good" />
              opened {timeAgo(c.last_opened_at)}
              {(c.open_count || 0) > 1 && <span className="tabular-nums">·{c.open_count}×</span>}
            </span>
          )}
          {(c.click_count || 0) > 0 && (
            <span className="rounded bg-good/10 px-1.5 py-0.5 text-[10px] font-medium text-good">
              clicked
            </span>
          )}
        </div>
      </button>
    </li>
  );
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
      /* Shares a row with the Delete button, so it flexes rather than
         claiming the full width the way a stacked control would. */
      className="min-w-0 flex-1 text-[13px] sm:h-8 sm:w-40 sm:flex-none"
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Email">
            <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@company.com" />
          </Field>
          <Field label="Phone" hint="Optional — mobile preferred">
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+974 5012 3456" />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Company">
            <Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          </Field>
          <Field label="Country">
            <Input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
  // Where the rows land. "pool" is the default because it is what almost
  // everybody means by importing: the automation only ever reads the review
  // pool, so a CSV sent straight to Contacts can never be emailed by the bot.
  const [dest, setDest] = useState<"pool" | "contacts">("pool");
  const [audience, setAudience] = useState<"customer" | "partner">("customer");
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
      const rows = valid.map((c) => ({
        email: c.email,
        company: c.company || undefined,
        country: c.country || undefined,
        industry: c.industry || undefined,
        category: c.category || undefined,
        phone: c.phone || undefined,
        source: "csv",
      }));

      if (dest === "pool") {
        const r = await api.importToPool(rows, { audience, label: fileName || "CSV import" });
        const parts = [`${r.added} queued for the automation`];
        if (r.duplicate) parts.push(`${r.duplicate} already known`);
        if (r.invalid) parts.push(`${r.invalid} unmailable`);
        toast(parts.join(" · "), "success");
      } else {
        // upsert=true: existing contacts are UPDATED (status preserved), new ones added.
        const r = await api.bulkContacts(rows, true, audience);
        const parts = [`${r.added} added`];
        if (r.updated) parts.push(`${r.updated} updated`);
        if (r.skipped) parts.push(`${r.skipped} unchanged`);
        toast(parts.join(" · "), "success");
      }
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
            <span className="mono-label mt-0.5 rounded-md bg-ink px-1.5 py-0.5 text-cream">01</span>
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
            <span className="mono-label rounded-md bg-ink px-1.5 py-0.5 text-cream">02</span>
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
              dragOver ? "border-ink bg-ink/[0.04]" : "border-line hover:border-ink/40 hover:bg-ink/[0.02]"
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

        {/* Step 3 — destination. The single most consequential choice in this
            modal, and the one that used to be made silently and wrongly. */}
        <div>
          <div className="mb-2 flex items-center gap-3">
            <span className="mono-label rounded-md bg-ink px-1.5 py-0.5 text-cream">03</span>
            <div className="text-[13px] font-semibold text-ink">Where should these go?</div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setDest("pool")}
              className={cn(
                "rounded-xl border px-4 py-3 text-left transition-colors",
                dest === "pool" ? "border-ink bg-ink/[0.04]" : "border-line hover:border-ink/40"
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", dest === "pool" ? "bg-ink" : "bg-ink/20")} />
                <span className="text-[13px] font-semibold text-ink">Review pool</span>
                <span className="rounded-full bg-[#e7f6ec] px-2 py-0.5 text-[10px] font-medium text-[#1f8b4c]">
                  automation
                </span>
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted">
                The bot emails them in batches, on its own schedule, respecting each
                country's sending window and your daily limit.
              </div>
            </button>
            <button
              type="button"
              onClick={() => setDest("contacts")}
              className={cn(
                "rounded-xl border px-4 py-3 text-left transition-colors",
                dest === "contacts" ? "border-ink bg-ink/[0.04]" : "border-line hover:border-ink/40"
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", dest === "contacts" ? "bg-ink" : "bg-ink/20")} />
                <span className="text-[13px] font-semibold text-ink">Contacts only</span>
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted">
                Stored, but the automation will never touch them. You email them
                yourself from the Send screen.
              </div>
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-ink/[0.02] px-3 py-2">
            <span className="text-xs font-medium text-ink/70">Pitch these as</span>
            {(["customer", "partner"] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAudience(a)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                  audience === a ? "bg-ink text-cream" : "text-ink/60 hover:bg-ink/[0.06]"
                )}
              >
                {a}s
              </button>
            ))}
            <span className="text-xs text-muted">
              — decides which lane, and which template, they get.
            </span>
          </div>
        </div>

        {/* Step 4 — preview */}
        {parsed.length > 0 && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="mono-label rounded-md bg-ink px-1.5 py-0.5 text-cream">04</span>
              <div className="text-[13px] font-semibold text-ink">Review</div>
              <div className="ml-1 flex flex-wrap gap-1.5">
                <Chip tone="good">{valid.length} ready</Chip>
                {dupes.length > 0 && <Chip tone="muted">{dupes.length} duplicate in file</Chip>}
                {invalid.length > 0 && <Chip tone="bad">{invalid.length} invalid</Chip>}
              </div>
            </div>
            <div className="touch-scroll max-h-56 overflow-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-paper">
                  <tr className="border-b border-line text-left mono-label text-muted">
                    <th className="px-3 py-2">Email</th>
                    <th className="px-2 py-2">Company</th>
                    {/* The email column carries the invalid/duplicate markers,
                        so on a phone it takes the room these two would have. */}
                    <th className="hidden px-2 py-2 sm:table-cell">Phone</th>
                    <th className="hidden px-2 py-2 sm:table-cell">Category</th>
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
                        <td className="hidden px-2 py-1.5 tabular-nums text-ink/70 sm:table-cell">{r.phone || "—"}</td>
                        <td className="hidden px-2 py-1.5 text-ink/70 sm:table-cell">{r.category || "—"}</td>
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
            <span className="text-xs text-muted">
              {dest === "pool"
                ? "Anyone already in Contacts or the pool is skipped, so re-importing is safe."
                : "Existing contacts are updated (their status is kept); new ones are added."}
            </span>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button loading={busy} onClick={submit} disabled={!valid.length}>
              {dest === "pool" ? "Queue" : "Import"} {valid.length || ""} contact{valid.length === 1 ? "" : "s"}
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
      ? "bg-[#e7f6ec] text-[#1f8b4c]"
      : tone === "bad"
      ? "bg-[#fde8e8] text-[#c0392b]"
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Email">
            <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Phone" hint="Optional — mobile preferred">
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+974 5012 3456" />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Company">
            <Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          </Field>
          <Field label="Country">
            <Input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

/* ------------------- Contacts the automation cannot see ------------------ */

/**
 * Contacts imported before the pool route existed are invisible to the bot:
 * every lane counts the review pool and nothing else. They are not broken and
 * not lost — they have simply never been queued, and there was previously no
 * way to tell from this screen, because a contact the bot will email tomorrow
 * and one it will never email look identical in the table.
 *
 * Shown only when there is something to do, and it disappears for good once
 * the backfill has run.
 */
function UnreachableBanner({ onDone }: { onDone: () => void }) {
  const [info, setInfo] = useState<AdoptableSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  async function load() {
    try {
      setInfo(await api.getAdoptable());
    } catch {
      /* a failure here must never break the Contacts screen */
    }
  }
  useEffect(() => { load(); }, []);

  async function queueThem() {
    setBusy(true);
    setProgress({ done: 0, total: info?.imported || 0 });
    try {
      const { jobId, total } = await api.adoptContacts({ importedOnly: true });
      setProgress({ done: 0, total });
      // Poll until the job settles. A 30k backfill is chunked server-side, so
      // this reports real movement rather than an indeterminate spinner.
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const job = await api.adoptContactsJob(jobId);
        setProgress({ done: job.processed || 0, total: job.total || total });
        if (job.status === "done") {
          const r = job.result || {};
          toast(
            `${(r.added || 0).toLocaleString()} contact(s) queued — the automation will email them in batches.`,
            "success"
          );
          break;
        }
        if (job.status === "error") {
          toast(job.error || "The backfill failed", "error");
          break;
        }
      }
      await load();
      onDone();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (dismissed || !info || info.imported < 1) return null;

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Card className="mb-6 border-ink/15 bg-ink/[0.02] px-4 py-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#fdf3e3] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9a6b16]">
              not queued
            </span>
            <span className="text-[13px] font-semibold text-ink">
              {info.imported.toLocaleString()} imported contact{info.imported === 1 ? " has" : "s have"} never been emailed
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            The automation only reads the review pool, so contacts imported straight
            into this list were never picked up. Queue them and the bot will email
            them in its normal batches — same daily limit, same sending windows.
            {info.alreadyEmailed > 0 && (
              <>
                {" "}
                The {info.alreadyEmailed.toLocaleString()} already emailed are left alone.
              </>
            )}
          </p>
          {progress && (
            <div className="mt-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
                <div className="h-full rounded-full bg-ink transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-[11px] tabular-nums text-muted">
                {progress.done.toLocaleString()} of {progress.total.toLocaleString()} queued
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDismissed(true)} disabled={busy}>
            Not now
          </Button>
          <Button size="sm" loading={busy} onClick={queueThem}>
            Queue for automation
          </Button>
        </div>
      </div>
    </Card>
  );
}
