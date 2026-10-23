// Import leads from a CSV: pick the file and where they go -> match the
// columns -> watch it run -> what happened to every row.
import { useEffect, useRef, useState } from "react";
import { Button, Field, Modal, Select, Spinner, cn, toast } from "../../lib/ui";
import { campaignsApi, type Segment } from "../../lib/v2/campaigns";
import { IMPORT_FIELD_LABEL, leadsApi, type ImportField, type ImportJob, type ImportPreview } from "../../lib/v2/leads";
import { errMsg, plural } from "../campaigns/parts";
import { Segmented } from "../targeting/controls";
import { useCampaignList } from "../shared/CampaignFilter";

const MAX_BYTES = 8_000_000;
const SHOWN: ImportField[] = ["email", "fullName", "firstName", "lastName", "title", "company", "website", "country", "city", "linkedin"];

export default function ImportDialog({ open, onClose, onDone, defaultCampaign }: { open: boolean; onClose: () => void; onDone: () => void; defaultCampaign?: string }) {
  const campaigns = useCampaignList();
  const [step, setStep] = useState<"file" | "map" | "run">("file");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [campaignId, setCampaignId] = useState(defaultCampaign || "");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segmentId, setSegmentId] = useState("");
  const [enterAt, setEnterAt] = useState<"research" | "verify">("research");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<ImportField, number>>>({});
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep("file");
    setCsv("");
    setFileName("");
    setPreview(null);
    setJob(null);
    setCampaignId(defaultCampaign || "");
  }, [open, defaultCampaign]);
  useEffect(() => {
    if (!campaignId && campaigns?.length) setCampaignId(campaigns[0].id);
  }, [campaigns, campaignId]);
  useEffect(() => {
    setSegmentId("");
    if (!campaignId) return setSegments([]);
    campaignsApi
      .get(campaignId)
      .then((r) => setSegments(r.campaign.segmentList))
      .catch(() => setSegments([]));
  }, [campaignId]);
  // Poll a running import.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      try {
        const r = await leadsApi.importGet(job.id);
        setJob(r.import);
        if (r.import.status !== "running") onDone();
      } catch {
        /* keep polling */
      }
    }, 1200);
    return () => clearInterval(t);
  }, [job, onDone]);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_BYTES) return toast("The file is too big (8 MB at most).", "error");
    setBusy(true);
    try {
      const text = await f.text();
      const p = await leadsApi.importPreview(text);
      setCsv(text);
      setFileName(f.name);
      setPreview(p);
      setMapping(p.mapping);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!preview || mapping.email === undefined) return toast("Pick the column that holds the email address.", "error");
    setBusy(true);
    try {
      const r = await leadsApi.importStart({ csv, mapping, campaignId, segmentId: segmentId || undefined, enterAt, fileName });
      setJob(r.import);
      setStep("run");
      if (r.import.status !== "running") onDone();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const tooBig = !!preview && preview.total > preview.max;

  return (
    <Modal open={open} onClose={onClose} title="Import leads from a CSV" wide>
      <ol className="mb-4 flex gap-1.5 text-[12px] font-semibold">
        {(["file", "map", "run"] as const).map((s, i) => (
          <li key={s} className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1", step === s ? "bg-hov text-ink ring-1 ring-inset ring-line-strong" : "text-muted")}>
            <span className="tabular-nums">{i + 1}</span> {s === "file" ? "File" : s === "map" ? "Columns" : "Import"}
          </li>
        ))}
      </ol>

      {step === "file" && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pick(e.dataTransfer.files?.[0]);
            }}
            className="flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-sunk px-6 py-8 text-center transition-colors hover:border-accent hover:bg-hov"
          >
            {busy ? <Spinner /> : <span className="text-[14px] font-semibold">{preview ? fileName : "Choose a CSV file, or drop it here"}</span>}
            <span className="text-[12.5px] text-muted">{preview ? `${plural(preview.total, "row")} · ${preview.headers.length} columns` : "One person per row, with an email column. Up to 5,000 rows per file."}</span>
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          {tooBig && <p className="rounded-lg border border-dgl bg-dgb px-3 py-2 text-[12.5px] text-bad">This file has {preview!.total.toLocaleString()} rows; the limit is {preview!.max.toLocaleString()} per file. Split it and import the parts.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Into campaign">
              <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                {(campaigns || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Segment (optional)">
              <Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                <option value="">No segment</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Where they start</div>
            <Segmented
              value={enterAt}
              onChange={setEnterAt}
              options={[
                { id: "research", label: "Research first", sub: "recommended" },
                { id: "verify", label: "Straight to the address check" },
              ]}
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              {enterAt === "research"
                ? "The agent reads each company's site, checks it against the campaign's target, then verifies the address, scores the fit and writes. The person from the file is kept."
                : "Skips research and the target check. The emails will be less personal, since there are no observations to use."}
            </p>
          </div>
          <p className="text-[12px] leading-relaxed text-muted">Every row is checked: a valid address, the do-not-contact lists, opt-outs from any campaign, and one conversation per company (a company another campaign is talking to is skipped).</p>
          <div className="flex justify-end gap-2 border-t border-line-soft pt-4">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!preview || !campaignId || tooBig} onClick={() => setStep("map")}>
              Match the columns
            </Button>
          </div>
        </div>
      )}

      {step === "map" && preview && (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">Matched by the column names. Check them; only Email is required.</p>
          <div className="overflow-hidden rounded-xl border border-line-soft">
            {SHOWN.map((f) => {
              const idx = mapping[f];
              const sample = idx === undefined ? [] : preview.sample.map((r) => r[idx]).filter(Boolean).slice(0, 2);
              return (
                <div key={f} className="grid grid-cols-1 items-center gap-2 border-b border-line-soft px-3 py-2 last:border-0 sm:grid-cols-[140px_220px_1fr]">
                  <div className="text-[13px] font-semibold">
                    {IMPORT_FIELD_LABEL[f]}
                    {f === "email" && <span className="ml-1 text-bad">*</span>}
                  </div>
                  <Select
                    value={idx === undefined ? "" : String(idx)}
                    onChange={(e) => {
                      const next = { ...mapping };
                      if (e.target.value === "") delete next[f];
                      else next[f] = Number(e.target.value);
                      setMapping(next);
                    }}
                    className="h-8 py-0 text-[12.5px]"
                  >
                    <option value="">Not in the file</option>
                    {preview.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                  <div className="truncate text-[12px] text-muted">{sample.length ? sample.join(" · ") : "—"}</div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between gap-2 border-t border-line-soft pt-4">
            <Button variant="ghost" onClick={() => setStep("file")}>
              Back
            </Button>
            <Button loading={busy} disabled={mapping.email === undefined} onClick={start}>
              Import {plural(preview.total, "row")}
            </Button>
          </div>
        </div>
      )}

      {step === "run" && job && (
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12.5px]">
              <span className="font-semibold">{job.status === "running" ? "Importing…" : job.status === "done" ? "Done" : "Stopped"}</span>
              <span className="tabular-nums text-muted">
                {job.processed.toLocaleString()} / {job.total.toLocaleString()}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
              <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${job.total ? (job.processed / job.total) * 100 : 0}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ["Imported", job.imported, "keep"],
                ["Duplicates", job.duplicate, ""],
                ["Do not contact", job.suppressed, ""],
                ["Invalid", job.invalid, ""],
              ] as [string, number, string][]
            ).map(([l, n, k]) => (
              <div key={l} className={cn("hb !px-3.5 !py-3", k)}>
                <div className="mono-label mb-1">{l}</div>
                <div className="text-[1.3rem] font-bold leading-none tabular-nums">{n.toLocaleString()}</div>
              </div>
            ))}
          </div>
          {job.error && <p className="rounded-lg border border-dgl bg-dgb px-3 py-2 text-[12.5px] text-bad">{job.error}</p>}
          {job.sample.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Not imported (first few)</div>
              <ul className="divide-y divide-line-soft rounded-xl border border-line-soft text-[12.5px]">
                {job.sample.map((s) => (
                  <li key={s.row} className="flex gap-3 px-3 py-2">
                    <span className="w-10 shrink-0 tabular-nums text-muted">#{s.row}</span>
                    <span className="min-w-0 flex-1 truncate">{s.email || s.company || "—"}</span>
                    <span className="min-w-0 flex-[1.4] truncate text-muted" title={s.reason}>
                      {s.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2 border-t border-line-soft pt-4">
            <Button variant="outline" size="sm" disabled={job.status === "running"} onClick={() => leadsApi.importResults(job.id).catch((e) => toast(errMsg(e), "error"))}>
              Download every row's result
            </Button>
            <Button onClick={onClose}>{job.status === "running" ? "Keep it running in the background" : "Close"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
