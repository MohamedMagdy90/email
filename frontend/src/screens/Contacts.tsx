import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Contact } from "../lib/api";
import { Button, Card, Field, Input, Modal, Select, Spinner, StatusPill, Textarea, toast, cn } from "../lib/ui";
import { downloadCsv, parseContacts, CONTACTS_TEMPLATE, type ParsedContact } from "../lib/csv";
import Crawler from "./Crawler";

const FILTERS = ["all", "new", "sent", "unsubscribed", "bounced"];

export default function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [categories, setCategories] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [crawlOpen, setCrawlOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);

  async function loadCategories() {
    try { setCategories((await api.getCategories()).categories || []); } catch { /* ignore */ }
  }
  useEffect(() => { loadCategories(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await api.getContacts({ status: filter, q: search, category: categoryFilter, limit: 1000 });
      setContacts(r.contacts);
      setTotal(r.total);
      setSelected((prev) => {
        const visible = new Set(r.contacts.map((c) => c.id));
        return new Set([...prev].filter((id) => visible.has(id)));
      });
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
  }, [filter, search, categoryFilter]);

  const allSelected = contacts.length > 0 && selected.size === contacts.length;
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(contacts.map((c) => c.id)));
  }
  function toggle(id: string) {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  }

  async function removeSelected() {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} contact(s)?`)) return;
    await api.deleteContacts([...selected]);
    setSelected(new Set());
    toast("Deleted", "success");
    load();
  }

  async function exportCsv() {
    try {
      const csv = await api.exportContacts({ status: filter, q: search, category: categoryFilter });
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
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full px-3 py-1 text-[13px] font-medium capitalize transition-colors",
                filter === f ? "bg-ink text-cream" : "text-ink/55 hover:text-ink"
              )}
            >
              {f}
            </button>
          ))}
        </div>
        {categories.length > 0 && (
          <Select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="h-9 w-44"
          >
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="__none__">Uncategorized</option>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <>
              {categories.length > 0 && (
                <BulkCategory
                  categories={categories}
                  onApply={async (cat) => {
                    await api.bulkContacts(
                      contacts.filter((c) => selected.has(c.id)).map((c) => ({ email: c.email, category: cat })),
                      true
                    );
                    toast(`Set category on ${selected.size} contact(s)`, "success");
                    setSelected(new Set());
                    load();
                  }}
                />
              )}
              {/* bulk-set assigns a category; clearing is done via Edit */}
              <Button variant="danger" size="sm" onClick={removeSelected}>
                Delete {selected.size}
              </Button>
            </>
          )}
          <Input
            placeholder="Search email or company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-64"
          />
        </div>
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted">
            <Spinner /> Loading…
          </div>
        ) : contacts.length === 0 ? (
          <Empty onFind={() => setCrawlOpen(true)} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left mono-label text-muted">
                  <th className="w-10 px-4 py-3">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-ink" />
                  </th>
                  <th className="px-2 py-3">Email</th>
                  <th className="px-2 py-3">Company</th>
                  <th className="px-2 py-3">Country</th>
                  <th className="px-2 py-3">Category</th>
                  <th className="px-2 py-3">Type</th>
                  <th className="px-2 py-3">Status</th>
                  <th className="w-12 px-2 py-3" />
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="group border-b border-line-soft last:border-0 hover:bg-ink/[0.015]">
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                        className="accent-ink"
                      />
                    </td>
                    <td className="px-2 py-2.5 font-medium">{c.email}</td>
                    <td className="px-2 py-2.5 text-ink/70">{c.company || "—"}</td>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AddModal open={addOpen} onClose={() => setAddOpen(false)} onDone={load} categories={categories} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={load} />
      <Crawler open={crawlOpen} onClose={() => setCrawlOpen(false)} onAdded={load} />
      {editing && (
        <EditModal
          key={editing.id}
          contact={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); load(); }}
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
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-clash text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
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
  const [f, setF] = useState({ email: "", company: "", country: "", industry: "", category: "" });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.email.includes("@")) return toast("Enter a valid email", "error");
    setBusy(true);
    try {
      await api.addContact(f);
      toast("Contact added", "success");
      setF({ email: "", company: "", country: "", industry: "", category: "" });
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
        <Field label="Email">
          <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@company.com" />
        </Field>
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
            <div className="text-xs text-muted">Columns: email, company, country, industry, category</div>
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
              placeholder={"email,company,country,industry,category\ninfo@acme.com,Acme Trading,Qatar,Trading,Customer"}
              className="mt-2 font-mono text-xs"
            />
          </details>
        </div>

        {/* Step 3 — preview */}
        {parsed.length > 0 && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="mono-label rounded-md bg-ink px-1.5 py-0.5 text-cream">03</span>
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
                    <th className="px-2 py-2">Country</th>
                    <th className="px-2 py-2">Industry</th>
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
                        <td className="px-2 py-1.5 text-ink/70">{r.country || "—"}</td>
                        <td className="px-2 py-1.5 text-ink/70">{r.industry || "—"}</td>
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
        <Field label="Email">
          <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
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
