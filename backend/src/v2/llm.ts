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
import { q, getSetting } from "../db";
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
  constructor(msg: string) {
    super(msg);
    this.name = "LlmUnavailable";
  }
}
export class LlmBudgetExceeded extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LlmBudgetExceeded";
  }
}

/* ------------------------------- config ------------------------------- */

const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash",
  geminiFast: "gemini-2.5-flash-lite",
  groq: "openai/gpt-oss-120b",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
};

// Minimum gap between calls to the same model, under the free-tier RPM caps.
const MIN_GAP_MS: Record<string, number> = {
  gemini: 6500, // ~9 RPM (2.5 Flash free = 10 RPM)
  geminiFast: 4500, // ~13 RPM (Flash-Lite free = 15 RPM)
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
      gemini: (await getSetting("ai_gemini_model")) || DEFAULT_MODELS.gemini,
      geminiFast: (await getSetting("ai_gemini_fast_model")) || DEFAULT_MODELS.geminiFast,
      groq: (await getSetting("ai_groq_model")) || DEFAULT_MODELS.groq,
      openrouter: (await getSetting("ai_openrouter_model")) || DEFAULT_MODELS.openrouter,
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
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
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
  // Thinking eats into maxOutputTokens on 2.5 models; keep it small and bounded.
  if (/2\.5-flash(?!-lite)/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: fast ? 0 : 512 };
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
  if (!res.ok) throw new ProviderError(`gemini ${res.status}: ${data?.error?.message || res.statusText}`, res.status);
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

  const errors: string[] = [];
  for (const route of routes) {
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
        return { text: r.text, data, provider: route.provider, model: route.model, sources: r.sources };
      } catch (e: any) {
        await recordUsage(route.provider, route.model, 0, 0, true);
        const msg = String(e?.message || e);
        errors.push(msg);
        if (e instanceof ProviderError && e.status === 429 && attempt === 0) {
          await sleep(8000);
          continue;
        }
        if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) break; // bad key -> next provider
        if (!(e instanceof ProviderError) || !e.retryable) break;
      }
    }
  }
  throw new LlmUnavailable(`All AI providers failed${req.task ? ` (${req.task})` : ""}: ${errors.slice(-3).join(" | ")}`);
}

/** Is any provider configured? (`search` = can we ground in Google Search) */
export async function aiStatus() {
  const cfg = await getLlmConfig();
  const usage = await usageToday();
  return {
    configured: !!(cfg.keys.gemini || cfg.keys.groq || cfg.keys.openrouter),
    canSearch: !!cfg.keys.gemini,
    providers: {
      gemini: { configured: !!cfg.keys.gemini, model: cfg.models.gemini, fastModel: cfg.models.geminiFast },
      groq: { configured: !!cfg.keys.groq, model: cfg.models.groq },
      openrouter: { configured: !!cfg.keys.openrouter, model: cfg.models.openrouter },
    },
    budget: cfg.dailyBudget,
    usage,
  };
}

/** Fire one tiny prompt at one provider to validate a key. */
export async function testProvider(provider: LlmProvider): Promise<{ ok: boolean; model?: string; error?: string; ms?: number }> {
  const cfg = await getLlmConfig();
  const key = cfg.keys[provider];
  if (!key) return { ok: false, error: "No key saved" };
  const t0 = Date.now();
  const req: LlmRequest = { prompt: 'Reply with the JSON {"ok":true}', json: true, tier: "fast", maxTokens: 50 };
  try {
    const model = provider === "gemini" ? cfg.models.geminiFast : cfg.models[provider];
    const r =
      provider === "gemini"
        ? await callGemini(key, model, req)
        : provider === "groq"
          ? await callOpenAICompat("https://api.groq.com/openai/v1", key, model, req)
          : await callOpenAICompat("https://openrouter.ai/api/v1", key, model, req);
    await recordUsage(provider, model, r.inTok, r.outTok);
    return { ok: true, model, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
