// Targeting tab — who each campaign goes after: the market (countries,
// cities, size, industries to avoid, people), the segments inside it, and who
// never to contact. Targeting belongs to a campaign; pick one at the top.
import { useCallback, useEffect, useState } from "react";
import { Button, PageHeader, Select, Spinner, toast } from "../lib/ui";
import { campaignsApi, type CampaignDetail, type CampaignSummary } from "../lib/v2/campaigns";
import { Empty, StatusChip, errMsg, goTab } from "./campaigns/parts";
import TargetingPanel from "./targeting/TargetingPanel";

const KEY = "dnaTargetingCampaign";

export default function Targeting() {
  const [list, setList] = useState<CampaignSummary[] | null>(null);
  const [id, setIdState] = useState<string>(() => {
    try {
      return localStorage.getItem(KEY) || "";
    } catch {
      return "";
    }
  });
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setId = (v: string) => {
    setIdState(v);
    setC(null);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    campaignsApi
      .list()
      .then((r) => {
        setList(r.campaigns);
        if (r.campaigns.length && !r.campaigns.some((x) => x.id === id)) setId(r.campaigns[0].id);
      })
      .catch((e) => setError(errMsg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      setC((await campaignsApi.get(id)).campaign);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }, [id]);
  useEffect(() => {
    reload();
  }, [reload]);

  const header = (
    <PageHeader
      title="Targeting"
      subtitle="Who each campaign goes after. Companies outside these rules are skipped right after research, before anyone is contacted."
      actions={
        list && list.length > 0 ? (
          <div className="flex items-center gap-2">
            {c && <StatusChip status={c.status} working={c.working} />}
            <Select value={id} onChange={(e) => setId(e.target.value)} className="h-8 w-auto min-w-[200px] max-w-[280px] py-0 text-[12.5px]" aria-label="Campaign">
              {list.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {x.kind === "partner" ? "partners" : "customers"}
                </option>
              ))}
            </Select>
          </div>
        ) : undefined
      }
    />
  );

  if (error) {
    return (
      <div>
        {header}
        <Empty title="Couldn't load campaigns" body={error} />
      </div>
    );
  }
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
  return (
    <div>
      {header}
      {c ? (
        <TargetingPanel key={c.id} c={c} reload={reload} onCampaign={setC} />
      ) : (
        <div className="flex items-center gap-2 py-20 text-muted">
          <Spinner /> Loading the campaign…
        </div>
      )}
    </div>
  );
}
