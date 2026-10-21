// Forms shared by the new-campaign wizard and the campaign view.
import { useState } from "react";
import { Badge, Button, Card, Field, Input, Select, Textarea, cn } from "../../lib/ui";
import type { CampaignSettings, Offer, Segment, SegmentInput } from "../../lib/v2/campaigns";
import { Chips, LinesField, Switch, Toggle } from "./parts";

export function emptyOffer(): Offer {
  return { product: "", oneLiner: "", valueProps: [], proof: [], differentiators: [], pricing: "", regions: [], idealCustomers: [], competitors: [], source: "manual", learnedAt: null, pages: [] };
}

const SOURCE_LABEL: Record<Offer["source"], [string, string]> = {
  ai: ["Learned by AI", "bg-tlb text-accent"],
  manual: ["Edited", "bg-inb text-inf"],
  fallback: ["From the knowledge base", "bg-wnb text-warn"],
};

export function OfferSource({ offer }: { offer: Offer }) {
  const [label, tone] = SOURCE_LABEL[offer.source];
  return <Badge className={tone}>{label}</Badge>;
}

export function OfferForm({ offer, onChange }: { offer: Offer; onChange: (o: Offer) => void }) {
  const set = <K extends keyof Offer>(k: K, v: Offer[K]) => onChange({ ...offer, [k]: v });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Product">
        <Input value={offer.product} onChange={(e) => set("product", e.target.value)} placeholder="DNA ERP" />
      </Field>
      <Field label="Pricing" hint="Only what the site says. Leave empty if it isn't public.">
        <Input value={offer.pricing} onChange={(e) => set("pricing", e.target.value)} placeholder="Free trial, then per user per month" />
      </Field>
      <div className="md:col-span-2">
        <Field label="In one sentence" hint="What it is and who it's for. The writer leans on this line.">
          <Textarea rows={2} value={offer.oneLiner} onChange={(e) => set("oneLiner", e.target.value)} placeholder="A cloud ERP for growing trading and manufacturing companies in the Gulf." />
        </Field>
      </div>
      <LinesField label="Outcomes for the buyer" hint="One per line." value={offer.valueProps} onChange={(v) => set("valueProps", v)} rows={4} />
      <LinesField label="Proof" hint="Facts the emails may use. Never invented: leave empty if unsure." value={offer.proof} onChange={(v) => set("proof", v)} rows={4} />
      <LinesField label="What makes it different" value={offer.differentiators} onChange={(v) => set("differentiators", v)} />
      <LinesField label="Who it's for" value={offer.idealCustomers} onChange={(v) => set("idealCustomers", v)} />
      <LinesField label="Regions" value={offer.regions} onChange={(v) => set("regions", v)} rows={2} />
      <LinesField label="Alternatives buyers compare" value={offer.competitors} onChange={(v) => set("competitors", v)} rows={2} />
    </div>
  );
}

/* ------------------------------ segments ------------------------------ */

export function SegmentEditor({ value, onChange }: { value: SegmentInput; onChange: (v: SegmentInput) => void }) {
  const set = <K extends keyof SegmentInput>(k: K, v: SegmentInput[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="md:col-span-2">
        <Field label="Name">
          <Input value={value.name || ""} onChange={(e) => set("name", e.target.value)} placeholder="Food distributors in Saudi Arabia" />
        </Field>
      </div>
      <div className="md:col-span-2">
        <Field label="Why they fit" hint="One or two sentences. The writer uses this as the angle.">
          <Textarea rows={2} value={value.why || ""} onChange={(e) => set("why", e.target.value)} />
        </Field>
      </div>
      <LinesField label="Industries" value={value.industries || []} onChange={(v) => set("industries", v)} rows={2} />
      <LinesField label="Countries" value={value.countries || []} onChange={(v) => set("countries", v)} rows={2} placeholder={"Saudi Arabia\nUnited Arab Emirates"} />
      <Field label="Company size">
        <Input value={value.companySize || ""} onChange={(e) => set("companySize", e.target.value)} placeholder="20-200 employees" />
      </Field>
      <Field label="Fit score" hint="0-100, your estimate.">
        <Input type="number" min={0} max={100} value={value.fitScore ?? ""} onChange={(e) => set("fitScore", e.target.value === "" ? null : Number(e.target.value))} />
      </Field>
      <LinesField label="People to contact" hint="Job titles in priority order, one per line." value={value.titles || []} onChange={(v) => set("titles", v)} rows={4} placeholder={"CFO\nFinance Manager\nGeneral Manager"} />
      <LinesField
        label="Searches that find them"
        hint='Each line is one web search that should return company websites, e.g. "food distributor Riyadh".'
        value={value.queries || []}
        onChange={(v) => set("queries", v)}
        rows={4}
      />
    </div>
  );
}

export function segmentToInput(s: Segment): SegmentInput {
  return { name: s.name, description: s.description, industries: s.industries, countries: s.countries, companySize: s.companySize, titles: s.titles, queries: s.queries, fitScore: s.fitScore, why: s.why, enabled: s.enabled };
}

export function SegmentCard({
  seg,
  stats,
  onToggle,
  onSave,
  onDelete,
}: {
  seg: Segment;
  stats?: boolean;
  onToggle: (enabled: boolean) => Promise<void> | void;
  onSave: (v: SegmentInput) => Promise<void>;
  onDelete: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState<SegmentInput | null>(null);
  const [busy, setBusy] = useState(false);
  if (editing) {
    return (
      <Card className="p-4 sm:p-5">
        <SegmentEditor value={editing} onChange={setEditing} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(editing);
                setEditing(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save segment
          </Button>
        </div>
      </Card>
    );
  }
  return (
    <Card className={cn("p-4 sm:p-5", !seg.enabled && "opacity-70")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[14.5px] font-[650] tracking-[-0.01em]">{seg.name}</div>
            {seg.fitScore != null && <Badge className="bg-tlb text-accent">Fit {seg.fitScore}</Badge>}
            {seg.exhausted && seg.enabled && <Badge className="bg-wnb text-warn">Searches used up</Badge>}
            {!seg.enabled && <Badge className="bg-ink/[0.06] text-muted">Off</Badge>}
          </div>
          {seg.why && <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{seg.why}</p>}
        </div>
        <Switch checked={seg.enabled} onChange={(v) => onToggle(v)} label={seg.enabled ? "Turn segment off" : "Turn segment on"} />
      </div>
      <div className="mt-3 grid gap-3 text-[12.5px] sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Where · who</div>
          <Chips items={[...seg.countries, ...seg.industries, ...(seg.companySize ? [seg.companySize] : [])]} />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Contact</div>
          <Chips items={seg.titles.slice(0, 6)} tone="bg-tlb text-accent" />
        </div>
      </div>
      <div className="mt-3 text-[12px] text-muted">
        {seg.queries.length} search{seg.queries.length === 1 ? "" : "es"}: {seg.queries.slice(0, 3).join(" · ")}
        {seg.queries.length > 3 ? " …" : ""}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
        {stats ? (
          <div className="flex gap-4 text-[12.5px] tabular-nums text-ink-soft">
            <span>
              <b className="text-ink">{seg.found}</b> found
            </span>
            <span>
              <b className="text-ink">{seg.sent}</b> sent
            </span>
            <span>
              <b className="text-ink">{seg.replies}</b> replies
            </span>
            <span>
              <b className="text-good">{seg.positive}</b> positive
            </span>
          </div>
        ) : (
          <span />
        )}
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setEditing(segmentToInput(seg))}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-bad"
            onClick={() => {
              if (confirm(`Delete the segment "${seg.name}"? Leads it already found stay in the campaign.`)) onDelete();
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------ settings ------------------------------ */

export function SettingsForm({ value, onChange, agentMinFit }: { value: CampaignSettings; onChange: (v: CampaignSettings) => void; agentMinFit?: number }) {
  const set = <K extends keyof CampaignSettings>(k: K, v: CampaignSettings[K]) => onChange({ ...value, [k]: v });
  const num = (v: string, lo: number, hi: number, d: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  return (
    <div className="space-y-5">
      <Toggle
        checked={value.reviewFirst}
        onChange={(v) => set("reviewFirst", v)}
        label="Review emails before they go out"
        hint="Written emails wait in the Review tab until you approve them. Turn off to send everything that passes the checks."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="New leads per day" hint="Also capped by mailbox capacity.">
          <Input type="number" min={1} max={500} value={value.dailyNewLeads} onChange={(e) => set("dailyNewLeads", num(e.target.value, 1, 500, 30))} />
        </Field>
        <Field label="Follow-ups">
          <Select value={value.followUps} onChange={(e) => set("followUps", Number(e.target.value))}>
            <option value={0}>None</option>
            <option value={1}>1 follow-up</option>
            <option value={2}>2 follow-ups</option>
          </Select>
        </Field>
        <Field label="Days before follow-up 1">
          <Input type="number" min={1} max={30} disabled={value.followUps < 1} value={value.followUpDelays[0]} onChange={(e) => set("followUpDelays", [num(e.target.value, 1, 30, 3), value.followUpDelays[1]])} />
        </Field>
        <Field label="Days before follow-up 2">
          <Input type="number" min={1} max={30} disabled={value.followUps < 2} value={value.followUpDelays[1]} onChange={(e) => set("followUpDelays", [value.followUpDelays[0], num(e.target.value, 1, 30, 4)])} />
        </Field>
        <Field label="Language">
          <Select value={value.language} onChange={(e) => set("language", e.target.value as CampaignSettings["language"])}>
            <option value="auto">Auto (English unless the site is Arabic-only)</option>
            <option value="en">English</option>
            <option value="ar">Arabic</option>
          </Select>
        </Field>
        <Field label="Send from" hint="In the leads' timezone.">
          <Input type="time" value={value.sendWindow.from} onChange={(e) => set("sendWindow", { ...value.sendWindow, from: e.target.value || "09:00" })} />
        </Field>
        <Field label="Send until">
          <Input type="time" value={value.sendWindow.to} onChange={(e) => set("sendWindow", { ...value.sendWindow, to: e.target.value || "17:00" })} />
        </Field>
        <Field label="Companies researched per day" hint="Keeps AI use in budget.">
          <Input type="number" min={1} max={500} value={value.researchPerDay} onChange={(e) => set("researchPerDay", num(e.target.value, 1, 500, 60))} />
        </Field>
        <Field label="Minimum fit score" hint={`Empty uses the agent's rule${agentMinFit != null ? ` (${agentMinFit})` : ""}.`}>
          <Input type="number" min={0} max={100} value={value.minFitScore ?? ""} onChange={(e) => set("minFitScore", e.target.value === "" ? null : num(e.target.value, 0, 100, 60))} />
        </Field>
      </div>
      <LinesField
        label="Never contact these domains"
        hint="Customers, partners and competitors. One domain per line, e.g. acme.com. Our own domains are always excluded."
        value={value.excludeDomains}
        onChange={(v) => set("excludeDomains", v)}
        rows={3}
      />
    </div>
  );
}
