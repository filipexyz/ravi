import { StringCodec, type Subscription } from "nats";
import { getNats, nats } from "../nats.js";
import { resolveSession, expandHome } from "../router/index.js";
import { listTasks } from "../tasks/index.js";
import { logger } from "../utils/logger.js";
import { executeHookAction } from "./actions.js";
import { dbGetHook, dbListHooks, dbUpdateHookState } from "./db.js";
import { matchesHook, resolveChangedCwd, resolveToolFilePaths } from "./matcher.js";
import { resolveHookTemplate } from "./template.js";
import type { HookExecutionResult, HookRecord, NormalizedHookEvent } from "./types.js";

const log = logger.child("hooks:runner");
const sc = StringCodec();
const HOOK_EVENT_QUEUE = "ravi-hooks";
const HOOK_REFRESH_TOPIC = "ravi.hooks.refresh";
const DEFAULT_DEDUPE_WINDOW_MS = 2_000;

interface PendingToolEvent {
  sessionName: string;
  agentId?: string;
  toolId: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  startedAt: number;
}

function parseSessionSubject(subject: string): { sessionName: string; kind: "prompt" | "tool" | "runtime" } | null {
  if (!subject.startsWith("ravi.session.")) {
    return null;
  }

  if (subject.endsWith(".prompt")) {
    return {
      sessionName: subject.slice("ravi.session.".length, -".prompt".length),
      kind: "prompt",
    };
  }
  if (subject.endsWith(".tool")) {
    return {
      sessionName: subject.slice("ravi.session.".length, -".tool".length),
      kind: "tool",
    };
  }
  if (subject.endsWith(".runtime")) {
    return {
      sessionName: subject.slice("ravi.session.".length, -".runtime".length),
      kind: "runtime",
    };
  }

  return null;
}

export function buildSyntheticHookEvent(hook: HookRecord): NormalizedHookEvent {
  const sessionName =
    hook.scopeType === "session" && hook.scopeValue
      ? hook.scopeValue
      : hook.scopeType === "task" && hook.scopeValue
        ? `${hook.scopeValue}-work`
        : `hook-${hook.id}-test`;
  const cwd = hook.scopeType === "workspace" && hook.scopeValue ? expandHome(hook.scopeValue) : process.cwd();

  switch (hook.eventName) {
    case "PreToolUse":
    case "PostToolUse":
      return {
        eventName: hook.eventName,
        source: "hooks.test",
        sessionName,
        ...(hook.scopeType === "agent" && hook.scopeValue ? { agentId: hook.scopeValue } : { agentId: "dev" }),
        ...(hook.scopeType === "task" && hook.scopeValue ? { taskId: hook.scopeValue } : {}),
        cwd,
        workspace: cwd,
        toolName: hook.matcher?.split("|")[0]?.trim() || "Write",
        toolInput: {
          file_path: "hook-runtime-test.txt",
        },
        toolOutput: {
          ok: true,
        },
        metadata: {
          synthetic: true,
        },
      };
    case "FileChanged":
      return {
        eventName: "FileChanged",
        source: "hooks.test",
        sessionName,
        ...(hook.scopeType === "agent" && hook.scopeValue ? { agentId: hook.scopeValue } : { agentId: "dev" }),
        ...(hook.scopeType === "task" && hook.scopeValue ? { taskId: hook.scopeValue } : {}),
        cwd,
        workspace: cwd,
        path: `${cwd}/hook-runtime-test.txt`,
        paths: [`${cwd}/hook-runtime-test.txt`],
        metadata: {
          synthetic: true,
        },
      };
    case "CwdChanged":
      return {
        eventName: "CwdChanged",
        source: "hooks.test",
        sessionName,
        ...(hook.scopeType === "agent" && hook.scopeValue ? { agentId: hook.scopeValue } : { agentId: "dev" }),
        ...(hook.scopeType === "task" && hook.scopeValue ? { taskId: hook.scopeValue } : {}),
        cwd,
        workspace: cwd,
        path: cwd,
        metadata: {
          previousCwd: process.cwd(),
          synthetic: true,
        },
      };
    case "Stop":
    case "SessionStart":
      return {
        eventName: hook.eventName,
        source: "hooks.test",
        sessionName,
        ...(hook.scopeType === "agent" && hook.scopeValue ? { agentId: hook.scopeValue } : { agentId: "dev" }),
        ...(hook.scopeType === "task" && hook.scopeValue ? { taskId: hook.scopeValue } : {}),
        cwd,
        workspace: cwd,
        metadata: {
          synthetic: true,
        },
      };
  }
}

async function executeSingleHook(hook: HookRecord, event: NormalizedHookEvent): Promise<HookExecutionResult> {
  const now = Date.now();

  if (!matchesHook(hook, event)) {
    return {
      hookId: hook.id,
      hookName: hook.name,
      eventName: event.eventName,
      skipped: hook.enabled ? "matcher" : "disabled",
    };
  }

  if (hook.lastFiredAt && hook.cooldownMs > 0 && now - hook.lastFiredAt < hook.cooldownMs) {
    return {
      hookId: hook.id,
      hookName: hook.name,
      eventName: event.eventName,
      skipped: "cooldown",
      detail: `${hook.cooldownMs}ms`,
    };
  }

  const dedupeValue = hook.dedupeKey ? resolveHookTemplate(hook.dedupeKey, event).trim() : undefined;
  const dedupeWindowMs = Math.max(hook.cooldownMs, DEFAULT_DEDUPE_WINDOW_MS);
  if (
    dedupeValue &&
    hook.lastDedupeKey === dedupeValue &&
    hook.lastFiredAt &&
    now - hook.lastFiredAt < dedupeWindowMs
  ) {
    return {
      hookId: hook.id,
      hookName: hook.name,
      eventName: event.eventName,
      skipped: "dedupe",
      detail: dedupeValue,
    };
  }

  const result = await executeHookAction(hook, event);
  dbUpdateHookState(hook.id, {
    lastFiredAt: now,
    ...(dedupeValue ? { lastDedupeKey: dedupeValue } : {}),
    incrementFire: true,
  });
  hook.lastFiredAt = now;
  hook.fireCount += 1;
  if (dedupeValue) {
    hook.lastDedupeKey = dedupeValue;
  }
  return result;
}

export async function runHookById(id: string, event?: NormalizedHookEvent): Promise<HookExecutionResult> {
  const hook = dbGetHook(id);
  if (!hook) {
    throw new Error(`Hook not found: ${id}`);
  }

  return executeSingleHook(hook, event ?? buildSyntheticHookEvent(hook));
}

export class HookRunner {
  private hooks: HookRecord[] = [];
  private running = false;
  private eventSubs: Subscription[] = [];
  private refreshSub: Subscription | null = null;
  private pendingTools = new Map<string, PendingToolEvent>();
  private sessionCwds = new Map<string, string>();

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reloadHooks();
    this.subscribeToSessionEvents();
    this.subscribeToRefresh();
    log.info("Hook runner started", { hooks: this.hooks.length });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const sub of this.eventSubs) {
      sub.unsubscribe();
    }
    this.eventSubs = [];
    this.refreshSub?.unsubscribe();
    this.refreshSub = null;
    this.pendingTools.clear();
    this.sessionCwds.clear();
    log.info("Hook runner stopped");
  }

  private async reloadHooks(): Promise<void> {
    this.hooks = dbListHooks({ enabledOnly: true });
    log.info("Hooks cache refreshed", { hooks: this.hooks.length });
  }

  private subscribeToSessionEvents(): void {
    this.subscribe("ravi.session.*.prompt", async (subject, data) => {
      const parsed = parseSessionSubject(subject);
      if (!parsed || parsed.kind !== "prompt") return;
      if (data._hook) return;
      const event = this.buildBaseEvent(parsed.sessionName, {
        eventName: "SessionStart",
        source: "session.prompt",
        metadata: {
          prompt: typeof data.prompt === "string" ? data.prompt : undefined,
          deliveryBarrier: typeof data.deliveryBarrier === "string" ? data.deliveryBarrier : undefined,
        },
      });
      await this.dispatchEvent(event);
    });

    this.subscribe("ravi.session.*.tool", async (subject, data) => {
      const parsed = parseSessionSubject(subject);
      if (!parsed || parsed.kind !== "tool") return;
      await this.handleToolEvent(parsed.sessionName, data);
    });

    this.subscribe("ravi.session.*.runtime", async (subject, data) => {
      const parsed = parseSessionSubject(subject);
      if (!parsed || parsed.kind !== "runtime") return;
      const type = typeof data.type === "string" ? data.type : undefined;
      if (type !== "turn.complete" && type !== "turn.failed" && type !== "turn.interrupted") {
        return;
      }

      const event = this.buildBaseEvent(parsed.sessionName, {
        eventName: "Stop",
        source: "session.runtime",
        metadata: {
          reason: type,
          ...(type === "turn.failed" && typeof data.error === "string" ? { error: data.error } : {}),
        },
      });
      await this.dispatchEvent(event);
    });
  }

  private subscribeToRefresh(): void {
    const sub = getNats().subscribe(HOOK_REFRESH_TOPIC);
    this.refreshSub = sub;
    void (async () => {
      try {
        for await (const _message of sub) {
          if (!this.running) break;
          await this.reloadHooks();
        }
      } catch (error) {
        if (!this.running) return;
        log.error("Hook refresh subscription failed", { error });
      }
    })();
  }

  private subscribe(subject: string, handler: (subject: string, data: Record<string, unknown>) => Promise<void>): void {
    const sub = getNats().subscribe(subject, { queue: HOOK_EVENT_QUEUE });
    this.eventSubs.push(sub);

    void (async () => {
      try {
        for await (const message of sub) {
          if (!this.running) break;
          if (message.subject.startsWith("$") || message.subject.startsWith("_INBOX.")) continue;
          try {
            const data = JSON.parse(sc.decode(message.data)) as Record<string, unknown>;
            await handler(message.subject, data);
          } catch (error) {
            log.warn("Failed to process hook event payload", { subject: message.subject, error });
          }
        }
      } catch (error) {
        if (!this.running) return;
        log.error("Hook event subscription failed", { subject, error });
      }
    })();
  }

  private getSessionTaskId(sessionName: string): string | undefined {
    return listTasks({ sessionName })[0]?.id;
  }

  private buildBaseEvent(
    sessionName: string,
    input: Pick<NormalizedHookEvent, "eventName" | "source" | "metadata"> &
      Partial<Omit<NormalizedHookEvent, "eventName" | "source" | "metadata">>,
  ): NormalizedHookEvent {
    const session = resolveSession(sessionName);
    const storedCwd = this.sessionCwds.get(sessionName);
    const cwd = input.cwd ?? storedCwd ?? session?.agentCwd;
    if (cwd) {
      this.sessionCwds.set(sessionName, cwd);
    }

    return {
      eventName: input.eventName,
      source: input.source,
      sessionName,
      ...(session?.sessionKey ? { sessionKey: session.sessionKey } : {}),
      ...(input.agentId ? { agentId: input.agentId } : session?.agentId ? { agentId: session.agentId } : {}),
      ...(input.taskId
        ? { taskId: input.taskId }
        : this.getSessionTaskId(sessionName)
          ? { taskId: this.getSessionTaskId(sessionName) }
          : {}),
      ...(cwd ? { cwd, workspace: cwd } : {}),
      ...(input.path ? { path: input.path } : {}),
      ...(input.paths ? { paths: input.paths } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.toolInput ? { toolInput: input.toolInput } : {}),
      ...(input.toolOutput !== undefined ? { toolOutput: input.toolOutput } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  private async handleToolEvent(sessionName: string, data: Record<string, unknown>): Promise<void> {
    const kind = data.event;
    if (kind !== "start" && kind !== "end") {
      return;
    }

    const toolId = typeof data.toolId === "string" ? data.toolId : `${sessionName}:${Date.now()}`;
    const pendingKey = `${sessionName}:${toolId}`;

    if (kind === "start") {
      const pending: PendingToolEvent = {
        sessionName,
        toolId,
        ...(typeof data.agentId === "string" ? { agentId: data.agentId } : {}),
        ...(typeof data.toolName === "string" ? { toolName: data.toolName } : {}),
        ...(data.input && typeof data.input === "object" ? { toolInput: data.input as Record<string, unknown> } : {}),
        startedAt: Date.now(),
      };
      this.pendingTools.set(pendingKey, pending);

      const event = this.buildBaseEvent(sessionName, {
        eventName: "PreToolUse",
        source: "session.tool.start",
        ...(pending.agentId ? { agentId: pending.agentId } : {}),
        ...(pending.toolName ? { toolName: pending.toolName } : {}),
        ...(pending.toolInput ? { toolInput: pending.toolInput } : {}),
        metadata: {
          toolId,
          safety: typeof data.safety === "string" ? data.safety : undefined,
          startedAt: pending.startedAt,
        },
      });
      await this.dispatchEvent(event);
      return;
    }

    const pending = this.pendingTools.get(pendingKey);
    this.pendingTools.delete(pendingKey);

    const postEvent = this.buildBaseEvent(sessionName, {
      eventName: "PostToolUse",
      source: "session.tool.end",
      ...(typeof data.agentId === "string"
        ? { agentId: data.agentId }
        : pending?.agentId
          ? { agentId: pending.agentId }
          : {}),
      ...(typeof data.toolName === "string"
        ? { toolName: data.toolName }
        : pending?.toolName
          ? { toolName: pending.toolName }
          : {}),
      ...(pending?.toolInput ? { toolInput: pending.toolInput } : {}),
      ...(data.output !== undefined ? { toolOutput: data.output } : {}),
      metadata: {
        toolId,
        durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
        isError: data.isError === true,
        startedAt: pending?.startedAt,
      },
    });
    await this.dispatchEvent(postEvent);

    const changedFiles = resolveToolFilePaths(postEvent);
    for (const changedFile of changedFiles) {
      const fileEvent = this.buildBaseEvent(sessionName, {
        eventName: "FileChanged",
        source: "session.tool.end",
        ...(postEvent.agentId ? { agentId: postEvent.agentId } : {}),
        ...(postEvent.taskId ? { taskId: postEvent.taskId } : {}),
        ...(postEvent.cwd ? { cwd: postEvent.cwd } : {}),
        ...(postEvent.toolName ? { toolName: postEvent.toolName } : {}),
        ...(postEvent.toolInput ? { toolInput: postEvent.toolInput } : {}),
        ...(postEvent.toolOutput !== undefined ? { toolOutput: postEvent.toolOutput } : {}),
        path: changedFile,
        paths: [changedFile],
        metadata: {
          originEvent: "PostToolUse",
          toolId,
        },
      });
      await this.dispatchEvent(fileEvent);
    }

    const nextCwd = resolveChangedCwd(postEvent);
    if (nextCwd && nextCwd !== postEvent.cwd) {
      const previousCwd = postEvent.cwd;
      this.sessionCwds.set(sessionName, nextCwd);
      const cwdEvent = this.buildBaseEvent(sessionName, {
        eventName: "CwdChanged",
        source: "session.tool.end",
        ...(postEvent.agentId ? { agentId: postEvent.agentId } : {}),
        ...(postEvent.taskId ? { taskId: postEvent.taskId } : {}),
        cwd: nextCwd,
        path: nextCwd,
        ...(postEvent.toolName ? { toolName: postEvent.toolName } : {}),
        ...(postEvent.toolInput ? { toolInput: postEvent.toolInput } : {}),
        metadata: {
          previousCwd,
          toolId,
        },
      });
      await this.dispatchEvent(cwdEvent);
    }
  }

  private async dispatchEvent(event: NormalizedHookEvent): Promise<void> {
    const matches = this.hooks.filter((hook) => matchesHook(hook, event));
    if (matches.length === 0) {
      return;
    }

    for (const hook of matches) {
      const run = async () => {
        try {
          await executeSingleHook(hook, event);
        } catch (error) {
          log.error("Hook execution failed", {
            hookId: hook.id,
            hookName: hook.name,
            eventName: event.eventName,
            error,
          });
        }
      };

      if (hook.async) {
        void run();
      } else {
        await run();
      }
    }
  }
}

let runner: HookRunner | null = null;

export function getHookRunner(): HookRunner {
  if (!runner) {
    runner = new HookRunner();
  }
  return runner;
}

export async function startHookRunner(): Promise<void> {
  await getHookRunner().start();
}

export async function stopHookRunner(): Promise<void> {
  if (!runner) return;
  await runner.stop();
}

export async function emitHookRefresh(): Promise<void> {
  await nats.emit(HOOK_REFRESH_TOPIC, {});
}
