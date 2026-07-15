// Best-effort robots.txt support (honors global "User-agent: *" rules).

import { fetchPage } from "./fetcher";

export interface Robots {
  allow: (path: string) => boolean;
}

interface Rules {
  disallow: string[];
  allow: string[];
}

export async function loadRobots(origin: string): Promise<Robots> {
  try {
    const res = await fetchPage(new URL("/robots.txt", origin).toString(), 8000);
    if (!res.ok || !res.html) return { allow: () => true };
    const rules = parseRobots(res.html);
    return { allow: (path: string) => isAllowed(rules, path) };
  } catch {
    return { allow: () => true };
  }
}

function parseRobots(txt: string): Rules {
  const lines = txt.split(/\r?\n/);
  let applies = false;
  const disallow: string[] = [];
  const allow: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      applies = val === "*";
    } else if (applies && key === "disallow") {
      if (val) disallow.push(val);
    } else if (applies && key === "allow") {
      if (val) allow.push(val);
    }
  }
  return { disallow, allow };
}

function matchRule(pattern: string, path: string): boolean {
  // Support "*" wildcard and "$" end-anchor per the robots spec.
  let p = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  p = p.replace(/\\\*/g, ".*");
  let anchored = false;
  if (p.endsWith("\\$")) {
    p = p.slice(0, -2) + "$";
    anchored = true;
  }
  try {
    const rx = new RegExp("^" + p + (anchored ? "" : ""));
    return rx.test(path);
  } catch {
    return path.startsWith(pattern);
  }
}

function isAllowed(rules: Rules, path: string): boolean {
  const disallowed = rules.disallow.some((p) => matchRule(p, path));
  if (!disallowed) return true;
  // An explicit Allow overrides a Disallow.
  const allowed = rules.allow.some((p) => matchRule(p, path));
  return allowed;
}
