import { describe, expect, test } from "bun:test";
import { createModelCallFence, ModelCallFenceError } from "./model-call-fence.js";
import type { ModelCallBinding, ModelCallInvalidation } from "./model-call-fence.js";

function binding(): ModelCallBinding {
  return {
    snapshotId: "snapshot-1",
    scope: { agentId: "restricted", executionId: "execution-1", contextKey: "context-1" },
  };
}

describe("model call fence", () => {
  test("rechecks every dispatch and permanently blocks the binding after a revision change", async () => {
    let currentRevision = 1;
    let dispatched = 0;
    const notifications: ModelCallInvalidation[] = [];
    const fence = createModelCallFence({
      binding: binding(),
      assertCurrent() {
        if (currentRevision !== 1) throw new Error("Policy changed");
      },
      notifyInvalidated: (event) => {
        notifications.push(event);
      },
    });

    await fence.run(() => {
      dispatched += 1;
    });
    currentRevision = 2;
    await expect(
      fence.run(() => {
        dispatched += 1;
      }),
    ).rejects.toBeInstanceOf(ModelCallFenceError);
    currentRevision = 1;
    await expect(
      fence.run(() => {
        dispatched += 1;
      }),
    ).rejects.toBeInstanceOf(ModelCallFenceError);

    expect(dispatched).toBe(1);
    expect(notifications).toEqual([
      {
        type: "skill_policy_stale",
        binding: {
          snapshotId: "snapshot-1",
          scope: {
            agentId: "restricted",
            executionId: "execution-1",
            contextKeyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          },
        },
        reason: "verification-failed",
      },
    ]);
  });

  test("redacts the runtime context credential from invalidation telemetry", async () => {
    const notifications: ModelCallInvalidation[] = [];
    const fence = createModelCallFence({
      binding: { ...binding(), scope: { ...binding().scope, contextKey: "rctx_private_context_fixture" } },
      assertCurrent() {},
      notifyInvalidated: (event) => {
        notifications.push(event);
      },
    });

    await fence.invalidate("policy-changed");

    expect(JSON.stringify(notifications)).not.toContain("rctx_private_context_fixture");
    expect(notifications[0]?.binding.scope).not.toHaveProperty("contextKey");
    expect(Object.isFrozen(notifications[0]?.binding.scope)).toBe(true);
  });

  test("never exposes a verification exception or lets notification failure reopen dispatch", async () => {
    const fence = createModelCallFence({
      binding: binding(),
      assertCurrent() {
        throw new Error("fixture-private-verification-content");
      },
      notifyInvalidated() {
        throw new Error("fixture-private-notification-content");
      },
    });
    let dispatched = 0;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await fence.run(() => {
          dispatched += 1;
        });
        throw new Error("Unexpected dispatch");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelCallFenceError);
        expect(String(error)).not.toContain("fixture-private");
        expect(JSON.stringify(error)).not.toContain("fixture-private");
      }
    }

    expect(dispatched).toBe(0);
  });

  test("binds a frozen copy of identity so caller mutations cannot retarget later checks", async () => {
    const input = {
      snapshotId: "snapshot-1",
      scope: { agentId: "restricted", executionId: "execution-1", contextKey: "context-1" },
    };
    const checked: ModelCallBinding[] = [];
    const fence = createModelCallFence({
      binding: input,
      assertCurrent: (identity) => {
        checked.push(identity);
      },
      notifyInvalidated() {},
    });
    input.snapshotId = "snapshot-admin";
    input.scope.agentId = "admin";

    await fence.run(() => "sent");

    expect(checked).toEqual([binding()]);
    expect(Object.isFrozen(checked[0])).toBe(true);
    expect(Object.isFrozen(checked[0]?.scope)).toBe(true);
  });

  test("caller mutation cannot replace the admission check of an existing binding", async () => {
    const options = {
      binding: binding(),
      assertCurrent(): void {
        throw new Error("Policy changed");
      },
      notifyInvalidated() {},
    };
    const fence = createModelCallFence(options);
    options.assertCurrent = () => {};

    await expect(fence.run(() => "unauthorized request")).rejects.toBeInstanceOf(ModelCallFenceError);
  });

  test("does not yield between a synchronous policy check and the actual dispatch", async () => {
    let revision = 1;
    const sentAtRevisions: number[] = [];
    const fence = createModelCallFence({
      binding: binding(),
      assertCurrent() {
        if (revision !== 1) throw new Error("Policy changed");
      },
      notifyInvalidated() {},
    });

    const request = fence.run(() => {
      sentAtRevisions.push(revision);
    });
    revision = 2;
    await request;

    expect(sentAtRevisions).toEqual([1]);
  });

  test("rechecks synchronously after async preparation before any dispatch", async () => {
    let revision = 1;
    const finishPreparation = Promise.withResolvers<void>();
    let dispatched = 0;
    const assertRevision = () => {
      if (revision !== 1) throw new Error("Policy changed");
    };
    const fence = createModelCallFence({
      binding: binding(),
      async assertCurrent() {
        assertRevision();
        await finishPreparation.promise;
      },
      assertCurrentAtDispatch: assertRevision,
      notifyInvalidated() {},
    });

    const request = fence
      .run(() => {
        dispatched += 1;
      })
      .catch((error: unknown) => error);
    revision = 2;
    finishPreparation.resolve();

    expect(await request).toBeInstanceOf(ModelCallFenceError);
    expect(dispatched).toBe(0);
  });

  test("fails closed when an async verifier has no synchronous final admission check", async () => {
    const fence = createModelCallFence({
      binding: binding(),
      async assertCurrent() {},
      notifyInvalidated() {},
    });

    await expect(fence.run(() => "unauthorized request")).rejects.toBeInstanceOf(ModelCallFenceError);
  });

  test("allows async preparation only when its synchronous final check is still current", async () => {
    const checked: string[] = [];
    const fence = createModelCallFence({
      binding: binding(),
      async assertCurrent() {
        checked.push("prepared");
      },
      assertCurrentAtDispatch() {
        checked.push("admitted");
      },
      notifyInvalidated() {},
    });

    await expect(
      fence.run(() => {
        checked.push("sent");
        return "response";
      }),
    ).resolves.toBe("response");

    expect(checked).toEqual(["prepared", "admitted", "sent"]);
  });

  test("rejects an async final check even though TypeScript permits async functions in void callback slots", async () => {
    const fence = createModelCallFence({
      binding: binding(),
      async assertCurrent() {},
      async assertCurrentAtDispatch() {
        throw new Error("fixture-private-final-check");
      },
      notifyInvalidated() {},
    });

    await expect(fence.run(() => "unauthorized request")).rejects.toBeInstanceOf(ModelCallFenceError);
  });

  test("a successful pending check cannot dispatch after another request invalidates the binding", async () => {
    const checkStarted = Promise.withResolvers<void>();
    const finishCheck = Promise.withResolvers<void>();
    let dispatched = 0;
    const fence = createModelCallFence({
      binding: binding(),
      async assertCurrent() {
        checkStarted.resolve();
        await finishCheck.promise;
      },
      assertCurrentAtDispatch() {},
      notifyInvalidated() {},
    });

    const pending = fence
      .run(() => {
        dispatched += 1;
      })
      .catch((error: unknown) => error);
    await checkStarted.promise;
    await fence.invalidate("policy-changed");
    finishCheck.resolve();
    expect(await pending).toBeInstanceOf(ModelCallFenceError);

    expect(dispatched).toBe(0);
  });

  test("invalidates before awaiting the notification and notifies only once", async () => {
    const notified = Promise.withResolvers<void>();
    const finishNotification = Promise.withResolvers<void>();
    let notifications = 0;
    let dispatched = 0;
    const fence = createModelCallFence({
      binding: binding(),
      assertCurrent() {},
      async notifyInvalidated() {
        notifications += 1;
        notified.resolve();
        await finishNotification.promise;
      },
    });

    const invalidating = fence.invalidate("policy-changed");
    await notified.promise;
    await expect(
      fence.run(() => {
        dispatched += 1;
      }),
    ).rejects.toBeInstanceOf(ModelCallFenceError);
    finishNotification.resolve();
    await invalidating;
    await fence.invalidate("policy-changed");

    expect(dispatched).toBe(0);
    expect(notifications).toBe(1);
  });

  test("does not misclassify an upstream failure as a policy failure", async () => {
    const notifications: ModelCallInvalidation[] = [];
    const fence = createModelCallFence({
      binding: binding(),
      assertCurrent() {},
      notifyInvalidated: (event) => {
        notifications.push(event);
      },
    });

    await expect(
      fence.run(() => {
        throw new Error("Upstream unavailable");
      }),
    ).rejects.toThrow("Upstream unavailable");
    await expect(fence.run(() => "second response")).resolves.toBe("second response");

    expect(notifications).toEqual([]);
  });

  test.each(["", " ", "bad\nidentity"])("rejects an invalid snapshot identity: %j", (snapshotId) => {
    expect(() =>
      createModelCallFence({
        binding: { ...binding(), snapshotId },
        assertCurrent() {},
        notifyInvalidated() {},
      }),
    ).toThrow();
  });
});
