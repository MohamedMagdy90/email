// Sending windows — "not at 3am, and not on their weekend".
//
// The automation used to fire the moment the pool was full, which meant a batch
// could land at 02:00 local time. Worse, "local" was never a thing the app knew:
// one server clock decided the moment for a pool that spans Qatar, Jordan, the
// UK and Singapore at once.
//
// So the unit of scheduling here is THE COUNTRY, not the server:
//   · every country resolves to an IANA time zone (overridable)
//   · every country has a window — start, end, and which local weekdays count
//   · a lead is only sendable while ITS OWN country's window is open
//
// The Gulf working week is Sunday–Thursday, Europe's is Monday–Friday, so the
// default day set is per country too. Everything is one JSON blob in settings,
// which keeps this a config change rather than a migration.

import { getSetting, setSetting } from "./db";
import { COUNTRY_NAME, normalizeCountry } from "./country";

/** Leads with no country on file — the pool's own bucket name. */
export const NO_COUNTRY = "__none__";

/* ------------------------------ time zones ----------------------------- */

// ISO2 → IANA zone. Countries that span several zones resolve to the one their
// business districts keep (US → New York, AU → Sydney): outreach cares about
// office hours, and a two-hour error inside a 9-to-5 window is not a 3am email.
const ISO_TZ: Record<string, string> = {
  QA: "Asia/Qatar", AE: "Asia/Dubai", SA: "Asia/Riyadh", KW: "Asia/Kuwait",
  BH: "Asia/Bahrain", OM: "Asia/Muscat", JO: "Asia/Amman", LB: "Asia/Beirut",
  SY: "Asia/Damascus", EG: "Africa/Cairo", MA: "Africa/Casablanca",
  TN: "Africa/Tunis", DZ: "Africa/Algiers", LY: "Africa/Tripoli",
  IQ: "Asia/Baghdad", PS: "Asia/Hebron", YE: "Asia/Aden", SD: "Africa/Khartoum",
  GB: "Europe/London", IE: "Europe/Dublin", DE: "Europe/Berlin",
  FR: "Europe/Paris", ES: "Europe/Madrid", IT: "Europe/Rome",
  NL: "Europe/Amsterdam", BE: "Europe/Brussels", CH: "Europe/Zurich",
  AT: "Europe/Vienna", SE: "Europe/Stockholm", NO: "Europe/Oslo",
  DK: "Europe/Copenhagen", FI: "Europe/Helsinki", PL: "Europe/Warsaw",
  PT: "Europe/Lisbon", GR: "Europe/Athens", CZ: "Europe/Prague",
  RO: "Europe/Bucharest", TR: "Europe/Istanbul", RU: "Europe/Moscow",
  UA: "Europe/Kyiv", CY: "Asia/Nicosia", MT: "Europe/Malta",
  US: "America/New_York", CA: "America/Toronto", MX: "America/Mexico_City",
  BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires",
  CL: "America/Santiago", CO: "America/Bogota",
  IN: "Asia/Kolkata", PK: "Asia/Karachi", BD: "Asia/Dhaka",
  LK: "Asia/Colombo", NP: "Asia/Kathmandu", CN: "Asia/Shanghai",
  JP: "Asia/Tokyo", KR: "Asia/Seoul", SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur", ID: "Asia/Jakarta", TH: "Asia/Bangkok",
  PH: "Asia/Manila", VN: "Asia/Ho_Chi_Minh", HK: "Asia/Hong_Kong",
  TW: "Asia/Taipei", AU: "Australia/Sydney", NZ: "Pacific/Auckland",
  ZA: "Africa/Johannesburg", NG: "Africa/Lagos", KE: "Africa/Nairobi",
  GH: "Africa/Accra", TZ: "Africa/Dar_es_Salaam", UG: "Africa/Kampala",
  ET: "Africa/Addis_Ababa",
};

// Weekdays, 0 = Sunday. The two working weeks this app actually meets.
export const WEEK_MON_FRI = [1, 2, 3, 4, 5];
export const WEEK_SUN_THU = [0, 1, 2, 3, 4];

// Countries whose working week runs Sunday–Thursday. The UAE moved to Monday–
// Friday in 2022, so it is deliberately NOT in this list.
const SUN_THU_ISO = new Set([
  "SA", "QA", "KW", "BH", "OM", "EG", "JO", "IQ", "LY", "PS", "SY", "YE", "SD",
]);

// Canonical country name → { tz, days }. Built once from the country table so
// the two modules can never disagree about spelling.
export const COUNTRY_TZ: Record<string, string> = {};
const COUNTRY_DAYS: Record<string, number[]> = {};
for (const [iso, name] of Object.entries(COUNTRY_NAME)) {
  if (ISO_TZ[iso]) COUNTRY_TZ[name] = ISO_TZ[iso];
  COUNTRY_DAYS[name] = SUN_THU_ISO.has(iso) ? WEEK_SUN_THU : WEEK_MON_FRI;
}

/* -------------------------------- config ------------------------------- */

export interface SendWindow {
  /** Minutes past local midnight, inclusive. 9am = 540. */
  start: number;
  /** Minutes past local midnight, exclusive. 5pm = 1020. */
  end: number;
  /** Local weekdays the window is open on. 0 = Sunday. */
  days: number[];
}

export interface CountryRule extends Partial<SendWindow> {
  /** Override the built-in IANA zone for this country. */
  timezone?: string;
  /** Hold this country entirely (a market you're not mailing right now). */
  paused?: boolean;
}

export interface ScheduleConfig {
  /** Off = send the moment a batch is ready, whatever the local clock says. */
  enabled: boolean;
  /** The window every country uses unless it has its own. */
  window: SendWindow;
  /** Per-country overrides, keyed by the canonical country name. */
  countries: Record<string, CountryRule>;
  /** Zone used for leads with no country on file. */
  fallbackTimezone: string;
  /** Send leads with no country at all, or hold them back? */
  sendUnknown: boolean;
}

// 9am–5pm, Monday–Friday, ON by default — the whole point of this feature is
// that the app stops emailing people in the middle of their night, and a
// safety rail that ships switched off is not a safety rail.
export const SCHEDULE_DEFAULTS: ScheduleConfig = {
  enabled: true,
  window: { start: 9 * 60, end: 17 * 60, days: WEEK_MON_FRI },
  countries: {},
  fallbackTimezone: "Asia/Qatar",
  sendUnknown: true,
};

const clampMin = (n: unknown, fallback: number) => {
  const x = Math.round(Number(n));
  return Number.isFinite(x) ? Math.max(0, Math.min(1439, x)) : fallback;
};

function cleanDays(input: unknown, fallback: number[]): number[] {
  if (!Array.isArray(input)) return [...fallback];
  const out = [...new Set(input.map((d) => Math.round(Number(d))).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  return out.length ? out.sort((a, b) => a - b) : [...fallback];
}

function cleanWindow(input: any, fallback: SendWindow): SendWindow {
  const start = clampMin(input?.start, fallback.start);
  let end = clampMin(input?.end, fallback.end);
  // A window that ends before it starts would never open. Give it an hour
  // rather than silently disabling the country.
  if (end <= start) end = Math.min(1440, start + 60);
  return { start, end, days: cleanDays(input?.days, fallback.days) };
}

function validZone(tz: unknown): string | null {
  const s = String(tz || "").trim();
  if (!s) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return s;
  } catch {
    return null;
  }
}

function cleanCountries(input: any): Record<string, CountryRule> {
  const out: Record<string, CountryRule> = {};
  if (!input || typeof input !== "object") return out;
  for (const [rawKey, rawVal] of Object.entries(input)) {
    if (!rawVal || typeof rawVal !== "object") continue;
    const key = rawKey === NO_COUNTRY ? NO_COUNTRY : normalizeCountry(rawKey) || String(rawKey).trim();
    if (!key) continue;
    const v = rawVal as CountryRule;
    const rule: CountryRule = {};
    if (v.start != null || v.end != null || v.days != null) {
      const w = cleanWindow(v, defaultWindowFor(key, SCHEDULE_DEFAULTS));
      rule.start = w.start;
      rule.end = w.end;
      rule.days = w.days;
    }
    const tz = validZone(v.timezone);
    if (tz) rule.timezone = tz;
    if (v.paused === true) rule.paused = true;
    if (Object.keys(rule).length) out[key] = rule;
  }
  return out;
}

/** The window a country falls back to when it has no override of its own. */
function defaultWindowFor(country: string, cfg: ScheduleConfig): SendWindow {
  const days = COUNTRY_DAYS[country];
  return days ? { ...cfg.window, days } : { ...cfg.window };
}

let cache: { at: number; cfg: ScheduleConfig } | null = null;
const CACHE_MS = 4000; // the tick and the status endpoint both read this a lot

export async function getSchedule(): Promise<ScheduleConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  const raw = await getSetting("send_schedule");
  let parsed: any = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* fall back to defaults */ }
  const cfg: ScheduleConfig = {
    enabled: parsed?.enabled == null ? SCHEDULE_DEFAULTS.enabled : parsed.enabled === true,
    window: cleanWindow(parsed?.window, SCHEDULE_DEFAULTS.window),
    countries: cleanCountries(parsed?.countries),
    fallbackTimezone: validZone(parsed?.fallbackTimezone) || SCHEDULE_DEFAULTS.fallbackTimezone,
    sendUnknown: parsed?.sendUnknown == null ? SCHEDULE_DEFAULTS.sendUnknown : parsed.sendUnknown === true,
  };
  cache = { at: Date.now(), cfg };
  return cfg;
}

export interface SchedulePatch {
  enabled?: boolean;
  window?: Partial<SendWindow>;
  countries?: Record<string, CountryRule | null>;
  fallbackTimezone?: string;
  sendUnknown?: boolean;
}

export async function setSchedule(patch: SchedulePatch): Promise<ScheduleConfig> {
  const cur = await getSchedule();
  const next: ScheduleConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    window: patch.window ? cleanWindow({ ...cur.window, ...patch.window }, cur.window) : cur.window,
    countries: { ...cur.countries },
    fallbackTimezone: validZone(patch.fallbackTimezone) || cur.fallbackTimezone,
    sendUnknown: typeof patch.sendUnknown === "boolean" ? patch.sendUnknown : cur.sendUnknown,
  };
  // A country posted as null goes back to the default window — that's how the
  // UI's "use the default" button undoes a customisation.
  if (patch.countries && typeof patch.countries === "object") {
    for (const [rawKey, val] of Object.entries(patch.countries)) {
      const key = rawKey === NO_COUNTRY ? NO_COUNTRY : normalizeCountry(rawKey) || String(rawKey).trim();
      if (!key) continue;
      if (val === null) delete next.countries[key];
      else Object.assign(next.countries, cleanCountries({ [key]: val }));
    }
  }
  await setSetting("send_schedule", JSON.stringify(next));
  cache = { at: Date.now(), cfg: next };
  return next;
}

/* ------------------------------ local time ----------------------------- */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalClock {
  /** 0 = Sunday. */
  day: number;
  /** Minutes past local midnight. */
  minutes: number;
  /** "14:05" */
  hhmm: string;
}

export function localClock(tz: string, at: Date = new Date()): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterFor(tz).formatToParts(at);
  } catch {
    parts = formatterFor("UTC").formatToParts(at);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const day = DAY_INDEX[get("weekday")] ?? at.getUTCDay();
  const hour = (Number(get("hour")) || 0) % 24; // some ICU builds say "24" at midnight
  const minute = Number(get("minute")) || 0;
  return { day, minutes: hour * 60 + minute, hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

/* ------------------------------- windows ------------------------------- */

/** The zone a country's leads are scheduled in. */
export function timezoneFor(cfg: ScheduleConfig, country: string | null | undefined): string {
  const key = keyOf(country);
  const rule = cfg.countries[key];
  if (rule?.timezone) return rule.timezone;
  if (key === NO_COUNTRY) return cfg.fallbackTimezone;
  return COUNTRY_TZ[key] || COUNTRY_TZ[normalizeCountry(key) || ""] || cfg.fallbackTimezone;
}

/** The window a country is actually using, defaults merged in. */
export function windowFor(cfg: ScheduleConfig, country: string | null | undefined): SendWindow {
  const key = keyOf(country);
  const base = defaultWindowFor(key, cfg);
  const rule = cfg.countries[key];
  if (!rule) return base;
  return {
    start: rule.start ?? base.start,
    end: rule.end ?? base.end,
    days: rule.days ?? base.days,
  };
}

/** Blank / unknown countries all collapse into the one explicit bucket. */
export function keyOf(country: string | null | undefined): string {
  const raw = String(country || "").trim();
  if (!raw || raw === NO_COUNTRY) return NO_COUNTRY;
  return normalizeCountry(raw) || raw;
}

export function isPaused(cfg: ScheduleConfig, country: string | null | undefined): boolean {
  const key = keyOf(country);
  if (key === NO_COUNTRY && !cfg.sendUnknown) return true;
  return cfg.countries[key]?.paused === true;
}

/**
 * Minutes until this country's window opens. 0 = it is open right now,
 * null = it never opens (paused, or no days selected).
 *
 * Computed arithmetically rather than by stepping a clock forward, so it costs
 * one timezone lookup however far away the next window is. A DST change inside
 * the gap can shift the answer by an hour; that is fine for "opens in ~14h" and
 * the real gate is re-evaluated every tick anyway.
 */
export function minutesUntilOpen(cfg: ScheduleConfig, country: string | null | undefined, at: Date = new Date()): number | null {
  if (!cfg.enabled) return 0;
  if (isPaused(cfg, country)) return null;
  const w = windowFor(cfg, country);
  if (!w.days.length) return null;
  const now = localClock(timezoneFor(cfg, country), at);
  const openToday = w.days.includes(now.day);
  if (openToday && now.minutes >= w.start && now.minutes < w.end) return 0;
  if (openToday && now.minutes < w.start) return w.start - now.minutes;
  for (let k = 1; k <= 7; k++) {
    if (!w.days.includes((now.day + k) % 7)) continue;
    return k * 1440 - now.minutes + w.start;
  }
  return null;
}

export function isOpen(cfg: ScheduleConfig, country: string | null | undefined, at: Date = new Date()): boolean {
  return minutesUntilOpen(cfg, country, at) === 0;
}

/** ISO timestamp of the next opening, or null if it never opens. */
export function nextOpenAt(cfg: ScheduleConfig, country: string | null | undefined, at: Date = new Date()): string | null {
  const m = minutesUntilOpen(cfg, country, at);
  if (m == null) return null;
  if (m === 0) return null;
  return new Date(at.getTime() + m * 60_000).toISOString();
}

/** ISO timestamp of today's close, for "sending until 17:00". */
export function closesAt(cfg: ScheduleConfig, country: string | null | undefined, at: Date = new Date()): string | null {
  if (!isOpen(cfg, country, at)) return null;
  const w = windowFor(cfg, country);
  const now = localClock(timezoneFor(cfg, country), at);
  return new Date(at.getTime() + (w.end - now.minutes) * 60_000).toISOString();
}

/** Of these countries, the ones that may be emailed right now. */
export function openCountries(cfg: ScheduleConfig, countries: (string | null)[], at: Date = new Date()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of countries) {
    const key = keyOf(c);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isOpen(cfg, key, at)) out.push(key);
  }
  return out;
}

/* ------------------------------ formatting ----------------------------- */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function hhmm(minutes: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function describeWindow(w: SendWindow): string {
  const days = w.days.length === 7 ? "every day" : w.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${hhmm(w.start)}–${hhmm(w.end)} · ${days}`;
}
