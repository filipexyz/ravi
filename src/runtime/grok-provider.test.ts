import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeGrokAcpPermission,
  buildGrokAcpProcessArgs,
  buildGrokAcpSpawnEnv,
  createGrokAcpSubprocessTransport,
  createGrokRuntimeProvider,
  extractGrokPermissionTool,
  GROK_FAIL_CLOSED_TOOL_IDS,
  mapGrokToolNameToRavi,
  resolveGrokToolAccessRules,
  selectGrokAuthMethod,
  selectGrokPermissionOutcome,
  toGrokEffort,
  type GrokAcpNotification,
  type GrokAcpStartInput,
  type GrokAcpTransport,
} from "./grok-provider.js";
import type { RuntimeEvent, RuntimeHostServices, RuntimePromptMessage, RuntimeStartRequest } from "./types.js";

interface TestQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
}

class FakeGrokAcpTransport implements GrokAcpTransport {
  readonly events: TestQueue<GrokAcpNotification> = createTestQueue<GrokAcpNotification>();
  readonly starts: GrokAcpStartInput[] = [];
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  responseFor?: (method: string, params?: Record<string, unknown>) => unknown | Promise<unknown>;
  closed = false;
  closeCalls = 0;

  async start(input: GrokAcpStartInput): Promise<void> {
    this.starts.push(input);
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    const response = await this.responseFor?.(method, params);
    if (response !== undefined) {
      return response;
    }
    return defaultGrokResponse(method);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.notifications.push({ method, params });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls += 1;
  }

  pushEvent(event: GrokAcpNotification): void {
    this.events.push(event);
  }

  endEvents(): void {
    this.events.end();
  }
}

describe("Grok Build runtime provider", () => {
  it("advertises an explicit subprocess RPC capability matrix", () => {
    expect(createGrokRuntimeProvider().getCapabilities()).toMatchObject({
      runtimeControl: {
        supported: true,
        operations: ["turn.interrupt"],
      },
      dynamicTools: {
        mode: "none",
      },
      execution: {
        mode: "subprocess-rpc",
      },
      sessionState: {
        mode: "provider-session-id",
        requiresCwdMatch: true,
      },
      usage: {
        semantics: "terminal-event",
      },
      tools: {
        permissionMode: "ravi-host",
        accessRequirement: "tool_and_executable",
        supportsParallelCalls: false,
      },
      systemPrompt: {
        mode: "append",
      },
      terminalEvents: {
        guarantee: "adapter",
      },
      skillVisibility: {
        availability: "none",
        loadedState: "none",
      },
      modelBroker: {
        protocols: ["openai-completions"],
        principalIsolation: "none",
      },
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsPartialText: true,
      supportsToolHooks: true,
      supportsHostSessionHooks: false,
      supportsPlugins: false,
      supportsMcpServers: false,
      supportsRemoteSpawn: false,
    });
  });

  it("never reintroduces daemon secrets into the subprocess spawn envelope", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "daemon-secret-must-not-leak";
    try {
      const env = buildGrokAcpSpawnEnv({ env: { PATH: "/usr/bin", XAI_API_KEY: "from-request" } });
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env).toEqual({ PATH: "/usr/bin", XAI_API_KEY: "from-request" });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("spawns grok agent stdio under Ravi-hosted permission rules, not always-approve", () => {
    const args = buildGrokAcpProcessArgs({
      model: "grok-4",
      effort: "ultra",
      systemPromptAppend: "Ravi instructions",
      allowTools: ["Read"],
      denyTools: ["Bash", "Edit", "Grep", "WebFetch", "WebSearch", "MCPTool", "TodoWrite", "Agent", "Skill"],
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--no-auto-update",
        "--no-alt-screen",
        "--permission-mode",
        "default",
        "--deny",
        "Bash",
        "--deny",
        "Edit",
        "--tools",
        "read_file,list_dir",
        "--no-subagents",
        "-m",
        "grok-4",
        "--effort",
        "high",
        "--append-system-prompt",
        "Ravi instructions",
        "agent",
        "stdio",
      ]),
    );
    expect(args.join("\0")).not.toContain("--allow\0Read");
    expect(args.join("\0")).not.toContain("--allow\0Bash");
    expect(args).not.toContain("--always-approve");
    expect(args).not.toContain("bypassPermissions");
    expect(args.includes("Read") && args[args.indexOf("Read") - 1] === "--tools").toBe(false);
  });

  it("uses Grok internal tool IDs on --tools and never class-wide --allow for a Bash grant", () => {
    const args = buildGrokAcpProcessArgs({
      allowTools: ["Bash"],
      denyTools: ["Read", "Edit", "Grep", "WebFetch", "WebSearch", "MCPTool", "TodoWrite", "Agent", "Skill"],
    });
    expect(args).toEqual(expect.arrayContaining(["--tools", "run_terminal_cmd", "--deny", "Read", "--no-subagents"]));
    expect(args.join("\0")).not.toContain("--allow\0Bash");
    expect(args).not.toContain("--always-approve");
    const toolsValue = args[args.indexOf("--tools") + 1];
    expect(toolsValue).toBe("run_terminal_cmd");
    expect(toolsValue).not.toContain("Bash");
    expect(toolsValue).not.toContain("Read");
    expect(toolsValue).not.toContain("Edit");
  });

  it("fail-closes empty grants by stripping Agent/todo_write and passing --no-subagents", () => {
    const args = buildGrokAcpProcessArgs({
      allowTools: [],
      denyTools: [],
    });
    const disallowed = args[args.indexOf("--disallowed-tools") + 1];
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "default", "--no-subagents"]));
    expect(args).not.toContain("--tools");
    expect(disallowed).toContain("todo_write");
    expect(disallowed).toContain("Agent");
    expect(disallowed).toContain("task");
    expect(disallowed).toContain("run_terminal_cmd");
    expect(GROK_FAIL_CLOSED_TOOL_IDS).toEqual(expect.arrayContaining(["todo_write", "Agent", "task"]));
    expect(args).not.toContain("--always-approve");
  });

  it("emits scoped --allow rules only when they are real grants, never a bare class", () => {
    const args = buildGrokAcpProcessArgs({
      allowTools: ["Read"],
      denyTools: ["Bash"],
      allowRules: ["Read(src/**)", "Read", "Bash(git *)"],
    });
    expect(args).toEqual(expect.arrayContaining(["--allow", "Read(src/**)", "--allow", "Bash(git *)"]));
    expect(args.join("\0")).not.toContain("--allow\0Read\0");
    expect(args.join("\0")).not.toContain("--allow\0Bash\0");
  });

  it("maps strongest Ravi effort values onto Grok high", () => {
    expect(toGrokEffort("none")).toBe("none");
    expect(toGrokEffort("minimal")).toBe("minimal");
    expect(toGrokEffort("low")).toBe("low");
    expect(toGrokEffort("medium")).toBe("medium");
    expect(toGrokEffort("high")).toBe("high");
    expect(toGrokEffort("xhigh")).toBe("high");
    expect(toGrokEffort("max")).toBe("high");
    expect(toGrokEffort("ultra")).toBe("high");
  });

  it("prefers xai.api_key when the env key is present", () => {
    expect(selectGrokAuthMethod([{ id: "cached_token" }, { id: "xai.api_key" }], { XAI_API_KEY: "xai-test" })).toBe(
      "xai.api_key",
    );
    expect(selectGrokAuthMethod([{ id: "cached_token" }, { id: "xai.api_key" }], {})).toBe("cached_token");
  });

  it("selects allow or reject permission options from Ravi's decision, never by default", () => {
    const options = [
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "allow-once", kind: "allow_once" },
    ];
    expect(selectGrokPermissionOutcome(options, "allow")).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(selectGrokPermissionOutcome(options, "reject")).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(selectGrokPermissionOutcome(options)).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("selects only allow_once / reject_once and never allow_always or disallow", () => {
    expect(
      selectGrokPermissionOutcome(
        [
          { optionId: "disallow", kind: "disallow" },
          { optionId: "allow-always", kind: "allow_always" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
        "allow",
      ),
    ).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(
      selectGrokPermissionOutcome(
        [
          { optionId: "allow-always", kind: "allow_always" },
          { optionId: "disallow", kind: "disallow" },
        ],
        "allow",
      ),
    ).toEqual({ outcome: "cancelled" });
    expect(
      selectGrokPermissionOutcome(
        [
          { optionId: "allow-always", kind: "allow_always" },
          { optionId: "reject-once", kind: "reject_once" },
        ],
        "reject",
      ),
    ).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("maps Grok ACP tool names onto Ravi/Claude tool identities", () => {
    expect(mapGrokToolNameToRavi("Read file")).toBe("Read");
    expect(mapGrokToolNameToRavi("read")).toBe("Read");
    expect(mapGrokToolNameToRavi("read_file")).toBe("Read");
    expect(mapGrokToolNameToRavi("list_dir")).toBe("Read");
    expect(mapGrokToolNameToRavi("bash")).toBe("Bash");
    expect(mapGrokToolNameToRavi("run_terminal_cmd")).toBe("Bash");
    expect(mapGrokToolNameToRavi("search_replace")).toBe("Edit");
    expect(mapGrokToolNameToRavi("Write")).toBe("Edit");
    expect(mapGrokToolNameToRavi("todo_write")).toBe("TodoWrite");
    expect(mapGrokToolNameToRavi("task")).toBe("Agent");
    expect(mapGrokToolNameToRavi("get_command_or_subagent_output")).toBe("Agent");
    expect(
      extractGrokPermissionTool({
        toolCall: { title: "Read file", kind: "read", rawInput: { path: "README.md" } },
      }),
    ).toEqual({
      toolName: "Read",
      input: { path: "README.md" },
    });
    expect(
      extractGrokPermissionTool({
        toolCall: { toolName: "run_terminal_cmd", rawInput: { command: "git status" } },
      }),
    ).toEqual({
      toolName: "Bash",
      input: { command: "git status" },
    });
  });

  it("fail-closes spawn rules when no Ravi tool hook is present", async () => {
    const rules = await resolveGrokToolAccessRules();
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toEqual([
      "Bash",
      "Edit",
      "Read",
      "Grep",
      "WebFetch",
      "WebSearch",
      "MCPTool",
      "TodoWrite",
      "Agent",
      "Skill",
    ]);
    expect(rules.allowToolIds).toEqual([]);
    expect(rules.allowSubagents).toBe(false);
    expect(rules.denyToolIds).toEqual(expect.arrayContaining(["todo_write", "Agent", "task", "run_terminal_cmd"]));
  });

  it("materializes spawn allow/deny from Ravi canUseTool grants", async () => {
    const canUseTool = async (toolName: string) => ({
      behavior: toolName === "Read" || toolName === "Grep" ? ("allow" as const) : ("deny" as const),
      reason: `${toolName} permission denied.`,
    });
    const rules = await resolveGrokToolAccessRules(canUseTool);
    expect(rules.allow).toEqual(["Read", "Grep"]);
    expect(rules.deny).toEqual(["Bash", "Edit", "WebFetch", "WebSearch", "MCPTool", "TodoWrite", "Agent", "Skill"]);
    expect(rules.allowToolIds).toEqual(["read_file", "list_dir", "grep"]);
    expect(rules.allowSubagents).toBe(false);
  });

  it("fail-closes unknown Grok tools that are not in the hosted catalog", async () => {
    await expect(
      authorizeGrokAcpPermission(
        {
          options: [
            { optionId: "reject-once", kind: "reject_once" },
            { optionId: "allow-once", kind: "allow_once" },
          ],
          toolCall: { toolName: "mystery_auto_exec", rawInput: {} },
        },
        {
          canUseTool: async () => ({ behavior: "allow" }),
        },
      ),
    ).resolves.toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("fail-closes ACP permission requests when Ravi hooks are missing", async () => {
    await expect(
      authorizeGrokAcpPermission({
        options: [
          { optionId: "reject-once", kind: "reject_once" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
        toolCall: { kind: "read", rawInput: { path: "README.md" } },
      }),
    ).resolves.toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("denies an ACP permission request when Ravi did not grant the tool", async () => {
    const outcome = await authorizeGrokAcpPermission(
      {
        options: [
          { optionId: "reject-once", kind: "reject_once" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
        toolCall: { kind: "bash", rawInput: { command: "rm -rf /" } },
      },
      {
        canUseTool: async (toolName) => ({
          behavior: toolName === "Read" ? "allow" : "deny",
          reason: `${toolName} permission denied.`,
        }),
      },
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("allows an ACP permission request only for tools Ravi granted", async () => {
    const outcome = await authorizeGrokAcpPermission(
      {
        options: [
          { optionId: "reject-once", kind: "reject_once" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
        toolCall: { kind: "read", rawInput: { path: "README.md" } },
      },
      {
        canUseTool: async (toolName) => ({
          behavior: toolName === "Read" ? "allow" : "deny",
          reason: `${toolName} permission denied.`,
        }),
      },
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("routes Grok shell permission requests through canUseTool(Bash) and command execution", async () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const outcome = await authorizeGrokAcpPermission(
      {
        options: [
          { optionId: "reject-once", kind: "reject_once" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
        toolCall: { toolName: "run_terminal_cmd", rawInput: { command: "git status" } },
      },
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
    );
    expect(tools).toContain("Bash");
    expect(commands).toEqual(["git status"]);
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("denies a shell call when canUseTool(Bash) is missing even if the command would be approved", async () => {
    const outcome = await authorizeGrokAcpPermission(
      {
        options: [
          { optionId: "reject-once", kind: "reject_once" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
        toolCall: { toolName: "run_terminal_cmd", rawInput: { command: "git status" } },
      },
      {
        canUseTool: async () => ({ behavior: "deny", reason: "Bash denied." }),
        approveRuntimeRequest: async () => ({ approved: true }),
      },
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("denies a shell call when a command is present but no executable authorizer exists", async () => {
    const outcome = await authorizeGrokAcpPermission(
      {
        options: [
          { optionId: "reject-once", kind: "reject_once" },
          { optionId: "allow-once", kind: "allow_once" },
        ],
        toolCall: { toolName: "run_terminal_cmd", rawInput: { command: "git status" } },
      },
      {
        canUseTool: async () => ({ behavior: "allow" }),
      },
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
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
    const prepared = await createGrokRuntimeProvider().prepareSession?.({
      agentId: "grok-probe",
      cwd: "/tmp",
      hostServices,
    });
    const approve = prepared?.startRequest?.approveRuntimeRequest;
    expect(approve).toBeTypeOf("function");
    await expect(
      approve!({
        kind: "permission",
        toolName: "Read",
        input: { path: "README.md" },
      }),
    ).resolves.toEqual({ approved: true });
    await expect(
      approve!({
        kind: "command_execution",
        toolName: "Bash",
        input: { command: "rm -rf /" },
      }),
    ).resolves.toEqual({ approved: false });
    expect(authorized).toEqual(["tool:Read", "command:rm -rf /"]);
  });

  it("starts a restricted Grok session with only granted tools enabled", async () => {
    const transport = new FakeGrokAcpTransport();
    const canUseTool = async (toolName: string) => ({
      behavior: toolName === "Read" ? ("allow" as const) : ("deny" as const),
      reason: `${toolName} permission denied.`,
    });

    await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("leia", { canUseTool })).events,
    );

    expect(transport.starts[0]).toMatchObject({
      allowTools: ["Read"],
      denyTools: ["Bash", "Edit", "Grep", "WebFetch", "WebSearch", "MCPTool", "TodoWrite", "Agent", "Skill"],
      allowSubagents: false,
    });
    const spawned = buildGrokAcpProcessArgs(transport.starts[0]);
    expect(spawned).toEqual(
      expect.arrayContaining(["--deny", "Bash", "--tools", "read_file,list_dir", "--no-subagents"]),
    );
    expect(spawned.join("\0")).not.toContain("--allow\0Read");
    expect(spawned.join("\0")).not.toContain("--allow\0Bash");
    expect(spawned).not.toContain("--always-approve");
    expect(spawned[spawned.indexOf("--tools") + 1]).not.toContain("Read");
    expect(spawned[spawned.indexOf("--disallowed-tools") + 1]).toEqual(expect.stringContaining("todo_write"));
  });

  it("closes the Grok ACP transport idempotently", async () => {
    const transport = new FakeGrokAcpTransport();
    const handle = createGrokRuntimeProvider({ transport }).startSession(createStartRequest("close"));

    await handle.close?.();
    await handle.close?.();

    expect(transport.closeCalls).toBe(1);
  });

  it("normalizes a successful ACP prompt into canonical runtime events", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        transport.pushEvent(
          sessionUpdate("agent_thought_chunk", {
            content: { type: "text", text: "hidden reasoning" },
          }),
        );
        transport.pushEvent(
          sessionUpdate("agent_message_chunk", {
            content: { type: "text", text: "ola" },
          }),
        );
        transport.pushEvent(
          sessionUpdate("agent_message_chunk", {
            content: { type: "text", text: " mundo" },
          }),
        );
        transport.pushEvent(
          sessionUpdate("usage_update", {
            used: 42,
            size: 200000,
          }),
        );
        return { stopReason: "end_turn" };
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("faz um teste")).events,
    );

    expect(events.map((event) => event.type)).toEqual([
      "thread.started",
      "turn.started",
      "provider.raw",
      "status",
      "provider.raw",
      "text.delta",
      "provider.raw",
      "text.delta",
      "provider.raw",
      "assistant.message",
      "turn.complete",
    ]);
    expect(events.find((event) => event.type === "assistant.message")).toMatchObject({
      type: "assistant.message",
      text: "ola mundo",
    });
    expect(events.filter((event) => event.type === "turn.complete")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn.complete",
      providerSessionId: "grok-session-1",
      session: {
        displayId: "grok-session-1",
        params: {
          integration: "acp",
          cwd: "/tmp",
          sessionId: "grok-session-1",
          model: "grok-4",
        },
      },
      execution: {
        provider: "grok",
        model: "grok-4",
        billingType: "unknown",
      },
      usage: {
        inputTokens: 42,
        outputTokens: 0,
      },
    });
    expect(transport.starts[0]).toMatchObject({
      cwd: "/tmp",
      model: "grok-4",
      effort: "high",
      allowTools: [],
      allowSubagents: false,
    });
    const emptyGrantArgs = buildGrokAcpProcessArgs(transport.starts[0]);
    expect(emptyGrantArgs).toEqual(expect.arrayContaining(["--no-subagents", "--disallowed-tools"]));
    expect(emptyGrantArgs[emptyGrantArgs.indexOf("--disallowed-tools") + 1]).toEqual(
      expect.stringContaining("todo_write"),
    );
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(transport.requests.find((request) => request.method === "session/prompt")?.params).toEqual({
      sessionId: "grok-session-1",
      prompt: [{ type: "text", text: "faz um teste" }],
    });
    expect(transport.closed).toBe(true);
  });

  it("maps tool_call updates into canonical tool events", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        transport.pushEvent(
          sessionUpdate("tool_call", {
            toolCallId: "call_1",
            title: "Read file",
            kind: "read",
            rawInput: { path: "README.md" },
          }),
        );
        transport.pushEvent(
          sessionUpdate("tool_call_update", {
            toolCallId: "call_1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "ok" } }],
          }),
        );
        transport.pushEvent(
          sessionUpdate("agent_message_chunk", {
            content: { type: "text", text: "li o arquivo" },
          }),
        );
        return { stopReason: "end_turn" };
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("leia")).events,
    );

    expect(events.find((event) => event.type === "tool.started")).toMatchObject({
      type: "tool.started",
      toolUse: {
        id: "call_1",
        name: "Read",
        input: { path: "README.md" },
      },
    });
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      toolUseId: "call_1",
      isError: false,
    });
    expect(events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type)).toEqual([
      "turn.started",
      "turn.complete",
    ]);
  });

  it("resumes an ACP session with session/load when stored state exists", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        transport.pushEvent(
          sessionUpdate("agent_message_chunk", {
            content: { type: "text", text: "continuidade" },
          }),
        );
        return { stopReason: "end_turn" };
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(
        createStartRequest("continua", {
          resume: "stored-session",
          resumeSession: {
            params: { sessionId: "stored-session", cwd: "/tmp" },
            displayId: "stored-session",
          },
        }),
      ).events,
    );

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/load",
      "session/prompt",
    ]);
    expect(transport.requests.find((request) => request.method === "session/load")?.params).toEqual({
      sessionId: "stored-session",
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn.complete",
      providerSessionId: "stored-session",
    });
  });

  it("emits a failed terminal event when Grok rejects a prompt", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        return Promise.reject(new Error("Grok prompt was rejected"));
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("falha")).events,
    );

    expect(events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type)).toEqual([
      "turn.started",
      "turn.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "Grok prompt was rejected",
      recoverable: true,
    });
  });

  it("emits turn.interrupted when session/prompt stops as cancelled", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        return { stopReason: "cancelled" };
      }
      return defaultGrokResponse(method);
    };

    const handle = createGrokRuntimeProvider({ transport }).startSession(createStartRequest("aborta"));
    const events = await collectRuntimeEvents(handle.events);

    expect(events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type)).toEqual([
      "turn.started",
      "turn.interrupted",
    ]);
    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
  });

  it("sends session/cancel from interrupt and control", async () => {
    const transport = new FakeGrokAcpTransport();
    let releasePrompt: ((value: unknown) => void) | undefined;
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        return new Promise((resolve) => {
          releasePrompt = resolve;
        });
      }
      return defaultGrokResponse(method);
    };

    const handle = createGrokRuntimeProvider({ transport }).startSession(createStartRequest("controle"));
    const collected: RuntimeEvent[] = [];
    const consuming = (async () => {
      for await (const event of handle.events) {
        collected.push(event);
      }
    })();

    await waitFor(() => transport.requests.some((request) => request.method === "session/prompt"));
    await handle.interrupt();
    const control = await handle.control?.({ operation: "turn.interrupt" });
    releasePrompt?.({ stopReason: "cancelled" });
    await consuming;

    expect(transport.notifications.filter((notification) => notification.method === "session/cancel")).toHaveLength(2);
    expect(control).toMatchObject({
      ok: true,
      operation: "turn.interrupt",
    });
    expect(collected.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
  });

  it("does not leak thought chunks as assistant text", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        transport.pushEvent(
          sessionUpdate("agent_thought_chunk", {
            content: { type: "text", text: "secret chain of thought" },
          }),
        );
        return { stopReason: "end_turn" };
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("pense")).events,
    );

    expect(events.some((event) => event.type === "assistant.message")).toBe(false);
    expect(events.filter((event) => event.type === "text.delta")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("turn.complete");
  });

  it("answers incoming ACP session/request_permission over a fake transport", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-grok-acp-"));
    const responsePath = join(dir, "permission.json");
    const command = writeFakeGrokAcpCommand(dir, responsePath);
    const authorized: string[] = [];
    const transport = createGrokAcpSubprocessTransport({
      command: process.execPath,
      commandArgs: [command],
      authorizePermission: async (params) => {
        authorized.push(extractGrokPermissionTool(params).toolName);
        return authorizeGrokAcpPermission(params, {
          canUseTool: async (toolName) => ({
            behavior: toolName === "Read" ? "allow" : "deny",
          }),
        });
      },
    });

    await transport.start({
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin" },
      allowTools: ["Read"],
      denyTools: ["Bash"],
    });
    const init = await transport.request("initialize", { protocolVersion: 1, clientInfo: { name: "ravi" } });
    expect(init).toMatchObject({ protocolVersion: 1 });
    await waitFor(() => existsSync(responsePath));
    const recorded = JSON.parse(readFileSync(responsePath, "utf8")) as {
      result?: { outcome?: { outcome?: string; optionId?: string } };
    };
    expect(authorized).toEqual(["Read"]);
    expect(recorded.result?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    await transport.close();
  });

  it("responds cancelled when incoming ACP authorization throws instead of swallowing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-grok-acp-throw-"));
    const responsePath = join(dir, "permission.json");
    const command = writeFakeGrokAcpCommand(dir, responsePath);
    const transport = createGrokAcpSubprocessTransport({
      command: process.execPath,
      commandArgs: [command],
      authorizePermission: async () => {
        throw new Error("host authorization exploded");
      },
    });

    await transport.start({
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin" },
    });
    await transport.request("initialize", { protocolVersion: 1, clientInfo: { name: "ravi" } });
    await waitFor(() => existsSync(responsePath));
    const recorded = JSON.parse(readFileSync(responsePath, "utf8")) as {
      result?: { outcome?: { outcome?: string; optionId?: string } };
    };
    expect(recorded.result?.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    await transport.close();
  });
});

function writeFakeGrokAcpCommand(dir: string, responsePath: string): string {
  const script = join(dir, "fake-grok.mjs");
  writeFileSync(
    script,
    `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 9001,
      method: "session/request_permission",
      params: {
        options: [
          { optionId: "reject-once", kind: "reject_once" },
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "allow-always", kind: "allow_always" },
        ],
        toolCall: { toolName: "read_file", rawInput: { path: "README.md" } },
      },
    }) + "\\n");
    return;
  }
  if (message.id === 9001) {
    writeFileSync(${JSON.stringify(responsePath)}, JSON.stringify(message));
    return;
  }
  if (typeof message.id === "number") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  }
});
`,
  );
  return script;
}

function createStartRequest(text: string, overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    prompt: onePrompt(text),
    model: "grok-4",
    effort: "high",
    cwd: "/tmp",
    abortController: new AbortController(),
    systemPromptAppend: "Ravi runtime instructions",
    ...overrides,
  };
}

async function* onePrompt(text: string): AsyncGenerator<RuntimePromptMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: text,
    },
    session_id: "session",
    parent_tool_use_id: null,
  };
}

async function collectRuntimeEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function sessionUpdate(sessionUpdate: string, extra: Record<string, unknown> = {}): GrokAcpNotification {
  return {
    method: "session/update",
    params: {
      sessionId: "grok-session-1",
      update: {
        sessionUpdate,
        ...extra,
      },
    },
  };
}

function defaultGrokResponse(method: string): unknown {
  if (method === "initialize") {
    return {
      protocolVersion: 1,
      authMethods: [{ id: "cached_token" }],
      agentCapabilities: { loadSession: true },
    };
  }
  if (method === "authenticate") {
    return {};
  }
  if (method === "session/new") {
    return { sessionId: "grok-session-1" };
  }
  if (method === "session/load") {
    return {};
  }
  if (method === "session/prompt") {
    return { stopReason: "end_turn" };
  }
  return {};
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for Grok fake transport condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createTestQueue<T>(): TestQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let ended = false;
  let failure: unknown;

  return {
    push(value) {
      if (ended || failure) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      if (ended || failure) {
        return;
      }
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as T, done: true });
      }
    },
    fail(error) {
      if (ended || failure) {
        return;
      }
      failure = error;
      while (waiters.length > 0) {
        waiters.shift()!.reject(error);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift()!, done: false });
          }
          if (failure) {
            return Promise.reject(failure);
          }
          if (ended) {
            return Promise.resolve({ value: undefined as T, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };
}
