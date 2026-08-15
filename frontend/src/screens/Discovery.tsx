import { useEffect, useRef, useState } from "react";
import {
  api,
  type DiscoveryStatus,
  type DiscoverySource,
  type DiscoveredLead,
  type AutomationStatus,
  type Place,
} from "../lib/api";
import { Button, Card, Field, Input, Modal, Select, Spinner, toast, cn, goTo } from "../lib/ui";
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

// The server's bucket for leads with no country on file — kept reviewable
// rather than hidden, so nothing silently falls out of the pool.
const NO_COUNTRY = "__none__";
const countryLabel = (c: string) => (c === NO_COUNTRY ? "No country" : c);

// Whether the sources list is expanded. Persisted, because once your sources
// are set up you come to this screen to work the review pool, not to edit them —
// and wrapped in try/catch because storage can be unavailable inside an iframe.
const SOURCES_OPEN_KEY = "dna-discovery-sources-open";
function readSourcesOpen(): boolean {
  try { return localStorage.getItem(SOURCES_OPEN_KEY) !== "0"; } catch { return true; }
}
function writeSourcesOpen(open: boolean) {
  try { localStorage.setItem(SOURCES_OPEN_KEY, open ? "1" : "0"); } catch { /* ignore */ }
}

export default function Discovery() {
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [archived, setArchived] = useState<DiscoverySource[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
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
  const [saveCountry, setSaveCountry] = useState("");
  // Country FILTER for the pool. Applied server-side so every bulk action acts
  // on exactly the rows on screen — "Approve all" included.
  const [country, setCountry] = useState("");
  const [countries, setCountries] = useState<{ country: string; n: number }[]>([]);
  const [breakdown, setBreakdown] = useState<{ withEmail: number; crawling: number; queued: number; noEmail: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [reEnriching, setReEnriching] = useState(false);
  const [badNames, setBadNames] = useState<{ leads: number; contacts: number } | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairLog, setRepairLog] = useState("");

  // add / edit source
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DiscoverySource | null>(null);
  // Sources list open/closed — remembered across visits.
  const [showSources, setSourcesOpen] = useState(readSourcesOpen);

  const pollRef = useRef<number | null>(null);

  /* ------------------------------- load ------------------------------ */
  async function refreshStatus() {
    try { setStatus(await api.getDiscoveryStatus()); } catch { /* ignore */ }
  }
  async function refreshAutomation() {
    try { setAutomation(await api.getAutomation()); } catch { /* ignore */ }
  }
  async function refreshSources() {
    try {
      const r = await api.getDiscoverySources();
      setSources(r.sources);
      setArchivedCount(r.archivedCount ?? 0);
    } catch { /* ignore */ }
  }
  async function refreshArchived() {
    try {
      const r = await api.getDiscoverySources(true);
      setArchived(r.sources);
      setArchivedCount(r.archivedCount ?? r.sources.length);
    } catch { /* ignore */ }
  }
  async function refreshBadNames() {
    try { setBadNames(await api.getBadNameCount()); } catch { /* ignore */ }
  }
  async function refreshLeads() {
    setLoadingLeads(true);
    try {
      const r = await api.getDiscoveryLeads({ status: tab, q: search.trim() || undefined, hasEmail: tab === "pending" && onlyEmail, limit: 200, country: country || undefined });
      setLeads(r.leads);
      setFilteredTotal(r.filteredTotal);
      setApprovableTotal(r.approvableTotal);
      setCountries(r.countries || []);
      setBreakdown(r.breakdown || null);
      setPicked(new Set());
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setLoadingLeads(false);
    }
  }

  // Re-read the directory sources and write the real company names back over the
  // phone numbers an older version of the harvester stored.
  async function repairNames() {
    setRepairing(true);
    setRepairLog("Checking every saved company name…");
    try {
      const { jobId } = await api.repairNames();
      // Poll until the job finishes — a full re-walk of a big directory is slow.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const job = await api.getCrawl(jobId);
        const last = job.logs?.[job.logs.length - 1];
        if (last?.msg) setRepairLog(String(last.msg));
        if (job.status === "done") {
          const r: any = job.result || {};
          toast(
            r.fixedLeads || r.fixedContacts
              ? `Fixed ${((r.fixedLeads || 0) + (r.fixedContacts || 0)).toLocaleString()} company name${(r.fixedLeads || 0) + (r.fixedContacts || 0) === 1 ? "" : "s"}`
              : "Nothing needed fixing",
            "success"
          );
          break;
        }
        if (job.status === "error") { toast(job.error || "Repair failed", "error"); break; }
      }
      refreshBadNames();
      refreshLeads();
    } catch (e: any) { toast(e.message, "error"); }
    finally { setRepairing(false); setRepairLog(""); }
  }

  useEffect(() => {
    refreshStatus();
    refreshAutomation();
    refreshSources();
    refreshArchived();
    refreshBadNames();
    api.getLeadCategories().then((r) => r.categories?.length && setCats(r.categories)).catch(() => {});
    api.getCategories().then((r) => setContactCats(r.categories || [])).catch(() => {});
    // Live status + sources while the bot works in the background.
    pollRef.current = window.setInterval(() => { refreshStatus(); refreshAutomation(); refreshSources(); refreshBadNames(); }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Reload the pool whenever the filters change.
  useEffect(() => { refreshLeads(); /* eslint-disable-next-line */ }, [tab, onlyEmail, country]);

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
  // Recover the historical "no email" pool: re-queue every lead whose site
  // blocked the crawler (Cloudflare) or hit the free reader's rate limit.
  async function reCheckBlocked() {
    setReEnriching(true);
    try {
      const r = await api.reEnrichDiscovery();
      toast(
        r.reset ? `Re-queued ${r.reset.toLocaleString()} lead${r.reset === 1 ? "" : "s"} — the bot will try to find their emails again` : "No blocked leads to re-check right now",
        r.reset ? "success" : "info"
      );
      refreshStatus();
      if (tab === "pending") refreshLeads();
    } catch (e: any) { toast(e.message, "error"); } finally { setReEnriching(false); }
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
      setTimeout(() => { refreshSources(); refreshStatus(); refreshBadNames(); if (tab === "pending") refreshLeads(); }, 2000);
    }
  }
  async function archiveSource(s: DiscoverySource) {
    try {
      await api.archiveDiscoverySource(s.id);
      toast(`Archived "${sourceTitle(s)}" — restore it any time`, "success");
      refreshSources(); refreshArchived(); refreshStatus();
    } catch (e: any) { toast(e.message, "error"); }
  }
  async function restoreSource(s: DiscoverySource) {
    try {
      await api.unarchiveDiscoverySource(s.id);
      toast(`Restored "${sourceTitle(s)}" — it picks up where it left off`, "success");
      refreshSources(); refreshArchived(); refreshStatus();
    } catch (e: any) { toast(e.message, "error"); }
  }
  async function removeSource(s: DiscoverySource) {
    const wasRunning = s.last_status === "running";
    const note = wasRunning ? "\n\nIt's scanning right now — that stops immediately." : "";
    if (!confirm(`Permanently delete the "${sourceTitle(s)}" source?${note}\n\nLeads it already found stay in your review pool, but its settings and walk position are gone for good. Archive it instead if you might want it back.`)) return;
    try {
      await api.deleteDiscoverySource(s.id);
      toast(wasRunning ? `Deleted "${sourceTitle(s)}" — its running scan was stopped` : `Deleted "${sourceTitle(s)}"`, "success");
      refreshSources(); refreshArchived(); refreshStatus();
    } catch (e: any) { toast(e.message, "error"); }
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
      const r = await api.approveDiscoveryLeads({ ids, category: saveCategory || undefined, country: saveCountry.trim() || undefined });
      toast(`Approved ${r.added} → Contacts${r.skipped ? ` · ${r.skipped} skipped` : ""}`, "success");
      refreshLeads(); refreshStatus();
    } catch (e: any) { toast(e.message, "error"); } finally { setBusy(false); }
  }
  // Approve every pending lead with an email that matches the CURRENT view —
  // search *and* country filter — not just the loaded page. Drains a large pool
  // one country at a time, in one action.
  async function approveAll() {
    if (!approvableTotal) return;
    const scope = country ? ` in ${countryLabel(country)}` : "";
    const tags = [saveCategory && `category "${saveCategory}"`, saveCountry.trim() && `country "${saveCountry.trim()}"`].filter(Boolean);
    const suffix = tags.length ? `\nThey'll be saved under ${tags.join(" and ")}.` : "";
    if (!confirm(`Approve all ${approvableTotal.toLocaleString()} lead${approvableTotal === 1 ? "" : "s"}${scope} into Contacts?${suffix}`)) return;
    setBusy(true);
    try {
      const r = await api.approveDiscoveryLeads({ all: true, q: search.trim() || undefined, category: saveCategory || undefined, country: saveCountry.trim() || undefined, filterCountry: country || undefined });
      toast(`Approved ${r.added.toLocaleString()}${scope} → Contacts${r.skipped ? ` · ${r.skipped} skipped` : ""}`, "success");
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
  // Real countries in the pool (the "no country" bucket is a filter option, not
  // something you'd ever want to SAVE a contact under).
  const poolCountries = countries.map((c) => c.country).filter((c) => c && c !== NO_COUNTRY);
  const running = !!status?.enabled;
  const counts = { pending: status?.leads.pending ?? 0, approved: status?.leads.approved ?? 0, rejected: status?.leads.rejected ?? 0 };

  function toggleSourcesOpen() {
    setSourcesOpen((v) => { writeSourcesOpen(!v); return !v; });
  }

  // What the collapsed header has to convey on its own: that work is happening,
  // and how much of it. Closing the list must never hide a running scan.
  const scanningNow = sources.filter((s) => s.enabled && s.last_status === "running").length;
  const activeCount = sources.filter((s) => s.enabled).length;
  const foundTotal = sources.reduce((n, s) => n + (s.total_found || 0), 0);
  const sourcesSummary = (() => {
    if (!sources.length) return "None yet — add one to start discovering companies.";
    const parts = [`${activeCount} active`];
    if (sources.length - activeCount > 0) parts.push(`${sources.length - activeCount} paused`);
    if (archivedCount > 0) parts.push(`${archivedCount} archived`);
    if (foundTotal > 0) parts.push(`${foundTotal.toLocaleString()} found`);
    return parts.join(" · ");
  })();

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

        <BotSwitch
          running={running}
          nextRunAt={status?.nextRunAt ?? null}
          activeSources={status?.activeSources ?? 0}
          onToggle={toggleBot}
          readerKeyed={status?.bypass?.readerKeyed}
          proxied={status?.bypass?.proxy}
          keysLive={status?.bypass?.readerKeysLive}
          keysConfigured={status?.bypass?.readerKeysConfigured}
          keyRejected={status?.bypass?.readerKeyRejected}
        />
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pending review" value={counts.pending} accent />
        <Stat label="Ready (with email)" value={status?.leads.withEmail ?? 0} />
        <Stat label="Approved → Contacts" value={counts.approved} />
        <Stat label="Finding emails" value={status?.pendingEnrich ?? 0} hint={status?.autoEnrich ? "queued" : "off"} />
      </div>

      {/* What happens to this pool — automation state + progress to its trigger. */}
      <AutomationStrip a={automation} />

      {/* Bad-name repair */}
      {badNames && (badNames.leads > 0 || badNames.contacts > 0) && (
        <div className="flex flex-col gap-3 rounded-2xl border border-[#9b6bff]/35 bg-[#f6f1ff] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#9b6bff]/15 font-clash text-[#6c43c5]">✎</span>
            <div>
              <div className="text-sm font-semibold text-ink">
                {badNames.leads.toLocaleString()} lead{badNames.leads === 1 ? "" : "s"} and {badNames.contacts.toLocaleString()} contact{badNames.contacts === 1 ? "" : "s"} have broken company names
              </div>
              <div className="text-xs leading-relaxed text-muted">
                An older directory import sometimes saved a phone number where the company name should be. Run the repair to restore the real names.
                {repairLog ? <span className="block mt-1 font-medium text-ink/70">{repairLog}</span> : null}
              </div>
            </div>
          </div>
          <Button size="sm" variant="outline" loading={repairing} onClick={repairNames} className="shrink-0">
            Repair company names
          </Button>
        </div>
      )}

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

      {/* Recovery for the "no email" pool — leads that have a website but no email
          (blocked by Cloudflare, rate-limited, or discovered before retry-tracking
          existed, i.e. the historical ~1,000). "Re-check" re-queues them all so the
          bot crawls their sites again. Shown whenever there's anything to recover
          OR anything still auto-retrying, so the button is never hidden when needed. */}
      {((status?.recoverable ?? 0) > 0 || (status?.blocked ?? 0) > 0) && (
        <div className="flex flex-col gap-3 rounded-2xl border border-[#5a86c2]/40 bg-[#eef4fb] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#5a86c2]/20 font-clash text-[#2f5a94]">↻</span>
            <div>
              <div className="text-sm font-semibold text-ink">
                {(status?.recoverable ?? 0) > 0
                  ? <>{status!.recoverable.toLocaleString()} lead{status!.recoverable === 1 ? "" : "s"} have a website but no email yet</>
                  : <>{status!.blocked.toLocaleString()} lead{status!.blocked === 1 ? "" : "s"} being re-checked for emails…</>}
              </div>
              <div className="text-xs leading-relaxed text-muted">
                Most were skipped because their site blocked the crawler (often a Cloudflare “Just a moment” wall){status!.bypass?.readerRateLimited ? ", and the free reader hit its rate limit" : ""}. Re-check crawls each site again to find the missing email — it runs in the background and can take a while for a big pool.
                {(status?.recoverable ?? 0) > 0 && (status?.blocked ?? 0) > 0 ? ` (${status!.blocked.toLocaleString()} more are already auto-retrying.)` : ""}
                {!status!.bypass?.readerKeyed && !status!.bypass?.proxy && <> To get past Cloudflare at scale, add a free <span className="font-medium text-ink/70">Jina key</span> or a <span className="font-medium text-ink/70">scraping proxy</span> in <span className="font-medium text-ink/70">Settings → Crawler</span> first.</>}
              </div>
            </div>
          </div>
          {(status?.recoverable ?? 0) > 0 && (
            <Button size="sm" variant="outline" loading={reEnriching} onClick={reCheckBlocked} className="shrink-0">
              Re-check {status!.recoverable.toLocaleString()} now
            </Button>
          )}
        </div>
      )}

      {/* Sources — collapsible. Once they're configured this list is reference
          material, while the review pool underneath is the daily work; folding it
          away puts the pool on screen without scrolling past every source. */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          {/* The heading WRAPS the toggle (the accordion pattern) so the whole
              title is clickable without putting block elements inside a button.
              The summary line is what keeps a closed card honest — it still
              reports what's active and what's scanning. */}
          <h2 className="min-w-0 flex-1">
            <button
              type="button"
              onClick={toggleSourcesOpen}
              aria-expanded={showSources}
              className="group flex w-full min-w-0 items-start gap-2.5 text-left"
            >
              <span
                className={cn(
                  "mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-md text-[11px] text-ink/40 transition-all duration-200",
                  "group-hover:bg-ink/[0.07] group-hover:text-ink",
                  showSources && "rotate-180"
                )}
              >
                ▾
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-clash text-lg font-semibold">Discovery sources</span>
                  {sources.length > 0 && (
                    <span className="rounded-full bg-ink/[0.07] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink/55">
                      {sources.length}
                    </span>
                  )}
                  {scanningNow > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-good/15 px-2 py-0.5 text-[11px] font-medium text-good">
                      <Spinner className="h-2.5 w-2.5" />
                      {scanningNow} scanning
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs font-normal text-muted">
                  {showSources
                    ? "Web search finds thousands like Google · Directory streams a listing site · Map area sweeps everything OpenStreetMap has mapped."
                    : sourcesSummary}
                </span>
              </span>
            </button>
          </h2>
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => { setEditing(null); setModalOpen(true); if (!showSources) { setSourcesOpen(true); writeSourcesOpen(true); } }}
          >
            Add source
          </Button>
        </div>

        {/* grid-rows animates to the content's real height, so the list can grow
            (or a source can start streaming) without a hard-coded max-height. */}
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-out",
            showSources ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="overflow-hidden">
            <div className="border-t border-line">
              {sources.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <p className="text-sm font-medium">No sources yet</p>
                  <p className="mx-auto mt-1 max-w-md text-xs text-muted">
                    Add a <span className="font-medium text-ink/70">Web search</span> source (e.g. Saudi Arabia · Construction) — it searches the web like Google across the country and its cities, streaming in hundreds–thousands of companies. Or paste a business <span className="font-medium text-ink/70">Directory</span> URL. (A <span className="font-medium text-ink/70">Map area</span> source sweeps every business OpenStreetMap has mapped there — accurate, but capped at what the map holds.)
                  </p>
                  <Button size="sm" variant="outline" className="mt-4" onClick={() => { setEditing(null); setModalOpen(true); }}>Add your first source</Button>
                </div>
              ) : (
                // Past a handful of sources the list scrolls inside the card, so
                // the review pool stays reachable even with it expanded.
                <div className={cn("divide-y divide-line-soft", sources.length > 6 && "max-h-[26rem] overflow-y-auto")}>
                  {sources.map((s) => (
                    <SourceRow
                      key={s.id}
                      s={s}
                      onToggle={() => toggleSource(s)}
                      onRun={() => runSource(s)}
                      onEdit={() => { setEditing(s); setModalOpen(true); }}
                      onArchive={() => archiveSource(s)}
                      onDelete={() => removeSource(s)}
                    />
                  ))}
                </div>
              )}

              {/* Archived drawer — retired sources, kept intact and restorable. */}
              {archivedCount > 0 && (
                <div className="border-t border-line bg-cream/40">
                  <button
                    type="button"
                    onClick={() => { setShowArchived((v) => !v); if (!showArchived) refreshArchived(); }}
                    className="flex w-full items-center justify-between px-5 py-3 text-left transition-colors hover:bg-ink/[0.03]"
                  >
                    <span className="flex items-center gap-2 text-[13px] font-medium text-ink/70">
                      <span className="grid h-5 w-5 place-items-center rounded-md bg-ink/[0.07] text-[10px] font-semibold tabular-nums text-ink/55">
                        {archivedCount}
                      </span>
                      Archived source{archivedCount === 1 ? "" : "s"}
                    </span>
                    <span className={cn("text-xs text-ink/40 transition-transform", showArchived && "rotate-180")}>▾</span>
                  </button>
                  {showArchived && (
                    archived.length === 0 ? (
                      <div className="px-5 pb-4 text-xs text-muted">Loading…</div>
                    ) : (
                      <div className="divide-y divide-line-soft border-t border-line-soft">
                        {archived.map((s) => (
                          <ArchivedRow key={s.id} s={s} onRestore={() => restoreSource(s)} onDelete={() => removeSource(s)} />
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
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
              {countries.length > 0 && (
                <Select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="h-9 w-44 text-[13px]"
                  title="Show only leads from this country. Every action below — including Approve all — then acts on just these."
                >
                  <option value="">All countries</option>
                  {countries.map((c) => (
                    <option key={c.country} value={c.country}>
                      {countryLabel(c.country)} · {c.n.toLocaleString()}
                    </option>
                  ))}
                </Select>
              )}
              <Input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && refreshLeads()} placeholder="Search name, email, domain…" className="h-9 w-56 text-[13px]" />
              <Button size="sm" variant="outline" onClick={refreshLeads}>Search</Button>
            </div>
          </div>

          {/* Where this view's leads stand on their way to an email. Without it,
              a 1,387-lead pool showing 107 "with email only" reads as "the bot
              only found 107". */}
          {tab === "pending" && breakdown && (breakdown.withEmail + breakdown.crawling + breakdown.queued + breakdown.noEmail) > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              <span className="font-medium text-ink/70">
                {(breakdown.withEmail + breakdown.crawling + breakdown.queued + breakdown.noEmail).toLocaleString()} lead{breakdown.withEmail + breakdown.crawling + breakdown.queued + breakdown.noEmail === 1 ? "" : "s"}
                {country ? ` in ${countryLabel(country)}` : ""}
              </span>
              <span className="inline-flex items-center gap-1.5" title="Have an email address — these are what Approve acts on">
                <span className="h-1.5 w-1.5 rounded-full bg-good" />
                {breakdown.withEmail.toLocaleString()} ready
              </span>
              {breakdown.crawling > 0 && (
                <span className="inline-flex items-center gap-1.5" title="Their website is being crawled for the address">
                  <span className="h-1.5 w-1.5 rounded-full bg-ink/40" />
                  {breakdown.crawling.toLocaleString()} crawling for an email
                </span>
              )}
              {breakdown.queued > 0 && (
                <span className="inline-flex items-center gap-1.5" title="Only a phone number so far. The bot searches the web for the company's website, then crawls that for an email.">
                  <span className="h-1.5 w-1.5 rounded-full bg-ink/20" />
                  {breakdown.queued.toLocaleString()} phone only — looking for a website
                </span>
              )}
              {breakdown.noEmail > 0 && (
                <span className="inline-flex items-center gap-1.5" title="Searched and crawled, but no email address is published anywhere">
                  <span className="h-1.5 w-1.5 rounded-full bg-ink/10" />
                  {breakdown.noEmail.toLocaleString()} no email published
                </span>
              )}
            </div>
          )}

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

            <div className="flex flex-wrap items-center justify-end gap-2">
              {tab === "pending" && (
                <>
                  {contactCats.length > 0 && (
                    <Select value={saveCategory} onChange={(e) => setSaveCategory(e.target.value)} className="h-8 w-36 text-[13px]" title="Save approved contacts under this category">
                      <option value="">No category</option>
                      {contactCats.map((c) => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  )}
                  <Input
                    value={saveCountry}
                    onChange={(e) => setSaveCountry(e.target.value)}
                    placeholder="Override country"
                    list="pool-countries"
                    className="h-8 w-36 text-[13px]"
                    title="Optional. Force every approved contact to this country. Leave blank to keep each lead's own country — which is what you normally want."
                  />
                  {poolCountries.length > 0 && (
                    <datalist id="pool-countries">
                      {poolCountries.map((c) => <option key={c} value={c} />)}
                    </datalist>
                  )}
                </>
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
                    Approve all {approvableTotal ? approvableTotal.toLocaleString() : ""}{country ? ` in ${countryLabel(country)}` : ""} → Contacts
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
                  <th className="px-1 py-2.5 font-medium">Country</th>
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
                        <span className="truncate"><EmailCell lead={l} /></span>
                        <ConfidenceTag c={l.confidence} />
                      </div>
                    </td>
                    <td className="px-1 py-2.5">
                      {l.country
                        ? <button
                            type="button"
                            onClick={() => setCountry(l.country === country ? "" : String(l.country))}
                            title={l.country === country ? "Clear the country filter" : `Show only ${l.country}`}
                            className={cn(
                              "max-w-[9rem] truncate rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                              l.country === country ? "bg-ink text-cream" : "bg-ink/[0.06] text-ink/65 hover:bg-ink/10 hover:text-ink"
                            )}
                          >
                            {l.country}
                          </button>
                        : <span className="text-xs text-muted">—</span>}
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
        onSaved={() => { setModalOpen(false); refreshSources(); refreshStatus(); refreshBadNames(); }}
      />
    </div>
  );
}


/* ------------------------------ Bot switch ----------------------------- */

function BotSwitch({ running, nextRunAt, activeSources, onToggle, readerKeyed, proxied, keysLive, keysConfigured, keyRejected }: { running: boolean; nextRunAt: string | null; activeSources: number; onToggle: (on: boolean) => void; readerKeyed?: boolean; proxied?: boolean; keysLive?: number; keysConfigured?: number; keyRejected?: boolean }) {
  const live = keysLive ?? 0;
  const configured = keysConfigured ?? 0;
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
      {/* How much bypass capacity the crawler ACTUALLY has. This used to read
          "Jina key active · 120 pages/min" whenever a key string existed in
          Settings — so when the key ran out of tokens the header kept claiming
          full speed while the crawler crawled at 15/min for hours. It now
          reports what the fetcher observed on its last call. */}
      <div className="mt-3 flex items-start gap-1.5 border-t border-line/60 pt-2.5 text-[11px]">
        <span className={cn(
          "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
          keyRejected ? "bg-bad" : live > 0 || proxied ? "bg-good" : "bg-ink/25"
        )} />
        {keyRejected ? (
          <span className="text-bad">
            <span className="font-medium">
              {configured > 1 ? `All ${configured} Jina keys are out of tokens` : "Jina key is out of tokens"}
            </span>
            {" "}— crawling at 20 pages/min.{" "}
            <a href="https://jina.ai/api-dashboard" target="_blank" rel="noreferrer" className="font-medium underline">get another free key</a>
          </span>
        ) : live > 0 ? (
          <span className="text-ink/60">
            {live > 1 ? `${live} Jina keys active` : "Jina key active"} · <span className="font-medium text-ink/75">120 pages/min</span>
          </span>
        ) : proxied ? (
          <span className="text-ink/60">Scraping proxy active</span>
        ) : (
          <span className="text-muted">
            Free reader · 20 pages/min ·{" "}
            <a href="https://jina.ai/api-dashboard" target="_blank" rel="noreferrer" className="font-medium text-ink/70 underline">get a free key</a>
          </span>
        )}
      </div>
    </div>
  );
}

/* --------------------------- Automation strip --------------------------- */

// Answers the question this screen inevitably raises: "so what happens to all
// these leads?" — either the automation takes the next batch by itself (and
// here's how close it is), or nothing happens until you approve them yourself.
function AutomationStrip({ a }: { a: AutomationStatus | null }) {
  if (!a) return null;
  const { enabled, threshold } = a.config;
  const ready = a.ready;
  const pct = Math.min(100, Math.round((ready / Math.max(1, threshold)) * 100));
  const sending = a.running || a.lastRun?.status === "running";
  const blocked = enabled && a.blockers.length > 0;

  if (!enabled) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-paper px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ink/[0.06]">
            <span className="h-2 w-2 rounded-full bg-ink/25" />
          </span>
          <div className="text-[13px] leading-relaxed">
            <span className="font-medium text-ink">Automation is off</span>
            <span className="text-muted"> — these leads wait here until you approve them. Turn it on and every {threshold.toLocaleString()} leads with an email get approved and emailed on their own.</span>
          </div>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => goTo("settings")}>Set up automation</Button>
      </div>
    );
  }

  return (
    <div className={cn("rounded-2xl border px-5 py-4", blocked ? "border-[#e0b354]/50 bg-[#fdf6e7]" : "border-good/40 bg-good/[0.06]")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className={cn("relative mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg", blocked ? "bg-[#e0b354]/25" : "bg-good/15")}>
            <span className={cn("h-2 w-2 rounded-full", blocked ? "bg-[#b06b16]" : "bg-good")} />
            {!blocked && <span className="absolute h-2 w-2 animate-ping rounded-full bg-good/60" />}
          </span>
          <div className="text-[13px] leading-relaxed">
            <span className="font-medium text-ink">
              {sending
                ? "Automation is emailing a batch right now"
                : blocked
                ? "Automation is on, but it can’t run yet"
                : ready >= threshold
                ? `Automation is about to take the next ${threshold.toLocaleString()}`
                : "Automation is watching this pool"}
            </span>
            <span className="text-muted">
              {blocked
                ? ` — ${a.blockers[0]}`
                : ` — ${ready.toLocaleString()} of ${threshold.toLocaleString()} leads with an email ready${ready < threshold ? ` · ${(threshold - ready).toLocaleString()} to go` : ""}. Approved automatically, then emailed.`}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {a.sentToday > 0 && <span className="text-[11px] text-muted">{a.sentToday.toLocaleString()} sent today</span>}
          <Button size="sm" variant="ghost" onClick={() => goTo("settings")}>Settings</Button>
        </div>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
        <div className={cn("h-full rounded-full transition-all", pct >= 100 ? "prism-bar" : "bg-ink")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------ Source row ----------------------------- */

function SourceRow({ s, onToggle, onRun, onEdit, onArchive, onDelete }: { s: DiscoverySource; onToggle: () => void; onRun: () => void; onEdit: () => void; onArchive: () => void; onDelete: () => void }) {
  const runningNow = s.last_status === "running";
  const isDir = s.type === "directory";
  const isSearch = s.type === "search";
  const streaming = s.enabled && runningNow;
  // Directory: show host + path so a resolved index (e.g. …/listings) is visible.
  const title = isDir ? sourceHost(s.base_url) : (s.location || (isSearch ? "Web search" : ""));
  const badge = isDir ? "Directory" : isSearch ? "Web search" : "";
  // Map area: how much of what OpenStreetMap actually holds here we've taken.
  const osmTiles = s.osm_tiles || 0;
  const osmAvail = s.osm_available || 0;

  return (
    <div className={cn("flex items-center gap-4 px-5 py-3.5", !s.enabled && "opacity-55")}>
      <Switch small checked={!!s.enabled} onChange={onToggle} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {badge && <span className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/55">{badge}</span>}
          <span className="truncate font-medium">{title}</span>
          {(!isDir || (s.category && s.category !== "Companies (general)")) && s.category && (
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
          ) : isSearch ? (
            <>
              {streaming
                ? <span className="inline-flex items-center gap-1 font-medium text-good"><Spinner className="h-2.5 w-2.5" /> searching · step {s.cursor}</span>
                : s.exhausted
                  ? <span>swept the web · re-searches {s.enabled && s.next_run_at ? fmtIn(s.next_run_at) : intervalLabel(s.interval_minutes).toLowerCase()}</span>
                  : <span>{s.enabled ? "searching the web" : "paused"} · step {s.cursor}</span>}
              <span>· {s.total_found} found</span>
              {s.keywords ? <span title={s.keywords}>· custom keywords</span> : null}
            </>
          ) : (
            <>
              {streaming
                ? <span className="inline-flex items-center gap-1 font-medium text-good"><Spinner className="h-2.5 w-2.5" /> sweeping{osmTiles ? ` · tile ${s.cursor} of ${osmTiles}` : ""}</span>
                : s.exhausted
                  ? <span>swept the whole area · re-checks {s.enabled && s.next_run_at ? fmtIn(s.next_run_at) : intervalLabel(s.interval_minutes).toLowerCase()}</span>
                  : <span>{s.enabled ? "queued" : "paused"}{osmTiles ? ` · resumes tile ${s.cursor} of ${osmTiles}` : ""}</span>}
              <span>· {(s.total_found || 0).toLocaleString()} found</span>
              {osmAvail > 0 && (
                <span title="Everything OpenStreetMap has mapped with a website, email or phone in this area. This is the ceiling — no amount of re-scanning can exceed it.">
                  · of {osmAvail.toLocaleString()} on the map
                </span>
              )}
            </>
          )}
          {s.last_status === "error" && <span className="text-bad">· blocked / error</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={onRun} disabled={runningNow} className="rounded-full px-3 py-1.5 text-xs font-medium text-ink/70 transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50">
          {runningNow ? <span className="inline-flex items-center gap-1.5"><Spinner className="h-3 w-3" /> running</span> : s.exhausted ? (isSearch ? "Re-search" : isDir ? "Restart" : "Re-sweep") : "Run now"}
        </button>
        <button onClick={onEdit} className="grid h-8 w-8 place-items-center rounded-full text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink" title="Edit">✎</button>
        <button
          onClick={onArchive}
          className="rounded-full px-2.5 py-1.5 text-xs font-medium text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink"
          title="Archive — stops scanning but keeps the source, its position and its leads"
        >
          Archive
        </button>
        <button onClick={onDelete} className="grid h-8 w-8 place-items-center rounded-full text-ink/45 transition-colors hover:bg-bad/10 hover:text-bad" title="Delete permanently">✕</button>
      </div>
    </div>
  );
}

/* --------------------------- Add / edit modal -------------------------- */

function SourceModal({ open, onClose, cats, editing, onSaved }: { open: boolean; onClose: () => void; cats: string[]; editing: DiscoverySource | null; onSaved: () => void }) {
  const [type, setType] = useState<"osm" | "directory" | "search">("search");
  const [location, setLocation] = useState("");
  const [place, setPlace] = useState<Place | null>(null);
  const [url, setUrl] = useState("");
  const [keywords, setKeywords] = useState("");
  const [category, setCategory] = useState(cats[0] || "Companies (general)");
  const [limit, setLimit] = useState(100);
  const [interval, setInterval] = useState(360);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setType(editing.type === "directory" ? "directory" : editing.type === "search" ? "search" : "osm");
      setLocation(editing.location || "");
      setUrl(editing.base_url || "");
      setKeywords(editing.keywords || "");
      setPlace(null);
      setCategory(editing.category);
      setLimit(editing.limit_n);
      setInterval(editing.interval_minutes);
    } else {
      setType("search"); setLocation(""); setUrl(""); setKeywords(""); setPlace(null);
      setCategory(cats[0] || "Companies (general)"); setLimit(100); setInterval(360);
    }
  }, [open, editing, cats]);

  // A map source should pull a whole area in one pass; the others batch.
  useEffect(() => { if (!editing) setLimit(type === "osm" ? 120 : 100); }, [type, editing]);

  async function save() {
    if (type === "osm" && !location.trim()) return toast("Choose a country or city", "error");
    if (type === "directory" && !url.trim()) return toast("Paste a directory URL", "error");
    if (type === "search" && !location.trim() && !keywords.trim()) return toast("Enter a country/city or some keywords", "error");
    setSaving(true);
    try {
      const body =
        type === "directory" ? { type: "directory" as const, url: url.trim(), location: location.trim(), category, limit, intervalMinutes: interval } :
        type === "search" ? { type: "search" as const, location: location.trim(), keywords: keywords.trim(), category, limit, intervalMinutes: interval } :
        { type: "osm" as const, location: location.trim(), category, limit, intervalMinutes: interval, place };
      if (editing) {
        await api.updateDiscoverySource(editing.id, body);
        toast("Source updated", "success");
      } else {
        await api.addDiscoverySource(body);
        toast(
          type === "directory" ? "Directory added — it'll start streaming companies in" :
          type === "search" ? "Web search added — it'll start finding companies right away" :
          "Source added — the bot will scan it shortly",
          "success"
        );
      }
      onSaved();
    } catch (e: any) { toast(e.message, "error"); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit source" : "Add discovery source"}>
      <div className="space-y-4">
        {/* type switch */}
        <div className="grid grid-cols-3 gap-1 rounded-full border border-line bg-cream p-1">
          {([["search", "Web search"], ["osm", "Map area"], ["directory", "Directory"]] as const).map(([t, label]) => (
            <button
              key={t}
              type="button"
              disabled={!!editing && (editing.type || "osm") !== t}
              onClick={() => setType(t)}
              className={cn("rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-30",
                type === t ? "bg-ink text-cream" : "text-ink/55 hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>

        {type === "search" ? (
          <>
            <Field label="Country or city" hint="Where to search. For a whole country, the bot fans out across its major cities automatically to find far more companies.">
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Saudi Arabia" />
            </Field>
            <Field label="Industry">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {cats.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Custom keywords (optional)" hint="Leave blank to use the industry above. Or type your own search terms, comma-separated — exactly what you'd Google.">
              <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="construction company, building contractor, MEP contractor" />
            </Field>
            <Field label="Re-search">
              <Select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
                {INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}
              </Select>
            </Field>
            <p className="rounded-xl bg-ink/[0.03] px-3 py-2.5 text-xs leading-relaxed text-muted">
              This searches the web like Google — across the whole country <span className="font-medium text-ink/70">and its major cities</span> — and streams every company website it finds into your pool, then finds each one's email. This is the source that scales to <span className="font-medium text-ink/70">hundreds–thousands</span>. Tip: add a free <span className="font-medium text-ink/70">Jina key</span> in Settings → Crawler so it can search at full speed.
            </p>
          </>
        ) : type === "osm" ? (
          <>
            <Field label="Country or city" hint="Where to look. Pick from the list for the most accurate area.">
              <LocationAutocomplete value={location} onChange={setLocation} onPick={setPlace} placeholder="Start typing… e.g. Qatar" />
            </Field>
            <Field label="Industry">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {cats.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Re-scan" hint="How often to sweep the area again for businesses added to the map since last time.">
              <Select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
                {INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}
              </Select>
            </Field>
            <p className="rounded-xl bg-ink/[0.03] px-3 py-2.5 text-xs leading-relaxed text-muted">
              The area is swept <span className="font-medium text-ink/70">tile by tile</span> until every business OpenStreetMap has mapped here — with a website, email <span className="font-medium text-ink/70">or phone</span> — is collected. The source card then shows how many of them you hold. OpenStreetMap is still a <span className="font-medium text-ink/70">map, not a company registry</span>, so that total is a hard ceiling (a country typically holds hundreds, not tens of thousands). Once it's swept, add a <span className="font-medium text-ink/70">Web search</span> or <span className="font-medium text-ink/70">Directory</span> source to go past it.
            </p>
          </>
        ) : (
          <>
            <Field label="Directory URL" hint="Paste the directory's listings page — or just its homepage. If you paste a homepage, the bot automatically finds the listings section, then walks every page pulling company + email + phone.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.example-directory.com  (homepage or /listings both work)" className="font-mono text-xs" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country" hint="Every lead from this directory is filed under it — so you can filter and approve by country later. Also used to read local phone numbers.">
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

// The email column for a discovered lead — reflects enrichment state so an
// empty cell tells you WHY: still searching, retrying after a block, blocked, or
// genuinely none. This is what makes "missed" emails visible instead of silent.
function EmailCell({ lead }: { lead: DiscoveredLead }) {
  if (lead.email) return <>{lead.email}</>;
  const tries = lead.retry_count ?? 0;
  if (!lead.enriched) {
    return tries > 0 ? (
      <span className="inline-flex items-center gap-1 text-ink/45" title="The site blocked the crawler — retrying automatically with a delay">
        <Spinner className="h-2.5 w-2.5" /> blocked — retrying (try {tries})
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-ink/50"><Spinner className="h-2.5 w-2.5" /> finding email…</span>
    );
  }
  if (lead.enrich_status === "blocked" || lead.enrich_status === "error") {
    return <span className="italic text-ink/45" title="The site kept blocking the crawler. Add a Jina key / proxy in Settings, then Re-check blocked.">couldn’t read site</span>;
  }
  return <span className="italic">no email found</span>;
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

/* ------------------------------ Archived row ----------------------------- */

// A retired source. Everything it knew is still here — where it stopped, how
// much it found — so restoring it resumes the walk instead of starting over.
function ArchivedRow({ s, onRestore, onDelete }: { s: DiscoverySource; onRestore: () => void; onDelete: () => void }) {
  const isDir = s.type === "directory";
  const isSearch = s.type === "search";
  const badge = isDir ? "Directory" : isSearch ? "Web search" : "Map area";
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/45">{badge}</span>
          <span className="truncate font-medium text-ink/70">{sourceTitle(s)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
          <span>{(s.total_found || 0).toLocaleString()} found</span>
          {(isDir || isSearch) && <span>· {s.exhausted ? "completed" : `stopped at ${isDir ? "page" : "step"} ${s.cursor}`}</span>}
          {s.archived_at && <span>· archived {fmtAgo(s.archived_at)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onRestore}
          className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink/70 transition-colors hover:border-ink hover:bg-ink hover:text-cream"
          title="Restore — the bot picks it up again from where it stopped"
        >
          Restore
        </button>
        <button onClick={onDelete} className="grid h-8 w-8 place-items-center rounded-full text-ink/45 transition-colors hover:bg-bad/10 hover:text-bad" title="Delete permanently">✕</button>
      </div>
    </div>
  );
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

// "just now", "12m ago", "3h ago", "5d ago" — relative PAST formatting.
function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function sourceTitle(s: DiscoverySource): string {
  if (s.type === "directory") return sourceHost(s.base_url) || "directory";
  if (s.type === "search") return s.location ? `${s.location} · ${s.category}` : "Web search";
  return [s.location, s.category].filter(Boolean).join(" · ") || "source";
}

// Host + path for a directory (so a resolved index like …/listings is visible),
// otherwise the place being watched. Used by the row headings and every confirm
// dialog, so a source is always referred to by the same name.
function sourceHost(url?: string | null): string {
  try {
    const u = new URL(url || "");
    const p = u.pathname.replace(/\/+$/, "");
    return u.hostname.replace(/^www\./, "") + (p && p !== "/" ? p : "");
  } catch { return url || ""; }
}
