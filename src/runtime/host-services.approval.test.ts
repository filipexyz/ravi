import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setApprovalGrantorRouterConfigForTest } from "../approval/grantor.js";
import { setApprovalServiceDependenciesForTest, type ApprovalServiceDependencies } from "../approval/service.js";
import { SLACK_APPROVAL_ACTION_APPROVE } from "../approval/slack-blocks.js";
import {
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  seedApprovalContact,
} from "../approval/test-support.js";
import { setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import { dbCreateAgent, dbCreateContext, dbUpdateAgent, type ContextCapability } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeHostServices } from "./host-services.js";

let stateDir: string | null = null;
let delivered: Array<Record<string, unknown>> = [];

const agentId = "slack-approval-agent";
const bootstrapCaps: ContextCapability[] = [
  { permission: "use", objectType: "tool", objectId: "*" },
  { permission: "execute", objectType: "executable", objectId: "ls" },
];

describe("runtime command approval on Slack", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-host-services-approval-");
    delivered = [];
    setApprovalGrantorRouterConfigForTest(() => ({ instances: {}, instanceToAccount: {} }));
    setPermissionAuditPublisherForTest(async () => {});
    dbCreateAgent({ id: agentId, cwd: "/tmp/slack-approval-agent" });
    dbUpdateAgent(agentId, {
      defaults: { runtimePermissions: { capabilities: ["use:tool:*", "execute:executable:ls"] } },
    });
    seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Slack Owner",
      tags: ["permission.admin"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "main" },
    });
    setApprovalServiceDependenciesForTest({
      requestReply: (async <T>(_topic: string, data: Record<string, unknown>) => {
        delivered.push(data);
        return {
          messageId: "eph_1",
          deliveries: [
            { userId: APPROVAL_TEST_SLACK_OWNER_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1" },
          ],
        } as T;
      }) satisfies ApprovalServiceDependencies["requestReply"],
      respondSlackInteraction: async () => {},
      finalizeSlackApproval: async () => {},
      nats: {
        emit: async () => {},
        subscribe: (() =>
          (async function* () {
            const blocks = delivered[0]?.blocks as Array<{ elements?: Array<{ value?: string }> }> | undefined;
            const requestId = blocks?.flatMap((block) => block.elements ?? []).find((element) => element.value)?.value;
            yield {
              topic: "ravi.inbound.interaction",
              data: {
                provider: "slack",
                accountId: "main",
                instanceId: "main",
                channelId: "C123",
                messageTs: "eph_1",
                userId: APPROVAL_TEST_SLACK_OWNER_USER,
                actionId: SLACK_APPROVAL_ACTION_APPROVE,
                value: requestId,
                responseUrlId: "resp_1",
              },
            };
          })()) as unknown as ApprovalServiceDependencies["nats"]["subscribe"],
      },
    });
  });

  afterEach(async () => {
    setApprovalServiceDependenciesForTest();
    setApprovalGrantorRouterConfigForTest();
    setPermissionAuditPublisherForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("runs a command once the owner approves its executable in Slack", async () => {
    const context = dbCreateContext({
      contextId: "ctx_slack_turn",
      contextKey: "rctx_slack_turn",
      kind: "turn-runtime",
      agentId,
      sessionName: "slack-turn",
      capabilities: bootstrapCaps,
      metadata: {
        authorityMode: "agent-identity",
        actorResolution: "resolved",
        approvalSource: { channel: "slack", accountId: "main", chatId: "C123" },
      },
      createdAt: 1000,
    });
    const services = createRuntimeHostServices({ context, agentId, sessionName: "slack-turn", toolContext: {} });

    const result = await services.authorizeCommandExecution({ command: "curl https://example.com" });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.privateTo).toEqual([APPROVAL_TEST_SLACK_OWNER_USER]);
    expect(result).toMatchObject({ approved: true });
  });
});
