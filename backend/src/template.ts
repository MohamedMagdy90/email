// Merge-tag rendering + email HTML wrapping (unsubscribe + open pixel).

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

export function wrapHtml(inner: string, unsubUrl: string, pixelUrl: string): string {
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
