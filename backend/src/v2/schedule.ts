// Sending windows and time zones. Used by both engines: the Instantly
// campaign schedule and our own send queue.

/** Map a country to a schedule time zone (values Instantly also accepts). */
export function timezoneForCountry(country?: string | null): string {
  const c = String(country || "").toLowerCase();
  if (/(emirates|uae|dubai|abu dhabi|oman)/.test(c)) return "Asia/Dubai";
  if (/(saudi|ksa|qatar|kuwait|bahrain|iraq)/.test(c)) return "Asia/Baghdad";
  if (/yemen/.test(c)) return "Asia/Aden";
  if (/jordan/.test(c)) return "Asia/Amman";
  if (/egypt/.test(c)) return "Africa/Cairo";
  if (/lebanon/.test(c)) return "Asia/Beirut";
  if (/pakistan/.test(c)) return "Asia/Karachi";
  if (/india/.test(c)) return "Asia/Kolkata";
  // Only values from Instantly's 102-entry enum are allowed (no Asia/Riyadh,
  // no Europe/London). Default: UTC+3, which covers KSA/Qatar/Kuwait/Bahrain.
  return "Asia/Baghdad";
}

/**
 * Sun–Thu where the weekend is Fri–Sat (Saudi, Qatar, Kuwait, Bahrain, Oman,
 * Iraq, Yemen, Jordan, Egypt); Mon–Fri elsewhere — including the UAE, which
 * moved to a Sat–Sun weekend in 2022. 0 = Sunday.
 */
export function workDaysForCountry(country?: string | null): Record<string, boolean> {
  const c = String(country || "").toLowerCase();
  const gulf = /(saudi|ksa|qatar|kuwait|bahrain|oman|iraq|yemen|jordan|egypt)/.test(c) && !/(emirates|uae)/.test(c);
  return gulf
    ? { "0": true, "1": true, "2": true, "3": true, "4": true, "5": false, "6": false }
    : { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false };
}

/* ------------------------------ wall clock ------------------------------ */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(d: Date, tz: string) {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(d)) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: WEEKDAY[p.weekday] ?? 0 };
}

/** Minutes the zone is ahead of UTC at `d`. */
export function tzOffsetMin(d: Date, tz: string): number {
  const p = localParts(d, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - d.getTime()) / 60000);
}

/** The UTC moment of a local wall-clock time in `tz`. */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = tzOffsetMin(new Date(guess), tz);
  let t = guess - off * 60000;
  const off2 = tzOffsetMin(new Date(t), tz);
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

const minutesOf = (s: string, fallback: number) => {
  const [h, m] = String(s || "").split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : fallback;
};

/* -------------------------------- windows -------------------------------- */

export interface SendWindow {
  tz: string;
  days: Record<string, boolean>;
  /** HH:MM, local. */
  from: string;
  to: string;
}

export function windowFor(country: string | null | undefined, hours: { from: string; to: string }): SendWindow {
  return { tz: timezoneForCountry(country), days: workDaysForCountry(country), from: hours.from || "09:00", to: hours.to || "17:00" };
}

export function inWindow(at: Date, w: SendWindow): boolean {
  const p = localParts(at, w.tz);
  const mins = p.hour * 60 + p.minute;
  return !!w.days[String(p.weekday)] && mins >= minutesOf(w.from, 540) && mins < minutesOf(w.to, 1020);
}

/** Today's (local) window for the day containing `at`: [start, end] or null on a day off. */
export function windowOn(at: Date, w: SendWindow): { start: Date; end: Date } | null {
  const p = localParts(at, w.tz);
  if (!w.days[String(p.weekday)]) return null;
  const s = minutesOf(w.from, 540);
  const e = minutesOf(w.to, 1020);
  return {
    start: zonedTime(p.year, p.month, p.day, Math.floor(s / 60), s % 60, w.tz),
    end: zonedTime(p.year, p.month, p.day, Math.floor(e / 60), e % 60, w.tz),
  };
}

/** The first moment at or after `from` that is inside the window. */
export function nextWindowStart(from: Date, w: SendWindow): Date {
  if (inWindow(from, w)) return from;
  for (let i = 0; i < 9; i++) {
    const probe = new Date(from.getTime() + i * 86_400_000);
    const day = windowOn(probe, w);
    if (!day) continue;
    if (day.start.getTime() >= from.getTime()) return day.start;
    if (from.getTime() >= day.start.getTime() && from.getTime() < day.end.getTime()) return from;
  }
  return new Date(from.getTime() + 86_400_000);
}

export const randomBetween = (lo: number, hi: number) => lo + Math.random() * Math.max(0, hi - lo);
