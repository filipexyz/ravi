import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { getSession, getSessionByName } from "../../router/index.js";
import {
  dbDeleteObserverRule,
  dbGetObserverBinding,
  dbGetObserverRule,
  dbListObserverBindings,
  dbListObserverRules,
  dbSetObserverRuleEnabled,
  dbUpsertObserverRule,
  ensureObserverBindingsForSession,
  explainObserverRulesForSession,
  validateObserverRules,
  type ObservationDeliveryPolicy,
  type ObserverMode,
  type ObserverRuleInput,
  type ObserverScope,
  type ObserverTagTargetType,
} from "../../runtime/observation-plane.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseCsv(value?: string): string[] | undefined {
  const values = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : undefined;
}

function parseJsonObject(value?: string): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("Metadata must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`Invalid metadata JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value.trim())) {
    fail(`${label} must be an integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${label} must be a safe integer.`);
  }
  return parsed;
}

function parseClearableText(value?: string): string | null | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized === "clear" ? null : normalized;
}

function sessionKeyForNameOrKey(value?: string): {
  sessionKey?: string;
  sessionName?: string;
} {
  const target = value?.trim();
  if (!target) return {};
  const session = getSessionByName(target) ?? getSession(target);
  if (!session) fail(`Session not found: ${target}`);
  return {
    sessionKey: session.sessionKey,
    sessionName: session.name ?? session.sessionKey,
  };
}

function serializeRule(rule: ReturnType<typeof dbListObserverRules>[number]): Record<string, unknown> {
  return {
    id: rule.id,
    enabled: rule.enabled,
    scope: rule.scope,
    priority: rule.priority,
    observerRole: rule.observerRole,
    observerAgentId: rule.observerAgentId,
    observerRuntimeProviderId: rule.observerRuntimeProviderId ?? null,
    observerModel: rule.observerModel ?? null,
    observerMode: rule.observerMode,
    eventTypes: rule.eventTypes,
    deliveryPolicy: rule.deliveryPolicy,
    debounceMs: rule.debounceMs ?? null,
    sourceAgentId: rule.sourceAgentId ?? null,
    sourceSession: rule.sourceSession ?? null,
    sourceTaskId: rule.sourceTaskId ?? null,
    sourceProfileId: rule.sourceProfileId ?? null,
    sourceProjectId: rule.sourceProjectId ?? null,
    tagTargetType: rule.tagTargetType ?? null,
    tagSlug: rule.tagSlug ?? null,
    tagInherited: rule.tagInherited,
    permissionGrants: rule.permissionGrants,
    metadata: rule.metadata ?? null,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function serializeBinding(binding: ReturnType<typeof dbListObserverBindings>[number]): Record<string, unknown> {
  return {
    id: binding.id,
    sourceSessionKey: binding.sourceSessionKey,
    sourceSessionName: binding.sourceSessionName ?? null,
    sourceAgentId: binding.sourceAgentId,
    observerSessionName: binding.observerSessionName,
    observerAgentId: binding.observerAgentId,
    observerRuntimeProviderId: binding.observerRuntimeProviderId ?? null,
    observerModel: binding.observerModel ?? null,
    observerRole: binding.observerRole,
    observerMode: binding.observerMode,
    ruleId: binding.ruleId,
    eventTypes: binding.eventTypes,
    deliveryPolicy: binding.deliveryPolicy,
    permissionGrants: binding.permissionGrants,
    metadata: binding.metadata ?? null,
    enabled: binding.enabled,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    lastDeliveredAt: binding.lastDeliveredAt ?? null,
  };
}

function printBinding(binding: ReturnType<typeof dbListObserverBindings>[number]): void {
  console.log(`${binding.enabled ? "✓" : "✗"} ${binding.id}`);
  console.log(`  Source:   ${binding.sourceSessionName ?? binding.sourceSessionKey} (${binding.sourceAgentId})`);
  console.log(`  Observer: ${binding.observerSessionName} (${binding.observerAgentId})`);
  console.log(
    `  Runtime:  ${binding.observerRuntimeProviderId ?? "(agent provider)"} / ${binding.observerModel ?? "(agent model)"}`,
  );
  console.log(`  Role:     ${binding.observerRole} :: ${binding.observerMode}`);
  console.log(`  Rule:     ${binding.ruleId}`);
  console.log(`  Events:   ${binding.eventTypes.join(", ")}`);
}

function printRule(rule: ReturnType<typeof dbListObserverRules>[number]): void {
  console.log(`${rule.enabled ? "✓" : "✗"} ${rule.id}`);
  console.log(`  Scope:    ${rule.scope}`);
  console.log(`  Observer: ${rule.observerAgentId} :: ${rule.observerRole} :: ${rule.observerMode}`);
  console.log(
    `  Runtime:  ${rule.observerRuntimeProviderId ?? "(agent provider)"} / ${rule.observerModel ?? "(agent model)"}`,
  );
  console.log(`  Delivery: ${rule.deliveryPolicy}`);
  console.log(`  Events:   ${rule.eventTypes.join(", ")}`);
  const selectors = [
    rule.sourceAgentId ? `agent=${rule.sourceAgentId}` : null,
    rule.sourceSession ? `session=${rule.sourceSession}` : null,
    rule.sourceTaskId ? `task=${rule.sourceTaskId}` : null,
    rule.sourceProfileId ? `profile=${rule.sourceProfileId}` : null,
    rule.sourceProjectId ? `project=${rule.sourceProjectId}` : null,
    rule.tagSlug ? `tag=${rule.tagTargetType ?? "any"}:${rule.tagSlug}` : null,
  ].filter(Boolean);
  console.log(`  Match:    ${selectors.join(" | ") || "(all matching scope)"}`);
}

@Group({
  name: "observers",
  description: "Inspect Observation Plane bindings",
  scope: "admin",
})
export class ObserverCommands {
  @Command({ name: "list", description: "List session observer bindings" })
  list(
    @Option({
      flags: "--session <name>",
      description: "Filter by source session name/key",
    })
    sessionName?: string,
    @Option({
      flags: "--agent <id>",
      description: "Filter by observer agent id",
    })
    observerAgentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const session = sessionKeyForNameOrKey(sessionName);
    const bindings = dbListObserverBindings({
      ...(session.sessionKey ? { sourceSessionKey: session.sessionKey } : {}),
      ...(observerAgentId?.trim() ? { observerAgentId: observerAgentId.trim() } : {}),
    });
    const payload = {
      total: bindings.length,
      bindings: bindings.map(serializeBinding),
    };
    if (asJson) {
      printJson(payload);
    } else if (bindings.length === 0) {
      console.log("\nNo observer bindings found.\n");
    } else {
      console.log(`\nObserver bindings (${bindings.length}):\n`);
      for (const binding of bindings) {
        printBinding(binding);
        console.log("");
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one observer binding" })
  show(
    @Arg("bindingId", { description: "Observer binding id" }) bindingId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const binding = dbGetObserverBinding(bindingId);
    if (!binding) fail(`Observer binding not found: ${bindingId}`);
    const payload = { binding: serializeBinding(binding) };
    if (asJson) {
      printJson(payload);
    } else {
      printBinding(binding);
    }
    return payload;
  }

  @Command({
    name: "refresh",
    description: "Apply observer rules to an existing source session",
  })
  refresh(
    @Arg("session", { description: "Source session name or key" })
    sessionName: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const session = getSessionByName(sessionName) ?? getSession(sessionName);
    if (!session) fail(`Session not found: ${sessionName}`);
    const result = ensureObserverBindingsForSession({
      sessionName: session.name ?? sessionName,
      session,
    });
    const payload = {
      source: result.source,
      total: result.bindings.length,
      created: result.created.map(serializeBinding),
      bindings: result.bindings.map(serializeBinding),
      skipped: result.skipped,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(
        `Refreshed observer bindings for ${session.name ?? sessionName}: ${result.bindings.length} total, ${result.created.length} created.`,
      );
    }
    return payload;
  }
}

@Group({
  name: "observers.rules",
  description: "Manage Observation Plane rules",
  scope: "admin",
})
export class ObserverRuleCommands {
  @Command({ name: "list", description: "List observer rules" })
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const rules = dbListObserverRules();
    const payload = { total: rules.length, rules: rules.map(serializeRule) };
    if (asJson) {
      printJson(payload);
    } else if (rules.length === 0) {
      console.log("\nNo observer rules configured.\n");
    } else {
      console.log(`\nObserver rules (${rules.length}):\n`);
      for (const rule of rules) {
        printRule(rule);
        console.log("");
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one observer rule" })
  show(
    @Arg("id", { description: "Observer rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const rule = dbGetObserverRule(id);
    if (!rule) fail(`Observer rule not found: ${id}`);
    const payload = { rule: serializeRule(rule) };
    if (asJson) {
      printJson(payload);
    } else {
      printRule(rule);
    }
    return payload;
  }

  @Command({ name: "set", description: "Create or overwrite an observer rule" })
  set(
    @Arg("id", { description: "Observer rule id" }) id: string,
    @Arg("observerAgentId", {
      description: "Agent id for the observer session",
    })
    observerAgentId: string,
    @Option({
      flags: "--role <role>",
      description: "Observer role. Defaults to rule id.",
    })
    observerRole?: string,
    @Option({
      flags: "--scope <scope>",
      description: "global|agent|session|task|profile|project|tag",
    })
    scope?: string,
    @Option({ flags: "--mode <mode>", description: "observe|summarize|report" })
    observerMode?: string,
    @Option({
      flags: "--provider <id>",
      description: "Runtime provider id for observer execution; use 'clear' to inherit the observer agent provider",
    })
    observerRuntimeProviderId?: string,
    @Option({
      flags: "--model <model>",
      description: "Runtime model for observer execution; use 'clear' to inherit the observer agent model",
    })
    observerModel?: string,
    @Option({
      flags: "--events <csv>",
      description: "Comma-separated observation event types",
    })
    eventTypesCsv?: string,
    @Option({
      flags: "--delivery <policy>",
      description: "realtime|debounce|end_of_turn|manual",
    })
    deliveryPolicy?: string,
    @Option({ flags: "--priority <n>", description: "Lower priority wins" })
    priorityStr?: string,
    @Option({
      flags: "--source-agent <id>",
      description: "Match source agent id",
    })
    sourceAgentId?: string,
    @Option({
      flags: "--source-session <name>",
      description: "Match source session name/key",
    })
    sourceSession?: string,
    @Option({
      flags: "--source-task <id>",
      description: "Match source task id",
    })
    sourceTaskId?: string,
    @Option({
      flags: "--source-profile <id>",
      description: "Match source task profile id",
    })
    sourceProfileId?: string,
    @Option({
      flags: "--source-project <id>",
      description: "Match source project id",
    })
    sourceProjectId?: string,
    @Option({
      flags: "--tag <slug>",
      description: "Match tag slug for scope=tag",
    })
    tagSlug?: string,
    @Option({
      flags: "--tag-target <type>",
      description: "agent|session|task|project|contact|profile|any",
    })
    tagTargetType?: string,
    @Option({
      flags: "--tag-inherited",
      description: "Allow inherited tag matching",
    })
    tagInherited?: boolean,
    @Option({
      flags: "--permissions <csv>",
      description: "Comma-separated permission grants for observer",
    })
    permissionsCsv?: string,
    @Option({
      flags: "--meta <json>",
      description: "Free JSON metadata for the rule",
    })
    metadataJson?: string,
    @Option({ flags: "--disabled", description: "Create rule disabled" })
    disabled?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const parsedObserverRuntimeProviderId = parseClearableText(observerRuntimeProviderId);
    const parsedObserverModel = parseClearableText(observerModel);
    const parsedEventTypes = parseCsv(eventTypesCsv);
    const parsedPriority = parseInteger(priorityStr, "priority");
    const parsedPermissions = parseCsv(permissionsCsv);
    const parsedMetadata = parseJsonObject(metadataJson);
    const input: ObserverRuleInput = {
      id,
      observerAgentId,
      ...(observerRole?.trim() ? { observerRole } : {}),
      ...(scope?.trim() ? { scope: scope.trim() as ObserverScope } : {}),
      ...(observerMode?.trim() ? { observerMode: observerMode.trim() as ObserverMode } : {}),
      ...(parsedObserverRuntimeProviderId !== undefined
        ? { observerRuntimeProviderId: parsedObserverRuntimeProviderId }
        : {}),
      ...(parsedObserverModel !== undefined ? { observerModel: parsedObserverModel } : {}),
      ...(parsedEventTypes ? { eventTypes: parsedEventTypes } : {}),
      ...(deliveryPolicy?.trim() ? { deliveryPolicy: deliveryPolicy.trim() as ObservationDeliveryPolicy } : {}),
      ...(parsedPriority !== undefined ? { priority: parsedPriority } : {}),
      ...(sourceAgentId?.trim() ? { sourceAgentId } : {}),
      ...(sourceSession?.trim() ? { sourceSession } : {}),
      ...(sourceTaskId?.trim() ? { sourceTaskId } : {}),
      ...(sourceProfileId?.trim() ? { sourceProfileId } : {}),
      ...(sourceProjectId?.trim() ? { sourceProjectId } : {}),
      ...(tagSlug?.trim() ? { tagSlug: tagSlug.trim().toLowerCase() } : {}),
      ...(tagTargetType?.trim() ? { tagTargetType: tagTargetType.trim() as ObserverTagTargetType } : {}),
      ...(tagInherited ? { tagInherited: true } : {}),
      ...(parsedPermissions ? { permissionGrants: parsedPermissions } : {}),
      ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
      ...(disabled === true ? { enabled: false } : {}),
    };
    const rule = dbUpsertObserverRule(input);
    const payload = { success: true, rule: serializeRule(rule) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`Set observer rule: ${rule.id}`);
    }
    return payload;
  }

  @Command({ name: "enable", description: "Enable an observer rule" })
  enable(
    @Arg("id", { description: "Observer rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const rule = dbSetObserverRuleEnabled(id, true);
    const payload = { success: true, rule: serializeRule(rule) };
    if (asJson) printJson(payload);
    else console.log(`Enabled observer rule: ${id}`);
    return payload;
  }

  @Command({ name: "disable", description: "Disable an observer rule" })
  disable(
    @Arg("id", { description: "Observer rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const rule = dbSetObserverRuleEnabled(id, false);
    const payload = { success: true, rule: serializeRule(rule) };
    if (asJson) printJson(payload);
    else console.log(`Disabled observer rule: ${id}`);
    return payload;
  }

  @Command({ name: "rm", description: "Delete an observer rule" })
  rm(
    @Arg("id", { description: "Observer rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const deleted = dbDeleteObserverRule(id);
    if (!deleted) fail(`Observer rule not found: ${id}`);
    const payload = { success: true, deleted };
    if (asJson) printJson(payload);
    else console.log(`Deleted observer rule: ${id}`);
    return payload;
  }

  @Command({ name: "validate", description: "Validate observer rules" })
  validate(
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const result = validateObserverRules();
    if (asJson) {
      printJson(result);
    } else if (result.ok) {
      console.log("Observer rules OK.");
    } else {
      console.log("\nObserver rule errors:\n");
      for (const error of result.errors) console.log(`- ${error.ruleId}: ${error.message}`);
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  @Command({
    name: "explain",
    description: "Explain observer rule matching for a source session",
  })
  explain(
    @Arg("session", { description: "Source session name or key" })
    sessionName: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const explanation = explainObserverRulesForSession(sessionName);
    if (!explanation.source) fail(`Session not found: ${sessionName}`);
    const payload = {
      source: explanation.source,
      rules: explanation.rules.map((item) => ({
        matched: item.matched,
        reason: item.reason,
        rule: serializeRule(item.rule),
      })),
      bindings: explanation.bindings.map(serializeBinding),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nObserver rule explain: ${explanation.source.sessionName}\n`);
      console.log(`Source agent: ${explanation.source.agentId}`);
      console.log(`Tags: ${explanation.source.tags.map((tag) => `${tag.targetType}:${tag.slug}`).join(", ") || "-"}`);
      console.log("\nRules:");
      for (const item of explanation.rules) {
        console.log(`  ${item.matched ? "✓" : "✗"} ${item.rule.id} :: ${item.reason}`);
      }
      console.log(`\nBindings: ${explanation.bindings.length}`);
    }
    return payload;
  }
}
