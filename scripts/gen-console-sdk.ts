import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitAll, computeRegistryHash } from "@ravi/sdk-codegen";
import { projectRegistry } from "@ravi/operation-contracts";
import { consoleRegistry } from "@ravi/operation-contracts/console";
const registry = projectRegistry(consoleRegistry, "console", "human");
const result = emitAll(registry, { version: { sdkVersion: "0.1.0", registryHash: computeRegistryHash(registry), gitSha: "service-contract" } });
let drift = false;
for (const file of ["client", "types", "schemas", "version"] as const) {
  const path = resolve(import.meta.dir, `../packages/console-sdk/src/${file}.ts`);
  const source = result[file].replaceAll("ravi sdk client generate", "bun run console:sdk").replaceAll("ravi sdk client check", "bun run console:sdk:check");
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== source) { console.error(`SDK drift: ${file}`); drift = true; }
  } else writeFileSync(path, source);
}
if (drift) process.exit(1);
console.log(`Console SDK: ${registry.commands.length} typed operations, ${computeRegistryHash(registry)}`);
