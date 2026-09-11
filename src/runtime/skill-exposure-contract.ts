import type { SkillPolicySnapshot } from "./skill-policy.js";
import type { RuntimeProvider, SessionRuntimeProvider } from "./types.js";

export type SkillExposureMode = "native-restricted" | "textual" | "on-demand";

export class SkillPolicyChangedError extends Error {
  readonly code = "RAVI_SKILL_POLICY_STALE";
  constructor() {
    super("Skill policy changed; a fresh authorized runtime context is required.");
    this.name = "SkillPolicyChangedError";
  }
}

export type SkillExposureCapabilities = {
  readonly contractVersion: 1;
  readonly modelCallFence: {
    readonly contractVersion: 1;
    readonly guarantee: "before-every-model-call";
  };
  readonly modes: readonly SkillExposureMode[];
  readonly nativeDiscovery: {
    readonly user: "disabled" | "restricted" | "none";
    readonly project: "disabled" | "restricted" | "none";
    readonly plugins: "disabled" | "restricted" | "none";
  };
  readonly contextUpdate: "rebuild" | "in-place";
};

export function enforceSkillExposureAtStart(provider: SessionRuntimeProvider): SessionRuntimeProvider {
  return {
    id: provider.id,
    getCapabilities: () => provider.getCapabilities(),
    ...(typeof provider.prepareSession === "function"
      ? { prepareSession: provider.prepareSession.bind(provider) }
      : {}),
    startSession(input) {
      const capabilities = assertSkillExposureContract(provider);
      assertResolvedSkillPolicySnapshot(input.skillPolicy);
      if (typeof input.verifySkillPolicy !== "function" || typeof input.verifySkillPolicyAtDispatch !== "function") {
        throw new Error("Managed skill exposure requires both policy verification callbacks.");
      }
      assertPreparedSkillExposure(input.skillPolicy, capabilities, input.skillExposure);
      try {
        const result: unknown = input.verifySkillPolicyAtDispatch();
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch(() => {});
          throw new SkillPolicyChangedError();
        }
      } catch {
        throw new SkillPolicyChangedError();
      }
      // No asynchronous boundary may appear between the final check and adapter execution.
      return provider.startSession(input);
    },
  };
}

export type PreparedSkillExposure = {
  readonly snapshotId: string;
  readonly mode: SkillExposureMode;
  readonly preparedIds: readonly string[];
};

export type ObservedSkillExposure = {
  readonly snapshotId: string;
  readonly mode: SkillExposureMode;
  readonly advertisedIds: readonly string[];
  readonly discoverableIds: readonly string[];
  readonly evidence: "native-discovery" | "effective-prompt" | "managed-discovery";
};

/** Capability declarations are checked at registration and at use, not by provider name. */
export function assertSkillExposureContract(provider: RuntimeProvider): SkillExposureCapabilities {
  let contract: SkillExposureCapabilities | undefined;
  try {
    contract = provider.getCapabilities().skillExposure;
  } catch {
    throw new Error("Runtime has no compatible skill exposure contract.");
  }
  const supportedModes = new Set<SkillExposureMode>(["native-restricted", "textual", "on-demand"]);
  const discoveryStates = new Set(["disabled", "restricted", "none"]);
  if (
    !contract ||
    contract.contractVersion !== 1 ||
    !Array.isArray(contract.modes) ||
    contract.modes.length === 0 ||
    new Set(contract.modes).size !== contract.modes.length ||
    typeof provider.prepareSession !== "function" ||
    contract.modelCallFence?.contractVersion !== 1 ||
    contract.modelCallFence.guarantee !== "before-every-model-call" ||
    contract.modes.some((mode) => !supportedModes.has(mode)) ||
    !contract.nativeDiscovery ||
    !discoveryStates.has(contract.nativeDiscovery.user) ||
    !discoveryStates.has(contract.nativeDiscovery.project) ||
    !discoveryStates.has(contract.nativeDiscovery.plugins) ||
    !["rebuild", "in-place"].includes(contract.contextUpdate)
  ) {
    throw new Error("Runtime has no compatible restrictive skill exposure contract.");
  }
  return contract;
}

export function assertPreparedSkillExposure(
  snapshot: SkillPolicySnapshot,
  capabilities: SkillExposureCapabilities,
  prepared: PreparedSkillExposure | undefined,
): void {
  assertResolvedSkillPolicySnapshot(snapshot);
  if (!prepared || prepared.snapshotId !== snapshot.id || !capabilities.modes.includes(prepared.mode)) {
    throw new Error("Managed skill exposure preparation is missing or bound to a different snapshot.");
  }
  assertExactSkillSet(snapshot, prepared.preparedIds, "prepared");
}

export function assertObservedSkillExposure(snapshot: SkillPolicySnapshot, observed: ObservedSkillExposure): void {
  if (observed.snapshotId !== snapshot.id) {
    throw new Error("Observed skill exposure belongs to a different snapshot.");
  }
  assertExactSkillSet(snapshot, observed.discoverableIds, "discoverable");
  const authorized = new Set(snapshot.skills.map((skill) => skill.id));
  const announced = new Set(observed.advertisedIds);
  if (announced.size !== observed.advertisedIds.length || observed.advertisedIds.some((id) => !authorized.has(id))) {
    throw new Error("Observed skill announcement contains duplicate or unauthorized IDs.");
  }
  if (observed.mode !== "on-demand") {
    assertExactSkillSet(snapshot, observed.advertisedIds, "advertised");
  }
}

function assertExactSkillSet(snapshot: SkillPolicySnapshot, actual: readonly string[], surface: string): void {
  const expected = new Set(snapshot.skills.map((skill) => skill.id));
  const received = new Set(actual);
  if (
    !Array.isArray(actual) ||
    actual.length !== received.size ||
    expected.size !== received.size ||
    actual.some((id) => !expected.has(id))
  ) {
    throw new Error(`Skill exposure ${surface} set does not match the authorized snapshot.`);
  }
}

export function assertResolvedSkillPolicySnapshot(
  snapshot: SkillPolicySnapshot | undefined,
): asserts snapshot is SkillPolicySnapshot {
  if (
    !snapshot ||
    snapshot.contractVersion !== 1 ||
    !nonemptyString(snapshot.id) ||
    !snapshot.scope ||
    !snapshot.revisions ||
    ![
      snapshot.scope.agentId,
      snapshot.scope.executionId,
      snapshot.scope.contextKey,
      snapshot.revisions.policy,
      snapshot.revisions.catalog,
      snapshot.revisions.permissions,
      snapshot.revisions.toolSurface,
    ].every(nonemptyString) ||
    !Array.isArray(snapshot.skills) ||
    (snapshot.status !== "ready" && snapshot.status !== "empty") ||
    (snapshot.status === "empty") !== (snapshot.skills.length === 0) ||
    snapshot.skills.some(
      (skill) =>
        !skill ||
        !nonemptyString(skill.id) ||
        !nonemptyString(skill.name) ||
        (skill.description !== undefined && typeof skill.description !== "string") ||
        !skill.resource ||
        !nonemptyString(skill.resource.path),
    ) ||
    new Set(snapshot.skills.map((skill) => skill.id)).size !== snapshot.skills.length
  ) {
    throw new Error("Managed skill exposure requires a valid resolved policy snapshot.");
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
