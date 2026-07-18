import { useEffect, useRef, useState } from "react";
import { api, type Job, type Place, type LeadCompany } from "../lib/api";
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
}
type Company = LeadCompany;

const FALLBACK_CATS = [
  "Accounting & Tax", "IT & Software", "Construction & Contracting", "Consulting",
  "Engineering", "Real Estate", "Legal", "Logistics & Transport",
  "Advertising & Marketing", "Insurance", "Trading & Retail", "Companies (general)",
];

type Mode = "discover" | "keyword" | "urls";

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
      });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        const j = await api.getCrawl(jobId).catch(() => null);
        if (j) {
          setJob(j);
          if (j.status !== "running" && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      }, 1000);
      setJob(await api.getCrawl(jobId));
    } catch (e: any) {
      toast(e.message, "error");
      setStage("input");
    }
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
      results.map((r) => ({ email: r.email, type: r.role_based ? "role" : "personal", confidence: r.confidence || "", method: r.method, domain: r.domain, mentions: (r.keywordsMatched || []).join(" "), source: r.source })),
      ["email", "type", "confidence", "method", "domain", "mentions", "source"]
    );
    downloadCsv("crawl-results.csv", csv);
  }

  function reset() {
    if (pollRef.current) clearInterval(pollRef.current);
    setJob(null);
    setSelected(new Set());
    setStage("input");
  }
  function close() {
    reset();
    setCompanies([]);
    setUrlCheck(null);
    onClose();
  }

  const listMode = mode === "discover" || mode === "keyword";

  return (
    <Modal open={open} onClose={close} title="Find emails" wide>
      {stage === "input" ? (
        <div className="space-y-5">
          {/* mode switch */}
          <div className="flex rounded-full border border-line bg-cream p-1 w-fit">
            {([["discover", "Discover companies"], ["keyword", "Keyword search"], ["urls", "Paste websites"]] as const).map(([m, label]) => (
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

          {/* shared options */}
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

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            {listMode ? (
              <Button onClick={crawlDiscovered} disabled={!pickedCrawlable.length}>Find emails on {pickedCrawlable.length || ""} site(s)</Button>
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
                  <span className="text-good">Done — {results.length} unique email(s) found</span>
                )}
              </span>
              <span className="text-muted">{job?.processed ?? 0}/{job?.total ?? 0} sites</span>
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

          <div ref={logRef} className="h-24 overflow-y-auto rounded-xl bg-ink px-3 py-2.5 font-mono text-[11px] leading-relaxed text-cream/80">
            {(job?.logs || []).map((l, i) => (
              <div key={i} className={cn(l.level === "hit" && "text-[#7ee7a6]", l.level === "warn" && "text-[#ffcf7a]", l.level === "fail" && "text-[#ff9a8a]")}>{l.msg}</div>
            ))}
            {!job?.logs?.length && <span className="text-cream/40">Starting…</span>}
          </div>

          {results.length > 0 && (
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
              <Button onClick={addSelected} disabled={!selected.size}>Add {selected.size || ""} to contacts</Button>
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
