/**
 * Tiny RFC4180-ish CSV parser (handles quoted fields, escaped "" quotes, and
 * newlines inside quotes). Plus a tolerance pass for the known data-quality
 * issue in the staging file: a few story rows have UNQUOTED commas in the
 * `title` column, which over-splits them. Those are merged back.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  // strip a UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c === "\r") {
      // ignore; handled by \n
    } else {
      field += c;
    }
  }
  // last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse a CSV with a fixed column count, returning objects keyed by the header.
 * When `fixColumn` is provided and a data row has MORE fields than the header,
 * the surplus is assumed to be unescaped commas inside that column and is merged
 * back in (used to repair the staging file's `title` column).
 */
export function parseRecords(
  text: string,
  opts: { fixColumn?: string } = {}
): Record<string, string>[] {
  const rows = parseCsv(text).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const n = header.length;
  const fixIdx = opts.fixColumn ? header.indexOf(opts.fixColumn) : -1;

  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    let fields = rows[r];
    if (fields.length === n) {
      // ok
    } else if (fields.length > n && fixIdx >= 0) {
      const surplus = fields.length - n;
      const merged = fields.slice(fixIdx, fixIdx + surplus + 1).join(",");
      fields = [...fields.slice(0, fixIdx), merged, ...fields.slice(fixIdx + surplus + 1)];
    } else if (fields.length < n) {
      continue; // malformed, skip
    } else {
      // more fields but no fix column -> trim extras
      fields = fields.slice(0, n);
    }
    const rec: Record<string, string> = {};
    for (let c = 0; c < n; c++) rec[header[c]] = (fields[c] ?? "").trim();
    out.push(rec);
  }
  return out;
}

/** Split a semicolon-delimited staging cell into a clean, deduped, lowercase list. */
export function splitMulti(cell: string | undefined, lowercase = false): string[] {
  if (!cell) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let part of cell.split(";")) {
    part = part.trim();
    if (lowercase) part = part.toLowerCase();
    if (part && !seen.has(part)) {
      seen.add(part);
      out.push(part);
    }
  }
  return out;
}
