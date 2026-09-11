import { createHash } from "node:crypto";
import type { SkillPolicyScope } from "./skill-policy.js";

export type ModelCallBinding = {
  readonly snapshotId: string;
  readonly scope: SkillPolicyScope;
};

export type ModelCallInvalidationReason = "policy-changed" | "verification-failed";

export type ModelCallPublicBinding = {
  readonly snapshotId: string;
  readonly scope: {
    readonly agentId: string;
    readonly executionId: string;
    readonly contextKeyDigest: string;
  };
};

export type ModelCallInvalidation = {
  readonly type: "skill_policy_stale";
  readonly binding: ModelCallPublicBinding;
  readonly reason: ModelCallInvalidationReason;
};

export type ModelCallFenceOptions = {
  readonly binding: ModelCallBinding;
  readonly assertCurrent: (binding: ModelCallBinding) => void | Promise<void>;
  /** Required after async preparation. Must check current revisions without yielding. */
  readonly assertCurrentAtDispatch?: (binding: ModelCallBinding) => void;
  readonly notifyInvalidated: (event: ModelCallInvalidation) => void | Promise<void>;
};

export type ModelCallFence = {
  readonly binding: ModelCallBinding;
  run<T>(dispatch: () => T | Promise<T>): Promise<T>;
  invalidate(reason: ModelCallInvalidationReason): Promise<void>;
};

export class ModelCallFenceError extends Error {
  readonly code = "RAVI_MODEL_CALL_FENCE_INVALIDATED";

  constructor() {
    super("The model call binding is invalidated; a new authorized context is required.");
    this.name = "ModelCallFenceError";
  }
}

export function createModelCallFence(options: ModelCallFenceOptions): ModelCallFence {
  const assertCurrent = options.assertCurrent;
  const assertCurrentAtDispatch = options.assertCurrentAtDispatch;
  const notifyInvalidated = options.notifyInvalidated;
  const input = options.binding;
  if (
    !input?.scope ||
    ![input.snapshotId, input.scope.agentId, input.scope.executionId, input.scope.contextKey].every(validIdentity)
  ) {
    throw new Error("A model call fence requires an explicit snapshot and execution identity.");
  }
  const binding = Object.freeze({
    snapshotId: input.snapshotId,
    scope: Object.freeze({ ...input.scope }),
  });
  const publicBinding = Object.freeze({
    snapshotId: binding.snapshotId,
    scope: Object.freeze({
      agentId: binding.scope.agentId,
      executionId: binding.scope.executionId,
      contextKeyDigest: `sha256:${createHash("sha256").update(binding.scope.contextKey).digest("hex")}`,
    }),
  });
  let invalidation: ModelCallInvalidation | undefined;
  let notification: Promise<void> | undefined;

  const assertOpen = () => {
    if (invalidation) throw new ModelCallFenceError();
  };

  const invalidate = async (reason: ModelCallInvalidationReason): Promise<void> => {
    if (invalidation) {
      await notification;
      return;
    }
    // Close admission before notifying the host, including synchronous reentry.
    invalidation = Object.freeze({ type: "skill_policy_stale", binding: publicBinding, reason });
    const event = invalidation;
    notification = (async () => {
      try {
        await notifyInvalidated(event);
      } catch {
        // A host callback may fail with secrets in its exception. The binding
        // stays closed and only this sanitized error crosses the boundary.
        throw new ModelCallFenceError();
      }
    })();
    await notification;
  };

  return {
    binding,
    async run(dispatch) {
      assertOpen();
      try {
        const preparation = assertCurrent(binding);
        if (preparation !== undefined) {
          if (!isPromiseLike(preparation)) throw new ModelCallFenceError();
          await preparation;
          if (!assertCurrentAtDispatch) throw new ModelCallFenceError();
        }
        // `await void` still yields. Keep synchronous checks and dispatch on
        // the same stack; an async preparation needs a fresh synchronous check.
        assertOpen();
        const finalCheck: unknown = assertCurrentAtDispatch?.(binding);
        if (isPromiseLike(finalCheck)) {
          // TypeScript allows async callbacks in void slots. Admission rejects
          // them; consume their rejection without disclosing private exceptions.
          void Promise.resolve(finalCheck).catch(() => undefined);
          throw new ModelCallFenceError();
        }
      } catch {
        await invalidate("verification-failed");
        throw new ModelCallFenceError();
      }
      // Another pending check may have invalidated the binding while this
      // check awaited I/O. No await is allowed between this check and dispatch.
      assertOpen();
      return dispatch();
    },
    invalidate,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function validIdentity(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
