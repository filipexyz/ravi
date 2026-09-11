import { describe, expect, test } from "bun:test";
import {
  assertSkillExposureContract,
  enforceSkillExposureAtStart,
  SkillPolicyChangedError,
} from "./skill-exposure-contract.js";
import {
  fixtureRuntimeCapabilities,
  fixtureRuntimeProvider,
  fixtureRuntimeStartRequest,
} from "./skill-exposure.fixtures.js";

describe("mandatory skill exposure execution contract", () => {
  test("requires an explicit versioned per-model-call guarantee", () => {
    const provider = fixtureRuntimeProvider();
    const capabilities = fixtureRuntimeCapabilities();
    Object.assign(capabilities.skillExposure ?? {}, { modelCallFence: undefined });
    provider.getCapabilities = () => capabilities;
    expect(() => assertSkillExposureContract(provider)).toThrow("skill exposure contract");
  });

  test("a future provider works without a name-based exception and keeps its receiver", () => {
    let started = 0;
    let verified = 0;
    const provider = enforceSkillExposureAtStart(fixtureRuntimeProvider(() => started++));
    const request = fixtureRuntimeStartRequest();
    request.verifySkillPolicyAtDispatch = () => {
      verified++;
    };
    expect(provider.startSession(request).provider).toBe("future-fixture-adapter");
    expect(started).toBe(1);
    expect(verified).toBe(1);
  });

  test("unsupported providers remain introspectable but cannot execute", () => {
    let started = 0;
    const raw = fixtureRuntimeProvider(() => started++);
    raw.getCapabilities = () => ({ ...fixtureRuntimeCapabilities(), skillExposure: undefined });
    const provider = enforceSkillExposureAtStart(raw);
    expect(provider.getCapabilities().skillExposure).toBeUndefined();
    expect(() => provider.startSession(fixtureRuntimeStartRequest())).toThrow("skill exposure contract");
    expect(started).toBe(0);
  });

  test.each(["skillPolicy", "skillExposure", "verifySkillPolicy", "verifySkillPolicyAtDispatch"] as const)(
    "missing %s is rejected before the adapter",
    (key) => {
      let started = 0;
      const provider = enforceSkillExposureAtStart(fixtureRuntimeProvider(() => started++));
      const request = fixtureRuntimeStartRequest();
      delete request[key];
      expect(() => provider.startSession(request)).toThrow("skill exposure");
      expect(started).toBe(0);
    },
  );

  test.each([
    { snapshotId: "other", mode: "textual", preparedIds: [] },
    { snapshotId: "same", mode: "native-restricted", preparedIds: [] },
    { snapshotId: "same", mode: "textual", preparedIds: ["unauthorized"] },
  ] as const)("invalid preparation is rejected before the adapter: %j", (prepared) => {
    let started = 0;
    const provider = enforceSkillExposureAtStart(fixtureRuntimeProvider(() => started++));
    const request = fixtureRuntimeStartRequest();
    request.skillExposure = {
      ...prepared,
      snapshotId: prepared.snapshotId === "same" ? (request.skillPolicy?.id ?? "") : prepared.snapshotId,
    };
    expect(() => provider.startSession(request)).toThrow();
    expect(started).toBe(0);
  });

  test("an unresolved snapshot cannot masquerade as a prepared empty set", () => {
    let started = 0;
    const provider = enforceSkillExposureAtStart(fixtureRuntimeProvider(() => started++));
    const request = fixtureRuntimeStartRequest();
    Object.assign(request, { skillPolicy: { ...request.skillPolicy, status: "unresolved" } });
    expect(() => provider.startSession(request)).toThrow("skill exposure");
    expect(started).toBe(0);
  });

  test("changes to capabilities after construction cannot bypass the boundary", () => {
    let started = 0;
    const raw = fixtureRuntimeProvider(() => started++);
    const provider = enforceSkillExposureAtStart(raw);
    raw.getCapabilities = () => ({ ...fixtureRuntimeCapabilities(), skillExposure: undefined });
    expect(() => provider.startSession(fixtureRuntimeStartRequest())).toThrow("skill exposure contract");
    expect(started).toBe(0);
  });

  test("verification failure is sanitized and no retry executes the adapter", () => {
    let started = 0;
    const provider = enforceSkillExposureAtStart(fixtureRuntimeProvider(() => started++));
    const request = fixtureRuntimeStartRequest();
    request.verifySkillPolicyAtDispatch = () => {
      throw new Error("rctx_secret_fixture");
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => provider.startSession(request)).toThrow(SkillPolicyChangedError);
      expect(() => provider.startSession(request)).not.toThrow("rctx_secret_fixture");
    }
    expect(started).toBe(0);
  });

  test.each([false, true])("an accidentally async dispatch guard fails closed (reject=%s)", async (reject) => {
    let started = 0;
    const provider = enforceSkillExposureAtStart(fixtureRuntimeProvider(() => started++));
    const request = fixtureRuntimeStartRequest();
    request.verifySkillPolicyAtDispatch = async () => {
      if (reject) throw new Error("rctx_secret_fixture");
    };
    expect(() => provider.startSession(request)).toThrow(SkillPolicyChangedError);
    await Promise.resolve();
    expect(started).toBe(0);
  });
});
