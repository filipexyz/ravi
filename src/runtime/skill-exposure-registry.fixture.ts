import assert from "node:assert/strict";
import {
  createRuntimeProvider,
  listRegisteredRuntimeProviderIds,
  registerRuntimeProvider,
  unregisterRuntimeProvider,
} from "./provider-registry.js";
import {
  fixtureRuntimeCapabilities,
  fixtureRuntimeProvider,
  fixtureRuntimeStartRequest,
} from "./skill-exposure.fixtures.js";

for (const providerId of ["pi", "grok"]) {
  const provider = createRuntimeProvider(providerId);
  assert.equal(provider.id, providerId);
  assert.equal(provider.getCapabilities().skillExposure, undefined);
  assert.throws(() => provider.startSession(fixtureRuntimeStartRequest()), /skill exposure contract/);
  assert.ok(listRegisteredRuntimeProviderIds().includes(providerId));
}

let started = 0;
registerRuntimeProvider("future-fixture-adapter", () => fixtureRuntimeProvider(() => started++));
try {
  const provider = createRuntimeProvider("future-fixture-adapter");
  const missingPolicy = fixtureRuntimeStartRequest();
  delete missingPolicy.skillPolicy;
  assert.throws(() => provider.startSession(missingPolicy), /skill exposure/);
  assert.equal(started, 0);
  assert.equal(provider.startSession(fixtureRuntimeStartRequest()).provider, "future-fixture-adapter");
  assert.equal(started, 1);
} finally {
  unregisterRuntimeProvider("future-fixture-adapter");
}

const unsafe = fixtureRuntimeProvider(() => {
  throw new Error("Unsafe adapter must not start");
});
unsafe.getCapabilities = () => ({ ...fixtureRuntimeCapabilities(), skillExposure: undefined });
assert.throws(() => registerRuntimeProvider(unsafe.id, () => unsafe), /skill exposure contract/);
assert.equal(listRegisteredRuntimeProviderIds().includes(unsafe.id), false);
assert.throws(() => registerRuntimeProvider("different-id", fixtureRuntimeProvider), /registered provider identity/);
assert.equal(listRegisteredRuntimeProviderIds().includes("different-id"), false);

let first = true;
registerRuntimeProvider("future-fixture-adapter", () => {
  if (first) {
    first = false;
    return fixtureRuntimeProvider();
  }
  return unsafe;
});
try {
  const provider = createRuntimeProvider("future-fixture-adapter");
  assert.equal(provider.getCapabilities().skillExposure, undefined);
  assert.throws(() => provider.startSession(fixtureRuntimeStartRequest()), /skill exposure contract/);
} finally {
  unregisterRuntimeProvider("future-fixture-adapter");
}

process.stdout.write("skill exposure registry boundary verified\n");
