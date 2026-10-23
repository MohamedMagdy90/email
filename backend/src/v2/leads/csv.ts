// CSV in and out for the Leads tab. RFC 4180 quoting, CRLF or LF, a UTF-8
// BOM, and comma / semicolon / tab delimiters (Excel in Arabic or European
// locales saves with semicolons).

export function detectDelimiter(text: string): string {
  const head = text.slice(0, 4000).split(/\r?\n/).slice(0, 5).join("\n");
  const count = (ch: string) => {
    let n = 0;
    let quoted = false;
    for (const c of head) {
      if (c === '"') quoted = !quoted;
      else if (!quoted && c === ch) n++;
    }
    return n;
  };
  const scores: [string, number][] = [
    [",", count(",")],
    [";", count(";")],
    ["\t", count("\t")],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ",";
}

/** Parse CSV text into rows of cells. Empty trailing lines are dropped. */
export function parseCsv(input: string, maxRows = 100_000): string[][] {
  const text = String(input || "").replace(/^\uFEFF/, "");
  const d = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
    } else if (c === d) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

export type ImportField = "email" | "firstName" | "lastName" | "fullName" | "title" | "company" | "website" | "country" | "city" | "linkedin";
export const IMPORT_FIELDS: ImportField[] = ["email", "firstName", "lastName", "fullName", "title", "company", "website", "country", "city", "linkedin"];

const GUESS: [ImportField, RegExp][] = [
  ["email", /^(e-?mail|email address|work email|البريد|ايميل|إيميل)/i],
  ["firstName", /^(first|given|fname|first name|الاسم الأول)/i],
  ["lastName", /^(last|surname|family|lname|last name|اسم العائلة)/i],
  ["fullName", /^(name|full name|contact|contact name|person|الاسم)$/i],
  ["title", /(title|position|role|job|designation|المسمى|الوظيفة)/i],
  ["company", /(company|organi[sz]ation|account|business|employer|الشركة)/i],
  ["website", /(website|domain|url|site|web|الموقع)/i],
  ["country", /(country|الدولة|البلد)/i],
  ["city", /(city|المدينة)/i],
  ["linkedin", /linkedin/i],
];

/** Header index for each field, guessed from the header names. */
export function guessMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const out: Partial<Record<ImportField, number>> = {};
  const used = new Set<number>();
  for (const [field, re] of GUESS) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(String(h || "").trim()));
    if (i >= 0) {
      out[field] = i;
      used.add(i);
    }
  }
  // A "linkedin" column must not be read as the website.
  if (out.website !== undefined && /linkedin/i.test(headers[out.website] || "")) delete out.website;
  return out;
}

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");
}
