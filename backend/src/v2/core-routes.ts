// Core v2 routes: integrations (AI keys, Instantly, Reacher), agent settings,
// the activity feed and a one-off verifier. All under /api/v2 (token-gated by
// the global /api/* middleware in index.ts).
import type { Hono } from "hono";
import { getSetting, setSetting } from "../db";
import { aiStatus, testProvider, type LlmProvider } from "./llm";
import { getInstantlyKey, testConnection } from "./instantly";
import { getReacherConfig, testReacher, verifyEmail } from "./verify";
import { getAgentSettings, saveAgentSettings } from "./agent-settings";
import { listEvents } from "./events";

function mask(v: string): string {
  if (!v) return "";
  return v.length <= 8 ? "••••" : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

async function integrationsView() {
  const ai = await aiStatus();
  const instantlyKey = await getInstantlyKey();
  const reacher = await getReacherConfig();
  return {
    ai,
    keys: {
      gemini: mask(((await getSetting("ai_gemini_key")) || process.env.GEMINI_API_KEY || "").trim()),
      groq: mask(((await getSetting("ai_groq_key")) || process.env.GROQ_API_KEY || "").trim()),
      openrouter: mask(((await getSetting("ai_openrouter_key")) || process.env.OPENROUTER_API_KEY || "").trim()),
      instantly: mask(instantlyKey),
    },
    instantly: { configured: !!instantlyKey },
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

  app.post("/api/v2/integrations/test", async (c) => {
    const { target } = await c.req.json().catch(() => ({}));
    if (target === "instantly") return c.json(await testConnection());
    if (target === "reacher") return c.json(await testReacher());
    if (["gemini", "groq", "openrouter"].includes(target)) return c.json(await testProvider(target as LlmProvider));
    return c.json({ ok: false, error: "Unknown target" }, 400);
  });

  app.get("/api/v2/agent-settings", async (c) => c.json(await getAgentSettings()));
  app.put("/api/v2/agent-settings", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await saveAgentSettings(b));
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
