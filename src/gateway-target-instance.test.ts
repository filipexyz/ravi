import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";
import { resolveTargetInstanceId } from "./gateway.js";

const INSTANCE_UUID = "11111111-2222-4333-8444-555555555555";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-target-instance-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("resolveTargetInstanceId", () => {
  it("uses the target's chat instance when the account is empty", () => {
    expect(resolveTargetInstanceId({ accountId: "", instanceId: INSTANCE_UUID })).toBe(INSTANCE_UUID);
  });

  it("keeps resolving by account when one is set", () => {
    expect(resolveTargetInstanceId({ accountId: INSTANCE_UUID, instanceId: "other" })).toBe(INSTANCE_UUID);
  });

  it("returns nothing when neither names an instance", () => {
    expect(resolveTargetInstanceId({ accountId: "" })).toBeUndefined();
  });
});
