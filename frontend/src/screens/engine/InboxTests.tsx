// Inbox tests (where our real emails land) and the warmup on/off test.
//   InboxTestGrid    mailbox x test inbox x last 7 days, the pool view
//   MailboxTests     the same for one mailbox, with "Run tests now"
//   ExperimentPanel  warmup on vs off, and the 10-point rule's verdict
import { Fragment, useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Spinner, cn, toast } from "../../lib/ui";
import { fmtDay, type Mailbox, type MailboxPolicy } from "../../lib/v2/mailboxes";
import { SEED_LABEL, engineApi, type Experiment, type GroupStats, type PlacementGrid, type PlacementTest } from "../../lib/v2/engine";
import { EngineLabel, PlacementBars, RESULT_META, ResultChip, placementTone } from "./shared";

function cellTitle(t: PlacementTest | undefined, day: string, seed: string) {
  if (!t) return `${fmtDay(day)} · ${seed}: no test`;
  const m = RESULT_META[t.result]?.label || t.result;
  return `${fmtDay(day)} · ${seed}: ${m}${t.folder ? ` (${t.folder})` : ""}${t.error ? ` · ${t.error}` : ""}`;
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
      {(["inbox", "other_tab", "spam", "missing", "pending"] as const).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={cn("h-2.5 w-2.5 rounded-[3px]", RESULT_META[k].cell)} />
          {RESULT_META[k].label}
        </span>
      ))}
    </div>
  );
}

function Grid({ grid, rows }: { grid: PlacementGrid; rows: { id: string; label: string; sub?: string }[] }) {
  const seeds = grid.seeds.filter((s) => s.enabled || grid.tests.some((t) => t.seedId === s.id));
  const byKey = new Map<string, PlacementTest>();
  for (const t of grid.tests) byKey.set(`${t.mailboxId}|${t.seedId}|${t.day}`, t);
  if (!seeds.length) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-muted">No test inboxes yet. Add them in Agent → Connections.</p>;
  }
  return (
    <div className="overflow-x-auto [scrollbar-width:thin]">
      <table className="w-full min-w-[520px] border-separate border-spacing-0 text-[12px]">
        <thead>
          <tr>
            <th className="w-[38%] pb-2 pr-3 text-left font-semibold uppercase tracking-[0.09em] text-muted" style={{ fontSize: 11 }}>
              Mailbox
            </th>
            {seeds.map((s) => (
              <th key={s.id} className="pb-2 pl-3 text-left align-bottom font-normal">
                <div className="truncate text-[12px] font-semibold text-ink-soft" title={s.email}>
                  {SEED_LABEL[s.provider] || s.provider}
                </div>
                <div className="truncate text-[11px] text-muted">{s.email}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="border-t border-line-soft py-2 pr-3 align-middle">
                <div className="truncate text-[12.5px] font-semibold">{r.label}</div>
                {r.sub && <div className="truncate text-[11px] text-muted">{r.sub}</div>}
              </td>
              {seeds.map((s) => (
                <td key={s.id} className="border-t border-line-soft py-2 pl-3 align-middle">
                  <div className="flex gap-[3px]">
                    {grid.days.map((day) => {
                      const t = byKey.get(`${r.id}|${s.id}|${day}`);
                      return (
                        <span
                          key={day}
                          title={cellTitle(t, day, s.email)}
                          className={cn("h-[14px] w-[14px] rounded-[3px]", t ? RESULT_META[t.result]?.cell || "bg-ink/[0.14]" : "bg-ink/[0.05] ring-1 ring-inset ring-line-soft")}
                        />
                      );
                    })}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-muted">
        <span>Each square is one day, {fmtDay(grid.days[0])} to {fmtDay(grid.days[grid.days.length - 1])}</span>
      </div>
    </div>
  );
}

/** The pool: every own mailbox against every test inbox. */
export function InboxTestGrid({ mailboxes, policy, version }: { mailboxes: Mailbox[]; policy: MailboxPolicy; version: number }) {
  const [grid, setGrid] = useState<PlacementGrid | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    engineApi
      .placement(7)
      .then((g) => (setGrid(g), setError("")))
      .catch((e) => setError(e.message));
  }, [version]);
  const own = mailboxes.filter((m) => m.engine === "own");
  if (!own.length) return null;
  // Mirrors the backend gate: the bar scales to what the test inboxes can produce (2 full days each).
  const live = grid ? grid.seeds.filter((s) => s.enabled && s.status === "ok").length : 0;
  const need = live ? Math.max(1, Math.min(policy.minPlacementTests, live * 2)) : policy.minPlacementTests;
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <EngineLabel>Inbox tests</EngineLabel>
          <p className="mt-1 max-w-[560px] text-[12.5px] leading-relaxed text-muted">
            One real email a day from each mailbox to each test inbox. A mailbox needs {need}+ results in 3 days
            {need < policy.minPlacementTests ? ` (${live} test inbox${live === 1 ? "" : "es"} x 2 full days)` : ""} and {policy.minPlacementRate}%+ in the inbox to
            start sending; under {policy.pausePlacementRate}% two days running pauses it.
          </p>
        </div>
        <Legend />
      </div>
      {!grid ? (
        error ? (
          <p className="text-[12.5px] text-bad">{error}</p>
        ) : (
          <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
            <Spinner /> Loading tests…
          </div>
        )
      ) : (
        <Grid
          grid={grid}
          rows={own.map((m) => ({
            id: m.id,
            label: m.email,
            sub: m.placement?.rate3d != null ? `${m.placement.rate3d}% inbox · ${m.placement.tests3d} tests, 3 days` : "no results yet",
          }))}
        />
      )}
    </Card>
  );
}

/** One mailbox: 7-day bars, the per-test-inbox grid, the latest results, and "Run tests now". */
export function MailboxTests({ m, policy, example }: { m: Mailbox; policy: MailboxPolicy; example: boolean }) {
  const [grid, setGrid] = useState<PlacementGrid | null>(null);
  const [running, setRunning] = useState(false);
  const load = useCallback(() => {
    if (example) return;
    engineApi
      .placement(7, m.id)
      .then(setGrid)
      .catch(() => setGrid(null));
  }, [m.id, example]);
  useEffect(() => load(), [load]);

  async function run() {
    if (example) return toast("This is example data. Actions are off in the preview.");
    setRunning(true);
    try {
      const r = await engineApi.runTests(m.id);
      toast(r.scheduled ? `${r.scheduled} test email${r.scheduled === 1 ? "" : "s"} going out in the next minute. Results in 10 minutes to 2 hours.` : "Today's tests already went out.", "success");
      setTimeout(load, 1500);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setRunning(false);
    }
  }

  const p = m.placement;
  const latest = grid ? [...grid.tests].filter((t) => t.result !== "pending").sort((a, b) => String(b.checkedAt || "").localeCompare(String(a.checkedAt || ""))).slice(0, 4) : [];
  const seedName = (id: string) => grid?.seeds.find((s) => s.id === id)?.email || "test inbox";
  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <EngineLabel>Inbox tests</EngineLabel>
        <Button variant="outline" size="sm" onClick={run} loading={running}>
          Run tests now
        </Button>
      </div>
      <div className="rounded-xl border border-line-soft bg-surf2 p-3.5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className={cn("text-[1.5rem] font-bold leading-none tabular-nums", placementTone(p?.rate3d, policy.minPlacementRate, policy.pausePlacementRate))}>
              {p?.rate3d == null ? "—" : `${p.rate3d}%`}
            </div>
            <div className="mt-1.5 text-[12px] text-muted">
              {p ? `in the inbox · ${p.pass3d} of ${p.tests3d} tests, last 3 days` : "no results yet; the first tests go out within the hour"}
            </div>
          </div>
          {p && <PlacementBars days={p.byDay} pass={policy.minPlacementRate} pause={policy.pausePlacementRate} className="h-7" />}
        </div>
        {p && p.m365Last.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-3 text-[12px] text-muted">
            Microsoft 365 test inbox, latest first:
            {p.m365Last.map((r, i) => (
              <ResultChip key={i} result={r} />
            ))}
          </div>
        )}
      </div>
      {grid && grid.seeds.length > 0 && (
        <div className="mt-3">
          <Grid grid={grid} rows={[{ id: m.id, label: m.email }]} />
        </div>
      )}
      {latest.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {latest.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-[12.5px]">
              <ResultChip result={t.result} />
              <span className="min-w-0 flex-1 truncate text-ink-soft">{seedName(t.seedId)}</span>
              <span className="shrink-0 text-[11px] text-muted">{fmtDay(t.day)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------ warmup test ------------------------------ */

function GroupCol({ g, title, hint, better }: { g: GroupStats; title: string; hint: string; better: boolean }) {
  const row = (k: string, v: string, sub?: string) => (
    <div className="flex items-baseline justify-between gap-3 border-t border-line-soft py-2 text-[12.5px] first:border-t-0">
      <span className="text-muted">{k}</span>
      <span className="text-right">
        <span className="font-semibold tabular-nums">{v}</span>
        {sub && <span className="ml-1.5 text-[11px] text-muted">{sub}</span>}
      </span>
    </div>
  );
  return (
    <div className={cn("rounded-xl border p-3.5", better ? "border-keepl bg-keep1" : "border-line-soft bg-surf2")}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13.5px] font-semibold">{title}</div>
        {better && <Badge className="bg-okb text-good">Ahead</Badge>}
      </div>
      <div className="mt-0.5 text-[11.5px] text-muted">{hint}</div>
      <div className="mt-2.5 text-[1.6rem] font-bold leading-none tabular-nums">{g.inboxRate == null ? "—" : `${g.inboxRate}%`}</div>
      <div className="mt-1 text-[11.5px] text-muted">inbox tests · {g.tests} results</div>
      <div className="mt-3">
        {Object.entries(g.bySeed).map(([k, v]) => (
          <Fragment key={k}>{row(SEED_LABEL[k] || k, v.rate == null ? "—" : `${v.rate}%`, `${v.tests} tests`)}</Fragment>
        ))}
        {row("Reply rate", g.replyRate == null ? "—" : `${g.replyRate}%`, `${g.replies} of ${g.contacted}`)}
        {row("Bounce rate", g.bounceRate == null ? "—" : `${g.bounceRate}%`, `${g.bounces} bounced`)}
      </div>
      <div className="mt-2 truncate text-[11.5px] text-muted" title={g.mailboxes.map((m) => m.email).join(", ")}>
        {g.mailboxes.length ? g.mailboxes.map((m) => m.email).join(" · ") : "No mailbox in this group"}
      </div>
    </div>
  );
}

export function ExperimentPanel({ version }: { version: number }) {
  const [ex, setEx] = useState<Experiment | null>(null);
  useEffect(() => {
    engineApi
      .experiment()
      .then(setEx)
      .catch(() => setEx(null));
  }, [version]);
  if (!ex || !ex.active) return null;
  const pct = Math.min(100, Math.round((ex.day / ex.testDays) * 100));
  const onAhead = ex.on.inboxRate != null && ex.off.inboxRate != null && ex.on.inboxRate > ex.off.inboxRate;
  const offAhead = ex.on.inboxRate != null && ex.off.inboxRate != null && ex.off.inboxRate > ex.on.inboxRate;
  const v = ex.verdict;
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <EngineLabel>Warmup test</EngineLabel>
          <h3 className="mt-1 text-[14.5px] font-[650]">Does Instantly warmup earn its keep?</h3>
          <p className="mt-1 max-w-[560px] text-[12.5px] leading-relaxed text-muted">
            Same ramp, same campaign, same copy. After {ex.testDays} days warmup stays only if it is 10+ points better on inbox tests, or clearly
            better on replies. {ex.note}
          </p>
        </div>
        <div className="w-full max-w-[200px]">
          <div className="flex justify-between text-[11.5px] tabular-nums text-muted">
            <span>Day {Math.min(ex.day, ex.testDays)}</span>
            <span>of {ex.testDays}</span>
          </div>
          <div className="mt-1 h-[6px] overflow-hidden rounded-full bg-ink/[0.07]">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <GroupCol g={ex.on} title="Warmup on" hint="Instantly warmup + slow ramp" better={onAhead} />
        <GroupCol g={ex.off} title="Warmup off" hint="Slow ramp only" better={offAhead} />
      </div>
      <div
        className={cn(
          "mt-4 rounded-xl border px-4 py-3 text-[13px] leading-relaxed",
          v.decided ? (v.keepWarmup ? "border-okl bg-okb text-good" : "border-wnl bg-wnb text-warn") : "border-line-soft bg-surf2 text-ink-soft"
        )}
      >
        <span className="font-semibold">{v.decided ? "Decision: " : "So far: "}</span>
        {v.text}
      </div>
    </Card>
  );
}
