import { useEffect, useRef, useState } from "react";
import { api, type Job } from "../lib/api";
import { Button, Field, Input, Modal, Select, Spinner, Textarea, toast, cn } from "../lib/ui";
import { toCsv, downloadCsv } from "../lib/csv";

interface Found {
  email: string;
  role_based: boolean;
  method: string;
  domain: string;
  source: string;
  mx?: boolean;
}
interface Company {
  name: string;
  website: string;
  city: string;
  email: string | null;
}

const FALLBACK_CATS = [
  "Accounting & Tax", "IT & Software", "Construction & Contracting", "Consulting",
  "Engineering", "Real Estate", "Legal", "Logistics & Transport",
  "Advertising & Marketing", "Insurance", "Trading & Retail", "Companies (general)",
];

export default function Crawler({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [mode, setMode] = useState<"discover" | "urls">("discover");
  const [stage, setStage] = useState<"input" | "job">("input");

  // discover
  const [cats, setCats] = useState<string[]>(FALLBACK_CATS);
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState(FALLBACK_CATS[0]);
  const [limit, setLimit] = useState(40);
  const [discovering, setDiscovering] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pickedCos, setPickedCos] = useState<Set<string>>(new Set());

  // urls
  const [urls, setUrls] = useState("");
  const [tagCountry, setTagCountry] = useState("");
  const [tagIndustry, setTagIndustry] = useState("");

  // options
  const [maxPages, setMaxPages] = useState(20);
  const [maxDepth, setMaxDepth] = useState(2);
  const [respectRobots, setRespectRobots] = useState(true);
  const [checkMx, setCheckMx] = useState(true);

  // job
  const [job, setJob] = useState<Job | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const addTags = useRef<{ country?: string; industry?: string }>({});
  const pollRef = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const running = job?.status === "running";
  const results: Found[] = job?.result?.emails || [];

  useEffect(() => {
    api.getLeadCategories().then((r) => {
      if (r.categories?.length) { setCats(r.categories); setCategory(r.categories[0]); }
    }).catch(() => {});
  }, []);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [job?.logs?.length]);

  /* ---------------------------- discover ---------------------------- */
  async function discover() {
    if (!location.trim()) return toast("Enter a country or city", "error");
    setDiscovering(true);
    setCompanies([]);
    try {
      const r = await api.findLeads(location.trim(), category, limit);
      setCompanies(r.companies);
      setPickedCos(new Set(r.companies.map((c) => c.website)));
      if (!r.companies.length) toast("No companies with websites found — try a broader area", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setDiscovering(false);
    }
  }
  function toggleCo(w: string) {
    const n = new Set(pickedCos);
    n.has(w) ? n.delete(w) : n.add(w);
    setPickedCos(n);
  }
  const allCos = companies.length > 0 && pickedCos.size === companies.length;
  const pickedWithEmail = companies.filter((c) => pickedCos.has(c.website) && c.email);

  async function addListedEmails() {
    if (!pickedWithEmail.length) return;
    try {
      const r = await api.bulkContacts(
        pickedWithEmail.map((c) => ({
          email: c.email!,
          company: c.name,
          country: location || undefined,
          industry: category || undefined,
          role_based: /^(info|sales|contact|support|admin|office)/i.test(c.email!),
          source: "osm",
        }))
      );
      toast(`Added ${r.added} listed email(s)`, "success");
      onAdded();
    } catch (e: any) {
      toast(e.message, "error");
    }
  }

  /* ------------------------------ crawl ----------------------------- */
  async function startCrawl(list: string[], tags: { country?: string; industry?: string }) {
    if (!list.length) return toast("Nothing selected to crawl", "error");
    addTags.current = tags;
    setSelected(new Set());
    setStage("job");
    setJob(null);
    try {
      const { jobId } = await api.startCrawl({ urls: list, maxPages, maxDepth, respectRobots, checkMx });
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
    const list = companies.filter((c) => pickedCos.has(c.website)).map((c) => c.website);
    startCrawl(list, { country: location || undefined, industry: category || undefined });
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
          role_based: c.role_based,
          source: "crawler",
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
      results.map((r) => ({ email: r.email, type: r.role_based ? "role" : "personal", method: r.method, domain: r.domain, source: r.source })),
      ["email", "type", "method", "domain", "source"]
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
    onClose();
  }

  return (
    <Modal open={open} onClose={close} title="Find emails" wide>
      {stage === "input" ? (
        <div className="space-y-5">
          {/* mode switch */}
          <div className="flex rounded-full border border-line bg-cream p-1 w-fit">
            {(["discover", "urls"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn("rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors", mode === m ? "bg-ink text-cream" : "text-ink/55 hover:text-ink")}
              >
                {m === "discover" ? "Discover companies" : "Paste websites"}
              </button>
            ))}
          </div>

          {mode === "discover" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
                <Field label="Country or city">
                  <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Qatar" onKeyDown={(e) => e.key === "Enter" && discover()} />
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
                <span className="text-xs text-muted">Powered by OpenStreetMap — free & open data.</span>
              </div>

              {companies.length > 0 && (
                <div className="rounded-xl border border-line">
                  <div className="flex items-center justify-between border-b border-line px-3 py-2">
                    <label className="flex items-center gap-2 text-[13px] font-medium">
                      <input type="checkbox" checked={allCos} onChange={() => setPickedCos(allCos ? new Set() : new Set(companies.map((c) => c.website)))} className="accent-ink" />
                      {companies.length} companies · {pickedCos.size} selected
                    </label>
                    {pickedWithEmail.length > 0 && (
                      <Button size="sm" variant="outline" onClick={addListedEmails}>
                        Add {pickedWithEmail.length} listed email(s)
                      </Button>
                    )}
                  </div>
                  <div className="max-h-52 overflow-y-auto">
                    {companies.map((c) => (
                      <div key={c.website} className="flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-0">
                        <input type="checkbox" checked={pickedCos.has(c.website)} onChange={() => toggleCo(c.website)} className="accent-ink" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{c.name}</div>
                          <div className="truncate text-xs text-muted">{c.website.replace(/^https?:\/\//, "")}{c.city ? ` · ${c.city}` : ""}</div>
                        </div>
                        {c.email && <span className="rounded-md bg-[#e7f6ec] px-1.5 py-0.5 text-[10px] text-[#1f8b4c]">email</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <Field label="Company websites" hint="One per line (or comma-separated). Bare domains are fine.">
                <Textarea rows={5} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={"acme-trading.com\nhttps://www.example-contractor.qa"} className="font-mono text-xs" />
              </Field>
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
            <div className="flex flex-wrap gap-4">
              <Toggle label="Respect robots.txt" checked={respectRobots} onChange={setRespectRobots} />
              <Toggle label="Verify MX (deliverability)" checked={checkMx} onChange={setCheckMx} />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            {mode === "discover" ? (
              <Button onClick={crawlDiscovered} disabled={!pickedCos.size}>Find emails on {pickedCos.size || ""} site(s)</Button>
            ) : (
              <Button onClick={crawlUrls}>Start crawl</Button>
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
                        <td className="px-1 py-2 font-medium">{r.email}</td>
                        <td className="px-1 py-2 text-xs text-muted">{r.role_based ? "role" : "personal"}</td>
                        <td className="px-1 py-2 text-xs text-muted">{r.method}</td>
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
            <div className="flex gap-2">
              <Button variant="outline" onClick={close}>Close</Button>
              <Button onClick={addSelected} disabled={!selected.size}>Add {selected.size || ""} to contacts</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2 text-[13px] font-medium text-ink/80">
      <span className={cn("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-ink" : "bg-ink/15")}>
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </span>
      {label}
    </button>
  );
}
