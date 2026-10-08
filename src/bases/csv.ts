// RFC 4180 CSV reading and writing for `ravi bases rows import|export|query --format csv`.

/** Parse CSV text into rows of cells. Handles quotes, escaped quotes, CRLF, and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += char;
      index += 1;
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += char === "\r" && source[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += char;
    index += 1;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field.");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ""));
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return `${rows.map((cells) => cells.map(quoteCsvCell).join(",")).join("\r\n")}\r\n`;
}

function quoteCsvCell(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Spreadsheet apps execute cells that start with `=`, `+`, `-`, `@`, tab, or CR.
 * Exported free text is prefixed with `'`; import strips that prefix again.
 */
export function neutralizeCsvFormula(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export function restoreCsvFormula(value: string): string {
  return value.startsWith("'") && FORMULA_PREFIX.test(value.slice(1)) ? value.slice(1) : value;
}
