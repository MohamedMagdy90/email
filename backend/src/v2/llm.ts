// Provider-agnostic LLM layer for the AI agent — free tiers first.
//
//   gemini      Google AI Studio key. JSON mode + Google Search grounding
//               (the only provider that can search the web for us).
//   groq        Free tier, very fast. Good for classification / short writing.
//   openrouter  Free models as a last resort.
//
// Every call is paced per model (free tiers are RPM-limited), counted in
// llm_usage, and capped by a daily call budget. Failing providers fall through
// to the next one. Callers never see provider details unless they want to.
import { q, getSetting, setSetting } from "../db";
import { sleep, todayUtc } from "./events";

export type LlmProvider = "gemini" | "groq" | "openrouter";

export interface LlmRequest {
  system?: string;
  prompt: string;
  /** Expect a JSON object/array back; parsed into `data`. */
  json?: boolean;
  /** Ground the answer in live Google Search results (Gemini only). */
  search?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** smart = research & writing (quality), fast = classification (cheap/quick). */
  tier?: "smart" | "fast";
  /** Short label for logs, e.g. "research:acme.com". */
  task?: string;
}

export interface LlmSource {
  title: string;
  url: string;
}

export interface LlmResult<T = any> {
  text: string;
  data: T | null;
  provider: LlmProvider | "mock";
  model: string;
  sources: LlmSource[];
}

export class LlmUnavailable extends Error {
  /** HTTP statuses the providers answered with (0 = network error). */
  statuses: number[];
  constructor(msg: string, statuses: number[] = []) {
    super(msg);
    this.name = "LlmUnavailable";
    this.statuses = statuses;
  }
}
export class LlmBudgetExceeded extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LlmBudgetExceeded";
  }
}

/* ------------------------------- config ------------------------------- */

// Google closed the 2.5 models to new API keys (404 "no longer available to
// new users") and points at 3.5 Flash-Lite / 3.8 Flash. OpenRouter keeps
// retiring individual ":free" slugs, so use its free router, which always
// lands on whichever free model is live.
const DEFAULT_MODELS = {
  gemini: "gemini-3.8-flash",
  geminiFast: "gemini-3.5-flash-lite",
  groq: "openai/gpt-oss-120b",
  openrouter: "openrouter/free",
};

// Model names that providers have withdrawn. A setting that still holds one
// (saved from the Models form back when it was the default) is ignored, so the
// current default applies instead of a guaranteed 404.
const RETIRED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "meta-llama/llama-3.3-70b-instruct:free",
]);
async function modelSetting(key: string, fallback: string): Promise<string> {
  const v = ((await getSetting(key)) || "").trim();
  return v && !RETIRED_MODELS.has(v) ? v : fallback;
}

// Minimum gap between calls to the same model, under the free-tier RPM caps.
const MIN_GAP_MS: Record<string, number> = {
  gemini: 6500, // ~9 RPM (Flash free tier)
  geminiFast: 4500, // ~13 RPM (Flash-Lite free tier)
  groq: 2200, // ~27 RPM (free = 30 RPM)
  openrouter: 3500, // ~17 RPM (free = 20 RPM)
};

export interface LlmConfig {
  keys: Record<LlmProvider, string>;
  models: { gemini: string; geminiFast: string; groq: string; openrouter: string };
  dailyBudget: number;
}

export async function getLlmConfig(): Promise<LlmConfig> {
  const s = async (k: string, env: string) => ((await getSetting(k)) || process.env[env] || "").trim();
  return {
    keys: {
      gemini: await s("ai_gemini_key", "GEMINI_API_KEY"),
      groq: await s("ai_groq_key", "GROQ_API_KEY"),
      openrouter: await s("ai_openrouter_key", "OPENROUTER_API_KEY"),
    },
    models: {
      gemini: await modelSetting("ai_gemini_model", DEFAULT_MODELS.gemini),
      geminiFast: await modelSetting("ai_gemini_fast_model", DEFAULT_MODELS.geminiFast),
      groq: await modelSetting("ai_groq_model", DEFAULT_MODELS.groq),
      openrouter: await modelSetting("ai_openrouter_model", DEFAULT_MODELS.openrouter),
    },
    dailyBudget: Math.max(10, Number(await getSetting("ai_daily_budget")) || 600),
  };
}

/* ------------------------------ test hook ------------------------------ */

type MockFn = (req: LlmRequest) => Promise<string | object> | string | object;
let mock: MockFn | null = null;
/** Scripts/tests only: answer every llm() call with this function. */
export function setLlmMock(fn: MockFn | null) {
  mock = fn;
}

/* ------------------------------- pacing ------------------------------- */

const chains = new Map<string, Promise<void>>();
const nextAt = new Map<string, number>();
async function pace(slot: string): Promise<void> {
  const gap = MIN_GAP_MS[slot] ?? 3000;
  const prev = chains.get(slot) || Promise.resolve();
  const mine = prev.then(async () => {
    const now = Date.now();
    const at = Math.max(now, nextAt.get(slot) || 0);
    nextAt.set(slot, at + gap);
    if (at > now) await sleep(at - now);
  });
  chains.set(slot, mine.catch(() => {}));
  return mine;
}

/* ------------------------------- usage -------------------------------- */

async function recordUsage(provider: string, model: string, inTok: number, outTok: number, error = false) {
  try {
    await q(
      `INSERT INTO llm_usage (day, provider, model, calls, errors, input_tokens, output_tokens)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (day, provider, model) DO UPDATE SET
         calls = llm_usage.calls + ?, errors = llm_usage.errors + ?,
         input_tokens = llm_usage.input_tokens + ?, output_tokens = llm_usage.output_tokens + ?`,
      [todayUtc(), provider, model, error ? 0 : 1, error ? 1 : 0, inTok, outTok, error ? 0 : 1, error ? 1 : 0, inTok, outTok]
    );
  } catch {
    /* never block a call on accounting */
  }
}

export async function usageToday(): Promise<{ calls: number; errors: number; byProvider: Record<string, number> }> {
  const rows = await q(`SELECT provider, calls, errors FROM llm_usage WHERE day = ?`, [todayUtc()]);
  const byProvider: Record<string, number> = {};
  let calls = 0;
  let errors = 0;
  for (const r of rows) {
    byProvider[r.provider] = (byProvider[r.provider] || 0) + Number(r.calls || 0);
    calls += Number(r.calls || 0);
    errors += Number(r.errors || 0);
  }
  return { calls, errors, byProvider };
}

/** How many more calls today's budget allows (callers use this to pace work). */
export async function budgetRemaining(): Promise<number> {
  const cfg = await getLlmConfig();
  const u = await usageToday();
  return Math.max(0, cfg.dailyBudget - u.calls);
}

/* --------------------------- web search state --------------------------- */
// Grounding with Google Search is paid-tier only on Gemini 3 and newer (the
// pricing page lists it as "Not available" on the free tier). A free key still
// answers normal prompts, so the key test passes, but EVERY search is refused.
// Remember the refusal per key and stop asking for a while: discovery uses the
// free web search instead, and research, scoring and writing keep the AI.

const SEARCH_BLOCK = "ai_search_block";
const SEARCH_BLOCK_KEY_MS = 12 * 3600_000; // the key can't search (free tier, no access, bad model)
const SEARCH_BLOCK_BUSY_MS = 15 * 60_000; // rate limit, overload, network

export interface SearchBlock {
  /** "key" = this key can't search; "busy" = a passing rate limit or outage. */
  kind: "key" | "busy";
  /** Plain-English reason for the UI and the activity log. */
  reason: string;
  /** What Google answered, shortened. */
  error: string;
  until: string;
  at: string;
  /** Last characters of the key it applies to (a new key starts unblocked). */
  key: string;
}

const keyTag = (key: string) => key.trim().slice(-6);

async function readSearchBlock(geminiKey: string): Promise<SearchBlock | null> {
  if (!geminiKey) return null;
  const raw = await getSetting(SEARCH_BLOCK);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as SearchBlock;
    if (!b || b.key !== keyTag(geminiKey) || !(Date.parse(b.until) > Date.now())) return null;
    return b;
  } catch {
    return null;
  }
}

/** Was this a "the key can't search" answer, or a passing problem? */
function searchFailureKind(errors: string[], statuses: number[]): "key" | "busy" {
  const text = errors.join(" | ");
  if (statuses.some((s) => s === 400 || s === 401 || s === 403 || s === 404)) return "key";
  if (/limit:\s*0\b|free[ _-]?tier|not available|not supported|billing|permission|paid tier/i.test(text)) return "key";
  return "busy";
}

async function blockSearch(geminiKey: string, errors: string[], statuses: number[]): Promise<SearchBlock> {
  const kind = searchFailureKind(errors, statuses);
  const error = (errors[errors.length - 1] || "no answer").slice(0, 240);
  const now = Date.now();
  const b: SearchBlock = {
    kind,
    reason:
      kind === "key"
        ? "Google refused web search on this Gemini key. On Gemini 3 models, Google Search only works once billing is on for the key's Google Cloud project (5,000 searches a month are free). Until then new companies come from the free web search; research, scoring and writing carry on with the AI."
        : "Gemini search is rate-limited or busy right now. New companies come from the free web search for the next 15 minutes; research, scoring and writing still use the AI.",
    error,
    until: new Date(now + (kind === "key" ? SEARCH_BLOCK_KEY_MS : SEARCH_BLOCK_BUSY_MS)).toISOString(),
    at: new Date(now).toISOString(),
    key: keyTag(geminiKey),
  };
  await setSetting(SEARCH_BLOCK, JSON.stringify(b)).catch(() => {});
  return b;
}

async function clearSearchBlock(): Promise<void> {
  if (await getSetting(SEARCH_BLOCK)) await setSetting(SEARCH_BLOCK, "").catch(() => {});
}

/* --------------------------- Gemini model pause --------------------------- */
// Google answers 429 "You exceeded your current quota" when a model's limit
// (per minute or per day) is used up on the key, or the model isn't on its plan
// at all ("limit: 0"). Asking again only fails again, and each try used to cost
// an 8 s wait before the work fell back to Groq, so slow research starved the
// rest of the pipeline. Now the model is paused and calls go straight to the
// next provider. A successful call or a passing key test lifts the pause.

const MODEL_PAUSE = "ai_gemini_paused";
const PAUSE_LONG_MS = 60 * 60_000; // daily limit / not on the plan / key refused: try again hourly
const PAUSE_UNKNOWN_START_MS = 2 * 60_000; // Google didn't say which limit: 2, 4, 8 … 60 min

export type PauseKind = "minute" | "day" | "plan" | "key" | "quota";

export interface ModelPause {
  model: string;
  kind: PauseKind;
  /** Plain-English reason for the UI and the activity log. */
  reason: string;
  /** What Google answered, shortened. */
  error: string;
  until: string;
  at: string;
  /** Failures in a row (grows the wait when Google doesn't say how long). */
  strikes: number;
  /** Last characters of the key it applies to (a new key starts unpaused). */
  key: string;
}

async function readPauses(geminiKey: string): Promise<Record<string, ModelPause>> {
  if (!geminiKey) return {};
  const raw = await getSetting(MODEL_PAUSE);
  if (!raw) return {};
  try {
    const all = JSON.parse(raw) as Record<string, ModelPause>;
    const out: Record<string, ModelPause> = {};
    for (const [model, p] of Object.entries(all || {})) if (p && p.key === keyTag(geminiKey)) out[model] = p;
    return out;
  } catch {
    return {};
  }
}

const isPaused = (p: ModelPause | undefined): p is ModelPause => !!p && Date.parse(p.until) > Date.now();

/** Models of this key that are paused right now. */
export async function pausedModels(geminiKey: string): Promise<ModelPause[]> {
  return Object.values(await readPauses(geminiKey)).filter(isPaused);
}

/** How long to pause a Gemini model after this error, or null when the error isn't about quota or access. */
function pauseFor(e: ProviderError, prev: ModelPause | undefined): { kind: PauseKind; ms: number; strikes: number } | null {
  const msg = e.message;
  const strikes = (prev?.strikes || 0) + 1;
  if (e.status === 401 || e.status === 403 || (e.status === 400 && /api[ _]?key/i.test(msg))) return { kind: "key", ms: PAUSE_LONG_MS, strikes };
  if (e.status === 404) return { kind: "plan", ms: PAUSE_LONG_MS, strikes };
  if (e.status !== 429) return null;
  const ids = e.quotaIds.join(" ");
  if (/limit:\s*0\b/.test(msg)) return { kind: "plan", ms: PAUSE_LONG_MS, strikes };
  if (/per ?day/i.test(ids) || /per day|daily/i.test(msg)) return { kind: "day", ms: PAUSE_LONG_MS, strikes };
  if (/per ?minute/i.test(ids) || e.retryMs != null) return { kind: "minute", ms: Math.min(5 * 60_000, Math.max(15_000, e.retryMs ?? 60_000)), strikes };
  return { kind: "quota", ms: Math.min(PAUSE_LONG_MS, PAUSE_UNKNOWN_START_MS * 2 ** Math.min(5, strikes - 1)), strikes };
}

function pauseReason(kind: PauseKind, model: string): string {
  switch (kind) {
    case "minute":
      return `Gemini's per-minute limit for ${model} is used up. The other AI providers take over and Gemini is asked again in a moment.`;
    case "day":
      return `Gemini's daily limit for ${model} is used up on this key. The other AI providers do the research, scoring and writing meanwhile; Gemini is asked again every hour (Google resets daily limits at midnight Pacific time).`;
    case "plan":
      return `${model} isn't available on this key's plan (Google allows it 0 requests). Turn billing on for the key's Google Cloud project, then press Test on the Gemini key.`;
    case "key":
      return "Google refused this Gemini key. Check the key in Google AI Studio, then press Test on it.";
    default:
      return `Google says this key is over its quota for ${model}. The other AI providers take over meanwhile; check usage and billing in Google AI Studio.`;
  }
}

/** Remember a quota / access failure. Returns the pause, or null when the error isn't one. */
async function noteGeminiFailure(geminiKey: string, model: string, e: unknown): Promise<ModelPause | null> {
  if (!geminiKey || !(e instanceof ProviderError)) return null;
  const all = await readPauses(geminiKey);
  const how = pauseFor(e, all[model]);
  if (!how) return null;
  const now = Date.now();
  const p: ModelPause = {
    model,
    kind: how.kind,
    reason: pauseReason(how.kind, model),
    error: e.message.slice(0, 240),
    until: new Date(now + how.ms).toISOString(),
    at: new Date(now).toISOString(),
    strikes: how.strikes,
    key: keyTag(geminiKey),
  };
  await setSetting(MODEL_PAUSE, JSON.stringify({ ...all, [model]: p })).catch(() => {});
  return p;
}

/** The model answered: lift its pause (no write when there is none). */
async function clearGeminiPause(geminiKey: string, model: string): Promise<void> {
  const all = await readPauses(geminiKey);
  if (!all[model]) return;
  delete all[model];
  await setSetting(MODEL_PAUSE, Object.keys(all).length ? JSON.stringify(all) : "").catch(() => {});
}

/* ------------------------------ JSON parse ----------------------------- */

/** Pull the first JSON object/array out of model text (fences, prose, trailing commas). */
export function extractJson<T = any>(text: string): T | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const tryParse = (x: string) => {
    try {
      return JSON.parse(x);
    } catch {
      try {
        return JSON.parse(x.replace(/,\s*([}\]])/g, "$1"));
      } catch {
        return undefined;
      }
    }
  };
  const direct = tryParse(s);
  if (direct !== undefined) return direct as T;
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const open = s[start];
    const close = open === "{" ? "}" : "]";
    const end = s.lastIndexOf(close);
    if (end > start) {
      const v = tryParse(s.slice(start, end + 1));
      if (v !== undefined) return v as T;
    }
  }
  return null;
}

/* ------------------------------ providers ------------------------------ */

class ProviderError extends Error {
  status: number;
  retryable: boolean;
  /** Gemini: the quota(s) Google says were hit, e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier". */
  quotaIds: string[];
  /** Gemini: how long Google says to wait (RetryInfo), in ms. */
  retryMs: number | null;
  constructor(msg: string, status: number, extra: { quotaIds?: string[]; retryMs?: number | null } = {}) {
    super(msg);
    this.status = status;
    this.retryable = status === 0 || status === 429 || status >= 500;
    this.quotaIds = extra.quotaIds || [];
    this.retryMs = extra.retryMs ?? null;
  }
}

/** The quota ids and retry delay in a Google error body (google.rpc.QuotaFailure / RetryInfo). */
function googleErrorDetails(data: any): { quotaIds: string[]; retryMs: number | null } {
  const details: any[] = Array.isArray(data?.error?.details) ? data.error.details : [];
  const quotaIds: string[] = [];
  let retryMs: number | null = null;
  for (const d of details) {
    for (const v of Array.isArray(d?.violations) ? d.violations : []) {
      const id = String(v?.quotaId || v?.quotaMetric || "").trim();
      if (id) quotaIds.push(id.slice(0, 120));
    }
    if (typeof d?.retryDelay === "string") {
      const s = Number.parseFloat(d.retryDelay);
      if (Number.isFinite(s) && s >= 0) retryMs = Math.round(s * 1000);
    }
  }
  return { quotaIds, retryMs };
}

async function callGemini(
  key: string,
  model: string,
  req: LlmRequest
): Promise<{ text: string; sources: LlmSource[]; inTok: number; outTok: number }> {
  const fast = req.tier === "fast";
  const body: any = {
    contents: [{ role: "user", parts: [{ text: req.prompt }] }],
    generationConfig: {
      temperature: req.temperature ?? (fast ? 0.2 : 0.6),
      maxOutputTokens: req.maxTokens ?? (fast ? 1024 : 4096),
    },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  // Thinking tokens come out of maxOutputTokens, so keep it bounded or the
  // answer gets cut off (empty response / half a JSON object).
  //  - 2.5 models take a token budget.
  //  - 3.x / 4 take a level. Flash-Lite allows "minimal" (≈ no thinking);
  //    Flash and Argon reject "minimal" with an error, so they use "low".
  const lite = /flash-lite/.test(model);
  if (/2\.5-flash(?!-lite)/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: fast ? 0 : 512 };
  else if (/^gemini-(3|4)/.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: lite ? "minimal" : "low" };
  if (req.search) body.tools = [{ google_search: {} }];
  // Structured output can't be combined with tools; with search we parse text.
  else if (req.json) body.generationConfig.responseMimeType = "application/json";

  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e: any) {
    throw new ProviderError(`gemini network: ${String(e?.message || e)}`, 0);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`gemini ${res.status}: ${data?.error?.message || res.statusText}`, res.status, googleErrorDetails(data));
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p: any) => p.text || "").join("").trim();
  if (!text) throw new ProviderError(`gemini empty response (${cand?.finishReason || "no candidate"})`, 502);
  const sources: LlmSource[] = (cand?.groundingMetadata?.groundingChunks || [])
    .map((c: any) => ({ title: String(c?.web?.title || ""), url: String(c?.web?.uri || "") }))
    .filter((s: LlmSource) => s.url);
  return {
    text,
    sources,
    inTok: Number(data?.usageMetadata?.promptTokenCount || 0),
    outTok: Number(data?.usageMetadata?.candidatesTokenCount || 0),
  };
}

async function callOpenAICompat(
  base: string,
  key: string,
  model: string,
  req: LlmRequest,
  extraHeaders: Record<string, string> = {}
): Promise<{ text: string; sources: LlmSource[]; inTok: number; outTok: number }> {
  const messages: any[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });
  const body: any = {
    model,
    messages,
    temperature: req.temperature ?? (req.tier === "fast" ? 0.2 : 0.6),
    max_tokens: req.maxTokens ?? (req.tier === "fast" ? 1024 : 4096),
  };
  if (req.json) body.response_format = { type: "json_object" };
  // Reasoning models (gpt-oss on Groq) spend output tokens thinking before
  // they answer; with a small max_tokens the JSON is cut off and Groq rejects
  // it ("Failed to validate JSON"). Keep the reasoning short and out of the reply.
  if (/gpt-oss/.test(model)) {
    body.reasoning_effort = "low";
    if (base.includes("groq.com")) body.reasoning_format = "hidden";
  }
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e: any) {
    throw new ProviderError(`${base} network: ${String(e?.message || e)}`, 0);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`${new URL(base).host} ${res.status}: ${data?.error?.message || res.statusText}`, res.status);
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new ProviderError(`${new URL(base).host} empty response`, 502);
  return {
    text,
    sources: [],
    inTok: Number(data?.usage?.prompt_tokens || 0),
    outTok: Number(data?.usage?.completion_tokens || 0),
  };
}

/* -------------------------------- main -------------------------------- */

interface Route {
  provider: LlmProvider;
  model: string;
  slot: string;
}

function routesFor(req: LlmRequest, cfg: LlmConfig): Route[] {
  const g = cfg.keys.gemini;
  const gq = cfg.keys.groq;
  const or = cfg.keys.openrouter;
  if (req.search) {
    return g ? [{ provider: "gemini", model: cfg.models.gemini, slot: "gemini" }] : [];
  }
  const r: Route[] = [];
  if (req.tier === "fast") {
    // Save Gemini quota for search/research: classify on Groq first.
    if (gq) r.push({ provider: "groq", model: cfg.models.groq, slot: "groq" });
    if (g) r.push({ provider: "gemini", model: cfg.models.geminiFast, slot: "geminiFast" });
  } else {
    if (g) r.push({ provider: "gemini", model: cfg.models.gemini, slot: "gemini" });
    if (gq) r.push({ provider: "groq", model: cfg.models.groq, slot: "groq" });
    if (g) r.push({ provider: "gemini", model: cfg.models.geminiFast, slot: "geminiFast" });
  }
  if (or) r.push({ provider: "openrouter", model: cfg.models.openrouter, slot: "openrouter" });
  return r;
}

/**
 * Ask the model. Throws LlmUnavailable when no provider is configured (or all
 * fail), LlmBudgetExceeded when today's call budget is spent.
 */
export async function llm<T = any>(req: LlmRequest): Promise<LlmResult<T>> {
  if (mock) {
    const out = await mock(req);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return { text, data: req.json ? extractJson<T>(text) : null, provider: "mock", model: "mock", sources: [] };
  }
  const cfg = await getLlmConfig();
  const routes = routesFor(req, cfg);
  if (!routes.length) {
    throw new LlmUnavailable(
      req.search
        ? "Web search needs a Gemini API key (free at aistudio.google.com) — add it in Agent → Integrations."
        : "No AI provider configured — add a free Gemini or Groq key in Agent → Integrations."
    );
  }
  const used = await usageToday();
  if (used.calls >= cfg.dailyBudget) {
    throw new LlmBudgetExceeded(`Daily AI budget reached (${used.calls}/${cfg.dailyBudget} calls). Work resumes tomorrow (UTC).`);
  }
  // A key Google refused search on: don't ask again until the block runs out.
  if (req.search) {
    const block = await readSearchBlock(cfg.keys.gemini);
    if (block) throw new LlmUnavailable(`Web search is off for now: ${block.error}`);
  }

  const errors: string[] = [];
  const statuses: number[] = [];
  // Gemini models over their quota are skipped until the pause runs out.
  const pauses = cfg.keys.gemini ? await readPauses(cfg.keys.gemini) : {};
  const skipped: ModelPause[] = [];
  for (const route of routes) {
    if (route.provider === "gemini" && isPaused(pauses[route.model])) {
      skipped.push(pauses[route.model]);
      continue;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await pace(route.slot);
      try {
        const key = cfg.keys[route.provider];
        const r =
          route.provider === "gemini"
            ? await callGemini(key, route.model, req)
            : route.provider === "groq"
              ? await callOpenAICompat("https://api.groq.com/openai/v1", key, route.model, req)
              : await callOpenAICompat("https://openrouter.ai/api/v1", key, route.model, req, {
                  "HTTP-Referer": "https://dna.systems",
                  "X-Title": "DNA Outreach",
                });
        await recordUsage(route.provider, route.model, r.inTok, r.outTok);
        let data: T | null = null;
        if (req.json) {
          data = extractJson<T>(r.text);
          if (data == null) {
            errors.push(`${route.provider}: unparseable JSON`);
            if (attempt === 0) {
              req = { ...req, prompt: `${req.prompt}\n\nIMPORTANT: respond with ONLY valid JSON, no prose, no code fences.` };
              continue;
            }
            break;
          }
        }
        if (req.search) await clearSearchBlock();
        if (route.provider === "gemini" && pauses[route.model]) await clearGeminiPause(cfg.keys.gemini, route.model);
        return { text: r.text, data, provider: route.provider, model: route.model, sources: r.sources };
      } catch (e: any) {
        await recordUsage(route.provider, route.model, 0, 0, true);
        const msg = String(e?.message || e);
        errors.push(msg);
        if (e instanceof ProviderError) statuses.push(e.status);
        // Gemini over its quota (or refusing the key): pause the model and move
        // on at once. No 8 s wait: a second try right away fails the same way.
        // Not for searches: a free key is refused search ("limit: 0" on the
        // search quota) while plain prompts to the same model still work; the
        // search block above covers that.
        if (route.provider === "gemini" && !req.search) {
          const p = await noteGeminiFailure(cfg.keys.gemini, route.model, e);
          if (p) {
            pauses[route.model] = p;
            break;
          }
        }
        // "limit: 0" = not on this plan at all; waiting won't help.
        if (e instanceof ProviderError && e.status === 429 && attempt === 0 && !/limit:\s*0\b/.test(msg)) {
          await sleep(8000);
          continue;
        }
        if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) break; // bad key -> next provider
        if (!(e instanceof ProviderError) || !e.retryable) break;
      }
    }
  }
  // Only a provider error blocks search (an unparseable answer is not a refusal).
  if (req.search && cfg.keys.gemini && statuses.length) {
    const b = await blockSearch(cfg.keys.gemini, errors, statuses);
    throw new LlmUnavailable(`Gemini couldn't search the web: ${b.error}`, statuses);
  }
  // Every route was a paused Gemini model (or the rest failed too): say so.
  if (skipped.length) {
    const p = skipped[0];
    const why = `Gemini ${p.model} is paused until ${p.until.slice(11, 16)} UTC (${p.error.slice(0, 120)})`;
    throw new LlmUnavailable(errors.length ? `All AI providers failed${req.task ? ` (${req.task})` : ""}: ${why} | ${errors.slice(-2).join(" | ")}` : why, statuses);
  }
  throw new LlmUnavailable(`All AI providers failed${req.task ? ` (${req.task})` : ""}: ${errors.slice(-3).join(" | ")}`, statuses);
}

/** Is any provider configured? (`search` = can we ground in Google Search) */
export async function aiStatus() {
  const cfg = await getLlmConfig();
  const usage = await usageToday();
  const blocked = await readSearchBlock(cfg.keys.gemini);
  const paused = await pausedModels(cfg.keys.gemini);
  // Search runs on the main model: paused for quota = no search either.
  const searchModelPaused = paused.some((p) => p.model === cfg.models.gemini);
  return {
    configured: !!(cfg.keys.gemini || cfg.keys.groq || cfg.keys.openrouter),
    /** A Gemini key exists, Google hasn't refused search on it lately, and its model isn't paused. */
    canSearch: !!cfg.keys.gemini && !blocked && !searchModelPaused,
    search: {
      blocked: blocked ? { kind: blocked.kind, reason: blocked.reason, error: blocked.error, until: blocked.until, at: blocked.at } : null,
    },
    providers: {
      gemini: {
        configured: !!cfg.keys.gemini,
        model: cfg.models.gemini,
        fastModel: cfg.models.geminiFast,
        /** Models over their quota right now; the other providers do the work until `until`. */
        paused: paused.map((p) => ({ model: p.model, kind: p.kind, reason: p.reason, error: p.error, until: p.until, at: p.at })),
      },
      groq: { configured: !!cfg.keys.groq, model: cfg.models.groq },
      openrouter: { configured: !!cfg.keys.openrouter, model: cfg.models.openrouter },
    },
    budget: cfg.dailyBudget,
    usage,
  };
}

/** Fire one tiny prompt at one provider to validate a key. */
export async function testProvider(
  provider: LlmProvider,
  /** Test this key instead of the saved one (checked before saving). */
  keyOverride?: string
): Promise<{ ok: boolean; model?: string; error?: string; ms?: number; search?: { ok: boolean; model: string; error?: string } }> {
  const cfg = await getLlmConfig();
  const key = (keyOverride || "").trim() || cfg.keys[provider];
  if (!key) return { ok: false, error: "No key saved" };
  const t0 = Date.now();
  // Room for a reasoning model's short think + the answer; 50 tokens was not
  // enough for gpt-oss and failed a perfectly good Groq key.
  const req: LlmRequest = { prompt: 'Reply with the JSON {"ok":true}', json: true, tier: "fast", maxTokens: 512 };
  let model = "";
  try {
    model = provider === "gemini" ? cfg.models.geminiFast : cfg.models[provider];
    const r =
      provider === "gemini"
        ? await callGemini(key, model, req)
        : provider === "groq"
          ? await callOpenAICompat("https://api.groq.com/openai/v1", key, model, req)
          : await callOpenAICompat("https://openrouter.ai/api/v1", key, model, req);
    await recordUsage(provider, model, r.inTok, r.outTok);
  } catch (e: any) {
    // Testing the saved key: remember a quota failure like any other call would.
    if (provider === "gemini" && !keyOverride) await noteGeminiFailure(key, model, e);
    return { ok: false, error: String(e?.message || e) };
  }
  const ms = Date.now() - t0;
  if (provider !== "gemini") return { ok: true, model, ms };
  // The key answered: lift a pause on this model (a NEW key starts without one anyway).
  await clearGeminiPause(key, model);
  // A key can pass the plain prompt and still be refused web search (free
  // tier), so check search on its own. Uses one search request.
  return { ok: true, model, ms, search: await testGeminiSearch(key, cfg.models.gemini) };
}

async function testGeminiSearch(key: string, model: string): Promise<{ ok: boolean; model: string; error?: string }> {
  const req: LlmRequest = {
    prompt: 'Use Google Search: what is the official website of Saudi Aramco? Reply with the JSON {"website": string}',
    search: true,
    json: true,
    tier: "fast",
    maxTokens: 1024,
  };
  try {
    const r = await callGemini(key, model, req);
    await recordUsage("gemini", model, r.inTok, r.outTok);
    await clearSearchBlock();
    await clearGeminiPause(key, model);
    return { ok: true, model };
  } catch (e: any) {
    await recordUsage("gemini", model, 0, 0, true);
    const status = e instanceof ProviderError ? e.status : 0;
    const b = await blockSearch(key, [String(e?.message || e)], [status]);
    return { ok: false, model, error: b.kind === "key" ? `Web search refused: ${b.error}` : `Web search didn't answer just now: ${b.error}` };
  }
}
