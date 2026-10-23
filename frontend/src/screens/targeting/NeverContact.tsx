// Who we never email: the global do-not-contact list (manual entries), the
// automatic ones the engine already refuses (opt-outs, bounces, complaints,
// the old console), and this campaign's own never-contact domains.
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, Spinner, Textarea, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import { campaignsApi, type CampaignDetail } from "../../lib/v2/campaigns";
import { targetingApi, type ExclusionList } from "../../lib/v2/targeting";
import { LinesField, errMsg, plural } from "../campaigns/parts";
import { CardHead } from "./controls";

export default function NeverContact({ c, onCampaignSaved }: { c: CampaignDetail | null; onCampaignSaved?: (c: CampaignDetail) => void }) {
  const [data, setData] = useState<ExclusionList | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [own, setOwn] = useState<string[]>(c?.settings.excludeDomains || []);

  useEffect(() => setOwn(c?.settings.excludeDomains || []), [c?.id, c?.settings.excludeDomains]);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const load = useCallback(() => {
    targetingApi
      .exclusions({ q: query || undefined, limit: 200 })
      .then(setData)
      .catch((e) => toast(errMsg(e), "error"));
  }, [query]);
  useEffect(load, [load]);

  async function add() {
    if (!entries.trim()) return;
    setBusy("add");
    try {
      const r = await targetingApi.addExclusions({ entries, reason: reason.trim() || undefined });
      const bad = r.skipped.filter((s) => s.reason !== "Already on the list");
      toast(`Added ${plural(r.added, "entry", "entries")}.${bad.length ? ` ${bad.length} weren't an email or a domain.` : ""}`, r.added ? "success" : "info");
      setEntries("");
      setReason("");
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  }

  const autoTiles: [string, number][] = data
    ? [
        ["Unsubscribed", data.auto.unsubscribed],
        ["Bounced", data.auto.bounced],
        ["Complained / legal", data.auto.complaints],
        ["Opted out in the inbox", data.auto.inbox],
        ["Old console", data.auto.oldConsole],
      ]
    : [];
  const ownDirty = c ? own.join("\n") !== c.settings.excludeDomains.join("\n") : false;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <Card className="min-w-0 p-5 sm:p-6">
        <CardHead
          n="01"
          title="Do-not-contact list"
          sub="For every campaign. A domain blocks every address at it; an email blocks one person. Checked when a company is found, when an address is verified, and again right before sending."
          right={
            <Button
              variant="ghost"
              size="sm"
              loading={busy === "export"}
              onClick={async () => {
                setBusy("export");
                try {
                  await targetingApi.exportExclusions();
                } catch (e) {
                  toast(errMsg(e), "error");
                } finally {
                  setBusy(null);
                }
              }}
            >
              Export CSV
            </Button>
          }
        />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
          <Field label="Add" hint="Paste emails or domains, one per line (or a column copied from a spreadsheet).">
            <Textarea rows={4} value={entries} onChange={(e) => setEntries(e.target.value)} placeholder={"acme-trading.com\nceo@customer.sa"} className="font-mono text-[12.5px]" />
          </Field>
          <div className="flex flex-col gap-3">
            <Field label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Existing customer" />
            </Field>
            <Button onClick={add} loading={busy === "add"} disabled={!entries.trim()} className="sm:mt-auto">
              Add to the list
            </Button>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-line-soft pt-4">
          <div className="text-[13px] font-semibold">{data ? plural(data.total, "entry", "entries") : "Entries"}</div>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-8 max-w-[220px] py-0 text-[12.5px]" />
        </div>
        {!data ? (
          <div className="flex items-center gap-2 py-8 text-muted">
            <Spinner /> Loading…
          </div>
        ) : !data.items.length ? (
          <p className="mt-3 rounded-lg border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-muted">
            {query ? "Nothing matches." : "Nothing on the list yet. Add existing customers, partners and competitors here."}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-line-soft rounded-lg border border-line-soft">
            {data.items.map((x) => (
              <li key={x.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px] hover:bg-hov">
                <Badge className={x.kind === "domain" ? "bg-ink/[0.06] text-ink-soft" : "bg-inb text-inf"}>{x.kind}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{x.value}</span>
                <span className="hidden min-w-0 max-w-[200px] truncate text-muted sm:inline">{x.reason || ""}</span>
                <span className="hidden shrink-0 text-[11.5px] text-muted md:inline">{ago(x.createdAt)}</span>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] font-semibold text-bad hover:bg-dgb"
                  onClick={async () => {
                    try {
                      await targetingApi.removeExclusion(x.id);
                      load();
                    } catch (e) {
                      toast(errMsg(e), "error");
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="min-w-0 space-y-4">
        <Card className="p-5 sm:p-6">
          <CardHead n="02" title="Already refused" sub="Added automatically. These people are never emailed again, by any campaign." />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
            {autoTiles.map(([label, n]) => (
              <div key={label} className="rounded-lg border border-line-soft bg-surf2 px-3 py-2.5">
                <div className="text-[1.15rem] font-bold leading-none tabular-nums">{n.toLocaleString()}</div>
                <div className="mt-1 text-[11.5px] leading-snug text-muted">{label}</div>
              </div>
            ))}
          </div>
          {data && data.autoRecent.length > 0 && (
            <ul className="mt-3 space-y-1 text-[12px]">
              {data.autoRecent.slice(0, 8).map((x) => (
                <li key={x.value + x.at} className="flex justify-between gap-3">
                  <span className="truncate font-mono text-[11.5px]">{x.value}</span>
                  <span className="shrink-0 text-muted">{x.reason}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted">Also skipped everywhere: our own domains (dna.systems, the agent's website, every sending mailbox's domain), and any company another campaign is already talking to.</p>
        </Card>

        {c && (
          <Card className="p-5 sm:p-6">
            <CardHead n="03" title={`Only for "${c.name}"`} sub="Domains this campaign skips, on top of the list for every campaign." />
            <LinesField label="Domains" hint="One per line, e.g. acme.com." value={own} onChange={setOwn} rows={4} />
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                disabled={!ownDirty}
                loading={busy === "own"}
                onClick={async () => {
                  setBusy("own");
                  try {
                    const r = await campaignsApi.update(c.id, { settings: { excludeDomains: own } });
                    setOwn(r.campaign.settings.excludeDomains);
                    onCampaignSaved?.(r.campaign);
                    toast("Saved.", "success");
                  } catch (e) {
                    toast(errMsg(e), "error");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Save domains
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
