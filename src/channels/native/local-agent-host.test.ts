import { describe, expect, it, mock } from "bun:test";

import {
  NATIVE_CHANNEL_DEFAULT_LOCAL_AGENT_TEMPLATE_ID,
  createNativeChannelLocalAgentReconciler,
} from "./local-agent-host.js";

describe("native channel local agent host", () => {
  it("keeps the default template least-privilege", async () => {
    const unexpected = mock(async () => {
      throw new Error("runtime_must_not_be_called");
    });
    const reconciler = createNativeChannelLocalAgentReconciler({
      stateDirectory: process.cwd(),
      runtime: {
        inspect: unexpected,
        create: unexpected,
        configureRuntime: unexpected,
        configurePermissions: unexpected,
      },
      now: () => "2026-07-26T00:00:00.000Z",
    });

    const result = await reconciler.reconcile({
      protocol: "ravi.agent.local-reconciliation",
      schemaVersion: 1,
      requestId: "request-native-channel-agent-1",
      idempotencyKey: "idempotency-native-channel-agent-1",
      sourceId: "example-channel-a",
      agentKey: "example-agent-a",
      templateId: NATIVE_CHANNEL_DEFAULT_LOCAL_AGENT_TEMPLATE_ID,
      revision: "a".repeat(64),
      requestedCapabilities: ["unmapped.capability"],
    });

    expect(result).toEqual({
      protocol: "ravi.agent.local-reconciliation",
      schemaVersion: 1,
      requestId: "request-native-channel-agent-1",
      disposition: "blocked",
      state: "blocked",
      grantedCapabilities: [],
      error: {
        code: "LOCAL_PERMISSION_DENIED",
        category: "authorization",
        retryable: false,
        correlationId: "request-native-channel-agent-1",
      },
      observedAt: "2026-07-26T00:00:00.000Z",
    });
    expect(unexpected).not.toHaveBeenCalled();
  });
});
