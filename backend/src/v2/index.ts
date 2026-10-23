// Outreach v2 entry point. index.ts calls mountV2(app) before the static
// frontend catch-all, then startV2Workers().
//
// Feature modules live in their own folders and export:
//   register(app: Hono): void | Promise<void>   — mount /api/v2/<feature>/* routes
//   start?(): void                              — start background workers
// They are loaded dynamically so a module that is still being built (or
// fails to load) never takes the rest of the API down.
import type { Hono } from "hono";
import { ensureV2Schema } from "./schema";
import * as core from "./core-routes";

const FEATURE_MODULES = ["./mailboxes/module", "./inbox/module", "./campaigns/module", "./targeting/module", "./leads/module", "./sequences/module", "./dashboard/module"] as const;

type FeatureModule = { register?: (app: Hono) => void | Promise<void>; start?: () => void };
const loaded: { name: string; mod: FeatureModule }[] = [];

export async function mountV2(app: Hono) {
  await ensureV2Schema();
  core.register(app);
  for (const path of FEATURE_MODULES) {
    try {
      const mod = (await import(path)) as FeatureModule;
      await mod.register?.(app);
      loaded.push({ name: path, mod });
      console.log(`[v2] mounted ${path}`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/Cannot find module|not found|ENOENT/i.test(msg)) console.log(`[v2] ${path} not present yet`);
      else console.error(`[v2] failed to load ${path}: ${msg}`);
    }
  }
}

/** Background workers. Disabled with V2_WORKERS=0 (scripts, tests). */
export function startV2Workers() {
  if (process.env.V2_WORKERS === "0") {
    console.log("[v2] workers disabled (V2_WORKERS=0)");
    return;
  }
  for (const { name, mod } of loaded) {
    try {
      mod.start?.();
    } catch (e: any) {
      console.error(`[v2] ${name} worker failed to start: ${String(e?.message || e)}`);
    }
  }
}
