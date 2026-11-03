import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { node24Binary } from "./binaries";

// Bun's node:http shim does not honor custom Duplex agents. Production Next runs
// on Node24: exercise real HTTP parsing/keepalive/backpressure on that same runtime.
test("Node HTTP/SSE over restricted SSH and pinned runtime proof", async () => {
  const root = await mkdtemp(resolve("node_modules/.cache-gateway-"));
  try {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "gateway-ssh.node-fixture.ts")],
      outdir: root,
      target: "node",
      format: "cjs",
      external: ["ssh2", "jose", "zod", "ipaddr.js"],
    });
    expect(result.success).toBe(true);
    const child = Bun.spawn(
      [await node24Binary(), "--test", "--test-reporter=tap", result.outputs[0]!.path],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) throw new Error(out + err);
    expect(out).toContain("# pass 4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

import { randomUUID } from "node:crypto";
import { bridgeBindingSchema } from "../../src/server/console/fleet/bridge-config";
test("operator enrollment contains transport trust, never human permissions", () => {
  const input = {
    organizationId: randomUUID(),
    installationId: randomUUID(),
    runtimeId: randomUUID(),
    runtimePublicKey: "p".repeat(60),
    installationRevision: 1,
    credentialRevision: 1,
    enrollmentId: randomUUID(),
    issuer: "https://fleet.test",
    issuerKeyId: "v1",
    signingKeyRef: { credentialId: randomUUID(), version: 1 },
    epoch: 1,
    active: true,
  };
  expect(bridgeBindingSchema.safeParse(input).success).toBe(true);
  expect(bridgeBindingSchema.safeParse({ ...input, humans: [{ userId: randomUUID() }] }).success).toBe(false);
});
