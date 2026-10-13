// Merge-tag rendering + email HTML wrapping (unsubscribe + open pixel).

import { createHash } from "node:crypto";

export function renderTemplate(tpl: string, contact: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, raw: string) => {
    const key = raw.toLowerCase();
    const v = contact[key];
    if (v != null && String(v).trim() !== "") return String(v);
    // Friendly fallbacks so emails never read "Hi {{company}}".
    if (key === "company") return "there";
    if (key === "country") return "your region";
    if (key === "industry") return "your industry";
    if (key === "email") return "";
    return "";
  });
}

// Detect leftover unresolved tags (used for validation warnings in the UI).
export function unresolvedTags(text: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*([a-z_]+)\s*\}\}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1].toLowerCase());
  return [...out];
}

// Rewrite every http(s) link in the body to route through the click tracker,
// so a click is recorded before redirecting the recipient to the real URL.
// Skips mailto:/tel:/anchors/relative links, the unsubscribe link, and our own
// tracking endpoints.
export function wrapLinks(html: string, clickBase: string, unsubUrl = ""): string {
  if (!clickBase) return html;
  return html.replace(/href\s*=\s*(["'])(.*?)\1/gi, (m, quote: string, url: string) => {
    const raw = String(url).trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return m; // skip mailto:, tel:, #, relative
    if (unsubUrl && raw === unsubUrl) return m; // never wrap unsubscribe
    if (/\/api\/(click|open|unsubscribe)\b/i.test(raw)) return m; // already ours
    const target = raw.replace(/&amp;/g, "&"); // un-escape the common HTML entity
    const wrapped = `${clickBase}&u=${encodeURIComponent(target)}`;
    return `href=${quote}${wrapped}${quote}`;
  });
}

// Stable, URL-safe id for a remote image — same URL always maps to the same id,
// so re-sending a template never piles up duplicate asset rows.
export function assetId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 20);
}

function assetExt(url: string): string {
  try {
    const m = /\.(png|jpe?g|gif|webp)$/i.exec(new URL(url).pathname);
    return m ? `.${m[1].toLowerCase()}` : "";
  } catch {
    return "";
  }
}

// Re-host every remote <img> through our own (sending-domain) host, e.g.
//   https://cdn.prod.website-files.com/.../logo.webp  ->  https://t.dna-erp.com/i/<id>.webp
// Gmail and Resend flag images served from a domain unrelated to the sender.
// Each rewritten URL is recorded in `assets` (id -> original URL) so the caller
// can register it; the /i/:file route only serves registered ids (no open proxy).
export function hostImages(html: string, assetBase: string, assets: Map<string, string>): string {
  if (!assetBase) return html;
  const base = assetBase.replace(/\/+$/, "");
  return html.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.replace(/\bsrc\s*=\s*(["'])(.*?)\1/i, (m, quote: string, src: string) => {
      const raw = String(src).trim().replace(/&amp;/g, "&");
      if (!/^https?:\/\//i.test(raw)) return m; // data:, cid:, relative — leave alone
      if (raw.startsWith(base + "/")) return m; // already on our host
      const id = assetId(raw);
      assets.set(id, raw);
      return `src=${quote}${base}/i/${id}${assetExt(raw)}${quote}`;
    })
  );
}

export interface WrapOptions {
  unsubUrl?: string;
  pixelUrl?: string;
  clickBase?: string;
  // Host that re-serves remote images (the sending domain's tracking host).
  assetBase?: string;
  // Collects id -> original URL for every image rewritten by hostImages().
  assets?: Map<string, string>;
}

export function wrapHtml(inner: string, opts: WrapOptions = {}): string {
  const unsubUrl = opts.unsubUrl || "";
  const pixelUrl = opts.pixelUrl || "";
  // Track links first — the footer (unsub link + pixel) is appended afterward,
  // so it's never rewritten.
  inner = wrapLinks(inner, opts.clickBase || "", unsubUrl);
  if (opts.assetBase && opts.assets) inner = hostImages(inner, opts.assetBase, opts.assets);

  const looksLikeFullDoc = /<html[\s>]/i.test(inner);
  const hasUnsub = unsubUrl && unsubUrl !== "#";
  const unsubBlock = hasUnsub
    ? `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#999;">
      You received this because we believe it's relevant to your business.
      If not, <a href="${unsubUrl}" style="color:#999;text-decoration:underline;">unsubscribe here</a>.
    </div>`
    : "";
  const pixelBlock = pixelUrl
    ? `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;max-height:0;overflow:hidden;" />`
    : "";
  const footer = `
    ${unsubBlock}
    ${pixelBlock}`;

  if (looksLikeFullDoc) {
    // inject footer before </body> if possible
    if (/<\/body>/i.test(inner)) return inner.replace(/<\/body>/i, footer + "</body>");
    return inner + footer;
  }

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;">
    ${inner}
    ${footer}
  </body>
</html>`;
}
