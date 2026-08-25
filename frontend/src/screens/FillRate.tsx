import type { FillRate, FillRateLane, FillStatus } from "../lib/api";
import { Tooltip, cn } from "../lib/ui";

/**
 * FILL RATE — one card, rendered on both Discovery and Overview.
 *
 * It replaces two LEVELS (Discovery's "Pending review", Overview's "Contacts")
 * with a RATE, because a level cannot answer the question either screen is
 * really being asked: will this still be sending tomorrow? A pool of 4,000 with
 * nothing coming in and a pool of 400 with plenty coming in read identically
 * until the first one abruptly stops.
 *
 * Deliberately ONE component in ONE file rather than a copy per screen. The
 * two counts it replaces already had to agree; a metric with a threshold and a
 * colour has far more to disagree about.
 */

/* ------------------------------ tone ---------------------------------- */

// The healthy state is the dark card: on both screens this is now the number
// worth looking at first, so it gets to be the anchor. Amber and red are the
// same two warning treatments the stale-source banners already use, so a
// problem here looks like a problem everywhere else in the app.
const TONE: Record<FillStatus, {
  card: string; label: string; value: string; sub: string;
  bar: string; track: string; target: string; dot: string; pill: string;
}> = {
  ok: {
    card: "border-ink bg-ink",
    label: "text-cream/50", value: "text-cream", sub: "text-cream/55",
    bar: "bg-good", track: "bg-cream/25", target: "border-cream/25",
    dot: "bg-good", pill: "bg-cream/10 text-cream/70",
  },
  slow: {
    card: "border-[#e0b354]/60 bg-[#fdf6e7]",
    label: "text-[#8a5a12]/70", value: "text-[#b06b16]", sub: "text-[#8a5a12]",
    bar: "bg-[#d9822b]", track: "bg-[#e0b354]/45", target: "border-[#b06b16]/40",
    dot: "bg-[#d9822b]", pill: "bg-[#e0b354]/25 text-[#8a5a12]",
  },
  starved: {
    card: "border-bad/50 bg-[#fdeae6]",
    label: "text-[#a3321c]/70", value: "text-[#b02a12]", sub: "text-[#a3321c]",
    bar: "bg-bad", track: "bg-bad/30", target: "border-bad/40",
    dot: "bg-bad", pill: "bg-bad/15 text-[#a3321c]",
  },
  idle: {
    card: "border-line bg-paper",
    label: "text-muted", value: "text-ink", sub: "text-muted",
    bar: "bg-ink/30", track: "bg-ink/[0.13]", target: "border-ink/15",
    dot: "bg-ink/25", pill: "bg-ink/[0.07] text-ink/55",
  },
};

const VERDICT: Record<FillStatus, string> = {
  ok: "keeping up",
  slow: "slowing",
  starved: "starved",
  idle: "idle",
};

/* --------------------------- formatting -------------------------------- */

// One decimal below ten, none above: 8.3 vs 8.0 is a real difference, 143.2 vs
// 143 is not.
function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 10) return Math.round(n).toLocaleString();
  return (Math.round(n * 10) / 10).toString();
}

function duration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const h = minutes / 60;
  if (h < 48) return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

const laneName = (l: FillRateLane) => (l.audience === "partner" ? "Partner" : "Customer");

/* ------------------------------ the card -------------------------------- */

export function FillRateCard({
  fill,
  className,
  onOpen,
  openLabel,
}: {
  fill: FillRate | null | undefined;
  className?: string;
  onOpen?: () => void;
  openLabel?: string;
}) {
  // An API that predates the field, or a first load. Hold the shape of the card
  // rather than collapsing the grid row it sits in.
  if (!fill) {
    return (
      <div className={cn("rounded-2xl border border-line bg-paper p-4", className)}>
        <div className="mono-label text-muted">Fill rate</div>
        <div className="mt-1 font-clash text-2xl font-semibold text-ink/25 tabular-nums">—</div>
        <div className="mt-1 text-[11px] text-muted">Reading the pool…</div>
      </div>
    );
  }

  const t = TONE[fill.status];
  const short = fill.status === "slow" || fill.status === "starved";
  const unit = `/${fill.unitMinutes}min`;

  // TWO lines, not one sentence. Cramming the shortfall and the cause together
  // ("2.7 short of 11 · the discovery bot is…") ran past the width of a
  // quarter-width card and clipped mid-word, losing the half that mattered.
  // The target line is now constant, so the number above it can always be read
  // against something; the cause gets a line of its own.
  const sub = fill.warming
    ? `Measuring — ${duration(Math.max(1, fill.coveredMinutes))} of history so far`
    : fill.status === "idle"
    ? "Nothing is consuming the pool"
    // The measurement window used to be on this line and was the first thing to
    // be clipped. It is a detail of HOW the number was arrived at, not
    // something anyone decides on, so it lives in the tooltip instead.
    : `Target ${num(fill.required)}${unit}`;
  const note = short
    ? fill.reason
      ? fill.reason.charAt(0).toUpperCase() + fill.reason.slice(1)
      : fill.rate <= 0
      ? "Nothing is arriving"
      : "Below target"
    : null;

  const Wrapper: any = onOpen ? "button" : "div";

  return (
    <Wrapper
      {...(onOpen ? { type: "button", onClick: onOpen } : {})}
      className={cn(
        // A container, not a viewport breakpoint: this card is narrow because
        // of the column it sits in — four across, next to a sidebar — which has
        // nothing to do with how wide the window is.
        "@container group/fill flex w-full flex-col overflow-hidden rounded-2xl border text-left transition-colors",
        t.card,
        onOpen && "cursor-pointer hover:brightness-[1.06]",
        className
      )}
    >
      <div className="px-4 pt-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className={cn("mono-label whitespace-nowrap", t.label)}>Fill rate</span>
          {/* The workings live one hover away rather than in the card, the same
              call the pool tools make: this is a glance metric, and nobody
              needs the arithmetic every time they look at it. */}
          <Tooltip side="bottom" wide label={<Workings fill={fill} />}>
            <span
              tabIndex={0}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                t.pill
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", t.dot)} />
              {/* Below ~230px the word and the label can't both fit, and the
                  label is the one that must survive — the colour already says
                  which way things are going. */}
              <span className="hidden @[230px]:inline">{VERDICT[fill.status]}</span>
            </span>
          </Tooltip>
        </div>

        <div className="mt-1 flex items-baseline gap-1">
          {/* A dash, not a zero, while warming: "0 per 10 minutes" is a claim,
              and twelve minutes after a fresh start we haven't earned it. */}
          <span className={cn("font-clash text-2xl font-semibold tabular-nums sm:text-[28px]", t.value)}>
            {fill.warming ? "—" : num(fill.rate)}
          </span>
          {!fill.warming && <span className={cn("text-[11px] font-medium", t.sub)}>{unit}</span>}
        </div>

        <p className={cn("mt-1 truncate text-[11px] leading-snug", t.sub)}>{sub}</p>
        {note && (
          <p className={cn("mt-0.5 line-clamp-2 text-[11px] font-medium leading-snug", t.value)}>{note}</p>
        )}
      </div>

      {/* Full-bleed, so it reads as part of the card rather than a chart bolted
          into it. The dashed rule is the target: bars above it are keeping up. */}
      <Spark fill={fill} tone={t} />

      {onOpen && (
        <span className="sr-only">{openLabel || "Open Discovery"}</span>
      )}
    </Wrapper>
  );
}

/* ------------------------------ sparkline ------------------------------- */

// EVERY HEIGHT HERE IS A PIXEL VALUE. The sends chart on the Overview drew flat
// for as long as it existed because its bars were a percentage of a parent that
// `items-end` had collapsed to its content height. Same lesson, applied up
// front: a known track, and heights computed against it.
const TRACK = 34;

function Spark({ fill, tone }: { fill: FillRate; tone: (typeof TONE)[FillStatus] }) {
  // Only the lanes being consumed, so a switched-off partner lane can't draw a
  // healthy-looking chart under a starving customer lane. With nothing live,
  // show everything — there is no demand to mislead anyone about.
  const live = fill.lanes.filter((l) => l.live);
  const lanes = live.length ? live : fill.lanes;
  const buckets = lanes[0]?.series.length ?? 0;
  if (!buckets) return <div className="h-3" />;

  const series: number[] = new Array(buckets).fill(0);
  for (const l of lanes) l.series.forEach((n, i) => { series[i] += n; });

  // The target, per bucket — what each bar has to clear to be keeping up.
  const perBucket = fill.required > 0 ? (fill.required / fill.unitMinutes) * fill.bucketMinutes : 0;
  const max = Math.max(1, perBucket * 1.25, ...series);

  return (
    <div className="relative mt-2.5 px-4 pb-3.5">
      <div className="relative flex items-end gap-[2px]" style={{ height: TRACK }}>
        {perBucket > 0 && (
          <span
            className={cn("pointer-events-none absolute inset-x-0 border-t border-dashed", tone.target)}
            style={{ bottom: Math.min(TRACK, (perBucket / max) * TRACK) }}
          />
        )}
        {/* An empty bucket is drawn as a 2px stub rather than a hairline. At 1px
            on a tinted card it disappeared completely, so a run of nothing —
            the single most important thing this chart can show — rendered as
            blank space that looked like a component that had failed to load. */}
        {series.map((n, i) => {
          const h = n > 0 ? Math.max(3, Math.round((n / max) * TRACK)) : 2;
          const met = perBucket > 0 && n >= perBucket;
          return (
            <span
              key={i}
              className={cn(
                "min-w-0 flex-1 rounded-[1.5px]",
                n === 0 ? tone.track : met ? tone.bar : cn(tone.bar, "opacity-45")
              )}
              style={{ height: h }}
              title={`${n} in ${fill.bucketMinutes} min`}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------- workings ------------------------------- */

// Everything the headline number is standing in for. Written as sentences, not
// a table: the point is that the target is DERIVED, and a reader who doesn't
// know that will assume somebody typed it in.
function Workings({ fill }: { fill: FillRate }) {
  const live = fill.lanes.filter((l) => l.live);
  return (
    <span className="block space-y-1.5">
      <span className="block font-medium text-cream">
        New leads with an email, per {fill.unitMinutes} minutes.
      </span>
      {live.length ? (
        <>
          {live.map((l) => (
            <span key={l.audience} className="block text-cream/70">
              {laneName(l)} · <b className="text-cream/95">{num(l.rate)}</b> arriving vs{" "}
              <b className="text-cream/95">{num(l.required)}</b> needed — {l.threshold.toLocaleString()} per batch,
              one batch every {duration(fill.windowMinutes)}.
              {l.coverMinutes != null && l.ready > 0 && (
                <> {l.ready.toLocaleString()} on hand ≈ {duration(l.coverMinutes)} of sending.</>
              )}
              {l.etaMinutes != null && l.etaMinutes > 0 && l.ready < l.threshold && (
                <> Next batch in ~{duration(l.etaMinutes)}.</>
              )}
            </span>
          ))}
          {fill.cappedByDaily && (
            <span className="block text-cream/60">
              Your daily ceiling caps this below the batch size — you can't need more leads than the sender will send.
            </span>
          )}
        </>
      ) : (
        <span className="block text-cream/70">
          No automation lane is switched on, so nothing is draining the pool. This is what the inflow would have to
          beat once one is.
        </span>
      )}
      <span className="block text-cream/50">
        Measured over the last {duration(fill.coveredMinutes || fill.windowMinutes)}
        {fill.coveredMinutes < fill.windowMinutes ? " (all the history there is)" : ""}, counting when each lead's
        email was found — not when the company was discovered.
      </span>
    </span>
  );
}
