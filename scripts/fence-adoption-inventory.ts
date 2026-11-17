// Regenerates src/threads/fence-adoption-inventory.ts from every CREATE TABLE of the legacy tag.
// Usage: bun scripts/fence-adoption-inventory.ts [tag]   (default v3.261113.2)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveLegacyTableInventory, renderLegacyInventory } from "../src/threads/fence-adoption-inventory-derive.js";

const tag = process.argv[2] ?? "v3.261113.2";
const repo = join(import.meta.dir, "..");
const inventory = deriveLegacyTableInventory(repo, tag);
writeFileSync(join(repo, "src", "threads", "fence-adoption-inventory.ts"), renderLegacyInventory(tag, inventory));
console.log(
  JSON.stringify({ tag, files: inventory.files.length, tables: inventory.entries.length, dynamic: inventory.dynamic.length }),
);
