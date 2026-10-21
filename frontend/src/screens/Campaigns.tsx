// Campaigns — the AI lead engine. List -> new-campaign wizard -> campaign view.
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, PageHeader, Spinner, toast } from "../lib/ui";
import { ago } from "../lib/v2/core";
import { campaignsApi, type CampaignReadiness, type CampaignSummary } from "../lib/v2/campaigns";
import CampaignView from "./campaigns/CampaignView";
import Wizard from "./campaigns/Wizard";
import { Empty, MiniFunnel, ReadinessStrip, StatusChip, errMsg } from "./campaigns/parts";

type View = { kind: "list" } | { kind: "wizard"; id?: string } | { kind: "campaign"; id: string };
const OPEN_KEY = "dnaCampaignOpen";

function initialView(): View {
  try {
    const id = localStorage.getItem(OPEN_KEY);
    if (id) return { kind: "campaign", id };
  } catch {
    /* private mode */
  }
  return { kind: "list" };
}

export default function Campaigns() {
  const [view, setViewState] = useState<View>(initialView);
  const setView = (v: View) => {
    setViewState(v);
    try {
      if (v.kind === "campaign") localStorage.setItem(OPEN_KEY, v.id);
      else localStorage.removeItem(OPEN_KEY);
    } catch {
      /* private mode */
    }
    window.scrollTo({ top: 0 });
  };

  if (view.kind === "wizard") return <Wizard resumeId={view.id} onCancel={() => setView({ kind: "list" })} onOpen={(id) => setView({ kind: "campaign", id })} />;
  if (view.kind === "campaign") return <CampaignView key={view.id} id={view.id} onBack={() => setView({ kind: "list" })} onResumeSetup={(id) => setView({ kind: "wizard", id })} />;
  return <CampaignList onNew={() => setView({ kind: "wizard" })} onOpen={(id) => setView({ kind: "campaign", id })} />;
}

const STEPS = [
  ["Learn the offer", "Give it your website. It reads the pages and writes down what you sell, for whom, and the facts it may use."],
  ["Pick ideal customers", "It suggests segments: industry, country, company size, the people to reach and the searches that find them."],
  ["Find and research", "Every day it finds companies, reads their sites, finds the decision maker and checks the address."],
  ["Write and send", "It writes a short personal email and follow-ups. You approve them, and Instantly sends from your warmed mailboxes."],
];

function CampaignList({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [data, setData] = useState<{ campaigns: CampaignSummary[]; readiness: CampaignReadiness } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    campaignsApi
      .list()
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => {
        setError(errMsg(e));
        if (data) toast(errMsg(e), "error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  const header = (
    <PageHeader
      title="Campaigns"
      subtitle="The agent finds companies that fit, researches them, finds the right person and writes a short personal email. You stay in control of what goes out."
      actions={<Button size="sm" onClick={onNew}>New campaign</Button>}
    />
  );

  if (!data) {
    return (
      <div>
        {header}
        {error ? (
          <Empty title="Couldn't load campaigns" body={error} action={<Button onClick={load}>Try again</Button>} />
        ) : (
          <div className="flex items-center gap-2 py-20 text-muted">
            <Spinner /> Loading campaigns…
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {header}
      <ReadinessStrip r={data.readiness} />
      {!data.campaigns.length ? (
        <Card className="p-6 sm:p-8">
          <div className="text-[17px] font-[650] tracking-[-0.01em]">Start your first campaign</div>
          <p className="mt-1 max-w-[640px] text-[13.5px] leading-relaxed text-muted">
            It can begin researching and writing today, while your mailboxes are still warming up. Nothing is sent until a mailbox is ready and you've approved the emails.
          </p>
          <ol className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="rounded-xl border border-line-soft bg-surf2 px-4 py-3.5">
                <div className="mono-label mb-1.5">Step {i + 1}</div>
                <div className="text-[14px] font-semibold">{title}</div>
                <div className="mt-1 text-[12.5px] leading-relaxed text-muted">{body}</div>
              </li>
            ))}
          </ol>
          <div className="mt-5">
            <Button onClick={onNew}>New campaign</Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.campaigns.map((c) => {
            const review = c.funnel.written;
            return (
              <button key={c.id} type="button" onClick={() => onOpen(c.id)} className="text-left">
                <Card className="h-full p-4 transition-colors hover:border-line-strong sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-[650] tracking-[-0.01em]">{c.name}</div>
                      <div className="mt-0.5 truncate text-[12.5px] text-muted">
                        {c.kind === "partner" ? "Partners" : "Customers"} · {c.segments} segment{c.segments === 1 ? "" : "s"}
                        {c.website ? ` · ${c.website.replace(/^https?:\/\//, "")}` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {review > 0 && <Badge className="bg-wnb text-warn">{review} to review</Badge>}
                      <StatusChip status={c.status} />
                    </div>
                  </div>
                  <div className="mt-4">
                    <MiniFunnel funnel={c.funnel} />
                  </div>
                  {c.lastError ? (
                    <p className="mt-3 truncate text-[12.5px] text-bad" title={c.lastError}>
                      {c.lastError}
                    </p>
                  ) : (
                    <p className="mt-3 text-[12px] text-muted">Updated {ago(c.updatedAt)}</p>
                  )}
                </Card>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
