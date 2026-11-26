// Web Push, the standard way browsers and phones receive alerts from a server.
// No library: WebCrypto (built into Bun) covers both halves.
//
//   VAPID (RFC 8292)  a P-256 key pair identifies this server to the push
//                     services (Google FCM, Apple, Mozilla). Each request
//                     carries a short-lived ES256 JWT signed with it.
//   aes128gcm (RFC 8188 + RFC 8291)  the payload is encrypted for one device
//                     with its p256dh key and auth secret, so the push service
//                     only ever sees ciphertext.
const enc = new TextEncoder();
/** Bytes backed by a plain ArrayBuffer (what WebCrypto takes). */
type Bytes = Uint8Array<ArrayBuffer>;

export const b64u = (u: Uint8Array | ArrayBuffer): string => Buffer.from(u instanceof Uint8Array ? u : new Uint8Array(u)).toString("base64url");
export const unb64u = (s: string): Bytes => new Uint8Array(Buffer.from(String(s || "").replace(/=+$/, ""), "base64url"));

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/* --------------------------------- VAPID --------------------------------- */

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url. The browser subscribes with this. */
  publicKey: string;
  /** The private key as a JWK (d, x, y). */
  privateJwk: JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64u(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y } };
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push endpoint. */
export async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, ttlSeconds = 12 * 3600): Promise<string> {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + Math.min(24 * 3600, Math.max(60, ttlSeconds));
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", { ...keys.privateJwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto returns r || s (64 bytes), which is exactly the JWS ES256 format.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

/* ------------------------------- encryption ------------------------------ */

/**
 * Encrypt one payload for one subscription (RFC 8291, aes128gcm, one record).
 * Returns the request body: salt | record size | key id length | sender key | ciphertext.
 */
export async function encryptPayload(plain: Bytes, p256dh: string, auth: string): Promise<Bytes> {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("The device's p256dh key isn't a P-256 public key");
  if (authSecret.length < 16) throw new Error("The device's auth secret is too short");
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  // IKM = HKDF(auth, ecdh, "WebPush: info" 0x00 ua_public as_public, 32)
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  // One record: the payload, then the 0x02 "last record" delimiter (no padding).
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, concat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/* ---------------------------------- send --------------------------------- */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOutcome {
  ok: boolean;
  status: number;
  /** The subscription no longer exists (404 / 410): forget the device. */
  gone: boolean;
  error?: string;
}

/** Push services only ever run on https; anything else is refused before a request is made. */
export function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !!u.hostname && endpoint.length <= 1200;
  } catch {
    return false;
  }
}

export async function sendPush(
  target: PushTarget,
  payload: unknown,
  opts: { keys: VapidKeys; subject: string; ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; timeoutMs?: number }
): Promise<PushOutcome> {
  if (!validEndpoint(target.endpoint)) return { ok: false, status: 0, gone: true, error: "Not a push service address" };
  let body: Bytes;
  try {
    const plain = enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload));
    // Apple and Google take up to 4 KB of payload.
    if (plain.length > 3800) throw new Error(`The alert is too large (${plain.length} bytes)`);
    body = await encryptPayload(plain, target.p256dh, target.auth);
  } catch (e: any) {
    return { ok: false, status: 0, gone: false, error: String(e?.message || e) };
  }
  let res: Response;
  try {
    res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(target.endpoint, opts.keys, opts.subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(Math.max(0, Math.round(opts.ttl ?? 86400))),
        Urgency: opts.urgency || "normal",
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e: any) {
    return { ok: false, status: 0, gone: false, error: `The push service didn't answer: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, gone: false };
  const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
  return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error: `The push service answered ${res.status}${text ? `: ${text}` : ""}` };
}
