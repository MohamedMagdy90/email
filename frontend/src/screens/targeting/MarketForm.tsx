// The target market of one campaign: where, which companies, which people,
// and the quality bar. Every segment of the campaign stays inside it.
import { useMemo, useState } from "react";
import { Card, Input, cn } from "../../lib/ui";
import type { CampaignKind, SizeBand, Taxonomy, TargetMarket } from "../../lib/v2/targeting";
import { Block, CardHead, ChipInput, CHIP, CHIP_OFF, Pick, RankedList, Segmented } from "./controls";

/* Same grouping as the backend's scheduleNote(): Instantly runs one schedule per campaign. */
const TZ: Record<string, string> = {
  "United Arab Emirates": "Dubai",
  Oman: "Dubai",
  "Saudi Arabia": "Riyadh",
  Qatar: "Riyadh",
  Kuwait: "Riyadh",
  Bahrain: "Riyadh",
  Iraq: "Riyadh",
  Egypt: "Cairo",
  Jordan: "Amman",
  Lebanon: "Beirut",
};
const MON_FRI = new Set(["United Arab Emirates", "Lebanon"]);

export function scheduleGroups(countries: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const c of countries) {
    const key = `${MON_FRI.has(c) ? "Mon–Fri" : "Sun–Thu"}, ${TZ[c] || "local"} time`;
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  return groups.size > 1 ? [...groups.entries()].map(([k, v]) => `${v.join(", ")}: ${k}`) : [];
}

export default function MarketForm({
  tax,
  value: m,
  onChange,
  kind,
  agent,
}: {
  tax: Taxonomy;
  value: TargetMarket;
  onChange: (m: TargetMarket) => void;
  kind: CampaignKind;
  agent: { allowRoleAddresses: boolean; minFitScore: number };
}) {
  const set = <K extends keyof TargetMarket>(k: K, v: TargetMarket[K]) => onChange({ ...m, [k]: v });
  const [allIndustries, setAllIndustries] = useState(false);
  const countryOpts = tax.countries.map((c) => ({ id: c.name, label: c.name, title: c.ar }));
  const isGulf = m.countries.length === tax.gulf.length && tax.gulf.every((c) => m.countries.includes(c));
  const schedule = useMemo(() => scheduleGroups(m.countries), [m.countries]);

  const setCountries = (list: string[]) => {
    const cities: Record<string, string[]> = {};
    for (const c of list) if (m.cities[c]?.length) cities[c] = m.cities[c];
    onChange({ ...m, countries: list, cities });
  };

  const excludeKind = tax.industries.filter((i) => i.kind === "exclude");
  const others = tax.industries.filter((i) => i.kind !== "exclude");
  const shownOthers = allIndustries ? others : others.filter((i) => m.excludeIndustries.includes(i.id));

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-4">
        {/* ------------------------------ where ------------------------------ */}
        <Card className="p-5 sm:p-6">
          <CardHead n="01" title="Where" sub="Countries and, if you like, cities. Companies based anywhere else are skipped." />
          <div className="divide-y divide-line-soft">
            <Block
              label="Countries"
              right={
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => setCountries([...tax.gulf])} className={cn("text-[12px] font-semibold", isGulf ? "text-muted" : "text-accent hover:underline")} disabled={isGulf}>
                    Gulf 6
                  </button>
                </div>
              }
            >
              <Pick options={countryOpts} value={m.countries} onChange={(v) => v.length && setCountries(v)} />
              {schedule.length > 0 && (
                <div className="mt-3 rounded-lg border border-wnl bg-wnb px-3 py-2.5 text-[12px] leading-relaxed text-warn">
                  <b className="font-semibold">Two schedules in one market.</b> Instantly sends a campaign on one schedule, the one of the country with the most leads.{" "}
                  {schedule.join(" · ")}. Split the campaign by country if that matters.
                </div>
              )}
            </Block>
            <Block label="Cities" hint="Pick cities to stay in them; pick none to cover the whole country. Searches use these cities too (the three biggest when none are picked).">
              <div className="space-y-3">
                {m.countries.map((country) => {
                  const tc = tax.countries.find((c) => c.name === country);
                  const picked = m.cities[country] || [];
                  return (
                    <div key={country} className="rounded-lg border border-line-soft bg-surf2 p-3">
                      <div className="mb-2 flex items-baseline justify-between gap-2">
                        <span className="text-[13px] font-semibold">{country}</span>
                        <span className="text-[11.5px] text-muted">{picked.length ? `${picked.length} cit${picked.length === 1 ? "y" : "ies"}` : "Whole country"}</span>
                      </div>
                      {tc?.cities.length ? (
                        <Pick
                          options={tc.cities.map((c) => ({ id: c.name, label: c.name, title: c.ar }))}
                          value={picked}
                          onChange={(v) => {
                            const cities = { ...m.cities };
                            if (v.length) cities[country] = v;
                            else delete cities[country];
                            set("cities", cities);
                          }}
                        />
                      ) : (
                        <p className="text-[12px] text-muted">No city list for this country: the whole country is covered.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </Block>
            <Block label="Never in these cities" hint="Skips companies based there even when the country is in.">
              <ChipInput value={m.excludeCities} onChange={(v) => set("excludeCities", v)} placeholder="e.g. Jeddah" tone="bad" />
            </Block>
          </div>
        </Card>

        {/* ---------------------------- companies ---------------------------- */}
        <Card className="p-5 sm:p-6">
          <CardHead n="02" title="Companies" sub="Size, industries to avoid, and what their website should or shouldn't say." />
          <div className="divide-y divide-line-soft">
            <Block label="Company size" hint="Size is read from the company's website (staff, branches), so it's an estimate.">
              <Pick options={tax.sizeBands.map((b) => ({ id: b, label: `${b} staff` }))} value={m.sizeBands} onChange={(v) => set("sizeBands", v as SizeBand[])} />
              <div className="mt-3 grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-muted">At least</span>
                  <span className="flex items-center rounded-lg border border-line bg-sunk focus-within:border-accent">
                    <input
                      inputMode="numeric"
                      value={m.minBranches ?? ""}
                      onChange={(e) => set("minBranches", e.target.value.replace(/\D/g, "") ? Number(e.target.value.replace(/\D/g, "")) : null)}
                      placeholder="—"
                      className="w-full min-w-0 bg-transparent px-3 py-2 text-[13px] tabular-nums text-ink outline-none"
                    />
                    <span className="shrink-0 pr-3 text-[12px] text-muted">branches</span>
                  </span>
                </label>
                <div className="space-y-2">
                  <div>
                    <span className="mb-1.5 block text-[12px] text-muted">Outside this size</span>
                    <Segmented
                      size="sm"
                      value={m.sizeMode}
                      onChange={(v) => set("sizeMode", v)}
                      options={[
                        { id: "prefer", label: "Lower the fit score" },
                        { id: "strict", label: "Skip the company" },
                      ]}
                    />
                  </div>
                  <div>
                    <span className="mb-1.5 block text-[12px] text-muted">Size unknown</span>
                    <Segmented
                      size="sm"
                      value={m.sizeUnknown}
                      onChange={(v) => set("sizeUnknown", v)}
                      options={[
                        { id: "allow", label: "Keep it" },
                        { id: "skip", label: "Skip it" },
                      ]}
                    />
                  </div>
                </div>
              </div>
            </Block>
            <Block
              label="Never these industries"
              hint="Decided from what the research finds on the company's website."
              right={
                <button type="button" onClick={() => setAllIndustries(!allIndustries)} className="text-[12px] font-semibold text-accent hover:underline">
                  {allIndustries ? "Show fewer" : "Exclude another industry"}
                </button>
              }
            >
              <Pick options={excludeKind.map((i) => ({ id: i.id, label: i.label }))} value={m.excludeIndustries} onChange={(v) => set("excludeIndustries", [...v, ...m.excludeIndustries.filter((x) => !excludeKind.some((i) => i.id === x))])} tone="bad" />
              {shownOthers.length > 0 && (
                <div className="mt-2.5">
                  <Pick
                    options={shownOthers.map((i) => ({ id: i.id, label: i.label }))}
                    value={m.excludeIndustries}
                    onChange={(v) => set("excludeIndustries", [...m.excludeIndustries.filter((x) => excludeKind.some((i) => i.id === x)), ...v.filter((x) => !excludeKind.some((i) => i.id === x))])}
                    tone="bad"
                  />
                </div>
              )}
            </Block>
            <Block label="The website should mention" hint="Any one of these words. Leave empty to skip this check.">
              <ChipInput value={m.mustKeywords} onChange={(v) => set("mustKeywords", v)} placeholder="e.g. warehouse, branches" />
              {m.mustKeywords.length > 0 && (
                <div className="mt-2">
                  <Segmented
                    size="sm"
                    value={m.mustMode}
                    onChange={(v) => set("mustMode", v)}
                    options={[
                      { id: "prefer", label: "If not: lower the fit score" },
                      { id: "strict", label: "If not: skip" },
                    ]}
                  />
                </div>
              )}
            </Block>
            <Block label="The website must not mention" hint="Skips the company if any of these words is on its website.">
              <ChipInput value={m.mustNotKeywords} onChange={(v) => set("mustNotKeywords", v)} placeholder="e.g. franchise" tone="bad" />
            </Block>
            <Block label="Website language">
              <Segmented
                size="sm"
                value={m.language}
                onChange={(v) => set("language", v)}
                options={[
                  { id: "any", label: "Any" },
                  { id: "ar", label: "Arabic" },
                  { id: "en", label: "English" },
                ]}
              />
            </Block>
          </div>
        </Card>
      </div>

      <div className="min-w-0 space-y-4">
        {/* ------------------------------ people ----------------------------- */}
        <Card className="p-5 sm:p-6">
          <CardHead
            n="03"
            title="People"
            sub="Who the agent emails at each company. It tries the titles in this order."
            right={
              JSON.stringify(m.titles) !== JSON.stringify(tax.titlePresets[kind]) ? (
                <button type="button" onClick={() => set("titles", [...tax.titlePresets[kind]])} className="text-[12px] font-semibold text-accent hover:underline">
                  Reset to the {kind === "partner" ? "partner" : "customer"} list
                </button>
              ) : null
            }
          />
          <div className="divide-y divide-line-soft">
            <Block label="Decision makers, best first">
              <RankedList value={m.titles} onChange={(v) => set("titles", v)} />
            </Block>
            <Block label="Never contact these titles" hint="The agent passes over these people and tries the next one.">
              <ChipInput value={m.excludeTitles} onChange={(v) => set("excludeTitles", v)} placeholder="e.g. HR" tone="bad" />
            </Block>
            <Block label="Seniority">
              <Segmented
                size="sm"
                value={m.seniority}
                onChange={(v) => set("seniority", v)}
                options={[
                  { id: "manager", label: "Manager and up" },
                  { id: "any", label: "Any level" },
                ]}
              />
            </Block>
            <Block label="Shared addresses (info@, sales@)" hint="Used only when no named decision maker can be found.">
              <Segmented
                size="sm"
                value={m.roleAddresses}
                onChange={(v) => set("roleAddresses", v)}
                options={[
                  { id: "inherit", label: `Agent setting (${agent.allowRoleAddresses ? "allowed" : "off"})` },
                  { id: "allow", label: "Allow" },
                  { id: "never", label: "Never" },
                ]}
              />
            </Block>
          </div>
        </Card>

        {/* ------------------------------ quality ---------------------------- */}
        <Card className="p-5 sm:p-6">
          <CardHead n="04" title="Quality bar" sub="After research, the AI scores each company 0-100 against this targeting and the offer." />
          <Block label="Minimum fit score" hint={`Below this, a lead is skipped. Empty uses the agent's rule (${agent.minFitScore}).`}>
            <div className="flex items-center gap-3">
              <Input
                inputMode="numeric"
                className="max-w-[120px] tabular-nums"
                value={m.minFitScore ?? ""}
                placeholder={String(agent.minFitScore)}
                onChange={(e) => {
                  const d = e.target.value.replace(/\D/g, "");
                  set("minFitScore", d ? Math.min(100, Number(d)) : null);
                }}
              />
              <div className="flex gap-1">
                {[50, 60, 70, 80].map((n) => (
                  <button key={n} type="button" onClick={() => set("minFitScore", n)} className={cn(CHIP, CHIP_OFF, "min-h-[28px] px-2.5 tabular-nums", m.minFitScore === n && "bg-hov text-ink ring-line-strong")}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </Block>
        </Card>
      </div>
    </div>
  );
}
