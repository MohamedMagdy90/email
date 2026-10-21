// New campaign: basics -> offer -> ideal customers -> rules -> launch.
import { useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, PageHeader, Spinner, cn, toast } from "../../lib/ui";
import { campaignsApi, DEFAULT_CAMPAIGN_SETTINGS, type CampaignDetail, type CampaignKind, type CampaignSettings, type Offer, type SegmentInput } from "../../lib/v2/campaigns";
import { OfferForm, OfferSource, SegmentCard, SegmentEditor, SettingsForm, emptyOffer } from "./forms";
import { Empty, QUIET, errMsg, goTab } from "./parts";

const STEPS = ["Basics", "Offer", "Ideal customers", "Rules", "Launch"];

export default function Wizard({ resumeId, onCancel, onOpen }: { resumeId?: string; onCancel: () => void; onOpen: (id: string) => void }) {
  const [step, setStep] = useState(0);
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(!!resumeId);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CampaignKind>("customer");
  const [website, setWebsite] = useState("https://dna.systems");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [settings, setSettings] = useState<CampaignSettings>(DEFAULT_CAMPAIGN_SETTINGS);
  const [busy, setBusy] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [adding, setAdding] = useState<SegmentInput | null>(null);

  const adopt = (d: CampaignDetail) => {
    setC(d);
    setName(d.name);
    setKind(d.kind);
    setWebsite(d.website || website);
    setOffer(d.offer);
    setSettings(d.settings);
  };

  useEffect(() => {
    if (!resumeId) return;
    campaignsApi
      .get(resumeId)
      .then((r) => {
        adopt(r.campaign);
        setStep(!r.campaign.offer ? 1 : !r.campaign.segmentList.length ? 2 : 3);
      })
      .catch((e) => toast(errMsg(e), "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const createOrSave = async () => {
    let created: CampaignDetail | null = null;
    await run("basics", async () => {
      if (!name.trim()) throw new Error("Give the campaign a name");
      const r = c ? await campaignsApi.update(c.id, { name: name.trim(), kind, website: website.trim() }) : await campaignsApi.create({ name: name.trim(), kind, website: website.trim() });
      adopt(r.campaign);
      setStep(1);
      created = r.campaign;
    });
    const made = created as CampaignDetail | null;
    if (made && !made.offer) await learn(made.id);
  };

  const learn = (id = c?.id) =>
    id &&
    run("learn", async () => {
      setWarning(null);
      const r = await campaignsApi.learnOffer(id, website.trim() || undefined);
      adopt(r.campaign);
      setWarning(r.warning || null);
    });

  const saveOffer = async () => {
    let saved = false;
    await run("offer", async () => {
      if (!c || !offer) throw new Error("Learn the offer or fill it in first");
      if (!offer.product.trim() || !offer.oneLiner.trim()) throw new Error("The offer needs at least a product name and one sentence about it");
      adopt((await campaignsApi.update(c.id, { offer })).campaign);
      setStep(2);
      saved = true;
    });
    if (saved && c && !c.segmentList.length) await suggest();
  };

  const reload = async (): Promise<void> => {
    if (c) adopt((await campaignsApi.get(c.id)).campaign);
  };

  const suggest = () =>
    c &&
    run("suggest", async () => {
      setWarning(null);
      const r = await campaignsApi.proposeSegments(c.id, 4);
      setWarning(r.warning || null);
      await reload();
    });

  const saveSettings = () =>
    run("rules", async () => {
      if (!c) return;
      adopt((await campaignsApi.update(c.id, { settings })).campaign);
      setStep(4);
    });

  const start = () =>
    run("start", async () => {
      if (!c) return;
      await campaignsApi.start(c.id);
      toast("Campaign started. The agent works on it in the background.", "success");
      onOpen(c.id);
    });

  const passNow = () =>
    run("pass", async () => {
      if (!c) return;
      const r = await campaignsApi.run(c.id);
      adopt(r.campaign);
      const n = r.ran;
      toast(`Pass done: ${n.discovered} found, ${n.researched} researched, ${n.written} written.`, "success");
      onOpen(c.id);
    });

  const header = (
    <PageHeader
      title={c ? c.name : "New campaign"}
      subtitle="Tell the agent what you sell and who to look for. It finds the companies, the people and writes the emails."
      actions={
        <Button variant="ghost" size="sm" onClick={() => (c ? onOpen(c.id) : onCancel())}>
          {c ? "Finish later" : "Cancel"}
        </Button>
      }
    />
  );

  if (loading) {
    return (
      <div>
        {header}
        <div className="flex items-center gap-2 py-20 text-muted">
          <Spinner /> Loading…
        </div>
      </div>
    );
  }

  const enabledSegs = c?.segmentList.filter((s) => s.enabled).length || 0;

  return (
    <div>
      {header}
      <ol className="mb-6 flex gap-1.5 overflow-x-auto pb-1">
        {STEPS.map((label, i) => {
          const reachable = i === 0 || (!!c && (i <= 2 || (i === 3 && !!c.offer) || (i === 4 && !!c.offer && enabledSegs > 0)));
          return (
            <li key={label} className="shrink-0">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => setStep(i)}
                className={cn("inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold transition-colors disabled:opacity-40", i === step ? QUIET : "text-muted hover:bg-hov hover:text-ink")}
              >
                <span className={cn("grid h-5 w-5 place-items-center rounded-full text-[11px] tabular-nums", i < step ? "bg-brand text-onbrand" : "bg-ink/[0.08]")}>{i + 1}</span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {warning && step > 0 && <div className="mb-4 rounded-xl border border-wnl bg-wnb px-4 py-3 text-[13px] text-warn">{warning}</div>}

      {step === 0 && (
        <Card className="max-w-[720px] space-y-4 p-5 sm:p-6">
          <Field label="Campaign name">
            <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Saudi distributors · Q4" />
          </Field>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Who are you reaching</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["customer", "Customers", "Companies that would buy and use the product."],
                  ["partner", "Partners", "Accountants, IT resellers and consultancies who would resell or refer it (Makers program)."],
                ] as const
              ).map(([k, label, sub]) => (
                <button key={k} type="button" onClick={() => setKind(k)} className={cn("rounded-xl border px-4 py-3 text-left transition-colors", kind === k ? "border-keepl bg-keep1" : "border-line-soft hover:bg-hov")}>
                  <div className="text-[14px] font-semibold">{label}</div>
                  <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{sub}</div>
                </button>
              ))}
            </div>
          </div>
          <Field label="Website to learn the offer from">
            <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://dna.systems" />
          </Field>
          <div className="flex justify-end">
            <Button loading={busy === "basics"} onClick={createOrSave}>
              {c ? "Save and continue" : "Create and learn the offer"}
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && c && (
        <Card className="space-y-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[15px] font-[650] tracking-[-0.01em]">What you sell</div>
              <p className="text-[13px] text-muted">Learned from the website. Check it: every email is built on these facts.</p>
            </div>
            <div className="flex items-center gap-2">
              {offer && <OfferSource offer={offer} />}
              <Button variant="outline" size="sm" loading={busy === "learn"} onClick={() => learn()}>
                {offer ? "Learn again" : "Learn from website"}
              </Button>
            </div>
          </div>
          {busy === "learn" && !offer ? (
            <div className="flex items-center gap-2 py-10 text-muted">
              <Spinner /> Reading {website.replace(/^https?:\/\//, "")}…
            </div>
          ) : (
            <OfferForm offer={offer || emptyOffer()} onChange={setOffer} />
          )}
          <div className="flex justify-between gap-2 border-t border-line-soft pt-4">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button loading={busy === "offer"} onClick={saveOffer} disabled={!offer}>
              Save and continue
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && c && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[15px] font-[650] tracking-[-0.01em]">Who to look for</div>
              <p className="text-[13px] text-muted">Each segment is a slice of the market with its own searches and the people to contact. Turn off the ones you don't want.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setAdding({ name: "", countries: ["Saudi Arabia"], titles: [], queries: [] })}>
                Add by hand
              </Button>
              <Button size="sm" loading={busy === "suggest"} onClick={suggest}>
                Suggest segments
              </Button>
            </div>
          </div>
          {adding && (
            <Card className="p-4 sm:p-5">
              <SegmentEditor value={adding} onChange={setAdding} />
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  loading={busy === "add"}
                  onClick={() =>
                    run("add", async () => {
                      await campaignsApi.addSegment(c.id, adding);
                      setAdding(null);
                      await reload();
                    })
                  }
                >
                  Add segment
                </Button>
              </div>
            </Card>
          )}
          {busy === "suggest" && !c.segmentList.length ? (
            <div className="flex items-center gap-2 py-10 text-muted">
              <Spinner /> Working out who buys this…
            </div>
          ) : !c.segmentList.length ? (
            <Empty title="No segments yet" body="Ask for suggestions based on the offer, or add one by hand." />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {c.segmentList.map((s) => (
                <SegmentCard
                  key={s.id}
                  seg={s}
                  onToggle={(enabled) => run("toggle", async () => (await campaignsApi.updateSegment(c.id, s.id, { enabled }), await reload()))}
                  onSave={async (v) => {
                    await campaignsApi.updateSegment(c.id, s.id, v);
                    await reload();
                  }}
                  onDelete={() => run("delete", async () => (await campaignsApi.deleteSegment(c.id, s.id), await reload()))}
                />
              ))}
            </div>
          )}
          <div className="flex justify-between gap-2 border-t border-line-soft pt-4">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)} disabled={!enabledSegs}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 3 && c && (
        <Card className="space-y-5 p-5 sm:p-6">
          <div>
            <div className="text-[15px] font-[650] tracking-[-0.01em]">Rules</div>
            <p className="text-[13px] text-muted">How much to send, when, and what needs your approval. You can change these any time.</p>
          </div>
          <SettingsForm value={settings} onChange={setSettings} />
          <div className="flex justify-between gap-2 border-t border-line-soft pt-4">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button loading={busy === "rules"} onClick={saveSettings}>
              Save and continue
            </Button>
          </div>
        </Card>
      )}

      {step === 4 && c && (
        <Card className="space-y-5 p-5 sm:p-6">
          <div>
            <div className="text-[15px] font-[650] tracking-[-0.01em]">Ready to start</div>
            <p className="text-[13px] text-muted">The agent can start researching and writing now, even while mailboxes warm up. Emails only leave once everything below is green.</p>
          </div>
          <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
            {(
              [
                [true, "Offer", c.offer ? c.offer.oneLiner || c.offer.product : "Missing", null],
                [enabledSegs > 0, "Segments", `${enabledSegs} enabled`, null],
                [c.readiness.ai, "AI key", c.readiness.ai ? "Research, scoring and writing are on" : "Needed to research properly and write the emails", "agent"],
                [c.readiness.aiSearch, "Gemini search", c.readiness.aiSearch ? "Finds companies and decision makers" : "Optional, but the free search is slow and finds fewer people", "agent"],
                [c.readiness.reacher, "Email verifier", c.readiness.reacher ? "Guessed addresses are checked before sending" : "Without it, guessed addresses wait (published ones still go)", "agent"],
                [c.readiness.instantly, "Instantly", c.readiness.instantly ? "Connected" : "Needed before anything is sent", "agent"],
                [c.readiness.mailboxes.sending > 0, "Sending mailboxes", c.readiness.mailboxes.sending ? `${c.readiness.mailboxes.sending} ready · ${c.readiness.mailboxes.dailyCapacity} emails a day` : "None ready yet. Approved emails wait until one is.", "mailboxes"],
              ] as [boolean, string, string, string | null][]
            ).map(([okk, label, sub, tab]) => (
              <li key={label} className="flex items-center gap-3 px-4 py-3">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", okk ? "bg-good" : "bg-warn")} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold">{label}</div>
                  <div className="truncate text-[12.5px] text-muted">{sub}</div>
                </div>
                {!okk && tab && (
                  <Button variant="ghost" size="sm" onClick={() => goTab(tab)}>
                    Connect
                  </Button>
                )}
                {okk && <Badge className="bg-okb text-good">Ready</Badge>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-between gap-2 border-t border-line-soft pt-4">
            <Button variant="ghost" onClick={() => setStep(3)}>
              Back
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" loading={busy === "pass"} onClick={passNow}>
                Run one pass as a test
              </Button>
              <Button loading={busy === "start"} onClick={start}>
                Start campaign
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
