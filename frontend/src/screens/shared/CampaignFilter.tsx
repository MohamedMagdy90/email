// One campaign filter shared by Dashboard, Leads, Targeting and Sequences
// ("All campaigns" or one campaign), remembered per browser, kept in step
// across tabs with a window event.
import { useEffect, useState } from "react";
import { Select, cn } from "../../lib/ui";
import { campaignsApi, type CampaignSummary } from "../../lib/v2/campaigns";

const KEY = "dnaCampaignFilter";
const EVENT = "dna-campaign-filter";

function read(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function setCampaignFilter(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

/** [campaign id or "" for all, setter] */
export function useCampaignFilter(): [string, (id: string) => void] {
  const [id, setId] = useState(read);
  useEffect(() => {
    const h = (e: Event) => setId(String((e as CustomEvent).detail ?? read()));
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return [id, setCampaignFilter];
}

let cache: { at: number; list: CampaignSummary[] } | null = null;
let inflight: Promise<CampaignSummary[]> | null = null;

export function refreshCampaignList(): Promise<CampaignSummary[]> {
  inflight = campaignsApi
    .list()
    .then((r) => {
      cache = { at: Date.now(), list: r.campaigns };
      return r.campaigns;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Campaigns (not archived), cached for 30 s across screens. */
export function useCampaignList(): CampaignSummary[] | null {
  const [list, setList] = useState<CampaignSummary[] | null>(cache?.list || null);
  useEffect(() => {
    let alive = true;
    if (cache && Date.now() - cache.at < 30_000) setList(cache.list);
    else (inflight || refreshCampaignList()).then((l) => alive && setList(l)).catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

/** The title-row select. `required` hides "All campaigns" (screens that need one campaign). */
export function CampaignFilter({ value, onChange, list, required, className }: { value: string; onChange: (id: string) => void; list: CampaignSummary[] | null; required?: boolean; className?: string }) {
  if (!list || !list.length) return null;
  const known = list.some((c) => c.id === value);
  return (
    <Select value={known ? value : required ? list[0].id : ""} onChange={(e) => onChange(e.target.value)} aria-label="Campaign" className={cn("h-8 w-auto min-w-[190px] max-w-[280px] py-0 text-[12.5px]", className)}>
      {!required && <option value="">All campaigns</option>}
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} · {c.kind === "partner" ? "partners" : "customers"}
        </option>
      ))}
    </Select>
  );
}
