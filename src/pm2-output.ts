import { stripVTControlCharacters } from "node:util";

/** PM2 writes version warnings (and sometimes [PM2] diagnostics) before jlist's JSON. */
export function parsePm2Jlist(raw: string): Array<Record<string, any>> {
  const output = stripVTControlCharacters(raw);
  // Keep the entire JSON suffix: truncated output or trailing garbage must fail,
  // rather than being mistaken for an empty/partially readable installation.
  const start = output.search(/^[ \t]*(?!\[PM2\])[[{]/m);
  if (start < 0) throw new Error("Missing PM2 process list");
  const list: unknown = JSON.parse(output.slice(start));
  if (!Array.isArray(list) || list.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error("Invalid PM2 process list: expected an array of process objects");
  }
  return list;
}
