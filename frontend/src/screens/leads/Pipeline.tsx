// Pipeline board: Replied · Interested · Meeting · Won · Lost. Dragging a card
// is the human override of how the Inbox read the reply — it sets the lead's
// stage and its interest status in Instantly. Every card also has a "Move"
// menu, for keyboards and phones.
import { useCallback, useEffect, useState } from "react";
import { Spinner, cn, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import { leadsApi, PIPELINE_COLUMNS, type LeadRow, type PipelineStage } from "../../lib/v2/leads";
import { Empty, errMsg, goTab } from "../campaigns/parts";
import { Menu } from "../shared/Menu";

export default function Pipeline({ campaign, q, version, onOpen }: { campaign: string; q: string; version: number; onOpen: (pid: string) => void }) {
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<PipelineStage | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await leadsApi.list({ campaign: campaign || undefined, stage: "replied", q: q || undefined, view: "people", sort: "updated", limit: 200, facets: "0" });
      if (r.view === "people") {
        setRows(r.rows);
        setTotal(r.total);
      }
    } catch (e) {
      toast(errMsg(e), "error");
      setRows([]);
    }
  }, [campaign, q]);
  useEffect(() => {
    load();
  }, [load, version]);

  const move = async (pid: string, to: PipelineStage) => {
    const prev = rows;
    const cur = rows?.find((r) => r.id === pid);
    if (!cur || cur.stage === to) return;
    setRows((rs) => (rs ? rs.map((r) => (r.id === pid ? { ...r, stage: to } : r)) : rs));
    try {
      const r = await leadsApi.setStage(pid, to);
      const label = PIPELINE_COLUMNS.find((c) => c.id === to)?.label;
      toast(r.instantly === "failed" ? `Moved to ${label}. Instantly couldn't be updated; see the lead's history.` : `Moved to ${label}.`, r.instantly === "failed" ? "info" : "success");
    } catch (e) {
      setRows(prev);
      toast(errMsg(e), "error");
    }
  };

  if (!rows) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted">
        <Spinner /> Loading the pipeline…
      </div>
    );
  }
  if (!rows.length) {
    return (
      <Empty
        title={q ? "No replies match" : "No replies yet"}
        body="Leads land here when they answer. The Inbox sorts each reply (interested, not now, unsubscribe…); drag a card to correct it or to move a deal forward."
        action={<button type="button" className="text-[13px] font-semibold text-accent hover:underline" onClick={() => goTab("inbox")}>Open the Inbox</button>}
      />
    );
  }
  return (
    <div>
      {total > rows.length && <p className="mb-2 text-[12.5px] text-muted">Showing the {rows.length} most recent of {total.toLocaleString()}. Narrow it with the campaign filter or the search.</p>}
      <div className="kb">
        {PIPELINE_COLUMNS.map((col) => {
          const cards = rows.filter((r) => r.stage === col.id);
          return (
            <section
              key={col.id}
              className={cn("kc", over === col.id && "over")}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                setOver(col.id);
              }}
              onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                const pid = e.dataTransfer.getData("text/plain") || drag;
                setOver(null);
                setDrag(null);
                if (pid) move(pid, col.id);
              }}
            >
              <h3 title={col.hint}>
                <span className={cn("flex items-center gap-2 !text-[0.78rem] !font-bold !text-ink", col.id === "won" && "!text-good", col.id === "lost" && "!text-muted")}>
                  <i className={cn("h-2 w-2 rounded-full", col.id === "replied" ? "bg-inf" : col.id === "lost" ? "bg-ink/25" : "bg-good")} />
                  {col.label}
                </span>
                <span>{cards.length}</span>
              </h3>
              <div className="cards">
                {cards.map((r) => (
                  <article
                    key={r.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", r.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDrag(r.id);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setOver(null);
                    }}
                    onClick={() => onOpen(r.id)}
                    className={cn("kd", drag === r.id && "drag")}
                  >
                    <b>{r.fullName || r.email || "Unknown"}</b>
                    <div className="meta text-muted">
                      {r.company || r.domain}
                      {r.title ? ` · ${r.title}` : ""}
                    </div>
                    <div className="tg">
                      {!campaign && r.campaignName && <span className="rounded-full bg-ink/[0.05] px-1.5 py-[1px] text-[10.5px] text-ink-soft">{r.campaignName}</span>}
                      {r.interest && r.interest !== col.id && <span className="rounded-full bg-inb px-1.5 py-[1px] text-[10.5px] text-inf">{r.interest.replace(/_/g, " ")}</span>}
                      <span className="mut text-muted">{ago(r.repliedAt || r.updatedAt)}</span>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Menu
                          label="Move"
                          variant="ghost"
                          className="[&>button]:!h-6 [&>button]:!px-1.5 [&>button]:!text-[11px]"
                          items={PIPELINE_COLUMNS.filter((c) => c.id !== r.stage).map((c) => ({ label: c.label, hint: c.hint, onClick: () => move(r.id, c.id) }))}
                        />
                      </span>
                    </div>
                  </article>
                ))}
                {!cards.length && <div className="px-2 py-6 text-center text-[12px] text-muted">{drag ? "Drop here" : "None"}</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
