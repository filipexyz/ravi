import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HISTORY_PATH = join(homedir(), ".ravi", "input-history.json");
const MAX_ENTRIES = 200;

let entries: string[] | null = null;

function load(): string[] {
  if (entries) return entries;
  try {
    entries = JSON.parse(readFileSync(HISTORY_PATH, "utf-8")) as string[];
  } catch {
    entries = [];
  }
  return entries;
}

function save(): void {
  try {
    mkdirSync(join(homedir(), ".ravi"), { recursive: true });
    writeFileSync(HISTORY_PATH, JSON.stringify(entries));
  } catch {
    // ignore write errors
  }
}

export const inputHistory = {
  /** All entries, oldest first */
  list(): string[] {
    return load();
  },

  /** Add an entry (deduplicates against last entry) */
  push(text: string): void {
    const items = load();
    // Don't add duplicates of the last entry
    if (items.length > 0 && items[items.length - 1] === text) return;
    items.push(text);
    if (items.length > MAX_ENTRIES) {
      items.splice(0, items.length - MAX_ENTRIES);
    }
    save();
  },

  /** Number of entries */
  get length(): number {
    return load().length;
  },

  /** Get entry by index (0 = oldest) */
  get(index: number): string | undefined {
    return load()[index];
  },
};
