import { execFileSync } from "node:child_process";

/**
 * Derives the table inventory of a legacy tag from every CREATE TABLE in its
 * source, read with git from the tag itself (never from the working tree).
 * `scripts/fence-adoption-inventory.ts` writes it to
 * src/threads/fence-adoption-inventory.ts, and fence-adoption-inventory.test.ts
 * compares that file with this derivation.
 */
export type DerivedTableEntry = {
  table: string;
  file: string;
  columns: string[];
  statusColumns: { name: string; values: string[] | null }[];
};

export type DerivedInventory = {
  files: string[];
  entries: DerivedTableEntry[];
  dynamic: { file: string; expression: string }[];
};

const STATUS_LIKE = /(^|_)(status|state)$|(^|_)(claim|claimed|lease|leased)(_|$)/;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Reads the source text of a file at the tag. */
export function legacySource(repo: string, tag: string, file: string): string {
  return git(repo, ["show", `${tag}:${file}`]);
}

function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  let level = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") level += 1;
    if (char === ")") level -= 1;
    if (char === "," && level === 0) {
      items.push(current);
      current = "";
    } else current += char;
  }
  items.push(current);
  return items;
}

export function deriveLegacyTableInventory(repo: string, tag: string): DerivedInventory {
  const files = git(repo, ["grep", "-l", "CREATE TABLE", tag, "--", "src/*.ts", ":!*.test.ts", ":!src/test/*"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(`${tag}:`, ""))
    .sort();
  const byTable = new Map<string, DerivedTableEntry>();
  const dynamic: { file: string; expression: string }[] = [];
  for (const file of files) {
    const source = legacySource(repo, tag, file);
    const pattern = /CREATE TABLE (?:IF NOT EXISTS )?(["`]?)([A-Za-z_$][A-Za-z0-9_${}]*)\1\s*\(/g;
    for (const match of source.matchAll(pattern)) {
      const name = match[2]!;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        dynamic.push({ file, expression: name });
        continue;
      }
      let depth = 1;
      let index = match.index! + match[0].length;
      const start = index;
      while (index < source.length && depth > 0) {
        const char = source[index]!;
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        index += 1;
      }
      const body = source.slice(start, index - 1);
      const columns: string[] = [];
      const statusColumns: DerivedTableEntry["statusColumns"] = [];
      for (const raw of splitTopLevel(body)) {
        const item = raw.replace(/--[^\n]*/g, "").trim();
        if (!item || /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|CONSTRAINT)\b/i.test(item)) continue;
        const column = item.split(/\s+/)[0]!.replace(/["`]/g, "");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) continue;
        columns.push(column);
        if (STATUS_LIKE.test(column)) {
          const check = new RegExp(`CHECK\\s*\\(\\s*["\`]?${column}["\`]?\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(body);
          const values = check
            ? check[1]!
                .split(",")
                .map((value) => value.trim().replace(/^'|'$/g, ""))
                .filter(Boolean)
            : null;
          statusColumns.push({ name: column, values });
        }
      }
      const existing = byTable.get(name);
      if (existing) {
        // Same table created in several places (migrations): the union of columns.
        for (const column of columns) if (!existing.columns.includes(column)) existing.columns.push(column);
        for (const status of statusColumns)
          if (!existing.statusColumns.some((entry) => entry.name === status.name)) existing.statusColumns.push(status);
        continue;
      }
      byTable.set(name, { table: name, file, columns, statusColumns });
    }
  }
  return { files, entries: [...byTable.values()].sort((a, b) => a.table.localeCompare(b.table)), dynamic };
}

/** String literals of a status union (`type X = "a" | "b"`) or an `as const` list declared in the tag. */
export function legacyVocabulary(repo: string, tag: string, file: string, declaration: string): string[] {
  const source = legacySource(repo, tag, file);
  const start = new RegExp(`(?:type|const)\\s+${declaration}\\s*=`).exec(source);
  if (!start) return [];
  const rest = source.slice(start.index + start[0].length);
  const end = rest.search(/;|\]\s*as\s+const/);
  return [...rest.slice(0, end === -1 ? undefined : end).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

export function renderLegacyInventory(tag: string, inventory: DerivedInventory): string {
  const header = `// Generated from every CREATE TABLE in the source of ${tag} (${inventory.files.length} files, ${inventory.entries.length} tables).
// Regenerate: bun scripts/fence-adoption-inventory.ts. Never edit by hand; fence-adoption-inventory.test.ts
// compares this file with the tag. statusColumns: columns named status/state/claim/lease, with CHECK values.
`;
  const body = `export type LegacyTableInventoryEntry = {
  table: string;
  file: string;
  columns: readonly string[];
  statusColumns: readonly { name: string; values: readonly string[] | null }[];
};

export const LEGACY_TABLE_INVENTORY: readonly LegacyTableInventoryEntry[] = ${JSON.stringify(inventory.entries, null, 2)};

/** CREATE TABLE statements whose name is computed at run time; each is covered by hand. */
export const LEGACY_DYNAMIC_TABLES: readonly { file: string; expression: string }[] = ${JSON.stringify(inventory.dynamic, null, 2)};
`;
  return header + body;
}
