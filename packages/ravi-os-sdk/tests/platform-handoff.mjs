import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const expectedNode = process.argv.find((arg) => arg.startsWith("--expect-node="))?.slice(14);
const artifactArg = process.argv.find((arg) => arg.startsWith("--artifacts="))?.slice(12);
const results = [];
const metadata = {
  version: process.version,
  platform: process.platform,
  arch: process.arch,
  bun: process.versions.bun ?? null,
  globalCryptoPresent: typeof globalThis.crypto !== "undefined",
  execArgvCount: process.execArgv.length,
  nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS),
};

// Every key in this fixed Unicode vector is deliberately in canonical order.
// The expected digest uses Node's official API, not the SDK's digest helper.
const canonicalOutput = JSON.stringify({
  binding: {
    agentId: "platform-agent",
    channelInstanceId: "platform-instance",
    chatId: "platform-chat",
    messageId: "platform-message",
    sessionId: "platform-session",
    turnId: "platform-turn",
  },
  causationId: "platform-request",
  content: [{ text: "ação — full reply 🚀", type: "text" }],
  correlationId: "platform-correlation",
  emittedAt: "2026-11-04T00:00:00.000Z",
  kind: "assistant_message",
  outputId: "platform-output",
  protocol: "ravi.channel.backend",
  schemaVersion: 1,
  target: {
    channelKind: "custom",
    connectionId: "platform-connection",
    conversationId: "platform-conversation",
  },
});
const output = JSON.parse(canonicalOutput);
const identity = {
  outputId: output.outputId,
  outputFingerprint: createHash("sha256").update(canonicalOutput, "utf8").digest("hex"),
  binding: output.binding,
  target: output.target,
};

/** Records every assertion group without turning a missing import or failed case into a skip. */
async function check(name, operation) {
  try {
    await operation();
    results.push({ name, status: "passed" });
  } catch (error) {
    results.push({ name, status: "failed", error: error instanceof Error ? error.stack : String(error) });
  }
}

try {
  if (expectedNode !== undefined) {
    assert.equal(process.version, `v${expectedNode}`, "the selected Node runtime must execute this consumer");
    assert.equal(process.versions.bun, undefined, "Bun is not a Node runtime proof");
    assert.equal(process.execArgv.length, 0, "runtime flags must not alter the platform proof");
    assert.ok(!process.env.NODE_OPTIONS, "NODE_OPTIONS must be unset for the Node18 proof");
    assert.equal(typeof globalThis.crypto, "undefined", "global crypto must not mask the Node18 regression");
  }

  const rootEntry = require.resolve("@ravi-os/sdk");
  const deepEntry = require.resolve("@ravi-os/sdk/channel-backend");
  const packageRoot = resolve(dirname(rootEntry), "..");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(rootEntry, join(packageRoot, "dist/index.js"));
  assert.equal(deepEntry, join(packageRoot, "dist/channel-backend.js"));
  assert.equal(existsSync(join(packageRoot, "src")), false, "consumer must not resolve SDK source");
  const publishedEntries = ["package.json", ...manifest.files.map((file) => file.replace(/\/$/, ""))].sort();
  assert.deepEqual(readdirSync(packageRoot).sort(), publishedEntries, "stage only declared published SDK files");
  const zodManifest = JSON.parse(readFileSync(require.resolve("zod/package.json"), "utf8"));
  Object.assign(metadata, {
    sdkVersion: manifest.version,
    zodVersion: zodManifest.version,
    rootEntry,
    deepEntry,
    publishedEntries,
    expectedFingerprint: identity.outputFingerprint,
  });

  for (const specifier of ["@ravi-os/sdk", "@ravi-os/sdk/channel-backend"]) {
    const sdk = await import(specifier);
    await check(`${specifier}: absent sink and typed identity`, async () => {
      const registry = new sdk.ChannelOutputSinkRegistry();
      assert.equal(await registry.tryEmit(output), false);
      await assert.rejects(registry.emit(output), (error) => {
        assert.ok(error instanceof sdk.ChannelOutputHandoffError);
        assert.equal(error.evidence.code, "SINK_UNAVAILABLE");
        assert.equal(error.evidence.disposition, "not_started");
        assert.deepEqual(error.evidence.identity, identity);
        return true;
      });
    });

    await check(`${specifier}: one invocation and durable handoff confirmation`, async () => {
      const registry = new sdk.ChannelOutputSinkRegistry();
      const context = { capability: sdk.CHANNEL_OUTPUT_HANDOFF_CAPABILITY, expectedRequestFingerprint: "a".repeat(64) };
      const confirmation = {
        capability: sdk.CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        schemaVersion: 1,
        identity,
        idempotencyKey: output.outputId,
        requestFingerprint: context.expectedRequestFingerprint,
        durableSaveConfirmed: true,
        disposition: "deferred",
      };
      let calls = 0;
      registry.register(output.target, {
        handoffCapability: sdk.CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        async emit(envelope, restriction) {
          calls += 1;
          assert.deepEqual(envelope, output);
          assert.deepEqual(restriction, context);
          assert.ok(Object.isFrozen(envelope.content[0]) && Object.isFrozen(restriction));
          return confirmation;
        },
      });
      assert.deepEqual(await registry.emit(output, context), confirmation);
      assert.equal(calls, 1);
    });

    await check(`${specifier}: void completion and original generic error`, async () => {
      const registry = new sdk.ChannelOutputSinkRegistry();
      const unregister = registry.register(output.target, { async emit() {} });
      assert.equal(await registry.emit(output), undefined);
      unregister();
      const failure = new Error("synthetic platform sink failure");
      registry.register(output.target, { async emit() { throw failure; } });
      await assert.rejects(registry.emit(output), (error) => error === failure);
    });
  }
} catch (error) {
  results.push({ name: "platform/package prerequisites", status: "failed", error: error instanceof Error ? error.stack : String(error) });
} finally {
  const success = results.length === 6 && results.every((result) => result.status === "passed");
  const report = { metadata, success, results };
  console.log(JSON.stringify(report, null, 2));
  if (artifactArg !== undefined) {
    mkdirSync(artifactArg, { recursive: true });
    writeFileSync(join(artifactArg, "result.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  if (!success) process.exitCode = 1;
}
