// Sequences tab (Phase 7) — the steps every lead gets. "All campaigns" shows
// each campaign's sequence side by side; pick one to edit it (the same editor
// as the campaign's Sequence tab).
import { useEffect, useState } from "react";
import { Badge, Button, Card, PageHeader, Spinner, cn, toast } from "../lib/ui";
import { ago } from "../lib/v2/core";
import { ANGLE_LABEL, dayOf, sequencesApi, type SequenceOverview } from "../lib/v2/sequences";
import { Empty, StatusChip, errMsg, goTab, plural } from "./campaigns/parts";
import { CampaignFilter, useCampaignFilter, useCampaignList } from "./shared/CampaignFilter";
import SequenceEditor from "./sequences/Editor";

export default function Sequences() {
  const [campaign, setCampaign] = useCampaignFilter();
  const campaigns = useCampaignList();
  const known = !!campaigns?.some((c) => c.id === campaign);
  const header = (
    <PageHeader
      title="Sequences"
      subtitle="The steps every lead gets: when each email goes out, what it must do, and whether the AI writes it or it's your fixed text. Preview it on a real lead before anything is sent."
      actions={<CampaignFilter value={known ? campaign : ""} onChange={setCampaign} list={campaigns} />}
    />
  );
  if (campaigns && !campaigns.length) {
    return (
      <div>
        {header}
        <Empty title="No campaigns yet" body="Each campaign has one sequence. Create a campaign and it starts with a proven 3-step sequence you can edit here." action={<Button onClick={() => goTab("campaigns")}>Go to Campaigns</Button>} />
      </div>
    );
  }
  return (
    <div>
      {header}
      {!campaigns ? (
        <div className="flex items-center gap-2 py-16 text-muted">
          <Spinner /> Loading…
        </div>
      ) : known ? (
        <SequenceEditor key={campaign} campaignId={campaign} />
      ) : (
        <Overview onOpen={setCampaign} />
      )}
    </div>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<SequenceOverview[] | null>(null);
  useEffect(() => {
    sequencesApi
      .list()
      .then((r) => setList(r.sequences))
      .catch((e) => {
        toast(errMsg(e), "error");
        setList([]);
      });
  }, []);
  if (!list) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted">
        <Spinner /> Loading sequences…
      </div>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {list.map((o) => {
        const days = dayOf(o.sequence.steps);
        const totalReplies = Object.values(o.repliesByStep).reduce((n, x) => n + x, 0);
        return (
          <Card key={o.campaign.id} className="flex flex-col p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[15px] font-[650] tracking-[-0.01em]">{o.campaign.name}</div>
                <div className="mt-0.5 text-[12.5px] text-muted">
                  {o.campaign.kind === "partner" ? "Partners" : "Customers"} · version {o.sequence.version} · saved {ago(o.sequence.updatedAt)}
                  {o.sequence.language !== "auto" && ` · ${o.sequence.language === "ar" ? "Arabic" : "English"}`}
                </div>
              </div>
              <StatusChip status={o.campaign.status as any} />
            </div>
            <ol className="mt-4 flex items-stretch gap-1.5 overflow-x-auto pb-1">
              {o.sequence.steps.map((s, i) => {
                const replies = o.repliesByStep[i + 1] || 0;
                return (
                  <li key={s.id} className="flex min-w-[120px] flex-1 flex-col rounded-lg border border-line-soft bg-surf2 px-3 py-2.5">
                    <div className="mono-label text-muted">Day {days[i]}</div>
                    <div className="mt-1 text-[13px] font-semibold">{i === 0 ? "First email" : `Follow-up ${i}`}</div>
                    <div className="mt-0.5 truncate text-[12px] text-muted">{s.kind === "template" ? "Your template" : ANGLE_LABEL[s.angle]}</div>
                    {totalReplies > 0 && (
                      <div className="mt-2">
                        <div className="h-1 overflow-hidden rounded-full bg-ink/[0.07]">
                          <div className="h-full rounded-full bg-brand" style={{ width: `${(replies / totalReplies) * 100}%` }} />
                        </div>
                        <div className="mt-1 text-[11px] tabular-nums text-muted">{plural(replies, "reply", "replies")}</div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
              <div className="flex flex-wrap gap-1.5 text-[12px]">
                {o.active > 0 && <Badge className="bg-pub text-puf">{o.active} in sequence</Badge>}
                {o.unsent > 0 && <Badge className="bg-ink/[0.06] text-ink-soft">{o.unsent} written, not sent</Badge>}
                {o.stale > 0 && <Badge className="bg-wnb text-warn">{o.stale} on an older version</Badge>}
                {!o.active && !o.unsent && <span className="text-muted">Nothing written yet</span>}
              </div>
              <Button size="sm" variant="outline" onClick={() => onOpen(o.campaign.id)} className={cn(o.stale > 0 && "border-wnl")}>
                Edit sequence
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
