// VERIFICATION — a corrupt local DB must park itself, not loop the boot.
// Run with SQLITE_PATH pointing at a deliberately-corrupt scratch file.
import { existsSync, readdirSync } from "node:fs";

const file = process.env.SQLITE_PATH!;
const { ensureSchema, q } = await import("../src/db");
await ensureSchema();
const rows = await q(`SELECT count(*) AS n FROM sqlite_master`);
const dir = file.slice(0, file.lastIndexOf("/")) || ".";
const base = file.slice(file.lastIndexOf("/") + 1);
const parked = readdirSync(dir).filter((f) => f.startsWith(base + ".corrupt-"));

let bad = 0;
const ok = (n: string, c: boolean, note = "") => { if (c) console.log(`  ✓ ${n}${note ? ` — ${note}` : ""}`); else { console.log(`  ✗ ${n}${note ? ` — ${note}` : ""}`); bad++; } };
ok("the app booted on a corrupt file instead of crashing", true);
ok("a fresh schema was created", Number(rows[0].n) > 20, `${rows[0].n} objects`);
ok("the corrupt file was parked, not deleted", parked.length === 1, parked.join(", "));
ok("the live db file exists", existsSync(file));
process.exit(bad === 0 ? 0 : 1);
