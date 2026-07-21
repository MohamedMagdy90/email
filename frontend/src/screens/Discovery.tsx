import { useEffect, useRef, useState } from "react";
import {
  api,
  type DiscoveryStatus,
  type DiscoverySource,
  type DiscoveredLead,
  type Place,
} from "../lib/api";
import { Button, Card, Field, Input, Modal, Select, Spinner, toast, cn } from "../lib/ui";
import { LocationAutocomplete } from "./Crawler";

const FALLBACK_CATS = [
  "Companies (general)", "Accounting & Tax", "IT & Software", "Construction & Contracting",
  "Consulting", "Engineering", "Real Estate", "Legal", "Logistics & Transport",
  "Advertising & Marketing", "Insurance", "Healthcare & Clinics", "Hospitality & Food",
  "Manufacturing & Industrial", "Education & Training", "Trading & Retail",
];

const INTERVALS: { v: number; label: string }[] = [
  { v: 60, label: "Every hour" },
  { v: 180, label: "Every 3 hours" },
  { v: 360, label: "Every 6 hours" },
  { v: 720, label: "Every 12 hours" },
  { v: 1440, label: "Once a day" },
  { v: 4320, label: "Every 3 days" },
  { v: 10080, label: "Weekly" },
];

type LeadTab = "pending" | "approved" | "rejected";

export default function Discovery() {
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [cats, setCats] = useState<string[]>(FALLBACK_CATS);
  const [contactCats, setContactCats] = useState<string[]>([]);

  // leads pool
  const [tab, setTab] = useState<LeadTab>("pending");
  const [onlyEmail, setOnlyEmail] = useState(true);
  const [search, setSearch] = useState("");
  const [leads, setLeads] = useState<DiscoveredLead[]>([]);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [approvableTotal, setApprovableTotal] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saveCategory, setSaveCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingLeads, setLoadingLeads] = useState(false);

  // add / edit source
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DiscoverySource | null>(null);

  const pollRef = useRef<number | null>(null);

  /* ------------------------------- load ------------------------------ */
  async function refreshStatus() {
    try { setStatus(await api.getDiscoveryStatus()); } catch { /* ignore */ }
  }
  async function refreshSources() {
    try { setSources((await api.getDiscoverySources()).sources); } catch { /* ignore */ }
  }
  async function refreshLeads() {
    setLoadingLeads(true);
    try {
      const r = await api.getDiscoveryLeads({ status: tab, q: search.trim() || undefined, hasEmail: tab === "pending" && onlyEmail, limit: 200 });
      setLeads(r.leads);
      setFilteredTotal(r.filteredTotal);
      setApprovableTotal(r.approvableTotal);
      setPicked(new Set());
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setLoadingLeads(false);
    }
  }

  useEffect(() => {
    refreshStatus();
    refreshSources();
    api.getLeadCategories().then((r) => r.categories?.length && setCats(r.categories)).catch(() => {});
    api.getCategories().then((r) => setContactCats(r.categories || [])).catch(() => {});
    // Live status + sources while the bot works in the background.
    pollRef.current = window.setInterval(() => { refreshStatus(); refreshSources(); }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Reload the pool whenever the filters change.
  useEffect(() => { refreshLeads(); /* eslint-disable-next-line */ }, [tab, onlyEmail]);

  /* ------------------------------ bot ops ---------------------------- */
  async function toggleBot(on: boolean) {
    try {
      setStatus(await api.toggleDiscovery({ enabled: on }));
      toast(on ? "Discovery bot is now running" : "Discovery bot paused", on ? "success" : "info");
    } catch (e: any) { toast(e.message, "error"); }
  }
  async function toggleAutoEnrich(on: boolean) {
    try { setStatus(await api.toggleDiscovery({ autoEnrich: on })); } catch (e: any) { toast(e.message, "error"); }
  }

  /* ---------------------------- source ops --------------------------- */
  async function toggleSource(s: DiscoverySource) {
    try {
      await api.updateDiscoverySource(s.id, { enabled: !s.enabled });
      refreshSources(); refreshStatus();
    } catch (e: any) { toast(e.message, "error"); }
  }
  async function runSource(s: DiscoverySource) {
    setSources((prev) => prev.map((x) => (x.id === s.id ? { ...x, last_status: "running" } : x)));
    try {
      await api.runDiscoverySource(s.id);
      toast(s.type === "directory" ? "Streaming from the directory — new companies will appear below" : "Scanning — results will appear below", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      // The run is now in the background; live polling + a nudge refresh show results.
      setTimeout(() => { refreshSources(); refreshStatus(); if (tab === "pending") refreshLeads(); }, 2000);
    }
  }
  async function removeSource(s: DiscoverySource) {
    if (!confirm(`Remove the "${s.location} · ${s.category}" source? Leads it already found stay in your review pool.`)) return;
    try { await api.deleteDiscoverySource(s.id); refreshSources(); refreshStatus(); }
    catch (e: any) { toast(e.message, "error"); }
  }

  /* ----------------------------- lead ops ---------------------------- */
  function toggle(id: string) {
    const n = new Set(picked);
    n.has(id) ? n.delete(id) : n.add(id);
    setPicked(n);
  }
  const allSelected = leads.length > 0 && leads.every((l) => picked.has(l.id));
  function toggleAll() { setPicked(allSelected ? new Set() : new Set(leads.map((l) => l.id))); }

  async function approve(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await api.approveDiscoveryLeads({ ids, category: saveCategory || undefined });
      toast(`Approved ${r.added} → Contacts${r.skipped ? ` · ${r.skipped} skipped` : ""}`, "success");
      refreshLeads(); refreshStatus();
    } catch (e: any) { toast(e.message, "error"); } finally { setBusy(false); }
  }
  // Approve every pending lead with an email that matches the current search —
  // not just the loaded page. Drains a large pool in one action.
  async function approveAll() {
    if (!approvableTotal) return;
    if (!confirm(`Approve all ${approvableTotal.toLocaleString()} matching lead${approvableTotal === 1 ? "" : "s"} into Contacts?${saveCategory ? `\nThey'll be saved under "${saveCategory}".` : ""}`)) return;
    setBusy(true);
    try {
      const r = await api.approveDiscoveryLeads({ all: true, q: search.trim() || undefined, category: saveCategory || undefined });
      toast(`Approved ${r.added.toLocaleString()} → Contacts${r.skipped ? ` · ${r.skipped} skipped` : ""}`, "success");
      refreshLeads(); refreshStatus();
    } catch (e: any) { toast(e.message, "error"); } finally { setBusy(false); }
  }
  async function reject(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    try { await api.rejectDiscoveryLeads({ ids }); refreshLeads(); refreshStatus(); }
    catch (e: any) { toast(e.message, "error"); } finally { setBusy(false); }
  }
  async function remove(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    try { await api.deleteDiscoveryLeads({ ids }); refreshLeads(); refreshStatus(); }
    catch (e: any) { toast(e.message, "error"); } finally { setBusy(false); }
  }

  const pickedWithEmail = leads.filter((l) => picked.has(l.id) && l.email);
  const running = !!status?.enabled;
  const counts = { pending: status?.leads.pending ?? 0, approved: status?.leads.approved ?? 0, rejected: status?.leads.rejected ?? 0 };

  return (
    <div className="space-y-8">
      {/* Header + master switch */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mono-label text-muted">02 · Discovery</div>
          <h1 className="mt-1 font-clash text-3xl font-semibold tracking-tight">Auto-discovery</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            A background bot that keeps finding companies for you — running on the server, even when this tab is closed.
            It drops everything into a review pool below; you approve the good ones into Contacts.
          </p>
        </div>

        <BotSwitch running={running} nextRunAt={status?.nextRunAt ?? null} activeSources={status?.activeSources ?? 0} onToggle={toggleBot} />
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pending review" value={counts.pending} accent />
        <Stat label="Ready (with email)" value={status?.leads.withEmail ?? 0} />
        <Stat label="Approved → Contacts" value={counts.approved} />
        <Stat label="Finding emails" value={status?.pendingEnrich ?? 0} hint={status?.autoEnrich ? "queued" : "off"} />
      </div>

      {/* Paused-with-sources nudge — the #1 reason "scanning stops": the bot is off. */}
      {!running && (status?.activeSources ?? 0) > 0 && (
        <div className="flex flex-col gap-3 rounded-2xl border border-[#e0b354]/50 bg-[#fdf6e7] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#e0b354]/25 font-clash text-[#b06b16]">!</span>
            <div>
              <div className="text-sm font-semibold text-ink">The bot is paused — your sources aren’t scanning</div>
              <div className="text-xs leading-relaxed text-muted">
                You have {status?.activeSources} enabled source{(status?.activeSources ?? 0) === 1 ? "" : "s"}. Turn the bot on and it scans
                continuously in the background — paging through directories back-to-back — even with this tab closed.
              </div>
            </div>
          </div>
          <Button size="sm" onClick={() => toggleBot(true)} className="shrink-0">Turn bot on</Button>
        </div>
      )}

      {/* Sources */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-clash text-lg font-semibold">Discovery sources</h2>
            <p className="text-xs text-muted">Area (map) sources for precision · Directory sources to pull in thousands.</p>
          </div>
          <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true); }}>Add source</Button>
        </div>

        {sources.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-sm font-medium">No sources yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted">
              Add an <span className="font-medium text-ink/70">Area</span> source (e.g. Qatar · IT &amp; Software) for precise map results, or a <span className="font-medium text-ink/70">Directory</span> source (paste a business-directory URL) to stream in tens of thousands of companies around the clock.
            </p>
            <Button size="sm" variant="outline" className="mt-4" onClick={() => { setEditing(null); setModalOpen(true); }}>Add your first source</Button>
          </div>
        ) : (
          <div className="divide-y divide-line-soft">
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                s={s}
                onToggle={() => toggleSource(s)}
                onRun={() => runSource(s)}
                onEdit={() => { setEditing(s); setModalOpen(true); }}
                onDelete={() => removeSource(s)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Review pool */}
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-line px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex rounded-full border border-line bg-cream p-1">
              {(["pending", "approved", "rejected"] as LeadTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn("rounded-full px-3.5 py-1.5 text-[13px] font-medium capitalize transition-colors", tab === t ? "bg-ink text-cream" : "text-ink/55 hover:text-ink")}
                >
                  {t} {t === "pending" && counts.pending ? `· ${counts.pending}` : ""}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && refreshLeads()} placeholder="Search name, email, domain…" className="h-9 w-56 text-[13px]" />
              <Button size="sm" variant="outline" onClick={refreshLeads}>Search</Button>
            </div>
          </div>

          {/* action bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[13px] font-medium">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-ink" disabled={!leads.length} />
              {picked.size ? `${picked.size} selected` : `${filteredTotal.toLocaleString()} in view`}
              {tab === "pending" && (
                <button type="button" onClick={() => setOnlyEmail((v) => !v)} className={cn("ml-2 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors", onlyEmail ? "border-ink bg-ink text-cream" : "border-line text-ink/55 hover:text-ink")}>
                  {onlyEmail ? "With email only" : "Show all"}
                </button>
              )}
            </label>

            <div className="flex items-center gap-2">
              {tab === "pending" && contactCats.length > 0 && (
                <Select value={saveCategory} onChange={(e) => setSaveCategory(e.target.value)} className="h-8 w-40 text-[13px]" title="Save approved under category">
                  <option value="">No category</option>
                  {contactCats.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              )}
              {tab === "pending" ? (
                <>
                  {picked.size > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => reject([...picked])} disabled={busy}>Reject {picked.size}</Button>
                  )}
                  {pickedWithEmail.length > 0 && (
                    <Button size="sm" variant="outline" onClick={() => approve(pickedWithEmail.map((l) => l.id))} disabled={busy}>
                      Approve {pickedWithEmail.length} selected
                    </Button>
                  )}
                  <Button size="sm" onClick={approveAll} loading={busy} disabled={!approvableTotal}>
                    Approve all {approvableTotal ? approvableTotal.toLocaleString() : ""} → Contacts
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => remove([...picked])} disabled={!picked.size || busy}>Delete</Button>
              )}
            </div>
          </div>
        </div>

        {/* table */}
        <div className="max-h-[520px] overflow-y-auto">
          {loadingLeads ? (
            <div className="grid place-items-center py-16"><Spinner className="h-5 w-5 text-ink/40" /></div>
          ) : leads.length === 0 ? (
            <div className="px-5 py-16 text-center text-sm text-muted">
              {tab === "pending"
                ? running ? "Nothing pending yet — the bot will fill this as it scans." : "No pending leads. Turn the bot on and add a source to start."
                : `No ${tab} leads.`}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-paper text-left text-[11px] uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="w-8 px-5 py-2.5" />
                  <th className="px-1 py-2.5 font-medium">Company</th>
                  <th className="px-1 py-2.5 font-medium">Phone</th>
                  <th className="px-1 py-2.5 font-medium">Source</th>
                  <th className="px-5 py-2.5 text-right font-medium">{tab === "pending" ? "" : "Status"}</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} className="border-b border-line-soft last:border-0 hover:bg-ink/[0.02]">
                    <td className="px-5 py-2.5">
                      <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} className="accent-ink" />
                    </td>
                    <td className="px-1 py-2.5">
                      <div className="font-medium leading-tight">{l.name || l.domain}</div>
                      <div className="flex items-center gap-1.5 text-xs text-muted">
                        <span className="truncate">{l.email || (l.enriched ? <span className="italic">no email found</span> : <span className="inline-flex items-center gap-1 text-ink/50"><Spinner className="h-2.5 w-2.5" /> finding email…</span>)}</span>
                        <ConfidenceTag c={l.confidence} />
                      </div>
                    </td>
                    <td className="px-1 py-2.5 text-xs tabular-nums text-ink/70">{l.phone || <span className="text-muted">—</span>}</td>
                    <td className="px-1 py-2.5 text-xs text-ink/55">{l.source_label}</td>
                    <td className="px-5 py-2.5 text-right">
                      {tab === "pending" ? (
                        l.website && <a href={l.website} target="_blank" rel="noreferrer" className="text-xs font-medium text-ink/50 underline hover:text-ink">visit</a>
                      ) : (
                        <StatusChip status={l.status} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      {/* auto-enrich footnote toggle */}
      <div className="flex items-center justify-between rounded-2xl border border-line bg-paper px-5 py-4">
        <div>
          <div className="text-sm font-medium">Auto-find emails</div>
          <div className="text-xs text-muted">When a company lists only a website, the bot quietly crawls it for a real email so leads arrive ready to approve.</div>
        </div>
        <Switch checked={!!status?.autoEnrich} onChange={toggleAutoEnrich} />
      </div>

      <SourceModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        cats={cats}
        editing={editing}
        onSaved={() => { setModalOpen(false); refreshSources(); refreshStatus(); }}
      />
    </div>
  );
}

/* ------------------------------ Bot switch ----------------------------- */

function BotSwitch({ running, nextRunAt, activeSources, onToggle }: { running: boolean; nextRunAt: string | null; activeSources: number; onToggle: (on: boolean) => void }) {
  return (
    <div className={cn("w-full shrink-0 rounded-2xl border p-4 sm:w-[300px]", running ? "border-good/40 bg-good/[0.06]" : "border-line bg-paper")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={cn("relative grid h-9 w-9 place-items-center rounded-xl", running ? "bg-good/15" : "bg-ink/[0.06]")}>
            <span className={cn("h-2.5 w-2.5 rounded-full", running ? "bg-good" : "bg-ink/30")} />
            {running && <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-good/60" />}
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">{running ? "Bot running" : "Bot paused"}</div>
            <div className="text-[11px] text-muted">
              {running
                ? activeSources ? `Next scan ${nextRunAt ? fmtIn(nextRunAt) : "soon"}` : "Add a source to begin"
                : "Turn on to start discovering"}
            </div>
          </div>
        </div>
        <Switch checked={running} onChange={onToggle} />
      </div>
    </div>
  );
}

/* ------------------------------ Source row ----------------------------- */

function SourceRow({ s, onToggle, onRun, onEdit, onDelete }: { s: DiscoverySource; onToggle: () => void; onRun: () => void; onEdit: () => void; onDelete: () => void }) {
  const runningNow = s.last_status === "running";
  const isDir = s.type === "directory";
  const streaming = isDir && s.enabled && runningNow;
  // Show host + path so a resolved index (e.g. …/listings) is visible.
  const host = (() => {
    try {
      const u = new URL(s.base_url || "");
      const p = u.pathname.replace(/\/+$/, "");
      return u.hostname.replace(/^www\./, "") + (p && p !== "/" ? p : "");
    } catch { return s.base_url || ""; }
  })();

  return (
    <div className={cn("flex items-center gap-4 px-5 py-3.5", !s.enabled && "opacity-55")}>
      <Switch small checked={!!s.enabled} onChange={onToggle} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isDir && <span className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/55">Directory</span>}
          <span className="truncate font-medium">{isDir ? host : s.location}</span>
          {(!isDir || (s.category && s.category !== "Companies (general)")) && (
            <>
              <span className="text-ink/30">·</span>
              <span className="truncate text-sm text-ink/70">{s.category}</span>
            </>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
          {isDir ? (
            <>
              {streaming
                ? <span className="inline-flex items-center gap-1 font-medium text-good"><Spinner className="h-2.5 w-2.5" /> streaming · page {s.cursor}</span>
                : s.exhausted
                  ? <span>finished at page {s.cursor}</span>
                  : <span>{s.enabled ? "queued" : "paused"} · resumes page {s.cursor}</span>}
              <span>· {s.total_found} found</span>
              {s.location && <span>· {s.location}</span>}
            </>
          ) : (
            <>
              <span>{intervalLabel(s.interval_minutes)}</span>
              <span>· up to {s.limit_n}</span>
              <span>· {s.total_found} found</span>
              {s.enabled && s.next_run_at && <span>· next {fmtIn(s.next_run_at)}</span>}
            </>
          )}
          {s.last_status === "error" && <span className="text-bad">· blocked / error</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={onRun} disabled={runningNow} className="rounded-full px-3 py-1.5 text-xs font-medium text-ink/70 transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50">
          {runningNow ? <span className="inline-flex items-center gap-1.5"><Spinner className="h-3 w-3" /> running</span> : isDir && s.exhausted ? "Restart" : "Run now"}
        </button>
        <button onClick={onEdit} className="grid h-8 w-8 place-items-center rounded-full text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink" title="Edit">✎</button>
        <button onClick={onDelete} className="grid h-8 w-8 place-items-center rounded-full text-ink/45 transition-colors hover:bg-bad/10 hover:text-bad" title="Remove">✕</button>
      </div>
    </div>
  );
}

/* --------------------------- Add / edit modal -------------------------- */

function SourceModal({ open, onClose, cats, editing, onSaved }: { open: boolean; onClose: () => void; cats: string[]; editing: DiscoverySource | null; onSaved: () => void }) {
  const [type, setType] = useState<"osm" | "directory">("osm");
  const [location, setLocation] = useState("");
  const [place, setPlace] = useState<Place | null>(null);
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState(cats[0] || "Companies (general)");
  const [limit, setLimit] = useState(40);
  const [interval, setInterval] = useState(360);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setType(editing.type === "directory" ? "directory" : "osm");
      setLocation(editing.location || "");
      setUrl(editing.base_url || "");
      setPlace(null);
      setCategory(editing.category);
      setLimit(editing.limit_n);
      setInterval(editing.interval_minutes);
    } else {
      setType("osm"); setLocation(""); setUrl(""); setPlace(null);
      setCategory(cats[0] || "Companies (general)"); setLimit(40); setInterval(360);
    }
  }, [open, editing, cats]);

  // Directory sources default to a bigger batch size.
  useEffect(() => { if (!editing) setLimit(type === "directory" ? 100 : 40); }, [type, editing]);

  async function save() {
    if (type === "osm" && !location.trim()) return toast("Choose a country or city", "error");
    if (type === "directory" && !url.trim()) return toast("Paste a directory URL", "error");
    setSaving(true);
    try {
      const body = type === "directory"
        ? { type: "directory" as const, url: url.trim(), location: location.trim(), category, limit, intervalMinutes: interval }
        : { type: "osm" as const, location: location.trim(), category, limit, intervalMinutes: interval, place };
      if (editing) {
        await api.updateDiscoverySource(editing.id, body);
        toast("Source updated", "success");
      } else {
        await api.addDiscoverySource(body);
        toast(type === "directory" ? "Directory added — it'll start streaming companies in" : "Source added — the bot will scan it shortly", "success");
      }
      onSaved();
    } catch (e: any) { toast(e.message, "error"); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit source" : "Add discovery source"}>
      <div className="space-y-4">
        {/* type switch */}
        <div className="flex rounded-full border border-line bg-cream p-1">
          {([["osm", "Area (map)"], ["directory", "Directory (bulk)"]] as const).map(([t, label]) => (
            <button
              key={t}
              type="button"
              disabled={!!editing && editing.type !== t}
              onClick={() => setType(t)}
              className={cn("flex-1 rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-30",
                type === t ? "bg-ink text-cream" : "text-ink/55 hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>

        {type === "osm" ? (
          <>
            <Field label="Country or city" hint="Where to look. Pick from the list for the most accurate area.">
              <LocationAutocomplete value={location} onChange={setLocation} onPick={setPlace} placeholder="Start typing… e.g. Qatar" />
            </Field>
            <Field label="Industry">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {cats.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Re-scan">
                <Select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
                  {INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}
                </Select>
              </Field>
              <Field label="Max per scan">
                <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                  {[20, 40, 60, 100, 120].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </Field>
            </div>
            <p className="rounded-xl bg-ink/[0.03] px-3 py-2.5 text-xs leading-relaxed text-muted">
              Map data (OpenStreetMap) is precise but limited — good for a few hundred well-tagged businesses. For <span className="font-medium text-ink/70">thousands</span> of companies, use a <span className="font-medium text-ink/70">Directory</span> source.
            </p>
          </>
        ) : (
          <>
            <Field label="Directory URL" hint="Paste the directory's listings page — or just its homepage. If you paste a homepage, the bot automatically finds the listings section, then walks every page pulling company + email + phone.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.example-directory.com  (homepage or /listings both work)" className="font-mono text-xs" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country" hint="Helps read local phone numbers">
                <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Qatar" />
              </Field>
              <Field label="Label (optional)">
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Leads per batch">
                <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                  {[50, 100, 200, 300].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </Field>
              <Field label="Re-check when finished">
                <Select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
                  {INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}
                </Select>
              </Field>
            </div>
            <p className="rounded-xl bg-ink/[0.03] px-3 py-2.5 text-xs leading-relaxed text-muted">
              The bot pages through the whole directory back-to-back until it runs out — this is how you reach tens of thousands. Not sure of the exact listings URL? Paste the homepage; it auto-detects the listings section. If a directory blocks crawlers, add a scraping proxy in Settings (the free reader is tried automatically).
            </p>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={saving}>{editing ? "Save changes" : "Add source"}</Button>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------- bits --------------------------------- */

function Stat({ label, value, accent, hint }: { label: string; value: number; accent?: boolean; hint?: string }) {
  return (
    <div className={cn("rounded-2xl border p-4", accent ? "border-ink bg-ink text-cream" : "border-line bg-paper")}>
      <div className={cn("mono-label", accent ? "text-cream/50" : "text-muted")}>{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-clash text-2xl font-semibold tabular-nums">{value.toLocaleString()}</span>
        {hint && <span className={cn("text-[11px]", accent ? "text-cream/50" : "text-muted")}>{hint}</span>}
      </div>
    </div>
  );
}

function Switch({ checked, onChange, small }: { checked: boolean; onChange: (v: boolean) => void; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn("relative shrink-0 rounded-full transition-colors", small ? "h-5 w-9" : "h-6 w-11", checked ? "bg-good" : "bg-ink/15")}
      aria-pressed={checked}
    >
      <span className={cn("absolute top-0.5 rounded-full bg-white shadow transition-all", small ? "h-4 w-4" : "h-5 w-5", checked ? (small ? "left-[18px]" : "left-[22px]") : "left-0.5")} />
    </button>
  );
}

function ConfidenceTag({ c }: { c?: string | null }) {
  if (!c) return null;
  const map: Record<string, string> = {
    verified: "bg-[#e7f6ec] text-[#1f8b4c]",
    listed: "bg-[#e7f6ec] text-[#1f8b4c]",
    likely: "bg-[#eaf3ff] text-[#2563a8]",
    guess: "bg-ink/[0.06] text-ink/50",
  };
  return <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium", map[c] || "bg-ink/[0.06] text-ink/50")}>{c}</span>;
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    approved: "bg-[#e7f6ec] text-[#1f8b4c]",
    rejected: "bg-ink/[0.06] text-ink/45",
    pending: "bg-[#fef3e2] text-[#b06b16]",
  };
  return <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium capitalize", map[status] || "bg-ink/[0.06] text-ink/60")}>{status}</span>;
}

/* ------------------------------ helpers -------------------------------- */

function intervalLabel(min: number): string {
  return INTERVALS.find((i) => i.v === min)?.label || `Every ${min}m`;
}

// "in 3h", "in 12m", "now" — relative future formatting.
function fmtIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}
