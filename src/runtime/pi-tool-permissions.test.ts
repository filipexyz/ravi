import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_PERMISSION_HOOKS_READY_MESSAGE,
  PI_PERMISSION_UI_TITLE,
  PI_RAVI_PERMISSION_EXTENSION_SOURCE,
  authorizePiToolCall,
  buildPiPermissionUiResponse,
  createPiApprovalHandler,
  createPiPermissionHooksReadyEvent,
  isPiPermissionBridgeError,
  isPiPermissionHooksReadyEvent,
  mapPiToolNameToRavi,
  materializePiPermissionExtensionFile,
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
    expect(allow).toEqual({ type: "extension_ui_response", id: "ui-allow", confirmed: true });

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
    expect(deny).toEqual({ type: "extension_ui_response", id: "ui-deny", confirmed: false });

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
    expect(buildPiPermissionUiResponse("ui-select", "select", false)).toEqual({
      type: "extension_ui_response",
      id: "ui-select",
      value: "Block",
    });
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
});
