// Mailboxes → domain → "DNS setup": the exact records this provider needs,
// whether each is live, the domain's age, and a "Check again" button.
import { useEffect, useState } from "react";
import { Badge, Button, Modal, Spinner, cn, toast } from "../../lib/ui";
import { ago } from "../../lib/v2/core";
import { fmtDay } from "../../lib/v2/mailboxes";
import { engineApi, type DomainCheck, type DomainSetup, type ExpectedRecord } from "../../lib/v2/engine";
import { CopyField, EngineLabel, ProviderMark } from "./shared";

const KEY_LABEL: Record<ExpectedRecord["key"], string> = { mx: "MX", spf: "SPF", dkim: "DKIM", dmarc: "DMARC", forward: "Website forward" };

function stateOf(key: ExpectedRecord["key"], check: DomainCheck | null): { tone: string; label: string; note?: string; found?: string[] } {
  if (!check) return { tone: "bg-ink/[0.06] text-muted", label: "Not checked" };
  if (key === "forward") {
    const f = check.forward;
    if (f.ok === true) return { tone: "bg-okb text-good", label: "Forwards", note: f.finalUrl || undefined };
    if (f.ok === false) return { tone: "bg-wnb text-warn", label: "Doesn't forward", note: f.finalUrl ? `Lands on ${f.finalUrl}` : undefined };
    return { tone: "bg-ink/[0.06] text-muted", label: "Couldn't tell" };
  }
  const r = check[key];
  if (r.ok) return { tone: "bg-okb text-good", label: "Found", found: r.found };
  if (r.indeterminate) return { tone: "bg-wnb text-warn", label: "Lookup timed out", note: r.note };
  return { tone: "bg-dgb text-bad", label: "Missing", note: r.note, found: r.found };
}

export function DnsModal({ domain, open, onClose, onChecked }: { domain: string; open: boolean; onClose: () => void; onChecked?: () => void }) {
  const [d, setD] = useState<DomainSetup | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setD(null);
    setError("");
    engineApi
      .domain(domain)
      .then(setD)
      .catch((e) => setError(e.message));
  }, [open, domain]);

  async function check() {
    setChecking(true);
    try {
      const r = await engineApi.checkDomain(domain);
      setD(r);
      toast(r.check?.allPass ? "Every record is in place." : "Checked. Some records are still missing.", r.check?.allPass ? "success" : "info");
      onChecked?.();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setChecking(false);
    }
  }

  const ageDays = d?.registeredAt ? Math.floor((Date.now() - Date.parse(d.registeredAt)) / 86_400_000) : null;
  const providerName = d?.provider === "microsoft" ? "Microsoft 365" : d?.provider === "google" ? "Google Workspace" : "your mail provider";

  return (
    <Modal open={open} onClose={onClose} title={`DNS setup · ${domain}`} wide>
      {!d ? (
        error ? (
          <p className="py-8 text-center text-[13px] text-bad">{error}</p>
        ) : (
          <div className="flex items-center gap-2 py-10 text-muted">
            <Spinner /> Loading…
          </div>
        )
      ) : (
        <div className="space-y-5">
          <div className="-mt-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-soft bg-surf2 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              {d.provider !== "unknown" && <ProviderMark provider={d.provider} />}
              <div className="min-w-0 text-[13px] leading-relaxed">
                <div className="font-semibold">
                  {d.check?.allPass ? "All four records are in place" : `Add these records at your domain's DNS provider for ${providerName}`}
                </div>
                <div className="text-[12px] text-muted">
                  {ageDays != null ? `Registered ${fmtDay(d.registeredAt)} (${ageDays} days ago)` : `Domain age unknown (added ${fmtDay(d.firstAddedAt)})`}
                  {d.check ? ` · checked ${ago(d.check.checkedAt)}` : " · not checked yet"}
                </div>
              </div>
            </div>
            <Button size="sm" onClick={check} loading={checking}>
              Check again
            </Button>
          </div>

          <div>
            <EngineLabel className="mb-2.5">Records</EngineLabel>
            <ul className="divide-y divide-line-soft overflow-hidden rounded-xl border border-line-soft">
              {d.records.map((r, i) => {
                const s = stateOf(r.key, d.check);
                return (
                  <li key={`${r.key}-${i}`} className="px-4 py-3.5">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold">{KEY_LABEL[r.key]}</span>
                      <Badge className="bg-ink/[0.06] font-mono text-ink-soft">{r.type}</Badge>
                      {r.priority != null && <span className="text-[12px] text-muted">priority {r.priority}</span>}
                      <Badge className={cn("ml-auto", s.tone)}>{s.label}</Badge>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,0.42fr)_minmax(0,1fr)]">
                      <CopyField label="Host / name" value={r.host} />
                      <CopyField label={r.key === "forward" ? "Forward to" : "Value"} value={r.value} />
                    </div>
                    {(r.note || s.note) && <p className="mt-2 text-[12px] leading-relaxed text-muted">{[r.note, s.note].filter(Boolean).join(" ")}</p>}
                    {s.found && s.found.length > 0 && !d.check?.[r.key as "mx"]?.ok && (
                      <p className="mt-1 truncate font-mono text-[11.5px] text-muted" title={s.found.join("\n")}>
                        Found instead: {s.found.join(" · ")}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <p className="text-[12px] leading-relaxed text-muted">
            DNS changes can take up to an hour to show. The domain also has to be 14 days old before its mailboxes send campaign email; inbox tests
            run from day one, so it builds a record while it ages.
          </p>
        </div>
      )}
    </Modal>
  );
}
