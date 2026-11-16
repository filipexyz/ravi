/** Inert test executable: no broker, provider credentials or production runtime imports. */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createDeliveryCompatibilityGate, DELIVERY_EFFECTS } from "../delivery-activation.js";
import { deliveryBootPath, publishDeliveryBoot } from "../delivery-boot.js";

const [stateDir, dbPath, inventoryPath, bootId, processName, fixtureProtocol] = process.argv.slice(2);
if (!stateDir || !dbPath || !inventoryPath || !bootId || !processName) throw new Error("Fixture arguments missing");

const boot = publishDeliveryBoot({
  stateDir,
  processName,
  bootId,
  bundlePath: import.meta.path,
  stateIdentity: dbPath,
  consumerDomain: "fixture-delivery",
});
// This fixture simulates a different release's declaration; the real publisher has no override.
if (fixtureProtocol === "1") {
  writeFileSync(deliveryBootPath(stateDir, boot), JSON.stringify({ ...boot, deliveryProtocolVersions: [1] }));
}
const gate = createDeliveryCompatibilityGate({
  stateDir,
  dbPath,
  stateIdentity: dbPath,
  consumerDomain: "fixture-delivery",
  readInventory: () => JSON.parse(readFileSync(inventoryPath, "utf8")),
});
const counters = { recovery: 0, pull: 0, claim: 0, send: 0, prune: 0 };
let permit: Extract<ReturnType<typeof gate.acquire>, { relation: "supports" }>["permit"] | undefined;
const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
write({ ready: true, threadProtocolReady: true });
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const command = JSON.parse(line) as { operation: string };
  if (command.operation === "acquire") {
    const result = gate.acquire();
    permit = result.relation === "supports" ? result.permit : undefined;
    write({ relation: result.relation, counters });
  } else if (command.operation === "attempt") {
    const failures: string[] = [];
    for (const effect of DELIVERY_EFFECTS) {
      try {
        gate.run(permit!, effect, () => counters[effect]++);
      } catch {
        failures.push(effect);
      }
    }
    write({ failures, counters, relation: gate.inspect().relation });
  } else if (command.operation === "stop") {
    break;
  }
}
