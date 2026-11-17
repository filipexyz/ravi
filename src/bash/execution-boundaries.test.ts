import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as approvalService from "../approval/service.js";
import { enforceCliCommandAccess } from "../cli/command-access.js";
import { createBashPermissionHook, createToolPermissionHook } from "./hook.js";
import { runWithContext } from "../cli/context.js";
import {
  flushPermissionAuditEvents,
  listPermissionDenials,
  setPermissionAuditPublisherForTest,
} from "../permissions/denials.js";
import { dbCreateAgent, dbUpdateAgent, type ContextCapability, type ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { createRuntimeHostServices } from "../runtime/host-services.js";

let stateDir: string | null = null;
const agentId = "bash-boundaries";
const restricted: ContextCapability[] = [
  { permission: "use", objectType: "tool", objectId: "Bash" },
  { permission: "execute", objectType: "executable", objectId: "printf" },
];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-bash-boundaries-");
  dbCreateAgent({ id: agentId, cwd: stateDir });
});

afterEach(async () => {
  await flushPermissionAuditEvents();
  setPermissionAuditPublisherForTest();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function host(context: ContextRecord) {
  return createRuntimeHostServices({ context, agentId, sessionName: "bash-boundaries", toolContext: {} });
}

function callSdkHook(context: ContextRecord, command: string, toolOnly = false) {
  const createHook = toolOnly ? createToolPermissionHook : createBashPermissionHook;
  const hook = createHook({ getAgentId: () => agentId }).hooks[0]!;
  return runWithContext({ agentId, context }, () =>
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, null, {
      signal: new AbortController().signal,
    }),
  );
}

describe("Bash execution authority boundaries", () => {
  it("keeps gateway command authorization separate from arbitrary shell execution", async () => {
    const context = createRuntimeContext({
      kind: "cli-runtime",
      agentId,
      capabilities: [
        { permission: "use", objectType: "tool", objectId: "Bash" },
        { permission: "execute", objectType: "executable", objectId: "*" },
      ],
    });
    expect((await host(context).authorizeCommandExecution({ command: "ravi demo create" })).approved).toBe(true);
    const authorize = () =>
      runWithContext({ agentId, context }, () =>
        enforceCliCommandAccess({
          group: "demo",
          command: "create",
          source: "gateway",
          access: { kind: "mutate", resource: "demo.items", action: "create", risk: "high" },
        }),
      );
    expect(authorize().allowed).toBe(false);
    context.capabilities.push({ permission: "mutate", objectType: "demo.items", objectId: "create" });
    expect(authorize().allowed).toBe(true);
  });
  it("applies live grants and reductions to the same native resolved turn", async () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId,
      capabilities: restricted,
      metadata: { authorityMode: "agent-identity", actorResolution: "resolved" },
    });
    const services = host(context);
    const command = "printf '%s' $(date)";

    expect((await services.authorizeCommandExecution({ command })).approved).toBe(true);
    dbUpdateAgent(agentId, {
      defaults: {
        runtimePermissions: { profile: "explicit-only", capabilities: ["use:tool:Bash", "execute:executable:printf"] },
      },
    });
    expect((await services.authorizeCommandExecution({ command })).approved).toBe(false);
  });

  it.each([
    { actorResolution: "missing_contact" },
    { actorResolution: "resolved", relayNarrowing: true },
    { actorResolution: "resolved", turnCapabilityCount: 1 },
    { actorResolution: "resolved", turnCapabilities: restricted },
    { actorResolution: "resolved", actorAuthorizationMode: "user-overlay" },
  ])("preserves a narrowed turn in native authorization: %j", async (metadata) => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId,
      capabilities: restricted,
      metadata: { authorityMode: "agent-identity", ...metadata },
    });

    const decision = await host(context).authorizeCommandExecution({ command: "printf ok | xargs sh -c id" });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("launch the interpreter sh");
  });

  it("retains native denial provenance without creating an executable grant request", async () => {
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const auditEvents: Array<Record<string, unknown>> = [];
    setPermissionAuditPublisherForTest(async (_topic, data) => {
      auditEvents.push(data);
    });
    const source = { channel: "slack", accountId: "main", chatId: "C_BASH_BOUNDARIES" };
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId,
      sessionName: "bash-boundaries",
      source,
      capabilities: restricted,
      metadata: { authorityMode: "agent-identity", actorResolution: "resolved", turnCapabilityCount: 1 },
    });
    const command = "printf '%s' PRIVATE_COMMAND_SENTINEL | sh";

    expect((await host(context).authorizeCommandExecution({ command })).approved).toBe(false);
    await flushPermissionAuditEvents();

    expect(listPermissionDenials({ subjectType: "agent", subjectId: agentId })).toEqual([]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      type: "shell_syntax",
      denied: "restricted_syntax",
      detail: { commandChars: command.length },
      context: {
        contextId: context.contextId,
        kind: "turn-runtime",
        agentId,
        sessionName: "bash-boundaries",
        authorityMode: "agent-identity",
        actorResolution: "resolved",
        turnCapabilityCount: 1,
        source,
      },
    });
    expect(JSON.stringify(auditEvents)).not.toContain("PRIVATE_COMMAND_SENTINEL");
  });

  it.each(["printf ok | xargs sh -c id", "python3 -c 'print(1)'", "bash -c 'printf ok'", "printf 'unterminated"])(
    "denies SDK syntax and never requests native approval: %s",
    async (command) => {
      // Missing Bash permission must not turn a syntax refusal into an approval.
      const context = createRuntimeContext({ kind: "cli-runtime", agentId, capabilities: [] });
      const authorize = spyOn(approvalService, "authorizeRuntimeContext");
      const beforeExternalApproval = mock(() => {});
      try {
        const sdk = await callSdkHook(context, command);
        expect(sdk.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect((await host(context).authorizeCommandExecution({ command, beforeExternalApproval })).approved).toBe(
          false,
        );
        expect(authorize).not.toHaveBeenCalled();
        expect(beforeExternalApproval).not.toHaveBeenCalled();
        expect(listPermissionDenials({ subjectType: "agent", subjectId: agentId })).toEqual([]);
      } finally {
        authorize.mockRestore();
      }
    },
  );

  it("requires the Bash tool grant in both adapters even with arbitrary execution", async () => {
    const context = createRuntimeContext({
      kind: "cli-runtime",
      agentId,
      capabilities: [{ permission: "execute", objectType: "executable", objectId: "*" }],
    });
    const command = "printf '%s' $(date)";

    expect((await callSdkHook(context, command, true)).hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("tool:Bash"),
    });
    expect((await host(context).authorizeCommandExecution({ command })).approved).toBe(false);
    expect(listPermissionDenials({ subjectType: "agent", subjectId: agentId })).toEqual(
      expect.arrayContaining([expect.objectContaining({ relation: "use", objectType: "tool", objectId: "Bash" })]),
    );
  });
});
