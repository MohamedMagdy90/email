// Secrets at rest (OAuth refresh tokens, client secrets, IMAP passwords).
//
// AES-256-GCM. The key comes from the APP_SECRET env var (set it on Railway).
// Without it, a random key is generated and kept in the settings table: that
// still keeps tokens out of plain sight in exports and logs, but anyone with
// the whole database has the key too — the Agent tab warns about it.
// Each blob records which key encrypted it, so adding APP_SECRET later never
// breaks the tokens saved before.
import { getSetting, setSetting } from "../../db";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export const hasAppSecret = () => !!(process.env.APP_SECRET || "").trim();

const keyCache = new Map<string, Promise<CryptoKey>>();
function keyFrom(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.digest("SHA-256", enc.encode(secret)).then((h) => crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]));
    keyCache.set(secret, k);
  }
  return k;
}

async function autoSecret(): Promise<string> {
  let s = await getSetting("engine_auto_secret");
  if (!s) {
    s = b64(crypto.getRandomValues(new Uint8Array(32)));
    await setSetting("engine_auto_secret", s);
  }
  return s;
}

async function keyFor(kind: "env" | "auto"): Promise<CryptoKey> {
  if (kind === "env") {
    const s = (process.env.APP_SECRET || "").trim();
    if (!s) throw new Error("This secret was saved with APP_SECRET, which is no longer set on the server.");
    return keyFrom(s);
  }
  return keyFrom(await autoSecret());
}

export async function encryptSecret(plain: string): Promise<string> {
  const kind = hasAppSecret() ? "env" : "auto";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(kind), enc.encode(plain)));
  return `v1:${kind}:${b64(iv)}:${b64(ct)}`;
}

export async function decryptSecret(blob: string | null | undefined): Promise<string> {
  if (!blob) return "";
  const parts = String(blob).split(":");
  if (parts.length !== 4 || parts[0] !== "v1" || (parts[1] !== "env" && parts[1] !== "auto")) throw new Error("Unreadable secret");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(parts[2]) }, await keyFor(parts[1]), unb64(parts[3]));
  return dec.decode(pt);
}

export async function encryptJson(v: unknown): Promise<string> {
  return encryptSecret(JSON.stringify(v));
}

export async function decryptJson<T>(blob: string | null | undefined): Promise<T | null> {
  if (!blob) return null;
  try {
    return JSON.parse(await decryptSecret(blob)) as T;
  } catch {
    return null;
  }
}

export const randomToken = (bytes = 24) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
