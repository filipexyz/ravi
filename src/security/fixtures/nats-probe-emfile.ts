import { closeSync, openSync } from "node:fs";
import { decideNatsExposureBootAction, probeNatsExposure } from "../nats-exposure.js";

// Only run in a subprocess with a low file-descriptor limit; never exhaust the test runner.
const keepAlive = setInterval(() => {}, 1_000);
const descriptors: number[] = [];
let exhaustion = "";
try {
  try {
    while (true) descriptors.push(openSync("/dev/null", "r"));
  } catch (error) {
    exhaustion = (error as NodeJS.ErrnoException).code ?? "unknown";
  }
  const report = await probeNatsExposure("nats://127.0.0.1:4222", {
    listAddresses: () => ["192.0.2.10"],
    readFirewallState: async () => "unknown",
  });
  console.log(
    JSON.stringify({
      exhaustion,
      status: report.status,
      strictAction: decideNatsExposureBootAction(report, { requirePrivate: true }),
    }),
  );
} finally {
  for (const descriptor of descriptors) closeSync(descriptor);
  clearInterval(keepAlive);
}
