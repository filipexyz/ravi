/** Regenerate the Console's DTO subset from the Ravi CLI registry, never by hand.
 * Run with an explicit disposable RAVI_STATE_DIR.
 * bun scripts/sync-ravi-gateway.ts <ravi-checkout> [--check]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
if (!process.env.RAVI_STATE_DIR || !process.env.RAVI_STATE_DIR.includes("gateway-")) {
  throw new Error("Explicit disposable gateway-* RAVI_STATE_DIR required");
}
const source = resolve(process.argv[2] ?? "");
const { buildRegistry } = await import(join(source, "src/cli/registry-snapshot.ts"));
const { SessionConversationCommands } = await import(
  join(source, "src/cli/commands/session-conversations.ts")
);
const { emitTypes } = await import(join(source, "src/sdk/client-codegen/index.ts"));
const { DesktopWorkCommands, DesktopSessionCommands, DesktopComputerCommands, DesktopLoopsCommands, DesktopChannelsCommands } = await import(
  join(source, "src/cli/commands/desktop-resources.ts")
);
const generated = emitTypes(buildRegistry([SessionConversationCommands, DesktopWorkCommands, DesktopSessionCommands, DesktopComputerCommands, DesktopLoopsCommands, DesktopChannelsCommands]).commands);
const outputs = new Map([
  ["src/shared/ravi-gateway/types.generated.ts", generated],
  [
    "src/shared/console-gateway.ts",
    await readFile(join(source, "src/sdk/gateway/console-contract.ts"), "utf8"),
  ],
]);
for (const [file, expected] of outputs) {
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== expected) throw new Error(`Gateway contract drift: ${file}`);
  } else {
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, expected);
  }
}
console.log(
  process.argv.includes("--check")
    ? "Gateway contract matches Ravi registry"
    : "Generated gateway contract from Ravi registry",
);
