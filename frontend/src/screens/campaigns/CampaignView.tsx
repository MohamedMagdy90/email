// One campaign: status and actions, funnel, what's waiting, and the tabs.
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Field, Input, PageHeader, Select, Spinner, cn, toast } from "../../lib/ui";
import { ago, v2, type AgentEvent } from "../../lib/v2/core";
import { campaignsApi, type CampaignDetail, type CampaignSettings, type Offer, type RunResult, type StageGroup } from "../../lib/v2/campaigns";
import { OfferForm, OfferSource, SettingsForm } from "./forms";
import { LeadsTab, ReviewTab } from "./Leads";
import LeadDrawer from "../leads/LeadDrawer";
import { Empty, StatusChip, errMsg, reached, replies } from "./parts";
import TargetingPanel from "../targeting/TargetingPanel";
import SequenceEditor from "../sequences/Editor";

type Tab = "review" | "leads" | "sequence" | "targeting" | "offer" | "settings" | "activity";

export default function CampaignView({ id, onBack, onResumeSetup }: { id: string; onBack: () => void; onResumeSetup: (id: string) => void }) {
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [group, setGroup] = useState<StageGroup>("all");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [lead, setLead] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await campaignsApi.get(id);
      setC(r.campaign);
      setError(null);
      setTab((t) => t || (r.campaign.reviewCount > 0 ? "review" : "leads"));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [id]);

  const refresh = useCallback(async () => {
    await load();
    setVersion((v) => v + 1);
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while the agent works on it.
  useEffect(() => {
    if (!c || (c.status !== "active" && !c.working)) return;
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, 15000);
    return () => clearInterval(t);
  }, [c?.status, c?.working, refresh]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  if (!c) {
    return (
      <div>
        <PageHeader title="Campaign" actions={<Button variant="ghost" size="sm" onClick={onBack}>All campaigns</Button>} />
        {error ? <Empty title="Couldn't load the campaign" body={error} action={<Button onClick={load}>Try again</Button>} /> : <div className="flex items-center gap-2 py-20 text-muted"><Spinner /> Loading…</div>}
      </div>
    );
  }

  const f = c.funnel;
  const tiles: { label: string; value: number; sub: string; g: StageGroup; keep?: boolean }[] = [
    { label: "Found", value: f.total, sub: `${c.today.discovered} today`, g: "all" },
    { label: "Researched", value: reached(f, "researched"), sub: `${c.today.researched} today`, g: "pipeline" },
    { label: "Verified", value: reached(f, "verified"), sub: "address checked", g: "pipeline" },
    { label: "To review", value: f.written, sub: c.settings.reviewFirst ? "waiting for you" : "review is off", g: "review", keep: f.written > 0 },
    { label: "Queued", value: f.approved + f.queued, sub: `${c.today.queued} of ${c.today.queueLimit} today`, g: "outreach" },
    { label: "Sent", value: reached(f, "sent"), sub: c.stats?.bounced ? `${c.stats.bounced} bounced` : "first emails", g: "outreach" },
    { label: "Replies", value: replies(f), sub: `${f.interested + f.meeting + f.won} positive`, g: "replies" },
    { label: "Skipped", value: f.skipped + f.failed, sub: "fit, policy or no contact", g: "excluded" },
  ];
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "review", label: "Review", badge: c.reviewCount },
    { id: "leads", label: "Leads" },
    { id: "sequence", label: "Sequence" },
    { id: "targeting", label: "Targeting" },
    { id: "offer", label: "Offer" },
    { id: "settings", label: "Settings" },
    { id: "activity", label: "Activity" },
  ];
  const setupIncomplete = !c.offer || !c.segmentList.length;

  return (
    <div>
      <PageHeader
        title={c.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusChip status={c.status} working={c.working} />
            <span>{c.kind === "partner" ? "Partners" : "Customers"}</span>
            {c.website && <span className="text-muted">· {c.website.replace(/^https?:\/\//, "")}</span>}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onBack}>
              All campaigns
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={busy === "run"}
              disabled={c.working}
              onClick={() =>
                act("run", async () => {
                  const r = await campaignsApi.run(c.id);
                  setC(r.campaign);
                  setLastRun(r.ran);
                  setVersion((v) => v + 1);
                })
              }
            >
              {c.working ? "Working…" : "Run a pass now"}
            </Button>
            {c.status === "active" ? (
              <Button size="sm" variant="outline" loading={busy === "pause"} onClick={() => act("pause", async () => setC((await campaignsApi.pause(c.id)).campaign))}>
                Pause
              </Button>
            ) : c.status !== "archived" ? (
              <Button size="sm" loading={busy === "start"} onClick={() => act("start", async () => (setC((await campaignsApi.start(c.id)).campaign), toast("Campaign started.", "success")))}>
                {c.status === "paused" ? "Resume" : "Start campaign"}
              </Button>
            ) : null}
          </>
        }
      />

      {setupIncomplete && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-keepl bg-keep1 px-4 py-3">
          <p className="text-[13px]">Setup isn't finished: {!c.offer ? "the offer is missing" : "there are no segments yet"}.</p>
          <Button size="sm" onClick={() => onResumeSetup(c.id)}>
            Finish setup
          </Button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
        {tiles.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => {
              if (t.g === "review") setTab("review");
              else {
                setGroup(t.g);
                setTab("leads");
              }
            }}
            className={cn(t.keep ? "hb keep" : "hb", "!px-3.5 !py-3 text-left transition-colors hover:border-line-strong")}
          >
            <div className="mono-label mb-1.5 truncate">{t.label}</div>
            <div className="text-[1.35rem] font-bold leading-none tracking-[-0.02em] tabular-nums">{t.value.toLocaleString()}</div>
            <div className="mt-1.5 truncate text-[11.5px] text-muted">{t.sub}</div>
          </button>
        ))}
      </div>

      {c.lastError && <div className="mb-3 rounded-xl border border-dgl bg-dgb px-4 py-3 text-[13px] text-bad">{c.lastError}</div>}

      {c.blockers.length > 0 && (
        <Card className="mb-4 px-4 py-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">What's waiting</div>
          <ul className="space-y-1.5">
            {c.blockers.map((b) => (
              <li key={b} className="flex gap-2 text-[13px] leading-snug">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {lastRun && (
        <Card className="mb-4 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">
                Last pass: {lastRun.discovered} found · {lastRun.researched} researched · {lastRun.contacted} contacts · {lastRun.verified} verified · {lastRun.written} written · {lastRun.queued} queued
              </div>
              {lastRun.notes.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-muted">
                  {lastRun.notes.slice(0, 8).map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setLastRun(null)}>
              Dismiss
            </Button>
          </div>
        </Card>
      )}

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line-soft">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn("-mb-px inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-[13px] font-semibold transition-colors", tab === t.id ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {t.label}
            {!!t.badge && <span className="badge">{t.badge}</span>}
          </button>
        ))}
      </nav>

      {tab === "review" && <ReviewTab c={c} version={version} onChanged={load} onOpenLead={setLead} />}
      {tab === "leads" && <LeadsTab c={c} version={version} group={group} setGroup={setGroup} onOpenLead={setLead} />}
      {tab === "sequence" && <SequenceEditor campaignId={c.id} onSaved={() => setVersion((v) => v + 1)} />}
      {tab === "targeting" && <TargetingPanel c={c} reload={refresh} onCampaign={setC} initial={c.segmentList.length ? "segments" : "market"} />}
      {tab === "offer" && <OfferTab c={c} onSaved={setC} />}
      {tab === "settings" && <SettingsTab c={c} onSaved={setC} onArchived={onBack} />}
      {tab === "activity" && <ActivityTab id={c.id} version={version} />}

      {lead && <LeadDrawer pid={lead} onClose={() => setLead(null)} onChanged={refresh} />}
    </div>
  );
}

/* --------------------------------- offer -------------------------------- */

function OfferTab({ c, onSaved }: { c: CampaignDetail; onSaved: (c: CampaignDetail) => void }) {
  const [offer, setOffer] = useState<Offer | null>(c.offer);
  const [website, setWebsite] = useState(c.website || "https://dna.systems");
  const [busy, setBusy] = useState<string | null>(null);
  const dirty = JSON.stringify(offer) !== JSON.stringify(c.offer);
  return (
    <Card className="space-y-5 p-5 sm:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex items-center gap-2">
          <div className="text-[15px] font-[650] tracking-[-0.01em]">What you sell</div>
          {c.offer && <OfferSource offer={c.offer} />}
          {c.offer?.learnedAt && <span className="text-[12px] text-muted">learned {ago(c.offer.learnedAt)}</span>}
        </div>
        <div className="flex gap-2">
          <Input value={website} onChange={(e) => setWebsite(e.target.value)} className="h-8 py-0 text-[12.5px] md:w-[240px]" />
          <Button
            variant="outline"
            size="sm"
            loading={busy === "learn"}
            onClick={async () => {
              if (dirty && !confirm("Learning again replaces your unsaved edits. Continue?")) return;
              setBusy("learn");
              try {
                const r = await campaignsApi.learnOffer(c.id, website);
                onSaved(r.campaign);
                setOffer(r.campaign.offer);
                toast(r.warning || "Offer learned from the website.", r.warning ? "info" : "success");
              } catch (e) {
                toast(errMsg(e), "error");
              } finally {
                setBusy(null);
              }
            }}
          >
            Learn again
          </Button>
        </div>
      </div>
      {offer ? <OfferForm offer={offer} onChange={setOffer} /> : <Empty title="No offer yet" body="Learn it from the website above. Every email is built on it." />}
      {offer && (
        <div className="flex justify-end border-t border-line-soft pt-4">
          <Button
            disabled={!dirty}
            loading={busy === "save"}
            onClick={async () => {
              setBusy("save");
              try {
                const r = await campaignsApi.update(c.id, { offer });
                onSaved(r.campaign);
                setOffer(r.campaign.offer);
                toast("Offer saved.", "success");
              } catch (e) {
                toast(errMsg(e), "error");
              } finally {
                setBusy(null);
              }
            }}
          >
            Save offer
          </Button>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------- settings ------------------------------- */

function SettingsTab({ c, onSaved, onArchived }: { c: CampaignDetail; onSaved: (c: CampaignDetail) => void; onArchived: () => void }) {
  const [settings, setSettings] = useState<CampaignSettings>(c.settings);
  const [name, setName] = useState(c.name);
  const [kind, setKind] = useState(c.kind);
  const [busy, setBusy] = useState<string | null>(null);
  const dirty = JSON.stringify(settings) !== JSON.stringify(c.settings) || name !== c.name || kind !== c.kind;
  return (
    <div className="space-y-4">
      <Card className="space-y-5 p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Campaign name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Reaching">
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="customer">Customers</option>
              <option value="partner">Partners</option>
            </Select>
          </Field>
        </div>
        <SettingsForm value={settings} onChange={setSettings} />
        <div className="flex justify-end border-t border-line-soft pt-4">
          <Button
            disabled={!dirty}
            loading={busy === "save"}
            onClick={async () => {
              setBusy("save");
              try {
                const r = await campaignsApi.update(c.id, { name: name.trim(), kind, settings });
                onSaved(r.campaign);
                setSettings(r.campaign.settings);
                toast("Settings saved.", "success");
              } catch (e) {
                toast(errMsg(e), "error");
              } finally {
                setBusy(null);
              }
            }}
          >
            Save settings
          </Button>
        </div>
      </Card>
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <div className="text-[13.5px] font-semibold">{c.status === "draft" && !c.instantly.id ? "Delete this campaign" : "Archive this campaign"}</div>
          <p className="text-[12.5px] text-muted">{c.status === "draft" && !c.instantly.id ? "Nothing was sent, so it's removed with its leads." : "Stops it and pauses the Instantly campaign. Leads and history are kept."}</p>
        </div>
        <Button
          variant="danger"
          size="sm"
          loading={busy === "remove"}
          onClick={async () => {
            if (!confirm(`${c.status === "draft" && !c.instantly.id ? "Delete" : "Archive"} "${c.name}"?`)) return;
            setBusy("remove");
            try {
              await campaignsApi.remove(c.id);
              onArchived();
            } catch (e) {
              toast(errMsg(e), "error");
              setBusy(null);
            }
          }}
        >
          {c.status === "draft" && !c.instantly.id ? "Delete" : "Archive"}
        </Button>
      </Card>
    </div>
  );
}

/* ------------------------------- activity ------------------------------- */

function ActivityTab({ id, version }: { id: string; version: number }) {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  useEffect(() => {
    v2.events({ campaignId: id, limit: 150 })
      .then((r) => setEvents(r.events))
      .catch((e) => toast(errMsg(e), "error"));
  }, [id, version]);
  if (!events) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted">
        <Spinner /> Loading activity…
      </div>
    );
  }
  if (!events.length) return <Empty title="No activity yet" body="Everything the agent does for this campaign is written here in plain words." />;
  const tone: Record<string, string> = { success: "bg-good", warn: "bg-warn", error: "bg-bad", info: "bg-ink/30" };
  return (
    <Card className="divide-y divide-line-soft">
      {events.map((e) => (
        <div key={e.id} className="flex gap-3 px-4 py-2.5">
          <span className={cn("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", tone[e.level] || tone.info)} />
          <div className="min-w-0 flex-1 text-[13px] leading-snug">{e.message}</div>
          <div className="shrink-0 whitespace-nowrap text-[12px] text-muted">{ago(e.created_at)}</div>
        </div>
      ))}
    </Card>
  );
}
