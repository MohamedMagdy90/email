// Targeting tab — who each campaign goes after, and what's working.
// Uses the shared campaign filter (plan §8.1):
//   All campaigns -> the results board across campaigns (offers side by side,
//                    every segment with its loop status) + the global
//                    do-not-contact list.
//   one campaign  -> Results · Market · Segments · Never contact, with
//                    steer-by-chat above Results and Segments.
import { useCallback, useEffect, useState } from "react";
import { Button, PageHeader, Spinner, cn, toast } from "../lib/ui";
import { campaignsApi, type CampaignDetail } from "../lib/v2/campaigns";
import { Empty, StatusChip, errMsg, goTab } from "./campaigns/parts";
import { CampaignFilter, useCampaignFilter, useCampaignList } from "./shared/CampaignFilter";
import NeverContact from "./targeting/NeverContact";
import Results from "./targeting/Results";
import TargetingPanel from "./targeting/TargetingPanel";

const FOCUS_KEY = "dnaTargetingSegment";

type Focus = { sid: string; n: number; cid: string };

/** A segment handed over by openSegment(), with the campaign it belongs to.
 * Peeked in the initialiser (StrictMode may run it twice), cleared once mounted. */
function peekFocus(): Focus | null {
  try {
    const sid = localStorage.getItem(FOCUS_KEY);
    return sid ? { sid, n: 1, cid: localStorage.getItem("dnaCampaignFilter") || "" } : null;
  } catch {
    return null;
  }
}
function clearFocus() {
  try {
    localStorage.removeItem(FOCUS_KEY);
  } catch {
    /* private mode */
  }
}

type AllSection = "results" | "never";

export default function Targeting() {
  const [campaign, setCampaign] = useCampaignFilter();
  const list = useCampaignList();
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(peekFocus);
  const [allSection, setAllSection] = useState<AllSection>("results");
  // "Edit" on the all-campaigns board: switch to that campaign, open the builder there.
  const [edit, setEdit] = useState<{ sid: string; n: number; cid: string } | null>(null);

  // A remembered filter can point at a campaign archived since.
  const cid = !campaign || !list || list.some((x) => x.id === campaign) ? campaign : "";

  useEffect(() => {
    clearFocus();
    const h = (e: Event) => {
      const sid = String((e as CustomEvent).detail || "");
      if (!sid) return;
      let fcid = "";
      try {
        fcid = localStorage.getItem("dnaCampaignFilter") || "";
      } catch {
        /* private mode */
      }
      clearFocus();
      setFocus({ sid, n: Date.now(), cid: fcid });
    };
    window.addEventListener("dna-open-segment", h);
    return () => window.removeEventListener("dna-open-segment", h);
  }, []);

  const reload = useCallback(async () => {
    if (!cid) return;
    try {
      setC((await campaignsApi.get(cid)).campaign);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
      toast(errMsg(e), "error");
    }
  }, [cid]);
  useEffect(() => {
    setC(null);
    reload();
  }, [reload]);

  const header = (
    <PageHeader
      title="Targeting"
      subtitle={cid ? "Who this campaign goes after, and which segments are working. Companies outside the rules are skipped right after research, before anyone is contacted." : "What's working across every campaign: the offers side by side and each segment with its numbers. Pick a campaign to change its market and segments."}
      actions={
        list && list.length > 0 ? (
          <div className="flex items-center gap-2">
            {cid && c && <StatusChip status={c.status} working={c.working} />}
            <CampaignFilter value={cid} onChange={setCampaign} list={list} />
          </div>
        ) : undefined
      }
    />
  );

  if (!list) {
    return (
      <div>
        {header}
        <div className="flex items-center gap-2 py-20 text-muted">
          <Spinner /> Loading…
        </div>
      </div>
    );
  }
  if (!list.length) {
    return (
      <div>
        {header}
        <Empty
          title="No campaigns yet"
          body="Targeting belongs to a campaign: each one has its own market and segments. Create a campaign first; its setup walks you through the targeting."
          action={<Button onClick={() => goTab("campaigns")}>Go to Campaigns</Button>}
        />
      </div>
    );
  }

  if (!cid) {
    const tabs: { id: AllSection; label: string; sub: string }[] = [
      { id: "results", label: "Results", sub: `${list.length} campaign${list.length === 1 ? "" : "s"}` },
      { id: "never", label: "Never contact", sub: "every campaign" },
    ];
    return (
      <div>
        {header}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Targeting">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={allSection === t.id}
                onClick={() => setAllSection(t.id)}
                className={cn("inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold transition-colors", allSection === t.id ? "bg-hov text-ink ring-1 ring-inset ring-line-strong" : "text-muted hover:bg-hov hover:text-ink")}
              >
                {t.label}
                <span className="font-normal text-muted">{t.sub}</span>
              </button>
            ))}
          </div>
          <p className="text-[12.5px] text-muted">Market, segments and steering by chat belong to one campaign: pick it at the top.</p>
        </div>
        {allSection === "results" ? (
          <Results
            campaignId={null}
            campaigns={list}
            onEditSegment={(campaignId, sid) => {
              setEdit({ sid, n: Date.now(), cid: campaignId });
              setCampaign(campaignId);
            }}
          />
        ) : (
          <NeverContact c={null} />
        )}
      </div>
    );
  }

  return (
    <div>
      {header}
      {c && c.id === cid ? (
        <TargetingPanel key={c.id} c={c} reload={reload} onCampaign={setC} focus={focus?.cid === cid ? focus : null} edit={edit?.cid === cid ? edit : null} />
      ) : error ? (
        <Empty title="Couldn't load the campaign" body={error} action={<Button onClick={reload}>Try again</Button>} />
      ) : (
        <div className="flex items-center gap-2 py-20 text-muted">
          <Spinner /> Loading the campaign…
        </div>
      )}
    </div>
  );
}
