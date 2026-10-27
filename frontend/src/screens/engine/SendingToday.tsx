// Campaigns on the own engine:
//   SendingToday   today's send plan (and what already went), per mailbox
//   EngineSwitch   where NEW leads are sent from: own mailboxes or Instantly
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Spinner, cn, toast } from "../../lib/ui";
import { campaignsApi, type CampaignDetail, type CampaignEngine } from "../../lib/v2/campaigns";
import { engineApi, type QueueItem } from "../../lib/v2/engine";
import { EngineLabel, ProviderMark } from "./shared";

const STATUS: Record<string, { label: string; cls: string; dot: string }> = {
  scheduled: { label: "Scheduled", cls: "bg-ink/[0.06] text-ink-soft", dot: "bg-ink/30" },
  sending: { label: "Sending", cls: "bg-tlb text-accent", dot: "bg-accent" },
  sent: { label: "Sent", cls: "bg-okb text-good", dot: "bg-good" },
  failed: { label: "Failed", cls: "bg-dgb text-bad", dot: "bg-bad" },
  cancelled: { label: "Stopped", cls: "bg-ink/[0.06] text-muted", dot: "bg-ink/20" },
  bounced: { label: "Bounced", cls: "bg-dgb text-bad", dot: "bg-bad" },
  soft_bounced: { label: "Soft bounce", cls: "bg-wnb text-warn", dot: "bg-warn" },
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function SendingToday({ campaignId, version }: { campaignId: string; version: number }) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    engineApi
      .queueToday(campaignId)
      .then((r) => alive && (setItems(r.items), setError("")))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [campaignId, version, tick]);

  // The queue moves every 30 s; follow it while the tab is open.
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const byMailbox = useMemo(() => {
    const m = new Map<string, QueueItem[]>();
    for (const it of items || []) {
      const k = it.mailbox || "Not assigned yet";
      m.set(k, [...(m.get(k) || []), it]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === "Not assigned yet" ? 1 : b[0] === "Not assigned yet" ? -1 : a[0].localeCompare(b[0])));
  }, [items]);

  if (!items) {
    return error ? (
      <Card className="px-5 py-8 text-center text-[13px] text-bad">{error}</Card>
    ) : (
      <div className="flex items-center gap-2 py-16 text-muted">
        <Spinner /> Loading today's sends…
      </div>
    );
  }

  const sent = items.filter((i) => i.status === "sent").length;
  const planned = items.filter((i) => i.status === "scheduled" || i.status === "sending").length;
  const stopped = items.filter((i) => i.status === "cancelled" || i.status === "failed" || i.status.includes("bounce")).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2.5">
        {[
          ["Sent today", sent, "from your mailboxes", true],
          ["Still to go", planned, "inside the sending hours", false],
          ["Stopped", stopped, "replied, bounced or failed", false],
        ].map(([k, v, sub, keep]) => (
          <div key={String(k)} className={cn(keep ? "hb keep" : "hb", "!px-3.5 !py-3")}>
            <div className="mono-label mb-1.5 truncate">{k}</div>
            <div className="text-[1.35rem] font-bold leading-none tracking-[-0.02em] tabular-nums">{Number(v).toLocaleString()}</div>
            <div className="mt-1.5 truncate text-[11.5px] text-muted">{sub}</div>
          </div>
        ))}
      </div>

      {items.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <h3 className="text-[15px] font-[650]">Nothing to send today</h3>
          <p className="mx-auto mt-2 max-w-[460px] text-[13px] leading-relaxed text-muted">
            Approved leads join the send queue while the campaign runs. Each mailbox sends within its daily limit, 6 to 14 minutes apart, in the
            lead's sending hours. Follow-ups are pinned to the mailbox that sent the first email.
          </p>
        </Card>
      ) : (
        byMailbox.map(([mb, list]) => (
          <Card key={mb} className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
              <div className="min-w-0 truncate text-[13.5px] font-semibold">{mb}</div>
              <div className="shrink-0 text-[12px] tabular-nums text-muted">
                {list.filter((i) => i.status === "sent").length} sent · {list.filter((i) => i.status === "scheduled").length} to go
              </div>
            </div>
            <ol className="divide-y divide-line-soft">
              {list.map((it) => {
                const s = STATUS[it.status] || { label: it.status, cls: "bg-ink/[0.06] text-muted", dot: "bg-ink/20" };
                return (
                  <li key={it.id} className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5">
                    <span className="pt-0.5 font-mono text-[12px] tabular-nums text-muted">{time(it.at)}</span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
                        <span className="truncate text-[13px] font-medium">{it.toName || it.to}</span>
                        <span className="shrink-0 text-[11.5px] text-muted">email {it.step}</span>
                      </div>
                      {(it.toName || it.reason) && (
                        <div className="mt-0.5 truncate pl-3.5 text-[12px] text-muted" title={it.reason || it.to}>
                          {[it.toName ? it.to : null, it.status === "sent" ? null : it.reason].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                    <Badge className={s.cls}>{s.label}</Badge>
                  </li>
                );
              })}
            </ol>
          </Card>
        ))
      )}
    </div>
  );
}

/** Settings → "Sends through". Switching only changes where NEW leads go. */
export function EngineSwitch({ c, onSaved }: { c: CampaignDetail; onSaved: (c: CampaignDetail) => void }) {
  const [busy, setBusy] = useState<CampaignEngine | null>(null);
  const own = c.readiness.ownMailboxes;

  async function pick(engine: CampaignEngine) {
    if (engine === c.engine) return;
    const msg =
      engine === "own"
        ? `Send new leads of "${c.name}" from your own mailboxes? Leads already in Instantly finish their sequence there.`
        : `Send new leads of "${c.name}" through Instantly? Leads already in your send queue finish their sequence from your mailboxes.`;
    if (!window.confirm(msg)) return;
    setBusy(engine);
    try {
      const r = await campaignsApi.update(c.id, { engine });
      onSaved(r.campaign);
      toast(engine === "own" ? "New leads now go out from your own mailboxes." : "New leads now go out through Instantly.", "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  const options: { id: CampaignEngine; title: string; body: string; status: string; mark: "own" | "instantly" }[] = [
    {
      id: "own",
      title: "Your own mailboxes",
      body: "Google Workspace and Microsoft 365 mailboxes signed in on the Mailboxes tab. Sent by our send queue; replies read from the mailbox.",
      status: own ? `${own.sending} of ${own.total} mailbox${own.total === 1 ? "" : "es"} sending · ${own.dailyCapacity} a day` : "No own mailboxes yet",
      mark: "own",
    },
    {
      id: "instantly",
      title: "Instantly",
      body: "An Instantly campaign with your Instantly mailboxes. Replies read from its Unibox.",
      status: c.readiness.instantly ? "Instantly connected" : "Instantly not connected",
      mark: "instantly",
    },
  ];

  return (
    <Card className="p-5 sm:p-6">
      <EngineLabel>Sends through</EngineLabel>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Switching changes where NEW leads go. Leads already sent finish their sequence where they started, so nobody gets a second first email.</p>
      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        {options.map((o) => {
          const on = c.engine === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => pick(o.id)}
              disabled={!!busy}
              aria-pressed={on}
              className={cn(
                "flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                on ? "border-accent bg-tlb" : "border-line hover:border-line-strong hover:bg-hov"
              )}
            >
              <ProviderMark provider={o.mark} size={30} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[13.5px] font-semibold">
                  {o.title}
                  {on && <Badge className="bg-okb text-good">In use</Badge>}
                  {busy === o.id && <Spinner />}
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{o.body}</span>
                <span className="mt-1.5 block text-[11.5px] font-medium text-ink-soft">{o.status}</span>
              </span>
            </button>
          );
        })}
      </div>
      {c.engine === "own" && own && own.sending === 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-wnl bg-wnb px-3.5 py-2.5 text-[12.5px] text-warn">
          {own.total ? "Your mailboxes are still going through the readiness checks. Approved emails wait until one passes." : "Connect a mailbox to send this campaign."}
          <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new CustomEvent("dna-tab", { detail: "mailboxes" }))}>
            Open Mailboxes
          </Button>
        </div>
      )}
    </Card>
  );
}
