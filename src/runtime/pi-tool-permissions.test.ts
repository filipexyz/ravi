import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_PERMISSION_HOOKS_READY_MESSAGE,
  PI_PERMISSION_MISSING_DECISION_REASON,
  PI_PERMISSION_OPAQUE_DENY_REASON,
  PI_PERMISSION_UI_TITLE,
  PI_RAVI_PERMISSION_EXTENSION_SOURCE,
  authorizePiToolCall,
  buildPiPermissionUiResponse,
  createPiApprovalHandler,
  createPiPermissionHooksReadyEvent,
  formatPiPermissionUiDecisionValue,
  isPiPermissionBridgeError,
  isPiPermissionHooksReadyEvent,
  mapPiToolNameToRavi,
  materializePiPermissionExtensionFile,
  resolvePiPermissionExtensionDirectory,
  parsePiPermissionUiDecisionValue,
  parsePiPermissionUiRequest,
  PiPermissionBridgeError,
  resolvePiExtensionUiResponse,
} from "./pi-tool-permissions.js";
import type { RuntimeHostServices } from "./types.js";

describe("Pi tool permission bridge", () => {
  it("maps Pi built-in tools onto Ravi REBAC names", () => {
    expect(mapPiToolNameToRavi("bash")).toBe("Bash");
    expect(mapPiToolNameToRavi("shell")).toBe("Bash");
    expect(mapPiToolNameToRavi("read")).toBe("Read");
    expect(mapPiToolNameToRavi("write")).toBe("Write");
    expect(mapPiToolNameToRavi("edit")).toBe("Edit");
    expect(mapPiToolNameToRavi("grep")).toBe("Grep");
    expect(mapPiToolNameToRavi("find")).toBe("Glob");
    expect(mapPiToolNameToRavi("web_fetch")).toBe("WebFetch");
    expect(mapPiToolNameToRavi("custom_tool")).toBe("custom_tool");
  });

  it("denies every tool when the Ravi canUseTool handler is missing", async () => {
    await expect(authorizePiToolCall("read", { path: "README.md" }, {})).resolves.toEqual({
      allowed: false,
      reason: "Pi tool permission handler is unavailable.",
    });
  });

  it("denies a restricted policy and allows the same tool when granted", async () => {
    const denied = await authorizePiToolCall(
      "bash",
      { command: "git status" },
      {
        canUseTool: async (toolName) => ({
          behavior: "deny",
          reason: `${toolName} permission denied.`,
        }),
        approveRuntimeRequest: async () => ({ approved: true }),
      },
    );
    expect(denied).toEqual({ allowed: false, reason: "Bash permission denied." });

    const allowed = await authorizePiToolCall(
      "read",
      { path: "README.md" },
      {
        canUseTool: async (toolName) => ({
          behavior: toolName === "Read" ? "allow" : "deny",
          reason: `${toolName} permission denied.`,
        }),
      },
    );
    expect(allowed).toEqual({ allowed: true });
  });

  it("requires both canUseTool(Bash) and command execution for shell calls", async () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const allowed = await authorizePiToolCall(
      "bash",
      { command: "git status" },
      {
        canUseTool: async (toolName) => {
          tools.push(toolName);
          return { behavior: toolName === "Bash" ? "allow" : "deny" };
        },
        approveRuntimeRequest: async (request) => {
          if (request.kind === "command_execution" && typeof request.input?.command === "string") {
            commands.push(request.input.command);
            return { approved: request.input.command.startsWith("git ") };
          }
          return { approved: false, reason: "unexpected" };
        },
      },
      { type: "extension_ui_request" },
    );
    expect(tools).toEqual(["Bash"]);
    expect(commands).toEqual(["git status"]);
    expect(allowed).toEqual({ allowed: true });
  });

  it("denies bash when the tool is granted but command execution is blocked", async () => {
    await expect(
      authorizePiToolCall(
        "bash",
        { command: "rm -rf /" },
        {
          canUseTool: async () => ({ behavior: "allow" }),
          approveRuntimeRequest: async () => ({ approved: false, reason: "rm is blocked by Ravi command policy." }),
        },
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: "rm is blocked by Ravi command policy.",
    });
  });

  it("denies bash when a command is present but no executable authorizer exists", async () => {
    await expect(
      authorizePiToolCall(
        "bash",
        { command: "git status" },
        {
          canUseTool: async () => ({ behavior: "allow" }),
        },
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: "Pi command execution authorizer is unavailable.",
    });
  });

  it("fails closed when authorization throws", async () => {
    await expect(
      authorizePiToolCall(
        "read",
        { path: "secret.md" },
        {
          canUseTool: async () => {
            throw new Error("observation plane unresolved");
          },
        },
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: "observation plane unresolved",
    });
  });

  it("parses the Ravi permission UI envelope and cancels other dialogs", () => {
    expect(
      parsePiPermissionUiRequest({
        type: "extension_ui_request",
        id: "ui-1",
        method: "confirm",
        title: PI_PERMISSION_UI_TITLE,
        message: JSON.stringify({ toolName: "bash", input: { command: "ls" } }),
      }),
    ).toMatchObject({
      kind: "permission",
      id: "ui-1",
      toolName: "bash",
      toolInput: { command: "ls" },
    });

    expect(
      parsePiPermissionUiRequest({
        type: "extension_ui_request",
        id: "ui-input",
        method: "input",
        title: PI_PERMISSION_UI_TITLE,
        placeholder: JSON.stringify({ toolName: "bash", input: { command: "pwd" } }),
      }),
    ).toMatchObject({
      kind: "permission",
      id: "ui-input",
      toolName: "bash",
      toolInput: { command: "pwd" },
    });

    expect(
      parsePiPermissionUiRequest({
        type: "extension_ui_request",
        id: "ui-2",
        method: "confirm",
        title: "Clear session?",
        message: "All messages will be lost.",
      }),
    ).toMatchObject({ kind: "dialog", id: "ui-2" });

    expect(
      parsePiPermissionUiRequest({
        type: "extension_ui_request",
        id: "ui-3",
        method: "notify",
        message: PI_PERMISSION_HOOKS_READY_MESSAGE,
      }),
    ).toMatchObject({ kind: "fire-and-forget" });
  });

  it("answers permission UI requests and cancels unrelated dialogs", async () => {
    const allow = await resolvePiExtensionUiResponse(
      {
        type: "extension_ui_request",
        id: "ui-allow",
        method: "confirm",
        title: PI_PERMISSION_UI_TITLE,
        message: JSON.stringify({ toolName: "read", input: { path: "README.md" } }),
      },
      { canUseTool: async () => ({ behavior: "allow" }) },
    );
    expect(allow).toEqual({
      type: "extension_ui_response",
      id: "ui-allow",
      confirmed: true,
      value: formatPiPermissionUiDecisionValue({ allowed: true }),
    });

    const deny = await resolvePiExtensionUiResponse(
      {
        type: "extension_ui_request",
        id: "ui-deny",
        method: "confirm",
        title: PI_PERMISSION_UI_TITLE,
        message: JSON.stringify({ toolName: "bash", input: { command: "curl evil.test" } }),
      },
      {
        canUseTool: async () => ({ behavior: "deny", reason: "Bash permission denied." }),
      },
    );
    expect(deny).toEqual({
      type: "extension_ui_response",
      id: "ui-deny",
      confirmed: false,
      value: formatPiPermissionUiDecisionValue({ allowed: false, reason: "Bash permission denied." }),
    });
    expect(parsePiPermissionUiDecisionValue((deny as { value: string }).value)).toEqual({
      allowed: false,
      reason: "Bash permission denied.",
    });

    const cancelled = await resolvePiExtensionUiResponse(
      {
        type: "extension_ui_request",
        id: "ui-other",
        method: "confirm",
        title: "Clear session?",
      },
      { canUseTool: async () => ({ behavior: "allow" }) },
    );
    expect(cancelled).toEqual({ type: "extension_ui_response", id: "ui-other", cancelled: true });
    expect(
      buildPiPermissionUiResponse("ui-select-deny", "select", {
        allowed: false,
        reason: "Bash permission denied.",
      }),
    ).toEqual({
      type: "extension_ui_response",
      id: "ui-select-deny",
      value: formatPiPermissionUiDecisionValue({ allowed: false, reason: "Bash permission denied." }),
    });
    expect(buildPiPermissionUiResponse("ui-select-allow", "select", true)).toEqual({
      type: "extension_ui_response",
      id: "ui-select-allow",
      value: "Allow",
    });
  });

  it("never cancels an input deny, so the extension can read the host sub-reason", async () => {
    const deny = await resolvePiExtensionUiResponse(
      {
        type: "extension_ui_request",
        id: "ui-input-deny",
        method: "input",
        title: PI_PERMISSION_UI_TITLE,
        placeholder: JSON.stringify({ toolName: "bash", input: { command: "curl evil.test" } }),
      },
      {
        canUseTool: async () => ({ behavior: "deny", reason: "rm is blocked by Ravi command policy." }),
      },
    );
    expect(deny).toEqual({
      type: "extension_ui_response",
      id: "ui-input-deny",
      value: formatPiPermissionUiDecisionValue({
        allowed: false,
        reason: "rm is blocked by Ravi command policy.",
      }),
    });
    expect("cancelled" in (deny ?? {})).toBe(false);
  });

  it("answers concurrent permission UI requests with matching ids and distinct host reasons", async () => {
    let releaseFirst!: (decision: { behavior: "allow" | "deny"; reason?: string }) => void;
    const firstGate = new Promise<{ behavior: "allow" | "deny"; reason?: string }>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: string[] = [];
    const handlers = {
      canUseTool: async (_toolName: string, input: Record<string, unknown>) => {
        const command = typeof input.command === "string" ? input.command : "";
        seen.push(command);
        if (command === "slow-deny") {
          return firstGate;
        }
        return { behavior: "allow" as const };
      },
      approveRuntimeRequest: async () => ({ approved: true }),
    };

    const slow = resolvePiExtensionUiResponse(
      {
        type: "extension_ui_request",
        id: "ui-slow",
        method: "input",
        title: PI_PERMISSION_UI_TITLE,
        placeholder: JSON.stringify({ toolName: "bash", input: { command: "slow-deny" } }),
      },
      handlers,
    );
    const fast = resolvePiExtensionUiResponse(
      {
        type: "extension_ui_request",
        id: "ui-fast",
        method: "input",
        title: PI_PERMISSION_UI_TITLE,
        placeholder: JSON.stringify({ toolName: "bash", input: { command: "fast-allow" } }),
      },
      handlers,
    );

    await Promise.resolve();
    releaseFirst({ behavior: "deny", reason: "slow command denied by bash policy." });
    const [slowResponse, fastResponse] = await Promise.all([slow, fast]);
    expect(seen.sort()).toEqual(["fast-allow", "slow-deny"]);
    expect(slowResponse).toEqual({
      type: "extension_ui_response",
      id: "ui-slow",
      value: formatPiPermissionUiDecisionValue({
        allowed: false,
        reason: "slow command denied by bash policy.",
      }),
    });
    expect(fastResponse).toEqual({
      type: "extension_ui_response",
      id: "ui-fast",
      value: formatPiPermissionUiDecisionValue({ allowed: true }),
    });
  });

  it("surfaces crash-recovery fence denials instead of the opaque fallback", async () => {
    const ownershipReason =
      "Runtime action approval denied because durable turn ownership changed before authorization completed.";
    let attemptId: string | undefined = "attempt-fence";
    const authorizeWithFence = async (
      authorize: () => Promise<{ approved: boolean; reason?: string }>,
    ): Promise<{ approved: boolean; reason?: string }> => {
      const captured = attemptId;
      if (!captured) {
        return { approved: false, reason: ownershipReason };
      }
      const result = await authorize();
      if (attemptId !== captured) {
        return { approved: false, reason: ownershipReason };
      }
      return result;
    };

    const allowed = await authorizePiToolCall(
      "bash",
      { command: "ravi --help" },
      {
        canUseTool: async () => ({ behavior: "allow" }),
        approveRuntimeRequest: async () =>
          authorizeWithFence(async () => {
            attemptId = undefined;
            return { approved: true };
          }),
      },
    );
    expect(allowed).toEqual({ allowed: false, reason: ownershipReason });

    const response = await resolvePiExtensionUiResponse(
      {
        type: "extension_ui_request",
        id: "ui-fence",
        method: "input",
        title: PI_PERMISSION_UI_TITLE,
        placeholder: JSON.stringify({ toolName: "bash", input: { command: "ravi --help" } }),
      },
      {
        canUseTool: async () => ({ behavior: "deny", reason: ownershipReason }),
      },
    );
    expect(parsePiPermissionUiDecisionValue((response as { value: string }).value)).toEqual({
      allowed: false,
      reason: ownershipReason,
    });
    expect((response as { value: string }).value).not.toContain(PI_PERMISSION_OPAQUE_DENY_REASON);
  });

  it("wires prepareSession approvals through Ravi host services", async () => {
    const authorized: string[] = [];
    const hostServices: RuntimeHostServices = {
      authorizeCapability: async () => ({ allowed: true, inherited: false }),
      authorizeCommandExecution: async (request) => {
        authorized.push(`command:${request.command}`);
        return { approved: request.command === "git status" };
      },
      authorizeToolUse: async (request) => {
        authorized.push(`tool:${request.toolName}`);
        return { approved: request.toolName === "Read" };
      },
      requestUserInput: async () => ({ approved: true, answers: {} }),
      listDynamicTools: () => [],
      executeDynamicTool: async () => ({ success: true, contentItems: [] }),
    };
    const approve = createPiApprovalHandler(hostServices);
    await expect(
      approve({
        kind: "permission",
        toolName: "Read",
        input: { path: "README.md" },
      }),
    ).resolves.toEqual({ approved: true });
    await expect(
      approve({
        kind: "command_execution",
        toolName: "Bash",
        input: { command: "rm -rf /" },
      }),
    ).resolves.toEqual({ approved: false });
    expect(authorized).toEqual(["tool:Read", "command:rm -rf /"]);
  });

  it("materializes the default permission extension under the Ravi state dir, not /tmp", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-state-pi-hooks-"));
    const previous = process.env.RAVI_STATE_DIR;
    process.env.RAVI_STATE_DIR = stateDir;
    try {
      expect(resolvePiPermissionExtensionDirectory()).toBe(join(stateDir, "pi-hooks"));
      expect(resolvePiPermissionExtensionDirectory()).not.toContain("/tmp/ravi-pi-hooks");
      const path = materializePiPermissionExtensionFile();
      expect(path.startsWith(join(stateDir, "pi-hooks"))).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(PI_RAVI_PERMISSION_EXTENSION_SOURCE);
    } finally {
      if (previous === undefined) delete process.env.RAVI_STATE_DIR;
      else process.env.RAVI_STATE_DIR = previous;
    }
  });

  it("materializes a Pi extension that gates tool_call before execution", () => {
    const directory = mkdtempSync(join(tmpdir(), "ravi-pi-hooks-"));
    const path = materializePiPermissionExtensionFile(directory);
    const source = readFileSync(path, "utf8");
    expect(source).toBe(PI_RAVI_PERMISSION_EXTENSION_SOURCE);
    expect(source).toContain('pi.on("tool_call"');
    expect(source).toContain('pi.on("tool_result"');
    expect(source).toContain(PI_PERMISSION_UI_TITLE);
    expect(source).toContain(PI_PERMISSION_HOOKS_READY_MESSAGE);
    expect(source).toContain("Ravi permission bridge UI is unavailable");
    expect(source).toContain("block: true");
    expect(source).toContain("ctx.ui.input");
    expect(source).toContain("withPermissionGate");
    expect(source).not.toContain("ctx.ui.confirm");
  });

  it("parses host decision values and refuses to drop a known deny reason", () => {
    expect(parsePiPermissionUiDecisionValue(formatPiPermissionUiDecisionValue({ allowed: true }))).toEqual({
      allowed: true,
    });
    expect(
      parsePiPermissionUiDecisionValue(
        formatPiPermissionUiDecisionValue({
          allowed: false,
          reason:
            "SKILL_NOT_AUTHORIZED: Skill 'image' is not authorized for this agent. Install it into Ravi if needed ('ravi skills install --source <skill-dir>'), then grant it ('ravi skills grant <agent> image').",
        }),
      ),
    ).toEqual({
      allowed: false,
      reason:
        "SKILL_NOT_AUTHORIZED: Skill 'image' is not authorized for this agent. Install it into Ravi if needed ('ravi skills install --source <skill-dir>'), then grant it ('ravi skills grant <agent> image').",
    });
    expect(parsePiPermissionUiDecisionValue(false)).toEqual({
      allowed: false,
      reason: PI_PERMISSION_MISSING_DECISION_REASON,
    });
    expect(parsePiPermissionUiDecisionValue(undefined)).toEqual({
      allowed: false,
      reason: PI_PERMISSION_MISSING_DECISION_REASON,
    });
    expect(parsePiPermissionUiDecisionValue("deny:bash policy")).toEqual({
      allowed: false,
      reason: "bash policy",
    });
  });

  it("reproduces the old confirm===true collapse and keeps host reasons on the live extension", async () => {
    const oldConfirmCollapse = (confirmed: unknown) =>
      confirmed === true ? undefined : { block: true, reason: PI_PERMISSION_OPAQUE_DENY_REASON };

    expect(oldConfirmCollapse(false)).toEqual({
      block: true,
      reason: PI_PERMISSION_OPAQUE_DENY_REASON,
    });
    expect(oldConfirmCollapse({ confirmed: false, reason: "Bash permission denied." })).toEqual({
      block: true,
      reason: PI_PERMISSION_OPAQUE_DENY_REASON,
    });

    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
    const factory = new Function(
      `${PI_RAVI_PERMISSION_EXTENSION_SOURCE.replace("export default ", "return ")}`,
    ) as () => (pi: {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void;
    }) => void;
    factory()({
      on(event, handler) {
        handlers[event] = handler;
      },
    });

    const toolCall = handlers.tool_call;
    expect(toolCall).toBeTypeOf("function");

    const denied = await toolCall?.(
      { toolName: "bash", toolCallId: "call-deny", input: { command: "curl evil.test" } },
      {
        ui: {
          input: async () => formatPiPermissionUiDecisionValue({ allowed: false, reason: "Bash permission denied." }),
        },
      },
    );
    expect(denied).toEqual({ block: true, reason: "Bash permission denied." });

    const allowed = await toolCall?.(
      { toolName: "read", toolCallId: "call-allow", input: { path: "README.md" } },
      {
        ui: {
          input: async () => formatPiPermissionUiDecisionValue({ allowed: true }),
        },
      },
    );
    expect(allowed).toBeUndefined();

    const cancelled = await toolCall?.(
      { toolName: "bash", toolCallId: "call-cancel", input: { command: "pwd" } },
      {
        ui: {
          input: async () => undefined,
        },
      },
    );
    expect(cancelled).toEqual({ block: true, reason: PI_PERMISSION_MISSING_DECISION_REASON });

    const thrown = await toolCall?.(
      { toolName: "bash", toolCallId: "call-throw", input: { command: "pwd" } },
      {
        ui: {
          input: async () => {
            throw new Error("extension UI dialog aborted");
          },
        },
      },
    );
    expect(thrown).toEqual({ block: true, reason: "extension UI dialog aborted" });
  });

  it("serializes overlapping tool_call UI so a single-slot dialog cannot cancel a sibling", async () => {
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
    const factory = new Function(
      `${PI_RAVI_PERMISSION_EXTENSION_SOURCE.replace("export default ", "return ")}`,
    ) as () => (pi: {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void;
    }) => void;
    factory()({
      on(event, handler) {
        handlers[event] = handler;
      },
    });

    let pending: ((value: string) => void) | undefined;
    let overlappingCalls = 0;
    const ui = {
      input: async () => {
        overlappingCalls += 1;
        expect(overlappingCalls).toBe(1);
        const value = await new Promise<string>((resolve) => {
          pending = resolve;
        });
        overlappingCalls -= 1;
        return value;
      },
    };

    const first = handlers.tool_call?.(
      { toolName: "bash", toolCallId: "call-1", input: { command: "ravi --help" } },
      { ui },
    );
    const second = handlers.tool_call?.(
      { toolName: "bash", toolCallId: "call-2", input: { command: "ravi --help" } },
      { ui },
    );
    await Promise.resolve();
    expect(overlappingCalls).toBe(1);
    pending?.(formatPiPermissionUiDecisionValue({ allowed: false, reason: "first call denied by bash policy." }));
    await expect(first).resolves.toEqual({ block: true, reason: "first call denied by bash policy." });
    expect(overlappingCalls).toBe(1);
    pending?.(formatPiPermissionUiDecisionValue({ allowed: true }));
    await expect(second).resolves.toBeUndefined();
  });

  it("recognizes only the Ravi permission-hooks handshake notify", () => {
    expect(isPiPermissionHooksReadyEvent(createPiPermissionHooksReadyEvent())).toBe(true);
    expect(
      isPiPermissionHooksReadyEvent({
        type: "extension_ui_request",
        method: "notify",
        message: "some other extension loaded",
      }),
    ).toBe(false);
    expect(
      isPiPermissionHooksReadyEvent({
        type: "extension_ui_request",
        method: "confirm",
        title: PI_PERMISSION_UI_TITLE,
        message: JSON.stringify({ toolName: "read", input: {} }),
      }),
    ).toBe(false);
    expect(isPiPermissionBridgeError(new PiPermissionBridgeError())).toBe(true);
    expect(isPiPermissionBridgeError(new Error("nope"))).toBe(false);
  });

  it("denies unauthorized skill use on the Pi authorize path and allows a granted skill", async () => {
    const handlers = {
      canUseTool: async () => ({ behavior: "allow" as const }),
      allowedSkills: ["ravi-dev-app-creator"],
    };

    await expect(
      authorizePiToolCall("read", { path: "/tmp/plugins/ravi-system/skills/whatsapp-manager/SKILL.md" }, handlers),
    ).resolves.toEqual({
      allowed: false,
      reason:
        "SKILL_NOT_AUTHORIZED: Skill 'whatsapp-manager' is not authorized for this agent. Install it into Ravi if needed ('ravi skills install --source <skill-dir>'), then grant it ('ravi skills grant <agent> whatsapp-manager').",
    });

    await expect(authorizePiToolCall("Skill", { skill: "ravi-system-image" }, handlers)).resolves.toEqual({
      allowed: false,
      reason:
        "SKILL_NOT_AUTHORIZED: Skill 'ravi-system-image' is not authorized for this agent. Install it into Ravi if needed ('ravi skills install --source <skill-dir>'), then grant it ('ravi skills grant <agent> ravi-system-image').",
    });

    await expect(
      authorizePiToolCall(
        "read",
        { path: "/workspace/src/plugins/internal/ravi-dev/skills/app-creator/SKILL.md" },
        handlers,
      ),
    ).resolves.toEqual({ allowed: true });

    await expect(authorizePiToolCall("read", { path: "README.md" }, handlers)).resolves.toEqual({
      allowed: true,
    });
  });

  it("still requires Bash command authorization before applying the skill allowlist", async () => {
    await expect(
      authorizePiToolCall(
        "bash",
        { command: "ravi skills show ravi-system-image --json" },
        {
          canUseTool: async () => ({ behavior: "allow" }),
          allowedSkills: ["ravi-dev-app-creator"],
        },
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: "Pi command execution authorizer is unavailable.",
    });

    await expect(
      authorizePiToolCall(
        "bash",
        { command: "ravi skills show ravi-system-image --json" },
        {
          canUseTool: async () => ({ behavior: "allow" }),
          approveRuntimeRequest: async () => ({ approved: true }),
          allowedSkills: ["ravi-dev-app-creator"],
        },
      ),
    ).resolves.toEqual({
      allowed: false,
      reason:
        "SKILL_NOT_AUTHORIZED: Skill 'ravi-system-image' is not authorized for this agent. Install it into Ravi if needed ('ravi skills install --source <skill-dir>'), then grant it ('ravi skills grant <agent> ravi-system-image').",
    });

    await expect(
      authorizePiToolCall(
        "bash",
        { command: "ravi skills show ravi-dev-app-creator --json" },
        {
          canUseTool: async () => ({ behavior: "allow" }),
          approveRuntimeRequest: async () => ({ approved: true }),
          allowedSkills: ["ravi-dev-app-creator"],
        },
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it("denies the unauthorized skill even when a granted skill shares the shell line", async () => {
    const handlers = {
      canUseTool: async () => ({ behavior: "allow" as const }),
      approveRuntimeRequest: async () => ({ approved: true }),
      allowedSkills: ["ravi-dev-app-creator"],
    };
    const denied =
      "SKILL_NOT_AUTHORIZED: Skill 'whatsapp-manager' is not authorized for this agent. Install it into Ravi if needed ('ravi skills install --source <skill-dir>'), then grant it ('ravi skills grant <agent> whatsapp-manager').";

    for (const command of [
      "head -20 /tmp/plugins/ravi-system/skills/whatsapp-manager/SKILL.md; cat /workspace/src/plugins/internal/ravi-dev/skills/app-creator/SKILL.md",
      "cat /workspace/src/plugins/internal/ravi-dev/skills/app-creator/SKILL.md /tmp/plugins/ravi-system/skills/whatsapp-manager/SKILL.md",
      "ravi skills show ravi-dev-app-creator --json && ravi skills show whatsapp-manager --json",
    ]) {
      await expect(authorizePiToolCall("bash", { command }, handlers)).resolves.toEqual({
        allowed: false,
        reason: denied,
      });
    }

    await expect(
      authorizePiToolCall(
        "bash",
        { command: "ravi skills install --source ~/.agents/skills/find-skills/SKILL.md --json" },
        handlers,
      ),
    ).resolves.toEqual({ allowed: true });
  });
});
