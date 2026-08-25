import { useEffect, useState } from "react";
import { api, PAID_TRANSPORTS, type Domain, type TransportName } from "../lib/api";
import { Button, Card, Field, Input, Modal, Select, toast, Badge, cn } from "../lib/ui";
import { Header } from "./Contacts";
import AutomationCard from "./Automation";
import FollowUpCard from "./FollowUp";

export default function Settings() {
  const [resendKey, setResendKey] = useState("");
  const [resendOn, setResendOn] = useState(false);
  const [appUrl, setAppUrl] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [editing, setEditing] = useState<Domain | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  async function load() {
    const [s, d] = await Promise.all([api.getSettings(), api.getDomains()]);
    setResendOn(s.resendConfigured);
    setAppUrl(s.appUrl || "");
    setReplyTo(s.replyTo || "");
    setDomains(d.domains);
  }
  useEffect(() => { load(); }, []);

  async function saveKey() {
    setSavingKey(true);
    try {
      await api.saveSettings({ resend_api_key: resendKey || undefined, app_url: appUrl, reply_to: replyTo });
      toast("Settings saved", "success");
      setResendKey("");
      load();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSavingKey(false);
    }
  }

  async function sendTest() {
    if (!testTo.includes("@")) return toast("Enter a valid email to send the test to", "error");
    setTesting(true);
    try {
      const r = await api.sendTestEmail(testTo.trim());
      toast(`Test sent from ${r.from}`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setTesting(false);
    }
  }

  async function removeDomain(d: Domain) {
    if (!confirm(`Remove ${d.domain}?`)) return;
    await api.deleteDomain(d.id);
    toast("Removed", "success");
    load();
  }
  async function resetCounts() {
    await api.resetCounts();
    toast("Daily counts reset", "success");
    load();
  }

  return (
    <div>
      <Header title="Settings" subtitle="Connect Resend, automate your outreach, and manage your sending domains." />

      {/* Automation — auto-approve a full pool of leads, then auto-send */}
      <div className="mb-8">
        <AutomationCard />
      </div>

      {/* Follow-up ladder — chase whoever didn't open, and whoever opened but
          didn't click, up to a hard ceiling of 3 emails per contact. */}
      <div className="mb-8">
        <FollowUpCard />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Resend */}
        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="font-clash text-lg font-semibold">Resend</div>
            <Badge className={resendOn ? "bg-[#e7f6ec] text-[#1f8b4c]" : "bg-[#fdf6ea] text-[#8a5a12]"}>
              {resendOn ? "connected" : "not connected"}
            </Badge>
          </div>
          <Field label="Resend API key" hint={resendOn ? "A key is already saved. Enter a new one to replace it." : "Get it from resend.com → API Keys."}>
            <Input type="password" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder="re_xxxxxxxx" />
          </Field>
          <Field label="App URL" hint="Public URL of THIS app's backend — used for unsubscribe & open-tracking links. e.g. https://your-api.up.railway.app">
            <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://your-api.up.railway.app" />
          </Field>
          <Field label="Reply-to email" hint="Where replies land when someone hits Reply (e.g. a real inbox you monitor). Emails send from your domain, but replies go here.">
            <Input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="inquiry@dna.systems" />
          </Field>
          <div className="flex justify-end">
            <Button loading={savingKey} onClick={saveKey}>Save</Button>
          </div>

          <div className="border-t border-line pt-4">
            <Field label="Send a test email" hint={resendOn ? "Uses your first active domain (or Resend's test sender)." : "Save a Resend API key first to enable test sends."}>
              <div className="flex gap-2">
                <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@youremail.com" disabled={!resendOn} />
                <Button variant="outline" loading={testing} onClick={sendTest} disabled={!resendOn}>Send test</Button>
              </div>
            </Field>
          </div>
        </Card>

        {/* Deliverability tips */}

        <Card className="space-y-3 p-5">
          <div className="font-clash text-lg font-semibold">Stay out of spam</div>
          <ul className="space-y-2 text-[13px] text-ink/75">
            <Tip>Send from <b>secondary domains</b> (e.g. dna-erp.com) — never your primary dna.systems.</Tip>
            <Tip>Set <b>SPF, DKIM &amp; DMARC</b> on each domain in Resend.</Tip>
            <Tip>Keep a <b>daily cap</b> per domain and a slow send rate.</Tip>
            <Tip>Keep lists clean &amp; targeted — complaints are what get accounts suspended.</Tip>
          </ul>
        </Card>
      </div>

      {/* Crawler — where pages come from, then the two optional paid tiers */}
      <div className="mt-8 space-y-3">
        <div className="mb-3 font-clash text-lg font-semibold">Crawler — page fetching</div>
        <PageSourcesCard />
        <ReaderCard />
        <ScrapeProxyCard />
      </div>

      {/* Domains */}
      <div className="mt-8">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="font-clash text-lg font-semibold">Sending domains</div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={resetCounts}>Reset daily counts</Button>
            <Button size="sm" onClick={() => setEditing({ id: "", domain: "", from_name: "DNA Systems", from_email: "", daily_cap: 40, sent_today: 0, active: true })}>Add domain</Button>
          </div>
        </div>

        {domains.length === 0 ? (
          <Card className="py-12 text-center text-sm text-muted">
            No domains yet. Add a verified secondary domain to rotate sends across.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {domains.map((d) => (
              <Card key={d.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-clash text-base font-semibold">{d.domain}</div>
                    <div className="text-[13px] text-muted">{d.from_name} &lt;{d.from_email}&gt;</div>
                  </div>
                  <Badge className={d.active ? "bg-[#e7f6ec] text-[#1f8b4c]" : "bg-ink/[0.06] text-ink/50"}>
                    {d.active ? "active" : "paused"}
                  </Badge>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="mb-1 flex justify-between text-xs text-muted">
                      <span>Today</span><span>{d.sent_today}/{d.daily_cap}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
                      <div className={cn("h-full rounded-full", d.sent_today >= d.daily_cap ? "bg-bad" : "bg-ink")} style={{ width: `${Math.min(100, (d.sent_today / Math.max(1, d.daily_cap)) * 100)}%` }} />
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEditing(d)}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-bad" onClick={() => removeDomain(d)}>Delete</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Categories */}
      <div className="mt-8">
        <div className="mb-3 font-clash text-lg font-semibold">Contact categories</div>
        <CategoriesCard />
      </div>

      {/* Account */}
      <div className="mt-8">
        <div className="mb-3 font-clash text-lg font-semibold">Account</div>
        <AccountCard />
      </div>

      {editing && (
        <DomainModal
          key={editing.id || "new"}
          domain={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function CategoriesCard() {
  const [cats, setCats] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getCategories().then((r) => setCats(r.categories || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function persist(next: string[]) {
    setBusy(true);
    try {
      const r = await api.saveCategories(next);
      setCats(r.categories || next);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const v = input.trim();
    if (!v) return;
    if (cats.some((c) => c.toLowerCase() === v.toLowerCase())) { toast("That category already exists", "info"); setInput(""); return; }
    const next = [...cats, v];
    setCats(next);
    setInput("");
    persist(next);
  }
  function remove(name: string) {
    const next = cats.filter((c) => c !== name);
    setCats(next);
    persist(next);
  }

  return (
    <Card className="space-y-4 p-5">
      <p className="text-[13px] text-muted">
        Define the categories you use to organise contacts (e.g. Customer, Partner, Reseller).
        They appear when adding contacts, finding emails, importing CSVs, and sending campaigns.
      </p>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add a category…"
          className="flex-1"
        />
        <Button variant="outline" onClick={add} loading={busy} disabled={!input.trim()}>Add</Button>
      </div>
      {loading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : cats.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
          No categories yet. Add your first one above.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {cats.map((c) => (
            <span key={c} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-cream py-1 pl-3 pr-1.5 text-[13px] font-medium">
              {c}
              <button
                onClick={() => remove(c)}
                className="grid h-5 w-5 place-items-center rounded-full text-ink/40 transition-colors hover:bg-ink/10 hover:text-ink"
                title={`Remove ${c}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

const PROVIDERS: { value: string; label: string; hint: string }[] = [
  { value: "", label: "None (disabled)", hint: "" },
  { value: "scrapingbee", label: "ScrapingBee", hint: "scrapingbee.com" },
  { value: "scraperapi", label: "ScraperAPI", hint: "scraperapi.com" },
  { value: "zenrows", label: "ZenRows", hint: "zenrows.com" },
];


/* --------------------------- where pages come from --------------------------- */

// The tiers, in the order the crawler actually tries them.
const TIERS: { key: TransportName; label: string; note: string; paid: boolean }[] = [
  { key: "direct", label: "Direct fetch", note: "the site answered us", paid: false },
  { key: "commoncrawl", label: "Common Crawl", note: "already crawled by the public archive", paid: false },
  { key: "archive", label: "Wayback Machine", note: "already archived", paid: false },
  { key: "reader", label: "Jina reader", note: "renders JavaScript · costs tokens", paid: true },
  { key: "proxy", label: "Scraping proxy", note: "residential IPs · costs credits", paid: true },
];

/**
 * The answer to "why is the Jina bill so high?".
 *
 * Before this panel existed there was no way to see which tier was doing the
 * work, so the reader quietly absorbed every blocked page and the keys kept
 * running dry. The bar makes the split obvious at a glance: as long as the
 * paid slice stays thin, the archives are earning their keep.
 */
function PageSourcesCard() {
  const [pages, setPages] = useState<Record<string, { calls: number; ok: number }>>({});
  const [archives, setArchives] = useState<{ source: string; fails: number; downForMs: number }[]>([]);
  const [engines, setEngines] = useState<{ engine: string; live: boolean; restingForMs: number; note?: string }[]>([]);

  async function load() {
    try {
      const s = await api.getSettings();
      setPages(s.transports?.pages || {});
      setArchives(s.transports?.archives || []);
      setEngines(s.transports?.searchEngines || []);
    } catch { /* ignore — the poller retries */ }
  }
  useEffect(() => {
    load();
    const t = window.setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  // Count only pages a tier actually DELIVERED. Attempts would flatter the
  // free tiers (a Common Crawl miss is cheap but useless) and unfairly punish
  // the reader, which is only ever asked for the hard ones.
  const got = (k: TransportName) => pages[k]?.ok ?? 0;
  const total = TIERS.reduce((n, t) => n + got(t.key), 0);
  const paid = PAID_TRANSPORTS.reduce((n, k) => n + got(k), 0);
  const freeShare = total ? Math.round(((total - paid) / total) * 100) : 0;
  const liveEngines = engines.filter((e) => e.live).length;

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div className="font-clash text-lg font-semibold">Where pages come from</div>
        {total > 0 && (
          <Badge className={freeShare >= 80 ? "bg-[#e7f6ec] text-[#1f8b4c]" : freeShare >= 50 ? "bg-[#fdf6ea] text-[#8a5a12]" : "bg-[#fde8e8] text-[#c0392b]"}>
            {freeShare}% free
          </Badge>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-muted">
        A Cloudflare wall isn't a property of the page — it's a property of us asking for it from a datacenter IP.
        Somebody else already fetched that page and wrote it down, so the crawler reads <b>their</b> copy first:
        Common Crawl and the Wayback Machine are free, unlimited and need no key. The metered tiers below are only
        reached when neither archive holds the page.
      </p>

      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[12px] text-muted">
          Nothing fetched yet this run. Turn the discovery bot on and the split appears here.
        </div>
      ) : (
        <>
          {/* free vs paid, at a glance */}
          <div className="flex h-2 overflow-hidden rounded-full bg-ink/[0.07]">
            {TIERS.filter((t) => got(t.key) > 0).map((t) => (
              <div
                key={t.key}
                title={`${t.label}: ${got(t.key).toLocaleString()} page(s)`}
                className={cn("h-full", t.paid ? (t.key === "reader" ? "bg-[#e6a33c]" : "bg-[#c0392b]") : t.key === "direct" ? "bg-ink/70" : "bg-good")}
                style={{ width: `${(got(t.key) / total) * 100}%` }}
              />
            ))}
          </div>

          <div className="space-y-1">
            {TIERS.map((t) => {
              const n = got(t.key);
              const tried = pages[t.key]?.calls ?? 0;
              return (
                <div key={t.key} className={cn("flex items-baseline justify-between gap-3 text-[12px]", !n && "opacity-45")}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.paid ? (t.key === "reader" ? "bg-[#e6a33c]" : "bg-[#c0392b]") : t.key === "direct" ? "bg-ink/70" : "bg-good")} />
                    <span className="font-medium text-ink/80">{t.label}</span>
                    {t.paid && <span className="rounded bg-[#fdf6ea] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#8a5a12]">paid</span>}
                    <span className="truncate text-muted">{t.note}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-ink/70">
                    <b>{n.toLocaleString()}</b>
                    <span className="text-muted"> / {tried.toLocaleString()} tried</span>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[11px] text-muted">
        <span>
          Search engines: <b className="text-ink/70">{liveEngines}/{engines.length || 4}</b> answering
          {engines.filter((e) => !e.live).length > 0 && (
            <>
              {" "}· resting:{" "}
              {engines
                .filter((e) => !e.live)
                .map((e) => (e.note ? `${e.engine} (${e.note})` : e.engine))
                .join(", ")}
            </>
          )}
        </span>
        {engines.some((e) => (e.note || "").includes("ignor")) && (
          <span className="text-[#8a5a12]">
            Some engines are returning results that ignore the country/site filter — they’re paused, and those results are being discarded rather than saved. Adding a free Jina key above restores full-speed, accurate searching.
          </span>
        )}
        {archives.length > 0 && (
          <span className="text-[#8a5a12]">
            Archive backing off: {archives.map((a) => `${a.source} (${Math.ceil(a.downForMs / 60000)}m)`).join(", ")}
          </span>
        )}
      </div>
    </Card>
  );
}

function ReaderCard() {
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [fromEnv, setFromEnv] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [keys, setKeys] = useState<{ masked: string; live: boolean; status: number }[]>([]);
  const [removing, setRemoving] = useState("");

  async function load() {
    try {
      const s = await api.getSettings();
      setConfigured(s.reader.configured);
      setFromEnv(s.reader.fromEnv);
      setKeys(s.reader.keys || []);
    } catch { /* ignore */ }
  }
  useEffect(() => { load(); }, []);
  const keyed = configured || fromEnv;
  const liveCount = keys.filter((k) => k.live).length;

  // Append, never replace. Pasting a second key used to wipe the first,
  // because the field saved its whole contents and cleared itself afterwards.
  async function add() {
    if (!apiKey.trim()) return;
    setAdding(true);
    try {
      const r = await api.addReaderKey(apiKey);
      setApiKey("");
      await load();
      if (r.added && r.duplicates) toast(`Added ${r.added} key — ${r.duplicates} already saved`, "success");
      else if (r.added) toast(r.total > 1 ? `Key added — ${r.total} in the pool` : "Key added", "success");
      else toast("That key is already saved", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setAdding(false);
    }
  }
  async function remove(masked: string) {
    setRemoving(masked);
    try {
      await api.removeReaderKey(masked);
      await load();
      toast("Key removed", "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setRemoving("");
    }
  }
  async function test() {
    setTesting(true);
    try {
      const r = await api.testReader();
      toast(`Free reader works — rendered ${r.bytes.toLocaleString()} bytes${r.keyed ? " (with your key)" : ""}`, "success");
      load(); // a 402 during the test retires the key — reflect that immediately
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div className="font-clash text-lg font-semibold">Jina reader <span className="text-muted">(metered fallback)</span></div>
        <Badge className={liveCount > 0 ? "bg-[#e7f6ec] text-[#1f8b4c]" : keyed ? "bg-[#fde8e8] text-[#c0392b]" : "bg-ink/[0.06] text-ink/55"}>
          {liveCount > 0 ? `${liveCount} key${liveCount > 1 ? "s" : ""} live` : keyed ? "keys spent" : "no key · optional"}
        </Badge>
      </div>
      <p className="text-[13px] leading-relaxed text-muted">
        Renders JavaScript, which is the one thing the free archives can't do. It now sits <b>below</b> them in the
        ladder, so it is only asked for pages that Common Crawl and the Wayback Machine don't hold — that is what
        stops the keys burning through tokens. <b>You do not need a key for the crawler to work</b>; without one it
        simply runs slower on that last slice of pages.{" "}
        {keyed
          ? <>Each key from <a href="https://jina.ai/api-dashboard" target="_blank" rel="noreferrer" className="underline">jina.ai</a> carries its own allowance, and the crawler rotates through them.</>
          : <>If you do add one, get it free at <a href="https://jina.ai/api-dashboard" target="_blank" rel="noreferrer" className="underline">jina.ai</a>.</>}
        {fromEnv && <span className="text-good"> A key is also set via the server environment.</span>}
      </p>

      {/* The saved pool. Keys are listed as fingerprints, never in full, and are
          removed one at a time — so adding a key can't destroy the others. */}
      {keys.length > 0 && (
        <div className="space-y-1.5">
          {keys.map((k) => (
            <div
              key={k.masked}
              className={cn(
                "flex items-center justify-between rounded-xl border px-3 py-2",
                k.live ? "border-line bg-paper" : "border-bad/30 bg-bad/[0.04]"
              )}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", k.live ? "bg-good" : "bg-bad")} />
                <code className="truncate font-mono text-[12px] text-ink/75">{k.masked}</code>
                {!k.live && (
                  <span className="shrink-0 text-[11px] text-bad">
                    {k.status === 402 ? "out of tokens" : k.status === 401 ? "invalid" : "not working"}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => remove(k.masked)}
                disabled={removing === k.masked}
                className="shrink-0 text-[11px] font-medium text-muted underline transition-colors hover:text-bad disabled:opacity-40"
              >
                {removing === k.masked ? "removing…" : "remove"}
              </button>
            </div>
          ))}
        </div>
      )}

      <Field
        label={keys.length ? "Add another key" : "Jina Reader API key"}
        hint={
          keys.length
            ? "Paste one key and press Add. Your existing keys are kept."
            : "Optional. Without a key the reader still runs at 20 pages/min — and it is the last tier tried, so that is rarely the bottleneck."
        }
      >
        <div className="flex gap-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder="jina_…"
            className="flex-1"
          />
          <Button loading={adding} onClick={add} disabled={!apiKey.trim()}>Add</Button>
        </div>
      </Field>

      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-muted">Tried after the free archives, before any paid proxy.</span>
        <Button variant="outline" loading={testing} onClick={test}>Test</Button>
      </div>
    </Card>
  );
}

function ScrapeProxyCard() {
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState<"blocked" | "always">("blocked");
  const [premium, setPremium] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function load() {
    try {
      const s = await api.getSettings();
      setProvider(s.scrape.provider || "");
      setMode(s.scrape.mode);
      setPremium(s.scrape.premium);
      setConfigured(s.scrape.configured);
    } catch { /* ignore */ }
  }
  useEffect(() => { load(); }, []);

  const on = configured && !!provider;

  async function save() {
    if (provider && !apiKey && !configured) return toast("Enter your provider API key first", "error");
    setSaving(true);
    try {
      await api.saveSettings({
        scrape_provider: provider,
        scrape_api_key: apiKey || undefined,
        scrape_mode: mode,
        scrape_premium: premium,
      });
      toast(provider ? "Scraping proxy saved" : "Scraping proxy disabled", "success");
      setApiKey("");
      load();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      const r = await api.testScrape();
      toast(`Proxy works — fetched ${r.bytes.toLocaleString()} bytes through ${r.provider}`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setTesting(false);
    }
  }

  const selected = PROVIDERS.find((p) => p.value === provider);

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div className="font-clash text-lg font-semibold">Scraping proxy</div>
        <Badge className={on ? "bg-[#e7f6ec] text-[#1f8b4c]" : "bg-[#fdf6ea] text-[#8a5a12]"}>
          {on ? "connected" : "not connected"}
        </Badge>
      </div>
      <p className="text-[13px] text-muted">
        <b>Optional.</b> The free reader above already handles most JavaScript / Cloudflare-blocked
        sites, so you usually don't need this. Connect a paid provider only if you want an extra
        fallback for the hardest sites. (Note: none of these can read login-walled Facebook/Instagram.)
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </Field>
        <Field
          label="API key"
          hint={
            !provider
              ? "Choose a provider to enable."
              : configured
              ? `A key is saved. Enter a new one to replace it.${selected?.hint ? ` Get it from ${selected.hint}.` : ""}`
              : selected?.hint ? `Get it from ${selected.hint}.` : undefined
          }
        >
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider ? "Paste your API key" : "—"}
            disabled={!provider}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="When to use it">
          <Select value={mode} onChange={(e) => setMode(e.target.value as "blocked" | "always")} disabled={!provider}>
            <option value="blocked">Only when a site blocks the crawler (recommended)</option>
            <option value="always">Every request (slower, more credits)</option>
          </Select>
        </Field>
        <div className="flex items-end">
          <label className={cn("flex items-center gap-2 text-sm", !provider && "opacity-50")}>
            <input
              type="checkbox"
              checked={premium}
              onChange={(e) => setPremium(e.target.checked)}
              disabled={!provider}
              className="h-[18px] w-[18px] shrink-0 accent-ink"
            />
            Premium / stealth mode <span className="text-muted">(needed for Cloudflare)</span>
          </label>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-muted">
          {mode === "blocked"
            ? "Credits are only spent on sites that actually block the crawler."
            : "Every page is fetched through the proxy."}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" loading={testing} onClick={test} disabled={!on}>Test</Button>
          <Button loading={saving} onClick={save}>Save</Button>
        </div>
      </div>
    </Card>
  );
}

function AccountCard() {
  const [current, setCurrent] = useState("");
  const [username, setUsername] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!current) return toast("Enter your current password to confirm changes", "error");
    if (next && next !== confirm) return toast("New passwords don't match", "error");
    if (next && next.length < 6) return toast("New password must be at least 6 characters", "error");
    if (!username.trim() && !next) return toast("Nothing to change", "info");
    setBusy(true);
    try {
      const r = await api.updateAccount({
        currentPassword: current,
        username: username.trim() || undefined,
        newPassword: next || undefined,
      });
      toast(`Account updated${username.trim() ? ` — username is now "${r.username}"` : ""}`, "success");
      setCurrent(""); setUsername(""); setNext(""); setConfirm("");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <p className="text-[13px] text-muted">
        Change your login username or password. Enter your current password to confirm.
      </p>
      <Field label="Current password">
        <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" autoComplete="current-password" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="New username" hint="Leave blank to keep it.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="New username" autoComplete="username" />
        </Field>
        <Field label="New password" hint="Leave blank to keep it.">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password" autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat new password" autoComplete="new-password" />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button loading={busy} onClick={save}>Update account</Button>
      </div>
    </Card>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="prism-text font-bold">›</span>
      <span>{children}</span>
    </li>
  );
}

function DomainModal({ domain, onClose, onSaved }: { domain: Domain; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(domain);
  const [busy, setBusy] = useState(false);

  // Resolve what the From email will actually be saved as (auto-append domain if the
  // user typed only a mailbox like "no-reply").
  const resolvedFrom =
    d.from_email && !d.from_email.includes("@") && d.domain
      ? `${d.from_email.trim()}@${d.domain.trim()}`
      : d.from_email.trim();
  const fromValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resolvedFrom);

  function completeEmail() {
    if (d.from_email && !d.from_email.includes("@") && d.domain) {
      setD((s) => ({ ...s, from_email: `${s.from_email.trim()}@${s.domain.trim()}` }));
    }
  }

  async function save() {
    if (!d.domain.trim()) return toast("Domain is required", "error");
    if (!fromValid) return toast("Enter a full From email like no-reply@" + (d.domain || "yourdomain.com"), "error");
    setBusy(true);
    try {
      const payload = { ...d, from_email: resolvedFrom };
      if (d.id) await api.updateDomain(d.id, payload);
      else await api.saveDomain(payload);
      toast("Saved", "success");
      onSaved();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={d.id ? "Edit domain" : "Add sending domain"}>
      <div className="space-y-4">
        <Field label="Domain" hint="A domain you've verified in Resend (SPF/DKIM added).">
          <Input value={d.domain} onChange={(e) => setD({ ...d, domain: e.target.value })} placeholder="dna-erp.com" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="From name">
            <Input value={d.from_name} onChange={(e) => setD({ ...d, from_name: e.target.value })} placeholder="Solution ERP" />
          </Field>
          <Field label="Daily cap">
            <Input type="number" value={d.daily_cap} onChange={(e) => setD({ ...d, daily_cap: Number(e.target.value) })} />
          </Field>
        </div>
        <Field
          label="From email"
          hint={
            d.from_email && !d.from_email.includes("@") && d.domain
              ? `Will be saved as ${resolvedFrom}`
              : "The full address emails are sent from — must be on the verified domain above."
          }
        >
          <Input
            value={d.from_email}
            onChange={(e) => setD({ ...d, from_email: e.target.value })}
            onBlur={completeEmail}
            placeholder="no-reply@dna-erp.com"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} className="h-[18px] w-[18px] accent-ink" />
          Active (include in rotation)
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={save}>Save domain</Button>
        </div>
      </div>
    </Modal>
  );
}
