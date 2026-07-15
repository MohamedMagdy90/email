import { useEffect, useMemo, useState } from "react";
import { api, type Contact } from "../lib/api";
import { Button, Card, Field, Input, Modal, Select, Spinner, StatusPill, Textarea, toast, cn } from "../lib/ui";
import { downloadCsv } from "../lib/csv";
import Crawler from "./Crawler";

const FILTERS = ["all", "new", "sent", "unsubscribed", "bounced"];

export default function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [crawlOpen, setCrawlOpen] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.getContacts({ status: filter, q: search, limit: 1000 });
      setContacts(r.contacts);
      setTotal(r.total);
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
  }, [filter, search]);

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
      const csv = await api.exportContacts({ status: filter, q: search });
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
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <Button variant="danger" size="sm" onClick={removeSelected}>
              Delete {selected.size}
            </Button>
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
                  <th className="px-2 py-3">Type</th>
                  <th className="px-2 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-b border-line-soft last:border-0 hover:bg-ink/[0.015]">
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
                      <span className="text-xs text-muted">{c.role_based ? "role" : "personal"}</span>
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusPill status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AddModal open={addOpen} onClose={() => setAddOpen(false)} onDone={load} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={load} />
      <Crawler open={crawlOpen} onClose={() => setCrawlOpen(false)} onAdded={load} />
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

function AddModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ email: "", company: "", country: "", industry: "" });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!f.email.includes("@")) return toast("Enter a valid email", "error");
    setBusy(true);
    try {
      await api.addContact(f);
      toast("Contact added", "success");
      setF({ email: "", company: "", country: "", industry: "" });
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
        <Field label="Industry">
          <Input value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} />
        </Field>
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
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!csv.trim()) return;
    setBusy(true);
    try {
      const r = await api.importCsv(csv);
      toast(`Imported ${r.added} · skipped ${r.skipped}`, "success");
      setCsv("");
      onDone();
      onClose();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Import CSV" wide>
      <div className="space-y-4">
        <Field
          label="Paste CSV"
          hint="First row can be a header. Recognized columns: email, company, country, industry."
        >
          <Textarea
            rows={9}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"email,company,country,industry\ninfo@acme.com,Acme Trading,Qatar,Trading"}
            className="font-mono text-xs"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={submit}>Import</Button>
        </div>
      </div>
    </Modal>
  );
}
