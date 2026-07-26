import path from "node:path";

import {
  LocalAgentReconciler,
  LocalAgentReconciliationRequestSchema,
  LocalAgentReconciliationResultSchema,
  createRaviClientLocalAgentRuntimeAdapter,
  type LocalAgentReconciliationRequest,
  type LocalAgentReconciliationResult,
  type LocalAgentRuntimeAdapter,
  type LocalAgentRaviClient,
} from "../../../packages/ravi-os-sdk/src/local-agent-reconciliation.js";
import { createInProcessTransport } from "../../../packages/ravi-os-sdk/src/transport/in-process.js";
import { getRegistry } from "../../cli/registry-snapshot.js";
import type { ContextRecord } from "../../router/router-db.js";
import { getRaviStateDir } from "../../utils/paths.js";

export const NATIVE_CHANNEL_DEFAULT_LOCAL_AGENT_TEMPLATE_ID = "native-channel-default" as const;

const NATIVE_CHANNEL_HOST_AGENT_ID = "native-channel-host";
const NATIVE_CHANNEL_AGENT_ID_PREFIX = "native-channel";

export interface NativeChannelLocalAgentReconciler {
  reconcile(request: LocalAgentReconciliationRequest): Promise<LocalAgentReconciliationResult>;
}

export interface NativeChannelLocalAgentReconcilerOptions {
  readonly stateDirectory?: string;
  readonly runtime?: LocalAgentRuntimeAdapter;
  readonly now?: () => string;
}

export function createNativeChannelLocalAgentReconciler(
  options: NativeChannelLocalAgentReconcilerOptions = {},
): NativeChannelLocalAgentReconciler {
  const runtime = options.runtime ?? createHostRuntimeAdapter();
  const reconciler = new LocalAgentReconciler({
    runtime,
    templates: [
      {
        templateId: NATIVE_CHANNEL_DEFAULT_LOCAL_AGENT_TEMPLATE_ID,
        workspaceRoot: path.join(options.stateDirectory ?? getRaviStateDir(), "channels", "native", "managed-agents"),
        agentIdPrefix: NATIVE_CHANNEL_AGENT_ID_PREFIX,
        manageInstructions: true,
        permissionProfile: "bootstrap",
        capabilityMap: {},
      },
    ],
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    async reconcile(input) {
      const request = LocalAgentReconciliationRequestSchema.parse(input);
      return LocalAgentReconciliationResultSchema.parse(await reconciler.reconcile(request));
    },
  };
}

function createHostRuntimeAdapter(): LocalAgentRuntimeAdapter {
  const context = nativeChannelHostContext();
  const transport = createInProcessTransport({
    registry: getRegistry(),
    scopeContext: {
      contextId: context.contextId,
      context,
      agentId: context.agentId,
    },
    contextRecord: context,
  });
  const client: LocalAgentRaviClient = {
    agents: {
      list: (options) =>
        transport.call({
          groupSegments: ["agents"],
          command: "list",
          body: { ...(options ?? {}) },
        }),
      create: (agentId, cwd, options) =>
        transport.call({
          groupSegments: ["agents"],
          command: "create",
          body: { id: agentId, cwd, ...(options ?? {}) },
        }),
      set: (agentId, key, value) =>
        transport.call({
          groupSegments: ["agents"],
          command: "set",
          body: { id: agentId, key, value },
        }),
      permissions: (agentId, profile, options) =>
        transport.call({
          groupSegments: ["agents"],
          command: "permissions",
          body: { id: agentId, profile, ...(options ?? {}) },
        }),
    },
  };
  return createRaviClientLocalAgentRuntimeAdapter(client);
}

function nativeChannelHostContext(): ContextRecord {
  return {
    contextId: "ctx_native_channel_host",
    contextKey: "host-internal",
    kind: "native-channel-host",
    agentId: NATIVE_CHANNEL_HOST_AGENT_ID,
    capabilities: [
      {
        permission: "execute",
        objectType: "group",
        objectId: "agents_list",
      },
      {
        permission: "execute",
        objectType: "group",
        objectId: "agents_create",
      },
      {
        permission: "execute",
        objectType: "group",
        objectId: "agents_set",
      },
      {
        permission: "execute",
        objectType: "group",
        objectId: "agents_permissions",
      },
      {
        permission: "view",
        objectType: "agent",
        objectId: `${NATIVE_CHANNEL_AGENT_ID_PREFIX}-*`,
      },
    ],
    metadata: {
      authorityMode: "host-internal",
    },
    createdAt: 0,
  };
}
