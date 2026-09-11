import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { YAML } from "bun";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import type {
  RuntimeEvent,
  RuntimeExecutionMetadata,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimeSessionState,
  RuntimeSessionHandle,
  RuntimeSkillVisibilitySnapshot,
  RuntimeStartRequest,
  RuntimeThinking,
  RuntimeStatus,
  SessionRuntimeProvider,
} from "./types.js";
import { toStrongestCompatibleRuntimeEffort } from "./effort.js";
import { buildPluginSkillVisibilitySnapshot, emptySkillVisibilitySnapshot } from "./skill-visibility.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";
import { materializeRuntimeModelBroker } from "./model-broker-materializer.js";
import { SANITIZED_ENV_VARS } from "../hooks/sanitize-bash.js";
import { coalesceAssistantTextBlocks } from "./assistant-transcript.js";
import { RUNTIME_BUILTIN_TOOLS } from "../cli/tool-registry.js";
import { assertPreparedSkillExposure } from "./skill-exposure-contract.js";
import type { SkillExposureCapabilities } from "./skill-exposure-contract.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";
import { createModelCallFence } from "./model-call-fence.js";
import { bindClaudeModelCalls } from "./claude-model-call-binding.js";
import { observeClaudeSkillPayload } from "./claude-skill-payload.js";
import type { ModelCallProxy } from "./model-call-proxy.js";

const nodeRequire = createRequire(import.meta.url);
const CLAUDE_CODE_EXECUTABLE_ENV_KEYS = ["RAVI_CLAUDE_CODE_EXECUTABLE", "CLAUDE_CODE_EXECUTABLE"] as const;
const CLAUDE_CODE_AUTH_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

const CLAUDE_SKILL_EXPOSURE: SkillExposureCapabilities = {
  contractVersion: 1,
  modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
  modes: ["native-restricted"],
  nativeDiscovery: { user: "restricted", project: "restricted", plugins: "restricted" },
  contextUpdate: "rebuild",
};

// SDK skills filters the main session only. Native delegation is unavailable
// until the SDK can bind every child context to the same restricted discovery.
// RAVI's independently authorized CLI delegation remains available.
const CLAUDE_UNSCOPED_DELEGATION_TOOLS = ["Agent", "Task", "TeamCreate", "SendMessage"];
const CLAUDE_SCOPED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "TodoWrite",
  "ToolSearch",
  "EnterWorktree",
  "Skill",
];

function claudeNativeSkillNames(
  snapshot: SkillPolicySnapshot,
  nativeNames: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!nativeNames || Object.keys(nativeNames).length !== snapshot.skills.length) {
    throw new Error("Claude native skill mapping does not match the authorized snapshot.");
  }
  const names = snapshot.skills.map((skill) => nativeNames[skill.id]);
  if (names.some((name) => !name || !/^[a-z0-9-]+:[a-z0-9-]+$/i.test(name)) || new Set(names).size !== names.length) {
    throw new Error("Claude native skill mapping contains missing, invalid, or duplicate names.");
  }
  return names;
}

function assertClaudeSkillCompatibility(snapshot: SkillPolicySnapshot): void {
  for (const skill of snapshot.skills) {
    const content = skill.resource.files
      ? skill.resource.files.find((file) => file.path === "SKILL.md")?.content
      : readFileSync(skill.resource.path, "utf8");
    if (content === undefined) throw new Error("Claude skill preparation is missing an authorized resource.");
    const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
    if (frontmatter === undefined) continue;
    let metadata: unknown;
    try {
      metadata = YAML.parse(frontmatter);
    } catch {
      // Parser errors may contain source lines; do not expose skill contents.
      throw new Error("Claude skill preparation contains invalid frontmatter.");
    }
    if (typeof metadata === "object" && metadata !== null && "context" in metadata && metadata.context === "fork") {
      throw new Error("Claude cannot restrict child discovery for a forked skill; use a compatible adapter.");
    }
  }
}

export interface ClaudeRuntimeProvider extends SessionRuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

export function createClaudeRuntimeProvider(): ClaudeRuntimeProvider {
  return {
    id: "claude",
    getCapabilities() {
      return {
        runtimeControl: {
          supported: false,
          operations: [],
        },
        dynamicTools: {
          mode: "none",
        },
        execution: {
          mode: "sdk",
        },
        sessionState: {
          mode: "provider-session-id",
        },
        usage: {
          semantics: "terminal-event",
        },
        tools: {
          availableCapabilities: RUNTIME_BUILTIN_TOOLS.filter((tool) =>
            CLAUDE_SCOPED_TOOLS.includes(tool.nativeName),
          ).map((tool) => tool.capability),
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
          availability: "plugins",
          loadedState: "provider-events",
        },
        skillExposure: CLAUDE_SKILL_EXPOSURE,
        modelBroker: {
          protocols: ["anthropic-messages"],
          principalIsolation: "one-shot-capability",
        },
        supportsSessionResume: true,
        supportsSessionFork: true,
        supportsPartialText: true,
        supportsToolHooks: true,
        supportsHostSessionHooks: true,
        supportsPlugins: true,
        supportsMcpServers: true,
        supportsRemoteSpawn: true,
        legacyEventTopicSuffix: "claude",
      };
    },
    prepareSession(input: RuntimePrepareSessionRequest): RuntimePrepareSessionResult {
      if (input.skillPolicy) {
        if (input.skillExposureMode !== "native-restricted") {
          throw new Error("Claude requires the native-restricted skill exposure mode.");
        }
        claudeNativeSkillNames(input.skillPolicy, input.skillNativeNames);
        assertClaudeSkillCompatibility(input.skillPolicy);
      }
      ensureClaudeSettings(input.cwd);
      const materialized = input.modelBroker ? materializeRuntimeModelBroker(input.modelBroker) : undefined;
      return {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: input.skillPolicy ? "0" : "1",
          CLAUDECODE: "",
          ...(materialized?.env ?? {}),
        },
        ...(input.skillPolicy
          ? {
              skillExposure: {
                snapshotId: input.skillPolicy.id,
                mode: "native-restricted",
                preparedIds: input.skillPolicy.skills.map((skill) => skill.id),
              },
            }
          : {}),
      };
    },
    startSession(input) {
      const request = input;
      if (request.skillPolicy) {
        assertPreparedSkillExposure(request.skillPolicy, CLAUDE_SKILL_EXPOSURE, request.skillExposure);
        claudeNativeSkillNames(request.skillPolicy, request.skillNativeNames);
        if (!request.verifySkillPolicy) throw new Error("Claude skill policy requires a revision verifier.");
        if (!request.verifySkillPolicyAtDispatch || !request.onSkillPolicyInvalidated) {
          throw new Error("Claude skill policy requires dispatch verification and invalidation handling.");
        }
      }
      const resumeSessionId = readRuntimeSessionId(request.resumeSession) ?? request.resume;
      const skillVisibility = request.skillPolicy
        ? emptySkillVisibilitySnapshot()
        : buildPluginSkillVisibilitySnapshot({
            provider: "claude",
            plugins: request.plugins,
            state: "advertised",
            confidence: "declared",
            evidenceKind: "plugin-bootstrap",
            ...(request.allowedSkills !== undefined ? { allowedSkills: request.allowedSkills } : {}),
          });
      let activeQuery: Query | null = null;
      let currentModel = request.model;
      let closed = false;
      let activeModelProxy: ModelCallProxy | undefined;
      const closeQuery = (queryResult: Query): void => {
        if (activeQuery !== queryResult) return;
        activeQuery = null;
        queryResult.close();
      };

      return {
        provider: "claude",
        skillVisibility,
        events: runClaudeTurns(request, {
          initialResumeSessionId: resumeSessionId,
          skillVisibility,
          getModel: () => currentModel,
          setActiveQuery: (queryResult) => {
            activeQuery = queryResult;
          },
          isClosed: () => closed,
          closeQuery,
          setModelProxy: (proxy) => {
            activeModelProxy = proxy;
          },
        }),
        interrupt: async () => {
          await activeQuery?.interrupt();
        },
        close: async () => {
          closed = true;
          const queryResult = activeQuery;
          if (queryResult) closeQuery(queryResult);
          await activeModelProxy?.close();
        },
        setModel: async (model: string) => {
          if (request.modelBroker && model !== request.modelBroker.model) {
            throw new Error("Changing models requires resolving a matching model-broker route.");
          }
          currentModel = model;
          if (activeQuery) {
            try {
              await activeQuery.setModel(model);
            } catch {
              // Some transports only accept model changes between turns. The
              // next query still uses currentModel.
            }
          }
        },
      };
    },
  };
}

async function* runClaudeTurns(
  input: RuntimeStartRequest,
  runtime: {
    initialResumeSessionId?: string;
    skillVisibility?: RuntimeSkillVisibilitySnapshot;
    getModel(): string;
    setActiveQuery(queryResult: Query | null): void;
    isClosed(): boolean;
    closeQuery(queryResult: Query): void;
    setModelProxy(proxy: ModelCallProxy | undefined): void;
  },
): AsyncGenerator<RuntimeEvent> {
  let resumeSessionId = runtime.initialResumeSessionId;
  let useForkSession = input.forkSession;

  for await (const message of input.prompt) {
    if (input.abortController.signal.aborted || runtime.isClosed()) {
      break;
    }

    const prompt = stringifyUserPrompt(message.message.content);
    if (!prompt.trim()) {
      continue;
    }
    if (input.skillPolicy && prompt.trimStart().startsWith("/")) {
      // Native slash expansion bypasses the SDK's main-session skill filter.
      // Do not pass this input to the SDK or classify it as a stale policy.
      yield {
        type: "turn.failed",
        error:
          "RAVI_CLAUDE_NATIVE_SLASH_UNSUPPORTED: Native slash commands are unavailable with restricted skills; request an authorized skill in plain language.",
        recoverable: false,
        rawEvent: { type: "input.unsupported", reason: "native-slash-command" },
      };
      continue;
    }

    // The host rotates `input.env` before yielding each turn. Snapshot it here
    // so authority changes apply between queries, never during an active one.
    const terminalTracker = createRuntimeTerminalEventTracker();
    let queryResult: Query | undefined;
    let modelProxy: ModelCallProxy | undefined;
    let modelPolicyInvalidated = false;
    const observationEvents: RuntimeEvent[] = [];
    const fenceOptions = input.skillPolicy
      ? {
          binding: { snapshotId: input.skillPolicy.id, scope: input.skillPolicy.scope },
          assertCurrent: () => input.verifySkillPolicy?.(),
          assertCurrentAtDispatch: () => input.verifySkillPolicyAtDispatch?.(),
          notifyInvalidated: (event: import("./model-call-fence.js").ModelCallInvalidation) => {
            modelPolicyInvalidated = true;
            // Notify the host directly before closing the SDK stream: it may never
            // emit a usable provider event once the HTTP attempt is refused.
            try {
              input.onSkillPolicyInvalidated?.(event);
            } finally {
              if (queryResult) runtime.closeQuery(queryResult);
            }
          },
        }
      : undefined;
    const fence = fenceOptions ? createModelCallFence(fenceOptions) : undefined;
    let releasePrompt: (allowed: boolean) => void = () => {};
    const promptPermission = new Promise<boolean>((resolve) => {
      releasePrompt = resolve;
    });
    const gatedPrompt = async function* (): AsyncGenerator<SDKUserMessage> {
      if (await promptPermission) {
        yield { type: "user", message: { role: "user", content: prompt }, session_id: "", parent_tool_use_id: null };
      }
    };
    try {
      if (fence) await fence.run(() => {});
      else await input.verifySkillPolicy?.();
      const env = buildClaudeCodeEnvironment(input.env);
      queryResult = query({
        // Pin the native transport before releasing the user message. The
        // proxy then checks the actual payload before any model dispatch.
        prompt: input.skillPolicy ? gatedPrompt() : prompt,
        options: buildClaudeQueryOptions({ ...input, model: runtime.getModel() }, env, {
          resumeSessionId,
          forkSession: useForkSession,
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(env),
        }),
      });
      runtime.setActiveQuery(queryResult);
      if (input.skillPolicy) {
        const snapshot = input.skillPolicy;
        if (!fence || !fenceOptions) throw new Error("Claude model call policy binding is missing.");
        modelProxy = await bindClaudeModelCalls({
          ...fenceOptions,
          fence,
          query: queryResult,
          environment: env,
          beforeDispatch(request) {
            if (request.method !== "POST" || request.path !== "/v1/messages") return;
            const observed = observeClaudeSkillPayload(request.body, snapshot, input.skillNativeNames ?? {}, prompt);
            if (runtime.skillVisibility) {
              const now = Date.now();
              runtime.skillVisibility.skills = observed.advertisedIds.map((id) => ({
                id,
                provider: "claude",
                state: "advertised",
                confidence: "observed",
                lastSeenAt: now,
                evidence: [{ kind: "system-prompt", eventType: "model.request", observedAt: now }],
              }));
              runtime.skillVisibility.updatedAt = now;
            }
            observationEvents.push({
              type: "provider.raw",
              rawEvent: { type: "skill.exposure.observed", ...observed },
            });
          },
          ...(input.modelBroker
            ? {
                upstreamBaseOverride: env.ANTHROPIC_BASE_URL,
                upstreamHeaders: input.modelBroker.transport.publicHeaders,
              }
            : {}),
        });
        runtime.setModelProxy(modelProxy);
        await fence.run(() => {});
        if (input.abortController.signal.aborted || runtime.isClosed()) {
          throw new Error("Claude skill preparation was aborted before the prompt was released.");
        }
        releasePrompt(true);
      }
      for await (const event of normalizeClaudeEvents(queryResult)) {
        while (observationEvents.length) {
          const observation = observationEvents.shift();
          if (observation) yield observation;
        }
        if (modelPolicyInvalidated) {
          const failed = terminalTracker.fail({
            error: "The skill policy changed; a newly authorized context is required.",
            recoverable: true,
            failureKind: "skill-policy",
          });
          if (failed) yield failed;
          break;
        }
        if (!terminalTracker.accept(event)) {
          continue;
        }
        if (event.type === "turn.complete") {
          resumeSessionId = event.providerSessionId ?? readRuntimeSessionId(event.session) ?? resumeSessionId;
          if (event.session?.params) {
            event.session.params.skillVisibility = runtime.skillVisibility ?? emptySkillVisibilitySnapshot();
          }
          useForkSession = false;
        }
        yield event;
      }
      if (!terminalTracker.terminalEmitted) {
        const terminal = modelPolicyInvalidated
          ? terminalTracker.fail({
              error: "The skill policy changed; a newly authorized context is required.",
              recoverable: true,
              failureKind: "skill-policy",
            })
          : input.abortController.signal.aborted
            ? terminalTracker.interrupt({
                rawEvent: {
                  type: "stream.ended",
                  reason: "abort",
                },
              })
            : terminalTracker.fail({
                error: "Runtime provider stream ended without a terminal event",
                recoverable: true,
                rawEvent: {
                  type: "stream.ended",
                  reason: "missing_terminal_event",
                },
              });
        if (terminal) {
          yield terminal;
        }
      }
    } catch (error) {
      const terminal = modelPolicyInvalidated
        ? terminalTracker.fail({
            error: "The skill policy changed; a newly authorized context is required.",
            recoverable: true,
            failureKind: "skill-policy",
          })
        : input.abortController.signal.aborted
          ? terminalTracker.interrupt({
              rawEvent: {
                type: "stream.error",
                reason: "abort",
              },
            })
          : terminalTracker.fail({
              error: error instanceof Error ? error.message : String(error),
              recoverable: true,
            });
      if (terminal) {
        yield terminal;
      }
    } finally {
      releasePrompt(false);
      if (input.skillPolicy && queryResult) runtime.closeQuery(queryResult);
      await modelProxy?.close();
      runtime.setModelProxy(undefined);
      runtime.setActiveQuery(null);
    }
  }
}

function buildClaudeQueryOptions(
  input: RuntimeStartRequest,
  env: Record<string, string>,
  runtime: {
    resumeSessionId?: string;
    forkSession?: boolean;
    pathToClaudeCodeExecutable?: string;
  },
): Options {
  const thinking = resolveClaudeThinkingConfig(input.thinking, input.model);
  const effort = toStrongestCompatibleRuntimeEffort(input.effort);
  return {
    model: input.model,
    effort: effort as Options["effort"],
    ...(thinking ? { thinking } : {}),
    cwd: input.cwd,
    ...(runtime.resumeSessionId ? { resume: runtime.resumeSessionId } : {}),
    ...(runtime.forkSession ? { forkSession: true } : {}),
    abortController: input.abortController,
    ...(input.permissionOptions as Partial<Options> | undefined),
    ...(input.canUseTool
      ? {
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>): Promise<PermissionResult> => {
            const result = await input.canUseTool!(toolName, toolInput);
            if (result.behavior === "deny") {
              return {
                behavior: "deny",
                message: result.reason ?? `Tool denied: ${toolName}`,
              };
            }
            return {
              behavior: "allow",
              updatedInput: result.updatedInput ?? toolInput,
            };
          },
        }
      : {}),
    includePartialMessages: true,
    env,
    ...(runtime.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers as Record<string, McpServerConfig> } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: input.systemPromptAppend,
    },
    // The materialized user settings contain the protected proxy and sandbox
    // policy. Project settings are intentionally excluded in proxy mode so a
    // repository cannot override the forwarder, auth helper, or sandbox.
    settingSources: input.modelBroker ? ["user"] : (input.settingSources ?? ["project"]),
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.plugins && input.plugins.length > 0 ? { plugins: input.plugins } : {}),
    ...(input.skillPolicy
      ? {
          skills: claudeNativeSkillNames(input.skillPolicy, input.skillNativeNames),
          tools: CLAUDE_SCOPED_TOOLS,
          disallowedTools: [
            ...new Set([...readDisallowedClaudeTools(input.permissionOptions), ...CLAUDE_UNSCOPED_DELEGATION_TOOLS]),
          ],
        }
      : input.allowedSkills !== undefined
        ? { skills: input.allowedSkills }
        : {}),
    ...(input.remoteSpawn ? { spawnClaudeCodeProcess: input.remoteSpawn as Options["spawnClaudeCodeProcess"] } : {}),
  };
}

function readDisallowedClaudeTools(options: RuntimeStartRequest["permissionOptions"]): string[] {
  const value = options?.disallowedTools;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error("Claude disallowed tool configuration must contain tool names.");
  }
  return value.filter((name): name is string => typeof name === "string");
}

function resolveClaudeThinkingConfig(thinking?: RuntimeThinking, model?: string): Options["thinking"] | undefined {
  switch (thinking) {
    case "off":
      if (isAdaptiveThinkingOnlyClaudeModel(model)) {
        return undefined;
      }
      return { type: "disabled" };
    case "verbose":
      return { type: "adaptive", display: "summarized" };
    case "normal":
      return { type: "adaptive", display: "omitted" };
    default:
      return undefined;
  }
}

function isAdaptiveThinkingOnlyClaudeModel(model?: string): boolean {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "claude-fable-5" || normalized === "fable" || normalized === "claude-mythos-5";
}

function stringifyUserPrompt(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function buildClaudeCodeEnvironment(inputEnv?: Record<string, string>): Record<string, string> {
  const env = inputEnv
    ? { ...inputEnv }
    : Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );

  if (env.RAVI_MODEL_BROKER_ACTIVE === "1") {
    for (const key of SANITIZED_ENV_VARS) delete env[key];
    return env;
  }

  for (const key of CLAUDE_CODE_AUTH_ENV_KEYS) {
    const processValue = process.env[key]?.trim();
    if (processValue && !env[key]?.trim()) {
      env[key] = processValue;
    }
  }

  return env;
}

export function resolveClaudeCodeExecutable(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const key of CLAUDE_CODE_EXECUTABLE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }

  const nativeExecutable = resolveNativeClaudeCodeExecutable();
  if (nativeExecutable) {
    return nativeExecutable;
  }

  return resolveExecutableFromPath("claude", env);
}

function resolveNativeClaudeCodeExecutable(): string | undefined {
  const executableName = process.platform === "win32" ? "claude.exe" : "claude";

  for (const packageName of getNativePackagePreference()) {
    try {
      const candidate = nodeRequire.resolve(`${packageName}/${executableName}`);
      if (ensureExecutable(candidate)) {
        return candidate;
      }
    } catch {
      // Optional native packages are platform/package-manager dependent.
    }
  }

  return undefined;
}

function ensureExecutable(candidate: string): boolean {
  if (process.platform === "win32") {
    return true;
  }

  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    // Bun/global installs can occasionally leave optional native package files
    // without executable bits. Repair when the current user owns the install.
  }

  try {
    chmodSync(candidate, statSync(candidate).mode | 0o111);
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getNativePackagePreference(): string[] {
  const arch = process.arch;

  if (process.platform === "linux") {
    const linuxPackages = [
      `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
      `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
    ];
    return isMuslRuntime() ? linuxPackages.reverse() : linuxPackages;
  }

  return [`@anthropic-ai/claude-agent-sdk-${process.platform}-${arch}`];
}

function isMuslRuntime(): boolean {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header) {
      return !report.header.glibcVersionRuntime;
    }
  } catch {
    // Fall through to loader inspection for runtimes such as Bun.
  }

  if (hasAnyExistingPath(getGlibcLoaderPaths())) {
    return false;
  }
  if (hasAnyExistingPath(getMuslLoaderPaths())) {
    return true;
  }
  return scanRuntimeLoaderDirectories().some((name) => name.startsWith("ld-musl-"));
}

function getGlibcLoaderPaths(): string[] {
  switch (process.arch) {
    case "arm64":
      return ["/lib/ld-linux-aarch64.so.1", "/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"];
    case "x64":
      return ["/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"];
    default:
      return [];
  }
}

function getMuslLoaderPaths(): string[] {
  switch (process.arch) {
    case "arm64":
      return ["/lib/ld-musl-aarch64.so.1", "/usr/lib/ld-musl-aarch64.so.1"];
    case "x64":
      return ["/lib/ld-musl-x86_64.so.1", "/usr/lib/ld-musl-x86_64.so.1"];
    default:
      return [];
  }
}

function hasAnyExistingPath(paths: string[]): boolean {
  return paths.some((path) => existsSync(path));
}

function scanRuntimeLoaderDirectories(): string[] {
  const names: string[] = [];
  for (const directory of ["/lib", "/lib64", "/usr/lib"]) {
    try {
      names.push(...readdirSync(directory));
    } catch {
      // Ignore missing or unreadable system directories.
    }
  }
  return names;
}

function resolveExecutableFromPath(command: string, env: Record<string, string | undefined>): string | undefined {
  const path = env.PATH;
  if (!path) {
    return undefined;
  }

  const executableNames = process.platform === "win32" ? [`${command}.exe`, command] : [command];

  for (const directory of path.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const executableName of executableNames) {
      const candidate = join(directory, executableName);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function* normalizeClaudeEvents(queryResult: Query): AsyncGenerator<RuntimeEvent> {
  for await (const message of queryResult as AsyncIterable<any>) {
    if (message.type === "stream_event") {
      const evt = message.event;
      if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        yield { type: "text.delta", text: evt.delta.text };
      }
      continue;
    }

    const rawEvent = message as Record<string, unknown>;
    yield { type: "provider.raw", rawEvent };

    if (message.type === "system" && message.subtype === "status") {
      yield {
        type: "status",
        status: normalizeClaudeStatus(message.status),
        rawEvent,
      };
      continue;
    }

    if (message.type === "assistant") {
      const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
      const textBlocks: string[] = [];

      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          textBlocks.push(block.text);
        }
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          yield {
            type: "tool.started",
            toolUse: { id: block.id, name: block.name, input: block.input },
            rawEvent,
          };
        }
      }

      for (const text of coalesceAssistantTextBlocks(textBlocks)) {
        yield {
          type: "assistant.message",
          text,
          rawEvent,
        };
      }
      continue;
    }

    if (message.type === "user") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        const toolResult = content.find((block: any) => block?.type === "tool_result");
        if (toolResult) {
          yield {
            type: "tool.completed",
            toolUseId: toolResult.tool_use_id,
            content: toolResult.content,
            isError: toolResult.is_error,
            rawEvent,
          };
        }
      }
      continue;
    }

    if (message.type === "result") {
      if (message.subtype && message.subtype !== "success") {
        yield {
          type: "turn.failed",
          error:
            Array.isArray(message.errors) && message.errors.length > 0
              ? message.errors.join("; ")
              : "Claude turn failed",
          recoverable: true,
          rawEvent,
        };
        continue;
      }

      yield {
        type: "turn.complete",
        providerSessionId: typeof message.session_id === "string" ? message.session_id : undefined,
        session: buildClaudeSessionState(typeof message.session_id === "string" ? message.session_id : undefined),
        execution: buildClaudeExecutionMetadata(message),
        usage: {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
          cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? 0,
        },
        rawEvent,
      };
    }
  }
}

function buildClaudeSessionState(sessionId: string | undefined): RuntimeSessionState | undefined {
  if (!sessionId) {
    return undefined;
  }

  return {
    params: { sessionId },
    displayId: sessionId,
  };
}

function buildClaudeExecutionMetadata(message: Record<string, any>): RuntimeExecutionMetadata {
  const model =
    typeof message.model === "string"
      ? message.model
      : typeof message.message?.model === "string"
        ? message.message.model
        : null;

  return {
    provider: "anthropic",
    model,
    billingType: "api",
  };
}

function readRuntimeSessionId(session: RuntimeStartRequest["resumeSession"]): string | undefined {
  if (!session?.params) {
    return undefined;
  }

  const value = session.params.sessionId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function ensureClaudeSettings(cwd: string): void {
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    return;
  }

  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        PermissionRequest: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: 'echo \'{"decision":"allow"}\'', timeout: 5 }],
          },
        ],
      },
      null,
      2,
    ),
  );
}

function normalizeClaudeStatus(status: string): RuntimeStatus {
  if (status === "queued" || status === "thinking" || status === "compacting" || status === "idle") {
    return status;
  }
  return status === "done" ? "idle" : "thinking";
}
