import { useEffect, useRef, useState } from "react";
import { api, type Job, type Place, type LeadCompany, type ParsedRow } from "../lib/api";
import { Button, Field, Input, Modal, Select, Spinner, Textarea, toast, cn } from "../lib/ui";
import { toCsv, downloadCsv } from "../lib/csv";

interface Found {
  email: string;
  role_based: boolean;
  method: string;
  confidence?: "high" | "medium" | "low" | "guessed";
  domain: string;
  source: string;
  mx?: boolean;
  keywordsMatched?: string[];
  phone?: string;
  phoneMobile?: boolean;
}
// A harvested directory listing (company + email + phone).
interface Lead {
  name: string;
  email: string | null;
  phone: string | null;
  phoneMobile?: boolean;
  role_based?: boolean;
  category?: string | null;
  detailUrl: string;
  domain: string;
  inContacts?: boolean;
}
type Company = LeadCompany;

const FALLBACK_CATS = [
  "Accounting & Tax", "IT & Software", "Construction & Contracting", "Consulting",
  "Engineering", "Real Estate", "Legal", "Logistics & Transport",
  "Advertising & Marketing", "Insurance", "Trading & Retail", "Companies (general)",
];

type Mode = "discover" | "keyword" | "urls" | "directory" | "pdf";

export default function Crawler({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [mode, setMode] = useState<Mode>("discover");
  const [stage, setStage] = useState<"input" | "job">("input");

  // location (shared by discover + keyword)
  const [location, setLocation] = useState("");
  const [place, setPlace] = useState<Place | null>(null);

  // discover
  const [cats, setCats] = useState<string[]>(FALLBACK_CATS);
  const [category, setCategory] = useState(FALLBACK_CATS[0]);
  const [limit, setLimit] = useState(40);
  const [discovering, setDiscovering] = useState(false);

  // keyword search
  const [keywords, setKeywords] = useState("");
  const [searching, setSearching] = useState(false);

  // results of discovery/search
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pickedCos, setPickedCos] = useState<Set<string>>(new Set());
  const [hideKnown, setHideKnown] = useState(true);

  // urls
  const [urls, setUrls] = useState("");
  const [tagCountry, setTagCountry] = useState("");
  const [tagIndustry, setTagIndustry] = useState("");
  const [urlCheck, setUrlCheck] = useState<{ total: number; inContacts: number; crawled: number; fresh: number } | null>(null);
  const [checking, setChecking] = useState(false);

  // directory harvest
  const [dirUrls, setDirUrls] = useState("");
  const [dirCountry, setDirCountry] = useState("");
  const [dirMaxPages, setDirMaxPages] = useState(20);
  const [dirMaxListings, setDirMaxListings] = useState(200);
  const [dirSelected, setDirSelected] = useState<Set<string>>(new Set());
  const [dirAdded, setDirAdded] = useState<Set<string>>(new Set());
  const [dirBusy, setDirBusy] = useState(false);

  // pdf import
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfRows, setPdfRows] = useState<ParsedRow[]>([]);
  const [pdfParsing, setPdfParsing] = useState(false);
  const [pdfCountry, setPdfCountry] = useState("");
  const [pdfMax, setPdfMax] = useState(50);
  const [pdfGuessInbox, setPdfGuessInbox] = useState(true);

  // options
  const [maxPages, setMaxPages] = useState(20);
  const [maxDepth, setMaxDepth] = useState(2);
  const [respectRobots, setRespectRobots] = useState(true);
  const [checkMx, setCheckMx] = useState(true);
  const [skipKnown, setSkipKnown] = useState(true);
  const [guessInbox, setGuessInbox] = useState(false);
  const [mustMention, setMustMention] = useState("");
  const [requireKeyword, setRequireKeyword] = useState(false);

  // category to save fetched emails under
  const [categories, setCategories] = useState<string[]>([]);
  const [saveCategory, setSaveCategory] = useState("");

  // job
  const [job, setJob] = useState<Job | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const addTags = useRef<{ country?: string; industry?: string }>({});
  const pollRef = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const running = job?.status === "running";
  const results: Found[] = job?.result?.emails || [];
  const skippedList: any[] = job?.result?.skipped || [];

  // directory job (also covers PDF enrichment — same result shape)
  const isEnrichJob = job?.result?.mode === "enrich";
  const isDirJob = job?.result?.mode === "directory" || isEnrichJob;
  const leads: Lead[] = job?.result?.contacts || [];
  const leadKey = (l: Lead) => l.email || l.phone || l.detailUrl;
  const isAdded = (l: Lead) => !!l.inContacts || dirAdded.has(leadKey(l));
  const addableLeads = leads.filter((l) => l.email && !isAdded(l));
  const leadsWithPhone = leads.filter((l) => l.phone).length;
  // When a directory harvest finishes with nothing, explain why (e.g. Cloudflare).
  const dirSites: any[] = job?.result?.sites || [];
  const dirBlocked = isDirJob && !running && leads.length === 0 && dirSites.some((s) => s.status === "blocked");
  const dirNote: string | undefined =
    isDirJob && !running && leads.length === 0 ? dirSites.find((s) => s.note)?.note : undefined;

  useEffect(() => {
    api.getLeadCategories().then((r) => {
      if (r.categories?.length) { setCats(r.categories); setCategory(r.categories[0]); }
    }).catch(() => {});
    api.getCategories().then((r) => setCategories(r.categories || [])).catch(() => {});
  }, []);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [job?.logs?.length]);

  /* ---------------------------- discover ---------------------------- */
  async function discover() {
    if (!location.trim()) return toast("Choose a country or city", "error");
    setDiscovering(true);
    setCompanies([]);
    try {
      const r = await api.findLeads(location.trim(), category, limit, place);
      applyResults(r.companies);
      if (!r.companies.length) toast("No companies found — try a broader area or category", "info");
      else if (!r.summary.new) toast("All results are already in your contacts or previously crawled", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setDiscovering(false);
    }
  }

  async function searchByKeyword() {
    if (!keywords.trim()) return toast("Enter keywords, e.g. \"auto partner\"", "error");
    setSearching(true);
    setCompanies([]);
    try {
      const r = await api.searchCompanies(keywords.trim(), location.trim(), limit);
      applyResults(r.companies);
      // Pre-arm the content filter with what you searched for.
      setMustMention(keywords.trim());
      setRequireKeyword(true);
      if (!r.companies.length) toast("No company sites found for those keywords", "info");
      else if (!r.summary.new) toast("All results are already in your contacts or previously crawled", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSearching(false);
    }
  }

  function applyResults(list: Company[]) {
    setCompanies(list);
    const fresh = list.filter((c) => c.hasWebsite && !c.inContacts && !c.crawled);
    setPickedCos(new Set(fresh.map((c) => c.website)));
  }

  function toggleCo(w: string) {
    const n = new Set(pickedCos);
    n.has(w) ? n.delete(w) : n.add(w);
    setPickedCos(n);
  }

  const visibleCos = companies.filter((c) => !(hideKnown && (c.inContacts || c.crawled)));
  const crawlable = companies.filter((c) => c.hasWebsite);
  const newCount = companies.filter((c) => !c.inContacts && !c.crawled).length;
  const knownCount = companies.length - newCount;
  const pickedCrawlable = crawlable.filter((c) => pickedCos.has(c.website));
  const allVisibleSelected = visibleCos.length > 0 && visibleCos.every((c) => !c.hasWebsite || pickedCos.has(c.website));
  const pickedWithEmail = companies.filter((c) => (pickedCos.has(c.website) || !c.hasWebsite) && c.email && !c.inContacts);

  function toggleAllVisible() {
    if (allVisibleSelected) setPickedCos(new Set());
    else setPickedCos(new Set(visibleCos.filter((c) => c.hasWebsite).map((c) => c.website)));
  }

  async function addListedEmails() {
    const list = companies.filter((c) => c.email && !c.inContacts && (pickedCos.has(c.website) || !c.hasWebsite));
    if (!list.length) return toast("No listed emails to add", "info");
    try {
      const r = await api.bulkContacts(
        list.map((c) => ({
          email: c.email!,
          company: c.name,
          country: location || undefined,
          industry: mode === "discover" ? category : keywords || undefined,
          category: saveCategory || undefined,
          phone: c.phone || undefined,
          role_based: /^(info|sales|contact|support|admin|office)/i.test(c.email!),
          source: mode === "keyword" ? "search" : "osm",
        }))
      );
      toast(`Added ${r.added} · skipped ${r.skipped} duplicate(s)`, "success");
      onAdded();
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  /* --------------------------- paste check -------------------------- */
  async function checkUrls() {
    const list = urls.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);
    if (!list.length) return;
    setChecking(true);
    try {
      setUrlCheck(await api.checkCrawl(list));
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setChecking(false);
    }
  }

  /* ------------------------------ crawl ----------------------------- */
  function beginPoll(jobId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      const j = await api.getCrawl(jobId).catch(() => null);
      if (j) {
        setJob(j);
        if (j.status !== "running" && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    }, 1000);
  }

  async function startCrawl(list: string[], tags: { country?: string; industry?: string }) {
    if (!list.length) return toast("Nothing selected to crawl", "error");
    addTags.current = tags;
    setSelected(new Set());
    setStage("job");
    setJob(null);
    const kw = mustMention.split(",").map((k) => k.trim()).filter(Boolean);
    try {
      const { jobId } = await api.startCrawl({
        urls: list, maxPages, maxDepth, respectRobots, checkMx, skipKnown, guessInbox,
        keywords: kw, requireKeyword: requireKeyword && kw.length > 0,
        defaultCountry: tags.country || undefined,
      });
      beginPoll(jobId);
      setJob(await api.getCrawl(jobId));
    } catch (e: any) {
      toast(e.message, "error");
      setStage("input");
    }
  }

  /* --------------------------- directory ---------------------------- */
  async function startDirectory() {
    const list = dirUrls.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);
    if (!list.length) return toast("Paste a directory URL to harvest", "error");
    setDirSelected(new Set());
    setStage("job");
    setJob(null);
    try {
      const { jobId } = await api.startCrawl({
        mode: "directory",
        urls: list,
        maxPages: dirMaxPages,
        maxDetails: dirMaxListings,
        defaultCountry: dirCountry || undefined,
        respectRobots,
        checkMx,
      });
      beginPoll(jobId);
      setJob(await api.getCrawl(jobId));
    } catch (e: any) {
      toast(e.message, "error");
      setStage("input");
    }
  }

  /* ------------------------------ pdf import ------------------------------ */
  async function onPdfFile(file: File | null) {
    setPdfFile(file);
    setPdfRows([]);
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) return toast("Please choose a PDF file", "error");
    setPdfParsing(true);
    try {
      const r = await api.parsePdf(file, pdfCountry.trim() || undefined);
      setPdfRows(r.rows || []);
      if (!r.rows?.length) toast("Couldn't find company rows in this PDF — try another file", "info");
      else toast(`Parsed ${r.count} compan${r.count === 1 ? "y" : "ies"} from ${r.pages} page(s)`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setPdfParsing(false);
    }
  }

  async function startPdfEnrich() {
    if (!pdfRows.length) return toast("Upload a PDF first", "error");
    setDirSelected(new Set());
    setStage("job");
    setJob(null);
    try {
      const { jobId } = await api.startCrawl({
        mode: "enrich",
        rows: pdfRows,
        maxRows: pdfMax,
        defaultCountry: pdfCountry || undefined,
        respectRobots,
        checkMx,
        guessInbox: pdfGuessInbox,
      });
      beginPoll(jobId);
      setJob(await api.getCrawl(jobId));
    } catch (e: any) {
      toast(e.message, "error");
      setStage("input");
    }
  }

  function toggleLead(k: string) {
    const n = new Set(dirSelected);
    n.has(k) ? n.delete(k) : n.add(k);
    setDirSelected(n);
  }
  const allLeadsSelected = addableLeads.length > 0 && addableLeads.every((l) => dirSelected.has(leadKey(l)));
  function toggleAllLeads() {
    setDirSelected(allLeadsSelected ? new Set() : new Set(addableLeads.map(leadKey)));
  }

  async function addDirectorySelected() {
    const chosen = leads.filter((l) => dirSelected.has(leadKey(l)) && l.email);
    if (!chosen.length) return toast("Select leads that have an email to add", "info");
    setDirBusy(true);
    try {
      const r = await api.bulkContacts(
        chosen.map((l) => ({
          email: l.email!,
          company: l.name,
          phone: l.phone || undefined,
          country: (mode === "pdf" ? pdfCountry : dirCountry) || undefined,
          category: saveCategory || l.category || undefined,
          role_based: l.role_based,
          source: mode === "pdf" ? "pdf-import" : "directory",
        })),
        true
      );
      // Flip the added rows to "added" and clear the selection so it's obvious.
      setDirAdded((prev) => new Set([...prev, ...chosen.map(leadKey)]));
      setDirSelected(new Set());
      const parts = [`Added ${r.added}`];
      if (r.updated) parts.push(`updated ${r.updated}`);
      if (r.skipped) parts.push(`skipped ${r.skipped}`);
      toast(`${parts.join(" · ")} — saved to Contacts`, "success");
      onAdded();
    } catch (e: any) {
      toast(e.message || "Could not add contacts", "error");
    } finally {
      setDirBusy(false);
    }
  }

  function exportLeads() {
    if (!leads.length) return;
    const csv = toCsv(
      leads.map((l) => ({ company: l.name, email: l.email || "", phone: l.phone || "", mobile: l.phoneMobile ? "yes" : "", domain: l.domain, source: l.detailUrl })),
      ["company", "email", "phone", "mobile", "domain", "source"]
    );
    downloadCsv("directory-leads.csv", csv);
  }

  function crawlDiscovered() {
    const list = pickedCrawlable.map((c) => c.website);
    const industry = mode === "discover" ? category : keywords;
    startCrawl(list, { country: location || undefined, industry: industry || undefined });
  }
  function crawlUrls() {
    const list = urls.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);
    startCrawl(list, { country: tagCountry || undefined, industry: tagIndustry || undefined });
  }

  /* ----------------------------- results ---------------------------- */
  function toggle(email: string) {
    const n = new Set(selected);
    n.has(email) ? n.delete(email) : n.add(email);
    setSelected(n);
  }
  const allSelected = results.length > 0 && selected.size === results.length;

  async function addSelected() {
    const chosen = results.filter((r) => selected.has(r.email));
    if (!chosen.length) return;
    try {
      const r = await api.bulkContacts(
        chosen.map((c) => ({
          email: c.email,
          company: c.domain,
          country: addTags.current.country,
          industry: addTags.current.industry,
          category: saveCategory || undefined,
          phone: c.phone || undefined,
          role_based: c.role_based,
          source: mode === "keyword" ? "search" : "crawler",
        }))
      );
      toast(`Added ${r.added} · skipped ${r.skipped} duplicate(s)`, "success");
      onAdded();
      close();
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  function exportResults() {
    if (!results.length) return;
    const csv = toCsv(
      results.map((r) => ({ email: r.email, phone: r.phone || "", type: r.role_based ? "role" : "personal", confidence: r.confidence || "", method: r.method, domain: r.domain, mentions: (r.keywordsMatched || []).join(" "), source: r.source })),
      ["email", "phone", "type", "confidence", "method", "domain", "mentions", "source"]
    );
    downloadCsv("crawl-results.csv", csv);
  }

  function reset() {
    if (pollRef.current) clearInterval(pollRef.current);
    setJob(null);
    setSelected(new Set());
    setDirSelected(new Set());
    setDirAdded(new Set());
    setStage("input");
  }
  function close() {
    reset();
    setCompanies([]);
    setUrlCheck(null);
    setPdfFile(null);
    setPdfRows([]);
    onClose();
  }

  const listMode = mode === "discover" || mode === "keyword";

  return (
    <Modal open={open} onClose={close} title="Find emails" wide>
      {stage === "input" ? (
        <div className="space-y-5">
          {/* mode switch */}
          <div className="flex rounded-full border border-line bg-cream p-1 w-fit">
            {([["discover", "Discover companies"], ["keyword", "Keyword search"], ["directory", "Directory"], ["pdf", "Import PDF"], ["urls", "Paste websites"]] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => { setMode(m); setCompanies([]); }}
                className={cn("rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors", mode === m ? "bg-ink text-cream" : "text-ink/55 hover:text-ink")}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "discover" && (
            <div className="space-y-4">
              <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
                <Field label="Country or city">
                  <LocationAutocomplete value={location} onChange={setLocation} onPick={setPlace} placeholder="Start typing… e.g. Qatar" onEnter={discover} />
                </Field>
                <Field label="Industry">
                  <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </Field>
                <Button onClick={discover} loading={discovering} className="mb-[1px]">Discover</Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-muted">Max results</span>
                <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="h-8 w-24">
                  {[20, 40, 60, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
                <span className="text-xs text-muted">Business directory · OpenStreetMap.</span>
              </div>
            </div>
          )}

          {mode === "keyword" && (
            <div className="space-y-4">
              <div className="grid grid-cols-[1.3fr_1fr_auto] items-end gap-3">
                <Field label="Keywords" hint="What the company says about itself">
                  <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder='e.g. auto partner, spare parts distributor' onKeyDown={(e) => e.key === "Enter" && searchByKeyword()} />
                </Field>
                <Field label="Location (optional)">
                  <LocationAutocomplete value={location} onChange={setLocation} onPick={setPlace} placeholder="e.g. Qatar" onEnter={searchByKeyword} />
                </Field>
                <Button onClick={searchByKeyword} loading={searching} className="mb-[1px]">Search</Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-muted">Max results</span>
                <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="h-8 w-24">
                  {[20, 40, 60, 80].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
                <span className="text-xs text-muted">Searches the live web for matching companies.</span>
              </div>
            </div>
          )}

          {listMode && companies.length > 0 && (
            <div className="rounded-xl border border-line">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <label className="flex items-center gap-2 text-[13px] font-medium">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} className="accent-ink" />
                  {companies.length} found · <span className="text-good">{newCount} new</span>
                  {knownCount > 0 && <span className="text-muted">· {knownCount} known</span>}
                </label>
                <div className="flex items-center gap-3">
                  {knownCount > 0 && (
                    <button onClick={() => setHideKnown((v) => !v)} className="text-xs font-medium text-ink/60 underline hover:text-ink">
                      {hideKnown ? "Show known" : "Hide known"}
                    </button>
                  )}
                  {categories.length > 0 && (
                    <Select value={saveCategory} onChange={(e) => setSaveCategory(e.target.value)} className="h-8 w-36 text-[13px]" title="Save under category">
                      <option value="">No category</option>
                      {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  )}
                  {pickedWithEmail.length > 0 && (
                    <Button size="sm" variant="outline" onClick={addListedEmails}>Add {pickedWithEmail.length} listed</Button>
                  )}
                </div>
              </div>
              <div className="max-h-52 overflow-y-auto">
                {visibleCos.length === 0 && (
                  <div className="px-3 py-6 text-center text-xs text-muted">All results are already known. Toggle "Show known" to review them.</div>
                )}
                {visibleCos.map((c) => {
                  const known = c.inContacts || c.crawled;
                  return (
                    <div key={c.website || c.email || c.name} className={cn("flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-0", known && "opacity-60")}>
                      <input type="checkbox" disabled={!c.hasWebsite} checked={pickedCos.has(c.website)} onChange={() => toggleCo(c.website)} className="accent-ink disabled:opacity-30" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{c.name}</div>
                        <div className="truncate text-xs text-muted">
                          {c.hasWebsite ? c.website.replace(/^https?:\/\//, "").replace(/\/$/, "") : "no website"}{c.city ? ` · ${c.city}` : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {c.email && <Tag tone="green">email</Tag>}
                        {c.inContacts && <Tag tone="blue">in contacts</Tag>}
                        {!c.inContacts && c.crawled && <Tag tone="amber">crawled</Tag>}
                        {!c.hasWebsite && !c.email && <Tag tone="gray">no site</Tag>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {mode === "urls" && (
            <div className="space-y-4">
              <Field label="Company websites" hint="One per line (or comma-separated). Bare domains are fine.">
                <Textarea rows={5} value={urls} onChange={(e) => { setUrls(e.target.value); setUrlCheck(null); }} placeholder={"acme-trading.com\nhttps://www.example-contractor.qa"} className="font-mono text-xs" />
              </Field>
              <div className="flex items-center gap-3">
                <Button size="sm" variant="outline" onClick={checkUrls} loading={checking} disabled={!urls.trim()}>Check for duplicates</Button>
                {urlCheck && (
                  <span className="text-xs text-muted">
                    {urlCheck.total} domain(s): <span className="text-good">{urlCheck.fresh} new</span>
                    {urlCheck.inContacts > 0 && <> · {urlCheck.inContacts} in contacts</>}
                    {urlCheck.crawled > 0 && <> · {urlCheck.crawled} already crawled</>}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tag country (optional)"><Input value={tagCountry} onChange={(e) => setTagCountry(e.target.value)} placeholder="Qatar" /></Field>
                <Field label="Tag industry (optional)"><Input value={tagIndustry} onChange={(e) => setTagIndustry(e.target.value)} placeholder="Construction" /></Field>
              </div>
            </div>
          )}

          {mode === "directory" && (
            <div className="space-y-4">
              <Field label="Directory URL" hint="Paste a listing/directory page. It walks every page, opens each listing, and pulls company + email + phone.">
                <Textarea
                  rows={3}
                  value={dirUrls}
                  onChange={(e) => setDirUrls(e.target.value)}
                  placeholder={"https://www.qatarcontact.com/listings/31\nhttps://www.odoo.com/partners/country/qatar-180"}
                  className="font-mono text-xs"
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Country" hint="Helps read local phone numbers">
                  <Input value={dirCountry} onChange={(e) => setDirCountry(e.target.value)} placeholder="Qatar" />
                </Field>
                <Field label="Max pages to walk">
                  <Select value={dirMaxPages} onChange={(e) => setDirMaxPages(Number(e.target.value))}>
                    {[5, 10, 20, 30, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                  </Select>
                </Field>
                <Field label="Max listings">
                  <Select value={dirMaxListings} onChange={(e) => setDirMaxListings(Number(e.target.value))}>
                    {[50, 100, 200, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-ink/[0.03] p-3">
                <Toggle label="Respect robots.txt" checked={respectRobots} onChange={setRespectRobots} />
                <Toggle label="Verify MX (deliverability)" checked={checkMx} onChange={setCheckMx} />
                {categories.length > 0 && (
                  <div className="ml-auto flex items-center gap-2">
                    <span className="text-[13px] text-muted">Save under</span>
                    <Select value={saveCategory} onChange={(e) => setSaveCategory(e.target.value)} className="h-8 w-40 text-[13px]">
                      <option value="">No category</option>
                      {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted">
                Extracts company, email &amp; phone (mobile preferred) from each listing. The directory's own contact details are filtered out automatically.
              </p>
            </div>
          )}

          {mode === "pdf" && (
            <div className="space-y-4">
              <Field label="Country" hint="Helps read local phone numbers and find the right websites">
                <Input value={pdfCountry} onChange={(e) => setPdfCountry(e.target.value)} placeholder="Qatar" />
              </Field>

              <label
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line bg-cream px-4 py-8 text-center transition-colors hover:border-ink/30",
                  pdfParsing && "pointer-events-none opacity-70"
                )}
              >
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  onChange={(e) => onPdfFile(e.target.files?.[0] || null)}
                />
                {pdfParsing ? (
                  <span className="inline-flex items-center gap-2 text-sm font-medium text-ink/70"><Spinner className="h-4 w-4" /> Reading PDF…</span>
                ) : pdfFile ? (
                  <>
                    <span className="text-sm font-medium">{pdfFile.name}</span>
                    <span className="text-xs text-muted">{pdfRows.length ? `${pdfRows.length} companies parsed` : "No rows found"} · click to choose another</span>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium">Drop or choose a directory PDF</span>
                    <span className="text-xs text-muted">e.g. the QCCI Directory. Company + phone are read from each listing.</span>
                  </>
                )}
              </label>

              {pdfRows.length > 0 && (
                <div className="rounded-xl border border-line">
                  <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[13px] font-medium">
                    <span>{pdfRows.length} companies parsed · <span className="text-muted">{pdfRows.filter((r) => r.phone).length} with phone</span></span>
                    <span className="text-xs text-muted">preview</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {pdfRows.slice(0, 100).map((r, i) => (
                          <tr key={i} className="border-b border-line-soft last:border-0">
                            <td className="px-3 py-1.5">
                              <div className="font-medium leading-tight">{r.company}</div>
                              {r.category && <div className="truncate text-xs text-muted">{r.category}</div>}
                            </td>
                            <td className="px-3 py-1.5 text-right text-xs tabular-nums text-ink/70">{r.phone || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-ink/[0.03] p-3">
                <Field label="Companies to process">
                  <Select value={pdfMax} onChange={(e) => setPdfMax(Number(e.target.value))} className="h-9 w-28">
                    {[10, 25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
                  </Select>
                </Field>
                <Toggle label="Respect robots.txt" checked={respectRobots} onChange={setRespectRobots} />
                <Toggle label="Verify MX (deliverability)" checked={checkMx} onChange={setCheckMx} />
                <Toggle label="Guess info@ if hidden" checked={pdfGuessInbox} onChange={setPdfGuessInbox} />
                {categories.length > 0 && (
                  <div className="ml-auto flex items-center gap-2">
                    <span className="text-[13px] text-muted">Save under</span>
                    <Select value={saveCategory} onChange={(e) => setSaveCategory(e.target.value)} className="h-8 w-40 text-[13px]">
                      <option value="">No category</option>
                      {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                    </Select>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted">
                For each company we find its website, then read the site for a real email &amp; phone. You review everything before it's added to Contacts.
              </p>
            </div>
          )}

          {/* shared crawl options (not needed for directory / pdf modes) */}
          {mode !== "directory" && mode !== "pdf" && (
          <div className="rounded-xl bg-ink/[0.03] p-3">
            <div className="mb-2 grid grid-cols-2 gap-3">
              <Field label="Max pages / site">
                <Select value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))}>{[10, 20, 30, 40].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
              </Field>
              <Field label="Crawl depth">
                <Select value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
              </Field>
            </div>
            <Field label="Must mention (optional)" hint="Only keep sites whose pages mention these words — comma-separated">
              <div className="flex items-center gap-2">
                <Input value={mustMention} onChange={(e) => setMustMention(e.target.value)} placeholder="auto partner, spare parts" className="flex-1" />
                {mustMention.trim() && (
                  <button type="button" onClick={() => setRequireKeyword((v) => !v)} className={cn("shrink-0 rounded-full border px-3 py-2 text-xs font-medium transition-colors", requireKeyword ? "border-ink bg-ink text-cream" : "border-line text-ink/60 hover:text-ink")}>
                    {requireKeyword ? "Required" : "Optional"}
                  </button>
                )}
              </div>
            </Field>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Toggle label="Skip already-crawled sites" hint="Never re-scan a domain you've done before" checked={skipKnown} onChange={setSkipKnown} />
              <Toggle label="Guess role inbox if none found" hint="Add info@domain when a site hides its email" checked={guessInbox} onChange={setGuessInbox} />
              <Toggle label="Respect robots.txt" checked={respectRobots} onChange={setRespectRobots} />
              <Toggle label="Verify MX (deliverability)" checked={checkMx} onChange={setCheckMx} />
            </div>
          </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            {listMode ? (
              <Button onClick={crawlDiscovered} disabled={!pickedCrawlable.length}>Find emails on {pickedCrawlable.length || ""} site(s)</Button>
            ) : mode === "directory" ? (
              <Button onClick={startDirectory} disabled={!dirUrls.trim()}>Harvest directory</Button>
            ) : mode === "pdf" ? (
              <Button onClick={startPdfEnrich} disabled={!pdfRows.length}>Find emails for {pdfRows.length ? Math.min(pdfRows.length, pdfMax) : ""} companies</Button>
            ) : (
              <Button onClick={crawlUrls} disabled={!urls.trim()}>Start crawl</Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Progress */}
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[13px]">
              <span className="font-medium">
                {running ? (
                  <span className="inline-flex items-center gap-2"><Spinner className="h-3.5 w-3.5" /> Crawling…</span>
                ) : job?.status === "error" ? (
                  <span className="text-bad">Error: {job.error}</span>
                ) : (
                  <span className="text-good">Done — {isEnrichJob ? `${leads.filter((l) => l.email).length} email(s) found` : isDirJob ? `${leads.length} lead(s) harvested` : `${results.length} unique email(s) found`}</span>
                )}
              </span>
              <span className="text-muted">{isEnrichJob ? `${job?.processed ?? 0}/${job?.total ?? 0} companies` : isDirJob ? (running ? "walking…" : `${job?.result?.sites?.[0]?.detailPages ?? 0} pages`) : `${job?.processed ?? 0}/${job?.total ?? 0} sites`}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-ink/[0.07]">
              <div className="prism-bar h-full rounded-full transition-all duration-300" style={{ width: `${Math.round((job?.progress || 0) * 100)}%` }} />
            </div>
          </div>

          {skippedList.length > 0 && (
            <div className="rounded-lg border border-line bg-cream px-3 py-2 text-xs text-ink/70">
              Skipped <span className="font-semibold">{skippedList.length}</span> already-known site(s) — previously crawled or already in your contacts.
            </div>
          )}

          {dirNote && (
            <div
              className={cn(
                "rounded-lg border px-3 py-2.5 text-xs",
                dirBlocked
                  ? "border-[#f0c98a] bg-[#fff6e8] text-[#8a5a12]"
                  : "border-line bg-cream text-ink/70"
              )}
            >
              <div className="font-semibold">
                {dirBlocked ? "This directory blocks crawlers" : "No leads found"}
              </div>
              <div className="mt-0.5 leading-relaxed">{dirNote}</div>
            </div>
          )}

          <div ref={logRef} className="h-24 overflow-y-auto rounded-xl bg-ink px-3 py-2.5 font-mono text-[11px] leading-relaxed text-cream/80">
            {(job?.logs || []).map((l, i) => (
              <div key={i} className={cn(l.level === "hit" && "text-[#7ee7a6]", l.level === "warn" && "text-[#ffcf7a]", l.level === "fail" && "text-[#ff9a8a]")}>{l.msg}</div>
            ))}
            {!job?.logs?.length && <span className="text-cream/40">Starting…</span>}
          </div>

          {isDirJob && leads.length > 0 && (
            <div className="rounded-xl border border-line">
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <label className="flex items-center gap-2 text-[13px] font-medium">
                  <input type="checkbox" checked={allLeadsSelected} onChange={toggleAllLeads} className="accent-ink" />
                  {leads.length} lead(s) · <span className="text-muted">{leadsWithPhone} with phone</span>
                  {dirAdded.size > 0 && <span className="text-good">· {dirAdded.size} added</span>}
                </label>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted">{dirSelected.size} selected</span>
                  <button onClick={exportLeads} className="text-xs font-medium text-ink/60 underline hover:text-ink">Export CSV</button>
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {leads.map((l) => {
                      const k = leadKey(l);
                      const added = isAdded(l);
                      return (
                        <tr key={k} className={cn("border-b border-line-soft last:border-0", added && "opacity-60")}>
                          <td className="w-8 px-3 py-2">
                            <input type="checkbox" disabled={!l.email || added} checked={dirSelected.has(k)} onChange={() => toggleLead(k)} className="accent-ink disabled:opacity-30" />
                          </td>
                          <td className="px-1 py-2">
                            <div className="font-medium leading-tight">{l.name || l.domain}</div>
                            <div className="truncate text-xs text-muted">{l.email || <span className="italic">no email</span>}</div>
                          </td>
                          <td className="px-1 py-2 text-xs">
                            {l.phone ? (
                              <span className="inline-flex items-center gap-1 tabular-nums text-ink/75">{l.phone}{l.phoneMobile && <Tag tone="green">mobile</Tag>}</span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                          <td className="px-1 py-2 text-right">
                            {l.inContacts && <Tag tone="blue">in contacts</Tag>}
                            {!l.inContacts && dirAdded.has(k) && <Tag tone="green">added</Tag>}
                            {!added && !l.email && l.phone && <Tag tone="gray">phone only</Tag>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!isDirJob && results.length > 0 && (
            <div className="rounded-xl border border-line">
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <label className="flex items-center gap-2 text-[13px] font-medium">
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(results.map((r) => r.email)))} className="accent-ink" />
                  Select all ({results.length})
                </label>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted">{selected.size} selected</span>
                  <button onClick={exportResults} className="text-xs font-medium text-ink/60 underline hover:text-ink">Export CSV</button>
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {results.map((r) => (
                      <tr key={r.email} className="border-b border-line-soft last:border-0">
                        <td className="w-8 px-3 py-2"><input type="checkbox" checked={selected.has(r.email)} onChange={() => toggle(r.email)} className="accent-ink" /></td>
                        <td className="px-1 py-2 font-medium">
                          {r.email}
                          {r.keywordsMatched && r.keywordsMatched.length > 0 && (
                            <span className="ml-2 align-middle"><Tag tone="green">mentions {r.keywordsMatched[0]}</Tag></span>
                          )}
                        </td>
                        <td className="px-1 py-2 text-xs">
                          {r.phone ? (
                            <span className="inline-flex items-center gap-1 tabular-nums text-ink/75">
                              {r.phone}
                              {r.phoneMobile && <Tag tone="green">mobile</Tag>}
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="px-1 py-2"><ConfidenceTag c={r.confidence} /></td>
                        <td className="px-1 py-2 text-xs text-muted">{r.role_based ? "role" : "personal"}</td>
                        <td className="px-1 py-2 text-xs text-ink/60">{r.domain}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" onClick={reset} disabled={running}>Back</Button>
            <div className="flex items-center gap-2">
              {categories.length > 0 && (
                <Select value={saveCategory} onChange={(e) => setSaveCategory(e.target.value)} className="h-9 w-40 text-[13px]" title="Save under category">
                  <option value="">No category</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              )}
              <Button variant="outline" onClick={close}>Close</Button>
              {isDirJob ? (
                <Button onClick={addDirectorySelected} loading={dirBusy} disabled={!dirSelected.size || dirBusy}>Add {dirSelected.size || ""} to contacts</Button>
              ) : (
                <Button onClick={addSelected} disabled={!selected.size}>Add {selected.size || ""} to contacts</Button>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* --------------------- Location autocomplete ---------------------- */

function LocationAutocomplete({
  value, onChange, onPick, placeholder, onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (p: Place | null) => void;
  placeholder?: string;
  onEnter?: () => void;
}) {
  const [opts, setOpts] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(0);
  const tRef = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  function change(v: string) {
    onChange(v);
    onPick(null);
    if (tRef.current) clearTimeout(tRef.current);
    if (v.trim().length < 2) { setOpts([]); setOpen(false); return; }
    setLoading(true);
    tRef.current = window.setTimeout(async () => {
      try {
        const r = await api.geocode(v.trim());
        setOpts(r.places || []);
        setHi(0);
        setOpen(true);
      } catch { setOpts([]); }
      finally { setLoading(false); }
    }, 260);
  }

  function pick(p: Place) {
    onChange(p.short_name);
    onPick(p);
    setOpts([]);
    setOpen(false);
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Input
          value={value}
          onChange={(e) => change(e.target.value)}
          onFocus={() => opts.length && setOpen(true)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (open && opts.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, opts.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); pick(opts[hi]); }
              else if (e.key === "Escape") setOpen(false);
            } else if (e.key === "Enter") { onEnter?.(); }
          }}
        />
        {loading && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />}
      </div>
      {open && opts.length > 0 && (
        <div className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-line bg-paper py-1 shadow-xl">
          {opts.map((p, i) => (
            <button
              key={`${p.osm_type}/${p.osm_id}`}
              type="button"
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(p)}
              className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors", i === hi ? "bg-ink/[0.06]" : "hover:bg-ink/[0.04]")}
            >
              <span className="truncate">{p.short_name}</span>
              {p.type && <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted">{p.type}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone: "green" | "blue" | "amber" | "gray" }) {
  const tones = {
    green: "bg-[#e7f6ec] text-[#1f8b4c]",
    blue: "bg-[#eaf3ff] text-[#2563a8]",
    amber: "bg-[#fef3e2] text-[#b06b16]",
    gray: "bg-ink/[0.06] text-ink/50",
  };
  return <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium", tones[tone])}>{children}</span>;
}

function ConfidenceTag({ c }: { c?: "high" | "medium" | "low" | "guessed" }) {
  if (!c) return null;
  const map = {
    high: { tone: "green" as const, label: "high" },
    medium: { tone: "blue" as const, label: "medium" },
    low: { tone: "amber" as const, label: "low" },
    guessed: { tone: "gray" as const, label: "guessed" },
  };
  const { tone, label } = map[c];
  return <Tag tone={tone}>{label}</Tag>;
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-start gap-2 text-left text-[13px] font-medium text-ink/80">
      <span className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-ink" : "bg-ink/15")}>
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </span>
      <span>
        {label}
        {hint && <span className="block text-[11px] font-normal text-muted">{hint}</span>}
      </span>
    </button>
  );
}
