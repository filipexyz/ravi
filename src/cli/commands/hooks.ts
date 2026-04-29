import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { formatDurationMs, parseDurationMs } from "../../cron/schedule.js";
import {
  dbCreateHook,
  dbDeleteHook,
  dbGetHook,
  dbListHooks,
  dbUpdateHook,
  emitHookRefresh,
  runHookById,
  type HookActionPayload,
  type HookActionType,
  type HookEventName,
  type HookHistoryRole,
  type HookInput,
  type HookRecord,
  type HookScopeType,
  HOOK_ACTION_TYPES,
  HOOK_EVENT_NAMES,
  HOOK_SCOPE_TYPES,
} from "../../hooks-runtime/index.js";

const VALID_SCOPE_TYPES = new Set<string>(HOOK_SCOPE_TYPES);
const VALID_ACTION_TYPES = new Set<string>(HOOK_ACTION_TYPES);

interface HookScopeOptions {
  scope?: string;
  agent?: string;
  session?: string;
  workspace?: string;
  task?: string;
}

function normalizeEventName(value: string | undefined): HookEventName {
  if (!value?.trim()) {
    fail(`--event is required. Valid: ${HOOK_EVENT_NAMES.join(", ")}`);
  }

  const trimmed = value.trim();
  const exact = HOOK_EVENT_NAMES.find((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  if (!exact) {
    fail(`Invalid event: ${value}. Valid: ${HOOK_EVENT_NAMES.join(", ")}`);
  }
  return exact;
}

function normalizeActionType(value: string | undefined): HookActionType {
  if (!value?.trim()) {
    fail(`--action is required. Valid: ${HOOK_ACTION_TYPES.join(", ")}`);
  }

  const trimmed = value.trim().replace(/-/g, "_");
  if (!VALID_ACTION_TYPES.has(trimmed)) {
    fail(`Invalid action: ${value}. Valid: ${HOOK_ACTION_TYPES.join(", ")}`);
  }
  return trimmed as HookActionType;
}

function inferScopeType(options: HookScopeOptions): HookScopeType {
  if (options.scope?.trim()) {
    const trimmed = options.scope.trim();
    if (!VALID_SCOPE_TYPES.has(trimmed)) {
      fail(`Invalid scope: ${options.scope}. Valid: ${HOOK_SCOPE_TYPES.join(", ")}`);
    }
    return trimmed as HookScopeType;
  }

  const explicitScopes = [
    options.agent ? "agent" : null,
    options.session ? "session" : null,
    options.workspace ? "workspace" : null,
    options.task ? "task" : null,
  ].filter((value): value is HookScopeType => Boolean(value));

  if (explicitScopes.length > 1) {
    fail("Use only one scope selector at a time: --agent, --session, --workspace, or --task.");
  }

  return explicitScopes[0] ?? "global";
}

function resolveScopeValue(scopeType: HookScopeType, options: HookScopeOptions): string | undefined {
  const ctx = getContext();

  switch (scopeType) {
    case "global":
      return undefined;
    case "agent":
      return options.agent?.trim() || ctx?.agentId || undefined;
    case "session":
      return options.session?.trim() || ctx?.sessionName || undefined;
    case "workspace":
      return options.workspace?.trim() || process.cwd();
    case "task":
      return options.task?.trim() || undefined;
  }
}

function buildActionPayload(
  actionType: HookActionType,
  input: {
    message?: string;
    targetSession?: string;
    targetTask?: string;
    role?: string;
    barrier?: string;
  },
): HookActionPayload {
  switch (actionType) {
    case "inject_context":
      if (!input.message?.trim()) {
        fail("--message is required for inject_context");
      }
      return {
        message: input.message.trim(),
        ...(input.targetSession?.trim() ? { sessionName: input.targetSession.trim() } : {}),
        ...(input.barrier?.trim() ? { deliveryBarrier: input.barrier.trim() as never } : {}),
      };
    case "send_session_event":
      if (!input.message?.trim()) {
        fail("--message is required for send_session_event");
      }
      return {
        message: input.message.trim(),
        ...(input.targetSession?.trim() ? { sessionName: input.targetSession.trim() } : {}),
        ...(input.barrier?.trim() ? { deliveryBarrier: input.barrier.trim() as never } : {}),
      };
    case "append_history": {
      if (!input.message?.trim()) {
        fail("--message is required for append_history");
      }
      const normalizedRole = input.role?.trim();
      if (normalizedRole && normalizedRole !== "user" && normalizedRole !== "assistant") {
        fail("Invalid --role. Valid: user, assistant");
      }
      return {
        message: input.message.trim(),
        ...(input.targetSession?.trim() ? { sessionName: input.targetSession.trim() } : {}),
        ...(normalizedRole ? { role: normalizedRole as HookHistoryRole } : {}),
      };
    }
    case "comment_task":
      if (!input.message?.trim()) {
        fail("--message is required for comment_task");
      }
      return {
        body: input.message.trim(),
        ...(input.targetTask?.trim() ? { taskId: input.targetTask.trim() } : {}),
      };
  }
}

function formatScope(hook: HookRecord): string {
  return hook.scopeValue ? `${hook.scopeType}:${hook.scopeValue}` : hook.scopeType;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function serializeHook(hook: HookRecord) {
  return {
    ...hook,
    scope: formatScope(hook),
    cooldownDescription: formatDurationMs(hook.cooldownMs),
  };
}

@Group({
  name: "hooks",
  description: "Generic runtime hooks",
  scope: "open",
})
export class HooksCommands {
  @Command({ name: "list", description: "List configured hooks" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const hooks = dbListHooks();
    const payload = { total: hooks.length, hooks: hooks.map(serializeHook) };

    if (asJson) {
      printJson(payload);
    } else if (hooks.length === 0) {
      console.log("\nNo hooks configured.\n");
      console.log("Usage:");
      console.log(
        '  ravi hooks create "workspace bridge" --event FileChanged --workspace /path --action inject_context --message "..."',
      );
      console.log(
        '  ravi hooks create "observer" --event PostToolUse --matcher "Write|Edit" --action append_history --message "{{toolName}} -> {{path}}" --async',
      );
    } else {
      console.log("\nRuntime Hooks:\n");
      console.log("  ID        NAME                      ENABLED  EVENT         SCOPE                   ACTION");
      console.log(
        "  --------  ------------------------  -------  ------------  ----------------------  -----------------",
      );
      for (const hook of hooks) {
        const id = hook.id.padEnd(8);
        const name = hook.name.slice(0, 24).padEnd(24);
        const enabled = (hook.enabled ? "yes" : "no").padEnd(7);
        const event = hook.eventName.padEnd(12);
        const scope = formatScope(hook).slice(0, 22).padEnd(22);
        const action = hook.actionType;
        console.log(`  ${id}  ${name}  ${enabled}  ${event}  ${scope}  ${action}`);
      }
      console.log(`\n  Total: ${hooks.length} hooks`);
      console.log("\nUsage:");
      console.log("  ravi hooks show <id>");
      console.log("  ravi hooks test <id>");
      console.log("  ravi hooks enable <id>");
      console.log("  ravi hooks disable <id>");
      console.log("  ravi hooks rm <id>");
    }
    return payload;
  }

  @Command({ name: "show", description: "Show hook details" })
  show(
    @Arg("id", { description: "Hook ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const hook = dbGetHook(id);
    if (!hook) {
      fail(`Hook not found: ${id}`);
    }

    const payload = { hook: serializeHook(hook) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nHook: ${hook.name}\n`);
      console.log(`  ID:              ${hook.id}`);
      console.log(`  Event:           ${hook.eventName}`);
      console.log(`  Scope:           ${formatScope(hook)}`);
      console.log(`  Matcher:         ${hook.matcher ?? "(none)"}`);
      console.log(`  Action:          ${hook.actionType}`);
      console.log(`  Enabled:         ${hook.enabled ? "yes" : "no"}`);
      console.log(`  Async:           ${hook.async ? "yes" : "no"}`);
      console.log(`  Cooldown:        ${formatDurationMs(hook.cooldownMs)}`);
      console.log(`  Dedupe key:      ${hook.dedupeKey ?? "(none)"}`);
      console.log(`  Fire count:      ${hook.fireCount}`);
      if (hook.lastFiredAt) {
        console.log(`  Last fired:      ${new Date(hook.lastFiredAt).toLocaleString()}`);
      }
      if (hook.lastDedupeKey) {
        console.log(`  Last dedupe:     ${hook.lastDedupeKey}`);
      }
      console.log(`  Created:         ${new Date(hook.createdAt).toLocaleString()}`);
      console.log("");
      console.log("  Action payload:");
      console.log(`    ${JSON.stringify(hook.actionPayload, null, 2).split("\n").join("\n    ")}`);
    }
    return payload;
  }

  @Command({ name: "create", description: "Create a new runtime hook", aliases: ["add"] })
  async create(
    @Arg("name", { description: "Hook name" }) name: string,
    @Option({ flags: "--event <name>", description: `Event: ${HOOK_EVENT_NAMES.join(", ")}` }) event?: string,
    @Option({ flags: "--action <name>", description: `Action: ${HOOK_ACTION_TYPES.join(", ")}` }) action?: string,
    @Option({ flags: "--matcher <pattern>", description: "Optional matcher (tool name, path, session, etc)" })
    matcher?: string,
    @Option({ flags: "--scope <type>", description: `Scope: ${HOOK_SCOPE_TYPES.join(", ")}` }) scope?: string,
    @Option({ flags: "--agent <id>", description: "Agent scope value" }) agent?: string,
    @Option({ flags: "--session <name>", description: "Session scope value" }) session?: string,
    @Option({ flags: "--workspace <path>", description: "Workspace scope value" }) workspace?: string,
    @Option({ flags: "--task <id>", description: "Task scope value" }) task?: string,
    @Option({ flags: "--message <text>", description: "Action message/body template" }) message?: string,
    @Option({ flags: "--target-session <name>", description: "Target session for action payload" })
    targetSession?: string,
    @Option({ flags: "--target-task <id>", description: "Target task for comment_task payload" }) targetTask?: string,
    @Option({ flags: "--role <role>", description: "append_history role: user or assistant" }) role?: string,
    @Option({ flags: "--barrier <barrier>", description: "Delivery barrier for prompt actions" }) barrier?: string,
    @Option({ flags: "--cooldown <duration>", description: "Cooldown (e.g. 5s, 1m)" }) cooldown?: string,
    @Option({ flags: "--dedupe-key <template>", description: "Optional dedupe template" }) dedupeKey?: string,
    @Option({ flags: "--async", description: "Run hook action asynchronously" }) asyncMode?: boolean,
    @Option({ flags: "--disabled", description: "Create hook disabled" }) disabled?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const eventName = normalizeEventName(event);
    const actionType = normalizeActionType(action);
    const scopeType = inferScopeType({ scope, agent, session, workspace, task });
    const scopeValue = resolveScopeValue(scopeType, { scope, agent, session, workspace, task });
    if (scopeType !== "global" && !scopeValue) {
      fail(`Scope ${scopeType} requires a value.`);
    }

    let cooldownMs = 0;
    if (cooldown?.trim()) {
      cooldownMs = parseDurationMs(cooldown.trim());
    }

    const input: HookInput = {
      name,
      eventName,
      scopeType,
      ...(scopeValue ? { scopeValue } : {}),
      ...(matcher?.trim() ? { matcher: matcher.trim() } : {}),
      actionType,
      actionPayload: buildActionPayload(actionType, {
        message,
        targetSession,
        targetTask,
        role,
        barrier,
      }),
      enabled: disabled !== true,
      async: asyncMode === true,
      cooldownMs,
      ...(dedupeKey?.trim() ? { dedupeKey: dedupeKey.trim() } : {}),
    };

    const created = dbCreateHook(input);
    await emitHookRefresh();

    const payload = {
      status: "created" as const,
      target: { type: "hook" as const, id: created.id },
      changedCount: 1,
      hook: serializeHook(created),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\n✓ Created hook: ${created.id}`);
      console.log(`  Name:       ${created.name}`);
      console.log(`  Event:      ${created.eventName}`);
      console.log(`  Scope:      ${formatScope(created)}`);
      console.log(`  Action:     ${created.actionType}`);
      console.log(`  Cooldown:   ${formatDurationMs(created.cooldownMs)}`);
    }
    return payload;
  }

  @Command({ name: "enable", description: "Enable a hook" })
  async enable(
    @Arg("id", { description: "Hook ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const hook = dbGetHook(id);
    if (!hook) {
      fail(`Hook not found: ${id}`);
    }
    const updated = dbUpdateHook(id, { enabled: true });
    await emitHookRefresh();
    const payload = {
      status: "enabled" as const,
      target: { type: "hook" as const, id },
      changedCount: 1,
      hook: serializeHook(updated),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Enabled hook: ${id} (${hook.name})`);
    }
    return payload;
  }

  @Command({ name: "disable", description: "Disable a hook" })
  async disable(
    @Arg("id", { description: "Hook ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const hook = dbGetHook(id);
    if (!hook) {
      fail(`Hook not found: ${id}`);
    }
    const updated = dbUpdateHook(id, { enabled: false });
    await emitHookRefresh();
    const payload = {
      status: "disabled" as const,
      target: { type: "hook" as const, id },
      changedCount: 1,
      hook: serializeHook(updated),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Disabled hook: ${id} (${hook.name})`);
    }
    return payload;
  }

  @Command({
    name: "rm",
    description: "Delete a hook",
    aliases: ["delete", "remove"],
  })
  async remove(
    @Arg("id", { description: "Hook ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const hook = dbGetHook(id);
    if (!hook) {
      fail(`Hook not found: ${id}`);
    }
    dbDeleteHook(id);
    await emitHookRefresh();
    const payload = {
      status: "deleted" as const,
      target: { type: "hook" as const, id },
      changedCount: 1,
      hook: serializeHook(hook),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Deleted hook: ${id} (${hook.name})`);
    }
    return payload;
  }

  @Command({ name: "test", description: "Execute a hook once with a synthetic event" })
  async test(
    @Arg("id", { description: "Hook ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw execution result" }) asJson?: boolean,
  ) {
    const result = await runHookById(id);
    if (asJson) {
      printJson(result);
    } else {
      console.log(`✓ Tested hook: ${result.hookId}`);
      if (result.skipped) {
        console.log(`  Skipped: ${result.skipped}${result.detail ? ` (${result.detail})` : ""}`);
      } else {
        console.log(`  Event: ${result.eventName}`);
      }
    }
    return result;
  }
}
