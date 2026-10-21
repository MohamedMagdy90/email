// Core v2 routes: integrations (AI keys, Instantly, Reacher), agent settings,
// the activity feed and a one-off verifier. All under /api/v2 (token-gated by
// the global /api/* middleware in index.ts).
import type { Hono } from "hono";
import { getSetting, setSetting, q } from "../db";
import { aiStatus, testProvider, llm, LlmBudgetExceeded, type LlmProvider } from "./llm";
import { getInstantlyKey, testConnection } from "./instantly";
import { getReacherConfig, testReacher, verifyEmail } from "./verify";
import {
  getAgentSettings,
  saveAgentSettings,
  resolveAgentSettings,
  voicePrompt,
  decideReply,
  REPLY_CATEGORIES,
  DEFAULT_AGENT_SETTINGS,
} from "./agent-settings";
import { buildSamplePrompt, readSample, SAMPLE_PROSPECT, SAMPLE_INBOUND, type SampleKind } from "./agent-preview";
import { listEvents } from "./events";

function mask(v: string): string {
  if (!v) return "";
  return v.length <= 8 ? "••••" : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

async function integrationsView() {
  const ai = await aiStatus();
  const instantlyKey = await getInstantlyKey();
  const reacher = await getReacherConfig();
  let mailboxes = { total: 0, sending: 0 };
  try {
    const r = await q(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN stage IN ('ramping','active') AND missing_since IS NULL THEN 1 ELSE 0 END) AS sending
       FROM mailboxes`
    );
    mailboxes = { total: Number(r[0]?.total || 0), sending: Number(r[0]?.sending || 0) };
  } catch {
    /* mailboxes module not migrated yet */
  }
  return {
    ai,
    keys: {
      gemini: mask(((await getSetting("ai_gemini_key")) || process.env.GEMINI_API_KEY || "").trim()),
      groq: mask(((await getSetting("ai_groq_key")) || process.env.GROQ_API_KEY || "").trim()),
      openrouter: mask(((await getSetting("ai_openrouter_key")) || process.env.OPENROUTER_API_KEY || "").trim()),
      instantly: mask(instantlyKey),
    },
    instantly: { configured: !!instantlyKey, mailboxes },
    reacher: { configured: !!reacher, url: reacher?.url || "", hasSecret: !!reacher?.secret },
  };
}

// Setting keys the integrations form may write. Empty string clears, absent = unchanged.
const FIELD_TO_SETTING: Record<string, string> = {
  geminiKey: "ai_gemini_key",
  groqKey: "ai_groq_key",
  openrouterKey: "ai_openrouter_key",
  instantlyKey: "instantly_api_key",
  reacherUrl: "reacher_url",
  reacherSecret: "reacher_secret",
  geminiModel: "ai_gemini_model",
  geminiFastModel: "ai_gemini_fast_model",
  groqModel: "ai_groq_model",
  openrouterModel: "ai_openrouter_model",
  aiDailyBudget: "ai_daily_budget",
};

export function register(app: Hono) {
  app.get("/api/v2/status", async (c) => {
    const view = await integrationsView();
    return c.json({
      ai: { configured: view.ai.configured, canSearch: view.ai.canSearch, usage: view.ai.usage, budget: view.ai.budget },
      instantly: view.instantly,
      reacher: view.reacher,
    });
  });

  app.get("/api/v2/integrations", async (c) => c.json(await integrationsView()));

  app.put("/api/v2/integrations", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    for (const [field, key] of Object.entries(FIELD_TO_SETTING)) {
      if (!(field in b)) continue;
      let v = String(b[field] ?? "").trim();
      if (field === "reacherUrl") v = v.replace(/\/+$/, "");
      if (field === "aiDailyBudget" && v && !(Number(v) > 0)) return c.json({ error: "Daily budget must be a positive number" }, 400);
      await setSetting(key, v);
    }
    return c.json(await integrationsView());
  });

  // `key` / `url` / `secret` test a candidate BEFORE it is saved, so a typo
  // never replaces a working key. Without them the saved values are tested.
  app.post("/api/v2/integrations/test", async (c) => {
    const { target, key, url, secret } = await c.req.json().catch(() => ({}));
    const candidate = typeof key === "string" && key.trim() ? key.trim() : undefined;
    if (target === "instantly") return c.json(await testConnection(candidate));
    if (target === "reacher") {
      if (typeof url === "string" && url.trim()) {
        const saved = await getReacherConfig();
        return c.json(await testReacher({ url, secret: typeof secret === "string" && secret.trim() ? secret : saved?.secret }));
      }
      return c.json(await testReacher());
    }
    if (["gemini", "groq", "openrouter"].includes(target)) return c.json(await testProvider(target as LlmProvider, candidate));
    return c.json({ ok: false, error: "Unknown target" }, 400);
  });

  app.get("/api/v2/agent-settings", async (c) => c.json(await getAgentSettings()));
  app.put("/api/v2/agent-settings", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await saveAgentSettings(b));
  });

  /* ------------------------------ Agent tab ------------------------------ */

  // Static vocabulary: reply categories + recommended settings (for "Reset").
  app.get("/api/v2/agent/meta", (c) =>
    c.json({ categories: REPLY_CATEGORIES, defaults: DEFAULT_AGENT_SETTINGS, sample: { prospect: SAMPLE_PROSPECT, inbound: SAMPLE_INBOUND } })
  );

  // What happens to each kind of reply under these (possibly unsaved) settings.
  app.post("/api/v2/agent/rules/preview", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const s = await resolveAgentSettings(b.settings);
    const categories = REPLY_CATEGORIES.map((cat) => ({
      id: cat.id,
      outcome: decideReply(s, { category: cat.id, confidence: 1, autoRepliesInThread: 0 }),
    }));
    const sc = b.scenario && typeof b.scenario === "object" ? b.scenario : null;
    const scenario = sc
      ? decideReply(s, { category: String(sc.category || ""), confidence: sc.confidence, autoRepliesInThread: sc.autoRepliesInThread })
      : null;
    return c.json({ categories, scenario });
  });

  // The voice instructions + full prompt for a sample; `generate: true` asks
  // the model to actually write it (costs one AI call).
  app.post("/api/v2/agent/voice/preview", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const s = await resolveAgentSettings(b.settings);
    const kind: SampleKind = b.sample === "reply" ? "reply" : "first_touch";
    const { system, prompt } = buildSamplePrompt(s, kind);
    const base = { kind, voice: voicePrompt(s), system, prompt };
    if (!b.generate) return c.json({ ...base, sample: null });
    try {
      const r = await llm({ system, prompt, json: true, tier: "smart", temperature: 0.7, maxTokens: 900, task: `agent-sample:${kind}` });
      return c.json({ ...base, sample: { ...readSample(r.data, r.text), provider: r.provider, model: r.model } });
    } catch (e: any) {
      return c.json({ ...base, sample: null, error: String(e?.message || e), errorKind: e instanceof LlmBudgetExceeded ? "budget" : "unavailable" });
    }
  });

  app.get("/api/v2/events", async (c) => {
    const campaignId = c.req.query("campaignId") || undefined;
    const kind = c.req.query("kind") || undefined;
    const limit = Number(c.req.query("limit")) || 100;
    return c.json({ events: await listEvents({ campaignId, kind, limit }) });
  });

  app.post("/api/v2/verify", async (c) => {
    const { email } = await c.req.json().catch(() => ({}));
    if (!email) return c.json({ error: "email required" }, 400);
    return c.json(await verifyEmail(String(email), { noCache: true }));
  });
}
