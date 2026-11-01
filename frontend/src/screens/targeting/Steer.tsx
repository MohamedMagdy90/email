// Steer by chat (plan §8.4.7): say what to change in plain words, the AI turns
// it into changes to the STRUCTURED targeting (market, segments, never
// contact, a new segment), you tick the ones you want and apply. Then the
// leads already found are re-checked (dry run first). Never applies on its own.
import { useEffect, useState } from "react";
import { Badge, Button, Spinner, cn, toast } from "../../lib/ui";
import { v2 } from "../../lib/v2/core";
import type { CampaignDetail } from "../../lib/v2/campaigns";
import { targetingApi, type RecheckResult, type SkipRule, type SteerChange, type SteerProposal } from "../../lib/v2/targeting";
import { errMsg, goTab, plural } from "../campaigns/parts";
import { useTaxonomy } from "./useTaxonomy";

const EXAMPLES: Record<"customer" | "partner", string[]> = {
  customer: ["Focus on Riyadh and Jeddah", "Only companies with 3+ branches", "Skip pharmacies and clinics", "Add plant managers for the factories"],
  partner: ["Focus on accounting firms in Dubai", "Skip one-person consultancies", "Add IT resellers in Qatar", "Contact managing partners first"],
};

const KIND: Record<SteerChange["kind"], [string, string]> = {
  market: ["Market", "bg-tlb text-accent"],
  segment: ["Segment", "bg-inb text-inf"],
  exclusion: ["Never contact", "bg-dgb text-bad"],
  new_segment: ["New segment", "bg-okb text-good"],
};

/** The label without the prefix the kind badge already says. */
const shortLabel = (ch: SteerChange) => ch.label.replace(/^Market · /, "").replace(/^Never contact: /, "").replace(/^New segment /, "");

export default function SteerBox({ c, onApplied }: { c: CampaignDetail; onApplied: () => Promise<void> | void }) {
  const tax = useTaxonomy();
  const [ai, setAi] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const [thinking, setThinking] = useState(false);
  const [proposal, setProposal] = useState<SteerProposal | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<{ applied: number; notes: string[]; recheck: RecheckResult } | null>(null);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    v2.status()
      .then((s) => setAi(s.ai.configured))
      .catch(() => setAi(null));
  }, []);

  async function propose() {
    const m = message.trim();
    if (!m || thinking) return;
    setThinking(true);
    setDone(null);
    try {
      const p = await targetingApi.steer(c.id, m);
      setProposal(p);
      setPicked(new Set(p.changes.map((x) => x.id)));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setThinking(false);
    }
  }

  async function apply() {
    if (!proposal) return;
    const changes = proposal.changes.filter((x) => picked.has(x.id));
    if (!changes.length) return;
    setApplying(true);
    try {
      const r = await targetingApi.applySteer(c.id, changes);
      setDone(r);
      setProposal(null);
      setMessage("");
      toast(`Applied ${plural(r.applied, "change")}.${r.notes.length ? ` ${r.notes.join(" ")}` : ""}`, "success");
      await onApplied();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setApplying(false);
    }
  }

  async function recheckNow() {
    setRechecking(true);
    try {
      const r = await targetingApi.recheck(c.id, { apply: true });
      toast(`Re-checked: ${plural(r.wouldSkip, "lead")} skipped, ${r.wouldRestore} brought back.`, "success");
      setDone(null);
      await onApplied();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setRechecking(false);
    }
  }

  const off = ai === false;
  const ruleText = (r: RecheckResult) =>
    (Object.entries(r.byRule) as [SkipRule, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${(tax?.skipRules[k] || k).toLowerCase()}`)
      .join(", ");

  return (
    <section className="db-card mb-4 !p-0 overflow-hidden">
      <div className="px-4 pb-3 pt-3.5 sm:px-5">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="mono-label whitespace-nowrap text-muted">Steer by chat</span>
            <span className="text-[12px] text-muted">Say it in plain words. Nothing changes until you tick and apply.</span>
          </div>
        </div>
        <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-end", off && "opacity-60")}>
          <textarea
            dir="auto"
            rows={1}
            value={message}
            disabled={off || thinking}
            onChange={(e) => {
              setMessage(e.target.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = `${Math.min(140, e.currentTarget.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                e.preventDefault();
                propose();
              }
            }}
            placeholder="e.g. Distributors with 3+ branches in Riyadh, skip pharmacies"
            aria-label="What to change in the targeting"
            className="min-h-[66px] w-full flex-1 resize-none sm:min-h-[42px] rounded-lg border border-line bg-sunk px-3 py-2.5 text-[13.5px] leading-snug text-ink outline-none transition-colors placeholder:text-ink/30 focus:border-accent"
          />
          <Button onClick={propose} loading={thinking} disabled={off || !message.trim()} className="shrink-0">
            Propose changes
          </Button>
        </div>
        {off ? (
          <p className="mt-2 text-[12.5px] text-muted">
            Steering by chat needs an AI key.{" "}
            <button type="button" className="font-semibold text-accent hover:underline" onClick={() => goTab("agent")}>
              Connect one in the Agent tab
            </button>
            , or change the market and segments by hand.
          </p>
        ) : (
          !proposal &&
          !done &&
          !message && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES[c.kind].map((x) => (
                <button key={x} type="button" onClick={() => setMessage(x)} className="rounded-full border border-line-soft px-2.5 py-[3px] text-[12px] text-muted transition-colors hover:border-line-strong hover:bg-hov hover:text-ink">
                  {x}
                </button>
              ))}
            </div>
          )
        )}
        {thinking && (
          <p className="mt-2 flex items-center gap-2 text-[12.5px] text-muted">
            <Spinner className="h-3 w-3" /> Reading the market and the segments…
          </p>
        )}
      </div>

      {proposal && (
        <div className="border-t border-line-soft bg-surf2 px-4 py-3.5 sm:px-5">
          <p className="text-[13px] leading-relaxed text-ink">
            <span className="font-semibold">The agent: </span>
            {proposal.summary}
          </p>
          {proposal.changes.length ? (
            <ul className="mt-3 space-y-1.5">
              {proposal.changes.map((ch) => {
                const on = picked.has(ch.id);
                return (
                  <li key={ch.id}>
                    <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors", on ? "border-keepl bg-keep1" : "border-line-soft bg-paper hover:bg-hov")}>
                      <input
                        type="checkbox"
                        className="mt-[3px]"
                        checked={on}
                        onChange={() =>
                          setPicked((s) => {
                            const n = new Set(s);
                            if (n.has(ch.id)) n.delete(ch.id);
                            else n.add(ch.id);
                            return n;
                          })
                        }
                      />
                      <Badge className={cn("mt-px shrink-0", KIND[ch.kind][1])}>{KIND[ch.kind][0]}</Badge>
                      <span className="min-w-0 text-[13px] leading-snug text-ink-soft">{shortLabel(ch)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-[12.5px] text-muted">Nothing in that maps to the targeting fields. Try naming a place, an industry, a size or a job title.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-muted">After applying, the leads already found are checked against the new targeting.</span>
            <Button variant="ghost" size="sm" onClick={() => setProposal(null)} disabled={applying}>
              Discard
            </Button>
            {proposal.changes.length > 0 && (
              <Button size="sm" onClick={apply} loading={applying} disabled={!picked.size}>
                Apply {picked.size ? plural(picked.size, "change") : ""}
              </Button>
            )}
          </div>
        </div>
      )}

      {done && (
        <div className="border-t border-line-soft bg-surf2 px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 text-[13px] leading-relaxed">
              <b className="font-semibold">Applied {plural(done.applied, "change")}.</b>{" "}
              {done.recheck.wouldSkip || done.recheck.wouldRestore ? (
                <span className="text-ink-soft">
                  {done.recheck.wouldSkip ? `${plural(done.recheck.wouldSkip, "lead")} already found ${done.recheck.wouldSkip === 1 ? "is" : "are"} now outside the target${ruleText(done.recheck) ? ` (${ruleText(done.recheck)})` : ""}` : ""}
                  {done.recheck.wouldSkip && done.recheck.wouldRestore ? ", and " : ""}
                  {done.recheck.wouldRestore ? `${plural(done.recheck.wouldRestore, "skipped lead")} ${done.recheck.wouldRestore === 1 ? "is" : "are"} back inside` : ""}.
                </span>
              ) : (
                <span className="text-muted">Checked {plural(done.recheck.checked, "lead")} already found: they all still fit.</span>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDone(null)}>
                {done.recheck.wouldSkip || done.recheck.wouldRestore ? "Leave them" : "Close"}
              </Button>
              {(done.recheck.wouldSkip > 0 || done.recheck.wouldRestore > 0) && (
                <Button size="sm" loading={rechecking} onClick={recheckNow}>
                  Re-check them
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
