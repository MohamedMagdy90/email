// One company: the research once, and every person the agent found there
// across campaigns. Clicking a person opens the lead drawer.
import { useEffect, useState } from "react";
import { Button, Spinner, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import { leadsApi, type CompanyDetail } from "../../lib/v2/leads";
import { EmailStatusChip, SectionLabel, StageChip, errMsg } from "../campaigns/parts";

export default function CompanyDrawer({ id, onClose, onOpenLead }: { id: string; onClose: () => void; onOpenLead: (pid: string) => void }) {
  const [c, setC] = useState<CompanyDetail | null>(null);
  useEffect(() => {
    setC(null);
    leadsApi
      .company(id)
      .then(setC)
      .catch((e) => toast(errMsg(e), "error"));
  }, [id]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[55] flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/45" onClick={onClose} />
      <aside className="drawer-in relative flex h-full w-full max-w-[580px] flex-col border-l border-line bg-cream shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-line-soft bg-paper px-5 py-4">
          <div className="min-w-0">
            <div className="mono-label mb-1 text-muted">Company</div>
            <div className="truncate text-[17px] font-[650] tracking-[-0.015em]">{c ? c.name || c.domain : "Loading…"}</div>
            {c?.website && (
              <a href={c.website} target="_blank" rel="noreferrer" className="text-[12.5px] text-accent hover:underline">
                {c.domain}
              </a>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        {!c ? (
          <div className="flex items-center gap-2 p-6 text-muted">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5 text-[13px]">
            <section>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
                {c.industry && <span>{c.industry}</span>}
                {c.size && <span>{c.size}</span>}
                {(c.city || c.country) && <span>{[c.city, c.country].filter(Boolean).join(", ")}</span>}
                {c.phone && <span>{c.phone}</span>}
                {c.researchedAt && <span>researched {ago(c.researchedAt)}</span>}
              </div>
              {c.description && <p className="mt-2 leading-relaxed text-ink-soft">{c.description}</p>}
              {!c.researchedAt && <p className="mt-2 text-muted">Not researched yet.</p>}
            </section>
            {c.hooks.length > 0 && (
              <section>
                <SectionLabel>Hooks</SectionLabel>
                <ul className="list-disc space-y-1 pl-5 text-ink-soft">
                  {c.hooks.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <SectionLabel>People the agent found ({c.people.length})</SectionLabel>
              <ul className="divide-y divide-line-soft overflow-hidden rounded-xl border border-line-soft bg-paper">
                {c.people.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onOpenLead(p.id)} className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-hov">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">
                          {p.fullName || p.email || "No named person"}
                          {p.title && <span className="font-normal text-muted">, {p.title}</span>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                          {p.email && <span>{p.email}</span>}
                          <EmailStatusChip status={p.emailStatus} />
                          <span>· {p.campaignName}</span>
                        </div>
                      </div>
                      <StageChip stage={p.stage} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            {c.peopleOnSite.length > 0 && (
              <section>
                <SectionLabel>Named on the website</SectionLabel>
                <ul className="space-y-0.5 text-ink-soft">
                  {c.peopleOnSite.map((x) => (
                    <li key={x.name}>
                      {x.name}
                      {x.title && <span className="text-muted">, {x.title}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
