export function toCsv(rows: Record<string, any>[], columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns || Object.keys(rows[0]);
  const cell = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(",")].concat(rows.map((r) => cols.map((c) => cell(r[c])).join(","))).join("\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------------------- CSV parsing --------------------------- */

// Robust CSV parser: handles quoted fields, escaped quotes ("") and CRLF.
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let val = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { val += '"'; i++; } else inQuotes = false;
      } else val += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cur.push(val); val = ""; }
      else if (ch === "\n") { cur.push(val); rows.push(cur); cur = []; val = ""; }
      else if (ch === "\r") { /* skip */ }
      else val += ch;
    }
  }
  if (val.length || cur.length) { cur.push(val); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedContact {
  email: string;
  company: string;
  country: string;
  industry: string;
  category: string;
  valid: boolean; // email looks valid
  duplicate: boolean; // duplicated earlier in this same file
}

// Parse a pasted / uploaded CSV into contact rows with validation flags.
// Recognizes an optional header row; otherwise assumes column order:
// email, company, country, industry, category.
export function parseContacts(text: string): ParsedContact[] {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes("email");
  const cols = hasHeader ? header : ["email", "company", "country", "industry", "category"];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const idx = (name: string) => cols.indexOf(name);
  const at = (r: string[], name: string, fallback = -1) => {
    const i = idx(name) >= 0 ? idx(name) : fallback;
    return i >= 0 ? String(r[i] ?? "").trim() : "";
  };

  const seen = new Set<string>();
  const out: ParsedContact[] = [];
  for (const r of dataRows) {
    const email = at(r, "email", 0).toLowerCase();
    const company = at(r, "company", 1);
    const country = at(r, "country", 2);
    const industry = at(r, "industry", 3);
    const category = at(r, "category", 4);
    if (!email && !company && !country && !industry && !category) continue; // blank line
    const valid = EMAIL_RE.test(email);
    const duplicate = valid && seen.has(email);
    if (valid) seen.add(email);
    out.push({ email, company, country, industry, category, valid, duplicate });
  }
  return out;
}

// A ready-to-fill template users can download, edit in Excel/Sheets, and re-import.
export const CONTACTS_TEMPLATE = `email,company,country,industry,category
info@acme-trading.com,Acme Trading,Qatar,Trading,Customer
sales@example-construction.qa,Example Construction Co,Qatar,Construction,Partner
hello@brightsoftware.ae,Bright Software,UAE,IT & Software,Reseller`;
