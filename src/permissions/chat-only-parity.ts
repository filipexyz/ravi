import { expect } from "bun:test";
import {
  buildAgentRuntimePermissionsDefaults,
  hasToolOrExecAuthority,
  isChatOnlyRuntimePermissions,
  isToolOrExecCapability,
  readAgentRuntimePermissionsConfig,
} from "./agent-default-capabilities-provider.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "./provider-runtime.js";
import { dbCreateAgent, dbGetAgent, dbUpdateAgent, type ContextCapability } from "../router/router-db.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { createRuntimeHostServices, getRuntimeToolAccessMode } from "../runtime/host-services.js";
import { getOrCreateSession } from "../router/sessions.js";
import { createCodexRuntimeProvider } from "../runtime/codex-provider.js";
import { buildClaudeQueryOptions, createClaudeRuntimeProvider } from "../runtime/claude-provider.js";
import { authorizePiToolCall } from "../runtime/pi-tool-permissions.js";
import {
  GROK_FAIL_CLOSED_TOOL_IDS,
  buildGrokAcpProcessArgs,
  resolveGrokToolAccessRules,
} from "../runtime/grok-provider.js";
import type { RuntimeStartRequest, RuntimeToolPermissionHandler } from "../runtime/types.js";

export const CHAT_ONLY_BOOTSTRAP_FLOOR_MIN = 20;

export function persistAgentRuntimeProfile(
  agentId: string,
  profile: "chat-only" | "none" | "bootstrap" | "full-access",
  cwd = `/tmp/${agentId}`,
): void {
  if (!dbGetAgent(agentId)) {
    dbCreateAgent({ id: agentId, cwd });
  }
  const agent = dbGetAgent(agentId);
  const next =
    profile === "none"
      ? buildAgentRuntimePermissionsDefaults(agent?.defaults, null)
      : buildAgentRuntimePermissionsDefaults(agent?.defaults, { profile });
  dbUpdateAgent(agentId, { defaults: next });
}

export function assertChatOnlyStore(agentId: string): void {
  const stored = readAgentRuntimePermissionsConfig(agentId);
  expect(stored).toEqual({ profile: "chat-only" });
  expect(isChatOnlyRuntimePermissions(stored)).toBe(true);
  expect(stored).not.toBeNull();
}

export function assertNoToolOrExecAuthority(capabilities: ContextCapability[], label = "capabilities"): void {
  expect(hasToolOrExecAuthority(capabilities), `${label} must not grant tool/exec authority`).toBe(false);
  expect(
    capabilities.some(
      (capability) =>
        capability.permission === "use" && capability.objectType === "tool" && capability.objectId === "*",
    ),
    `${label} must not include use:tool:*`,
  ).toBe(false);
  expect(capabilities.filter(isToolOrExecCapability), `${label} tool/exec entries`).toEqual([]);
}

export function assertBootstrapFloor(capabilities: ContextCapability[]): void {
  expect(capabilities.length).toBeGreaterThanOrEqual(CHAT_ONLY_BOOTSTRAP_FLOOR_MIN);
  expect(
    capabilities.some(
      (capability) =>
        capability.permission === "use" &&
        capability.objectType === "tool" &&
        capability.objectId === "*" &&
        capability.source === "runtime-bootstrap:agent",
    ),
  ).toBe(true);
  expect(
    capabilities.some(
      (capability) =>
        capability.permission === "execute" &&
        capability.objectType === "group" &&
        capability.objectId === "sessions" &&
        capability.source === "runtime-bootstrap:agent",
    ),
  ).toBe(true);
  expect(canWithCapabilities(capabilities, "use", "tool", "Read")).toBe(true);
  expect(canWithCapabilities(capabilities, "execute", "executable", "ls")).toBe(true);
}

export function materializeAgentAndIdentity(
  agentId: string,
  compartmentId = "parity-chat",
): {
  agent: ContextCapability[];
  identity: ContextCapability[];
  dm: ContextCapability[];
} {
  return {
    agent: materializeSubjectCapabilities("agent", agentId),
    identity: materializeSubjectCapabilities("agent_identity", `${agentId}:chat:${compartmentId}`, {
      executorAgentId: agentId,
      compartmentType: "chat",
      compartmentId,
    }),
    dm: materializeSubjectCapabilities("agent_identity", `${agentId}:dm:${compartmentId}`, {
      executorAgentId: agentId,
      compartmentType: "dm",
      compartmentId,
    }),
  };
}

export async function assertChatOnlyHostDeny(
  agentId: string,
  capabilities: ContextCapability[],
): Promise<{
  canUseTool: RuntimeToolPermissionHandler;
}> {
  getOrCreateSession(`agent:${agentId}:parity`, agentId, `/tmp/${agentId}`, { name: `${agentId}-parity` });
  const context = createRuntimeContext({
    kind: "turn-runtime",
    agentId,
    sessionKey: `agent:${agentId}:parity`,
    sessionName: `${agentId}-parity`,
    capabilities,
    metadata: {
      authorityMode: "agent-identity",
      executorAgentId: agentId,
    },
  });
  const services = createRuntimeHostServices({
    context,
    agentId,
    sessionName: `${agentId}-parity`,
    toolContext: {},
  });

  const generic = await services.authorizeToolUse({ toolName: "Read", input: { path: "README.md" } });
  expect(generic.approved).toBe(false);
  expect(generic.reason ?? "").toMatch(/chat-only|denied|permission/i);

  const bash = await services.authorizeCommandExecution({ command: "curl https://example.com", input: {} });
  expect(bash.approved).toBe(false);

  const ls = await services.authorizeCommandExecution({ command: "ls", input: {} });
  expect(ls.approved).toBe(false);

  expect(services.listDynamicTools()).toEqual([]);

  const canUseTool: RuntimeToolPermissionHandler = async (toolName, input) => {
    const result = await services.authorizeToolUse({ toolName, input });
    if (!result.approved) {
      return { behavior: "deny", reason: result.reason ?? `${toolName} permission denied.` };
    }
    return { behavior: "allow", updatedInput: result.updatedInput ?? input };
  };

  return { canUseTool };
}

export async function assertChatOnlyCodexParity(
  agentId: string,
  capabilities: ContextCapability[],
  canUseTool: RuntimeToolPermissionHandler,
): Promise<void> {
  const provider = createCodexRuntimeProvider();
  const caps = provider.getCapabilities();
  expect(caps.tools.accessRequirement).toBe("tool_surface");
  expect(
    getRuntimeToolAccessMode(
      { tools: { accessRequirement: "tool_surface" } } as Parameters<typeof getRuntimeToolAccessMode>[0],
      agentId,
      {
        kind: "turn-runtime",
        metadata: { authorityMode: "agent-identity" },
      },
    ),
  ).toBe("restricted");
  expect(canWithCapabilities(capabilities, "use", "tool", "*")).toBe(false);
  const hosted = await canUseTool("Bash", { command: "ls" });
  expect(hosted.behavior).toBe("deny");
}

export async function assertChatOnlyPiParity(canUseTool: RuntimeToolPermissionHandler): Promise<void> {
  const missing = await authorizePiToolCall("read", { path: "README.md" }, {});
  expect(missing.allowed).toBe(false);
  expect(missing.reason ?? "").toMatch(/unavailable|denied/i);

  const denied = await authorizePiToolCall("bash", { command: "ls" }, { canUseTool });
  expect(denied.allowed).toBe(false);
  expect(denied.reason ?? "").toMatch(/denied|permission/i);
}

export async function assertChatOnlyClaudeParity(canUseTool: RuntimeToolPermissionHandler): Promise<void> {
  const provider = createClaudeRuntimeProvider();
  expect(provider.getCapabilities().tools.permissionMode).toBe("ravi-host");

  const options = buildClaudeQueryOptions(
    {
      prompt: (async function* () {})(),
      model: "claude-sonnet-4-5",
      cwd: "/tmp/chat-only-parity",
      abortController: new AbortController(),
      systemPromptAppend: "",
      permissionOptions: { permissionMode: "bypassPermissions" },
      canUseTool,
    } satisfies RuntimeStartRequest,
    {},
    {},
  );

  expect(options.permissionMode).toBe("bypassPermissions");
  expect(typeof options.canUseTool).toBe("function");
  const decision = await options.canUseTool!(
    "Read",
    { path: "README.md" },
    {
      signal: new AbortController().signal,
      toolUseID: "parity-tool-use",
      requestId: "parity-request",
    },
  );
  expect(decision?.behavior).toBe("deny");
}

export async function assertChatOnlyGrokParity(canUseTool: RuntimeToolPermissionHandler): Promise<void> {
  const rules = await resolveGrokToolAccessRules(canUseTool);
  expect(rules.allow).toEqual([]);
  expect(rules.allowToolIds).toEqual([]);
  expect(rules.allowSubagents).toBe(false);
  expect(rules.deny).toEqual(expect.arrayContaining(["Bash", "Read", "Edit", "Agent"]));
  expect(rules.denyToolIds).toEqual(expect.arrayContaining(["run_terminal_cmd", "todo_write", "Agent"]));

  const args = buildGrokAcpProcessArgs({
    allowTools: rules.allow,
    denyTools: rules.deny,
    allowRules: rules.allowRules,
    allowSubagents: rules.allowSubagents,
  });
  expect(args).not.toContain("--tools");
  expect(args).toEqual(expect.arrayContaining(["--disallowed-tools", "--no-subagents"]));
  const disallowed = args[args.indexOf("--disallowed-tools") + 1];
  expect(disallowed).toEqual(expect.stringContaining("run_terminal_cmd"));
  expect(GROK_FAIL_CLOSED_TOOL_IDS).toEqual(expect.arrayContaining(["run_terminal_cmd", "todo_write", "Agent"]));
}

export async function assertChatOnlyParity(agentId: string): Promise<void> {
  persistAgentRuntimeProfile(agentId, "chat-only");
  assertChatOnlyStore(agentId);

  const chatOnly = materializeAgentAndIdentity(agentId);
  assertNoToolOrExecAuthority(chatOnly.agent, "agent materialize");
  assertNoToolOrExecAuthority(chatOnly.identity, "agent_identity materialize");
  assertNoToolOrExecAuthority(chatOnly.dm, "dm compartment materialize");
  expect(canWithCapabilities(chatOnly.identity, "use", "tool", "Read")).toBe(false);
  expect(canWithCapabilities(chatOnly.dm, "use", "tool", "Bash")).toBe(false);

  persistAgentRuntimeProfile(agentId, "none");
  expect(readAgentRuntimePermissionsConfig(agentId)).toBeNull();
  assertBootstrapFloor(materializeSubjectCapabilities("agent", agentId));

  persistAgentRuntimeProfile(agentId, "chat-only");
  const restored = materializeAgentAndIdentity(agentId);
  assertNoToolOrExecAuthority(restored.agent, "restored chat-only agent");
  const { canUseTool } = await assertChatOnlyHostDeny(agentId, restored.identity);
  await assertChatOnlyCodexParity(agentId, restored.agent, canUseTool);
  await assertChatOnlyPiParity(canUseTool);
  await assertChatOnlyClaudeParity(canUseTool);
  await assertChatOnlyGrokParity(canUseTool);
}
