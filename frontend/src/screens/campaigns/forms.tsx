// Forms shared by the new-campaign wizard and the campaign view.
import { Badge, Field, Input, Select, Textarea } from "../../lib/ui";
import type { CampaignSettings, Offer } from "../../lib/v2/campaigns";
import { LinesField, Toggle } from "./parts";

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
        <Field label="Language" hint="The sequence can set its own language.">

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
      </div>
      <p className="text-[12px] leading-relaxed text-muted">How many follow-ups, when they go out and what each one says are set in the Sequence. Who to target, the minimum fit score and the domains never to contact are set in Targeting.</p>
    </div>
  );
}
