/**
 * Instances Commands - Central config entity for all channels/accounts
 *
 * ravi instances list
 * ravi instances show <name>
 * ravi instances create <name> [--channel whatsapp] [--agent main]
 * ravi instances set <name> <key> <value>
 * ravi instances get <name> <key>
 * ravi instances enable <name-or-instanceId>
 * ravi instances disable <name-or-instanceId>
 * ravi instances connect <name> [--channel whatsapp]
 * ravi instances disconnect <name>
 * ravi instances status <name>
 * ravi routes list [name]
 * ravi routes show <name> <pattern>
 * ravi routes explain <name> <pattern> [--channel whatsapp]
 * ravi instances routes list <name>
 * ravi instances routes add <name> <pattern> <agent> [--policy open|closed|...] [--priority N] [--session s] [--dm-scope s]
 * ravi instances routes remove <name> <pattern>
 * ravi instances routes set <name> <pattern> <key> <value>
 * ravi instances routes show <name> <pattern>
 * ravi instances pending list <name>
 * ravi instances pending approve <name> <contact>
 * ravi instances pending reject <name> <contact>
 */

import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import qrcode from "qrcode-terminal";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { nats } from "../../nats.js";
import { createOmniClient } from "../../omni/client.js";
import {
  dbGetInstance,
  dbGetInstanceByInstanceId,
  dbListInstances,
  dbUpsertInstance,
  dbUpdateInstance,
  dbDeleteInstance,
  dbRestoreInstance,
  dbListDeletedInstances,
  dbGetAgent,
  dbCreateAgent,
  dbListAgents,
  dbGetRoute,
  dbListRoutes,
  dbCreateRoute,
  dbUpdateRoute,
  dbDeleteRoute,
  dbRestoreRoute,
  dbListDeletedRoutes,
  DmScopeSchema,
  DmPolicySchema,
  GroupPolicySchema,
  dbGetSetting,
  dbSetSetting,
} from "../../router/router-db.js";
import { loadRouterConfig, matchRoute } from "../../router/index.js";
import {
  IGNORED_OMNI_INSTANCE_IDS_SETTING,
  parseIgnoredOmniInstanceIds,
  serializeIgnoredOmniInstanceIds,
} from "../../router/omni-ignore.js";
import { resolveOmniConnection } from "../../omni-config.js";
import {
  getContact,
  listAccountPending,
  removeAccountPending,
  allowContact,
  type AccountPendingEntry,
} from "../../contacts.js";
import { listSessions, deleteSession } from "../../router/sessions.js";
import { formatCliRuntimeTarget, getCliRuntimeMismatchMessage, inspectCliRuntimeTarget } from "../runtime-target.js";
import { formatInspectionSection, printInspectionField } from "../inspection-output.js";

const CONFIG_DB_META = { source: "config-db", freshness: "persisted" } as const;
const LIVE_OMNI_META = { source: "live-omni", freshness: "live" } as const;
type ListedRoute = ReturnType<typeof dbListRoutes>[number];
type OmniInstanceStatus = { isConnected?: boolean; profileName?: string; state?: string };

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

function parseEnabledValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "on", "open", "enabled"].includes(normalized)) return true;
  if (["false", "0", "off", "closed", "disabled"].includes(normalized)) return false;
  fail(`Invalid enabled value: ${value}. Valid: true, false`);
}

function getIgnoredOmniInstanceIds(): string[] {
  return parseIgnoredOmniInstanceIds(dbGetSetting(IGNORED_OMNI_INSTANCE_IDS_SETTING));
}

function saveIgnoredOmniInstanceIds(instanceIds: Iterable<string>): void {
  dbSetSetting(IGNORED_OMNI_INSTANCE_IDS_SETTING, serializeIgnoredOmniInstanceIds(instanceIds));
  emitConfigChanged();
}

function resolveInstanceByNameOrId(value: string) {
  return dbGetInstance(value) ?? dbGetInstanceByInstanceId(value);
}

function requireInstance(name: string) {
  const instance = dbGetInstance(name);
  if (!instance) fail(`Instance not found: ${name}`);
  return instance;
}

function printInstanceMutationTarget(name: string): void {
  const summary = inspectCliRuntimeTarget(name);
  for (const line of formatCliRuntimeTarget(summary)) {
    console.log(line);
  }
}

function assertInstanceMutationRuntime(name: string, allowRuntimeMismatch?: boolean): void {
  const summary = inspectCliRuntimeTarget(name);
  const mismatch = getCliRuntimeMismatchMessage(summary);
  if (mismatch && !allowRuntimeMismatch) {
    fail(
      `${mismatch}\nTarget instance: ${name}\nRe-run with the repo CLI/runtime or pass --allow-runtime-mismatch if you really mean it.`,
    );
  }
}

function inspectRouteLiveWinner(
  name: string,
  pattern: string,
  channel?: string,
): { winningPattern: string; winningAgent: string } | null {
  const config = loadRouterConfig();

  if (pattern.startsWith("group:")) {
    const groupId = pattern.slice("group:".length);
    const resolved = matchRoute(config, {
      phone: groupId,
      groupId,
      isGroup: true,
      accountId: name,
      ...(channel ? { channel } : {}),
    });

    if (!resolved) {
      return null;
    }

    return {
      winningPattern: resolved.route?.pattern ?? "(instance default)",
      winningAgent: resolved.agentId,
    };
  }

  if (!pattern.includes("*") && /^\d+$/.test(pattern)) {
    const resolved = matchRoute(config, {
      phone: pattern,
      accountId: name,
      ...(channel ? { channel } : {}),
    });

    if (!resolved) {
      return null;
    }

    return {
      winningPattern: resolved.route?.pattern ?? "(instance default)",
      winningAgent: resolved.agentId,
    };
  }

  return null;
}

function getRouteLiveEffect(name: string, pattern: string, expectedAgent?: string, channel?: string) {
  const winner = inspectRouteLiveWinner(name, pattern, channel);
  if (!winner) {
    const exactPattern = pattern.startsWith("group:") || (!pattern.includes("*") && /^\d+$/.test(pattern));
    return {
      status: exactPattern ? "unresolved" : "skipped_broad_pattern",
      verified: false,
      winningPattern: null,
      winningAgent: null,
    };
  }

  const verified = expectedAgent ? winner.winningPattern === pattern && winner.winningAgent === expectedAgent : false;
  return {
    status: expectedAgent ? (verified ? "verified" : "different_winner") : "matched",
    verified,
    winningPattern: winner.winningPattern,
    winningAgent: winner.winningAgent,
  };
}

function printRouteLiveEffect(name: string, pattern: string, expectedAgent: string, channel?: string): void {
  const effect = getRouteLiveEffect(name, pattern, expectedAgent, channel);
  if (effect.status === "unresolved") {
    console.log(`  Live effect:   unresolved for ${pattern} on instance ${name}`);
    return;
  }
  if (effect.status === "skipped_broad_pattern") {
    console.log(`  Live effect:   broad pattern — exact winner check skipped for ${pattern}`);
    return;
  }

  console.log(`  Live effect:   ${effect.verified ? "verified" : "different winner"}`);
  console.log(`  Winning route: ${effect.winningPattern}`);
  console.log(`  Winning agent: ${effect.winningAgent}`);
}

function getRouteStatusIcon(pattern: string): string {
  const contact = getContact(pattern);
  if (!contact) return "\x1b[33m?\x1b[0m";
  if (contact.status === "allowed") return "\x1b[32m✓\x1b[0m";
  if (contact.status === "blocked") return "\x1b[31m✗\x1b[0m";
  return "\x1b[36m○\x1b[0m";
}

function printRouteTable(routes: ListedRoute[], includeInstanceColumn: boolean): void {
  if (includeInstanceColumn) {
    console.log(
      "  INSTANCE         ST  PATTERN                              AGENT           POLICY       PRI  SESSION",
    );
    console.log(
      "  ---------------- --  -----------------------------------  --------------  -----------  ---  -------",
    );
  } else {
    console.log("  ST  PATTERN                              AGENT           POLICY       PRI  SESSION");
    console.log("  --  -----------------------------------  --------------  -----------  ---  -------");
  }

  for (const route of routes) {
    const statusIcon = getRouteStatusIcon(route.pattern);
    const policy = route.policy ?? "-";
    const session = route.session ?? "-";
    const channelLabel = route.channel ? ` [${route.channel}]` : "";
    if (includeInstanceColumn) {
      console.log(
        `  ${route.accountId.padEnd(16)} ${statusIcon}   ${route.pattern.padEnd(35)} ${route.agent.padEnd(14)}  ${policy.padEnd(11)}  ${String(route.priority ?? 0).padEnd(3)}  ${session}${channelLabel}`,
      );
      continue;
    }

    console.log(
      `  ${statusIcon}   ${route.pattern.padEnd(35)} ${route.agent.padEnd(14)}  ${policy.padEnd(11)}  ${String(route.priority ?? 0).padEnd(3)}  ${session}${channelLabel}`,
    );
  }
}

function printRouteList(name?: string): void {
  if (name) {
    requireInstance(name);
    const routes = dbListRoutes(name);

    if (routes.length === 0) {
      console.log(`No routes for instance "${name}".`);
      console.log(`\nAdd a route: ravi instances routes add ${name} <pattern> <agent>`);
      return;
    }

    console.log(`\nRoutes for: ${name}\n`);
    printRouteTable(routes, false);
    console.log(`\n  Total: ${routes.length}`);
    console.log(`  Show one: ravi routes show ${name} "<pattern>"`);
    console.log(`  Explain:  ravi routes explain ${name} "<pattern>"`);
    console.log(`  Mutate:   ravi instances routes set ${name} "<pattern>" <key> <value>`);
    return;
  }

  const routes = dbListRoutes();
  if (routes.length === 0) {
    console.log("No routes configured.");
    console.log(`\nAdd one: ravi instances routes add <instance> <pattern> <agent>`);
    return;
  }

  console.log("\nRoutes across all instances:\n");
  printRouteTable(routes, true);
  console.log(`\n  Total: ${routes.length}`);
  console.log(`  Show one: ravi routes show <instance> "<pattern>"`);
  console.log(`  Explain:  ravi routes explain <instance> "<pattern>"`);
  console.log(`  Mutate:   ravi instances routes add <instance> <pattern> <agent>`);
}

function buildRouteListPayload(name?: string) {
  if (name) {
    requireInstance(name);
  }
  const routes = dbListRoutes(name);
  return {
    instance: name ?? null,
    total: routes.length,
    routes,
  };
}

function printRouteDetails(name: string, pattern: string): void {
  requireInstance(name);
  const route = dbGetRoute(pattern, name);
  if (!route) fail(`Route not found: ${pattern} (instance: ${name})`);

  console.log(`\nRoute: ${route.pattern} (instance: ${name})\n`);
  console.log(`  Agent:     ${route.agent}`);
  console.log(`  Priority:  ${route.priority ?? 0}`);
  console.log(`  Policy:    ${route.policy ?? "(inherits from instance)"}`);
  console.log(`  DM Scope:  ${route.dmScope ?? "(inherits)"}`);
  console.log(`  Session:   ${route.session ?? "(auto)"}`);
  console.log(`  Channel:   ${route.channel ?? "(all channels)"}`);
  console.log(`\n  Explain live routing: ravi routes explain ${name} "${pattern}"`);
  console.log(`  Mutate config:        ravi instances routes set ${name} "${pattern}" <key> <value>`);
}

function buildRouteDetailsPayload(name: string, pattern: string) {
  requireInstance(name);
  const route = dbGetRoute(pattern, name);
  if (!route) fail(`Route not found: ${pattern} (instance: ${name})`);
  return {
    instance: name,
    pattern,
    route,
  };
}

function buildRouteExplanationPayload(name: string, pattern?: string, channel?: string) {
  const target = inspectCliRuntimeTarget(name);

  if (!target.instance?.exists) {
    fail(`Instance not found: ${name}`);
  }

  if (!pattern) {
    return {
      target,
      instance: name,
      pattern: null,
      channel: channel ?? null,
      configuredRoute: null,
      liveEffect: null,
    };
  }

  const configuredRoute = dbGetRoute(pattern, name);
  if (configuredRoute) {
    return {
      target,
      instance: name,
      pattern,
      channel: channel ?? configuredRoute.channel ?? null,
      configuredRoute,
      liveEffect: getRouteLiveEffect(
        name,
        pattern,
        configuredRoute.agent,
        channel ?? configuredRoute.channel ?? undefined,
      ),
    };
  }

  const winner = inspectRouteLiveWinner(name, pattern, channel);
  return {
    target,
    instance: name,
    pattern,
    channel: channel ?? null,
    configuredRoute: null,
    liveEffect: winner
      ? {
          status: "different_winner",
          verified: false,
          winningPattern: winner.winningPattern,
          winningAgent: winner.winningAgent,
        }
      : getRouteLiveEffect(name, pattern, undefined, channel),
  };
}

function printRouteExplanation(name: string, pattern?: string, channel?: string): void {
  const summary = inspectCliRuntimeTarget(name);
  for (const line of formatCliRuntimeTarget(summary)) {
    console.log(line);
  }

  if (!summary.instance?.exists) {
    fail(`Instance not found: ${name}`);
  }

  if (!pattern) {
    console.log(`\n  Discover routes: ravi routes list ${name}`);
    console.log(`  Explain one:     ravi routes explain ${name} "<pattern>"`);
    return;
  }

  const configuredRoute = dbGetRoute(pattern, name);
  if (configuredRoute) {
    console.log(`  Config route:  ${configuredRoute.pattern} → ${configuredRoute.agent}`);
    printRouteLiveEffect(name, pattern, configuredRoute.agent, channel ?? configuredRoute.channel ?? undefined);
    console.log(`\n  Route details: ravi routes show ${name} "${pattern}"`);
    console.log(`  Mutate config: ravi instances routes set ${name} "${pattern}" <key> <value>`);
    return;
  }

  const winner = inspectRouteLiveWinner(name, pattern, channel);
  if (!winner) {
    if (pattern.startsWith("group:") || (!pattern.includes("*") && /^\d+$/.test(pattern))) {
      console.log(`  Live effect:   unresolved for ${pattern} on instance ${name}`);
    } else {
      console.log(`  Live effect:   broad pattern — exact winner check skipped for ${pattern}`);
    }
    console.log(`\n  Route details: ravi routes show ${name} "${pattern}"`);
    console.log(`  Mutate config: ravi instances routes add ${name} "${pattern}" <agent>`);
    return;
  }

  console.log("  Config route:  (none)");
  console.log("  Live effect:   different winner");
  console.log(`  Winning route: ${winner.winningPattern}`);
  console.log(`  Winning agent: ${winner.winningAgent}`);
  console.log(`\n  Route details: ravi routes show ${name} "${pattern}"`);
  console.log(`  Mutate config: ravi instances routes add ${name} "${pattern}" <agent>`);
}

function deleteConflictingSessions(pattern: string, targetAgent: string, opts: { silent?: boolean } = {}): number {
  const sessions = listSessions();
  let deleted = 0;
  for (const session of sessions) {
    if (pattern.startsWith("group:")) {
      const groupId = pattern.replace("group:", "");
      if (session.sessionKey.includes(`group:${groupId}`) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        if (!opts.silent) console.log(`  Deleted conflicting session: ${session.sessionKey}`);
        deleted++;
      }
    } else if (pattern.startsWith("lid:")) {
      const lid = pattern.replace("lid:", "");
      if (session.sessionKey.includes(`lid:${lid}`) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        if (!opts.silent) console.log(`  Deleted conflicting session: ${session.sessionKey}`);
        deleted++;
      }
    } else if (pattern.includes("*")) {
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      const match = session.sessionKey.match(/dm:(\d+)/);
      if (match && regex.test(match[1]) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        if (!opts.silent) console.log(`  Deleted conflicting session: ${session.sessionKey}`);
        deleted++;
      }
    }
  }
  return deleted;
}

function getOmniClient() {
  const conn = resolveOmniConnection();
  if (!conn) fail("Omni not configured. Is omni running?");
  return createOmniClient({ baseUrl: conn.apiUrl, apiKey: conn.apiKey });
}

const SETTABLE_KEYS = [
  "agent",
  "dmPolicy",
  "groupPolicy",
  "dmScope",
  "instanceId",
  "channel",
  "enabled",
  "defaults",
] as const;
type SettableKey = (typeof SETTABLE_KEYS)[number];

const ROUTE_SETTABLE_KEYS = ["agent", "priority", "dmScope", "session", "policy", "channel"] as const;

// ============================================================================
// Main group
// ============================================================================

@Group({
  name: "instances",
  description: "Instance management (channels, policies, routes)",
  scope: "admin",
})
export class InstancesCommands {
  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------
  @Command({ name: "list", description: "List all instances" })
  async list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const instances = dbListInstances();
    const ignoredOmniInstanceIds = getIgnoredOmniInstanceIds();

    // Try to enrich with omni status
    const omniStatus: Record<string, OmniInstanceStatus> = {};
    try {
      const omni = getOmniClient();
      const result = await omni.instances.list({});
      for (const item of result.items as Array<{ id?: string; isActive?: boolean; profileName?: string }>) {
        if (item.id) omniStatus[item.id] = { isConnected: item.isActive, profileName: item.profileName };
      }
    } catch {
      /* omni offline */
    }

    if (asJson) {
      printJson({
        total: instances.length,
        instances: instances.map((inst) => ({
          ...inst,
          raviStatus: inst.enabled === false ? "disabled" : "enabled",
          live: inst.instanceId ? (omniStatus[inst.instanceId] ?? null) : null,
        })),
        ignoredOmniInstanceIds,
      });
      return;
    }

    if (instances.length === 0) {
      console.log("No registered instances configured.");
      if (ignoredOmniInstanceIds.length > 0) {
        console.log("\nIgnored unknown omni instanceIds:\n");
        for (const instanceId of ignoredOmniInstanceIds) {
          console.log(`  ${instanceId}`);
        }
      } else {
        console.log("\nCreate one: ravi instances create <name> --channel whatsapp");
      }
      return;
    }

    console.log("\nInstances:\n");
    console.log("  NAME                 CHANNEL       AGENT           RAVI      DM           GROUP        STATUS");
    console.log("  -------------------- ------------- --------------- --------- ------------ ------------ ----------");

    for (const inst of instances) {
      const status = inst.instanceId
        ? omniStatus[inst.instanceId]?.isConnected
          ? "connected"
          : "disconnected"
        : "no-omni-id";
      const profile = inst.instanceId ? (omniStatus[inst.instanceId]?.profileName ?? "") : "";
      const label = profile ? `${status} (${profile})` : status;
      console.log(
        `  ${inst.name.padEnd(20)} ${inst.channel.padEnd(13)} ${(inst.agent ?? "-").padEnd(15)} ${(inst.enabled === false ? "disabled" : "enabled").padEnd(9)} ${inst.dmPolicy.padEnd(12)} ${inst.groupPolicy.padEnd(12)} ${label}`,
      );
    }
    console.log(`\n  Total: ${instances.length}`);

    if (ignoredOmniInstanceIds.length > 0) {
      console.log("\nIgnored unknown omni instanceIds:\n");
      for (const instanceId of ignoredOmniInstanceIds) {
        console.log(`  ${instanceId}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // show
  // --------------------------------------------------------------------------
  @Command({ name: "show", description: "Show instance details" })
  async show(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = requireInstance(name);

    const routes = dbListRoutes(name);

    let omniInfo: OmniInstanceStatus = {};
    if (inst.instanceId) {
      try {
        const omni = getOmniClient();
        omniInfo = (await omni.instances.status(inst.instanceId)) as typeof omniInfo;
      } catch {
        /* omni offline */
      }
    }

    if (asJson) {
      printJson({
        instance: {
          ...inst,
          raviStatus: inst.enabled === false ? "disabled" : "enabled",
        },
        routes,
        live: inst.instanceId ? omniInfo : null,
      });
      return;
    }

    console.log(`\nInstance: ${inst.name}\n`);
    printInspectionField("Channel", inst.channel, CONFIG_DB_META);
    printInspectionField("Instance ID", inst.instanceId ?? "(not set)", CONFIG_DB_META);
    printInspectionField("Ravi", inst.enabled === false ? "disabled" : "enabled", CONFIG_DB_META);
    printInspectionField("Agent", inst.agent ?? "(default)", CONFIG_DB_META);
    printInspectionField("DM Policy", inst.dmPolicy, CONFIG_DB_META);
    printInspectionField("Group Policy", inst.groupPolicy, CONFIG_DB_META);
    if (inst.dmScope) printInspectionField("DM Scope", inst.dmScope, CONFIG_DB_META);
    if (inst.defaults && Object.keys(inst.defaults).length > 0) {
      printInspectionField("Defaults", JSON.stringify(inst.defaults), CONFIG_DB_META);
    }
    if (inst.instanceId) {
      printInspectionField("Connected", omniInfo.isConnected ?? "unknown", LIVE_OMNI_META);
      if (omniInfo.profileName) printInspectionField("Profile", omniInfo.profileName, LIVE_OMNI_META);
    }
    console.log(`\n${formatInspectionSection(`  Routes (${routes.length}):`, CONFIG_DB_META)}`);
    if (routes.length === 0) {
      console.log(`    (none — all messages go to agent "${inst.agent ?? "default"}")`);
    } else {
      for (const r of routes) {
        const policy = r.policy ? ` [policy:${r.policy}]` : "";
        console.log(`    ${r.pattern.padEnd(35)} → ${r.agent}${policy}  pri=${r.priority ?? 0}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------
  @Command({ name: "create", description: "Create a new instance" })
  create(
    @Arg("name", { description: "Instance name (e.g., main, vendas)" }) name: string,
    @Option({ flags: "--channel <channel>", description: "Channel type (default: whatsapp)" }) channel?: string,
    @Option({ flags: "--agent <id>", description: "Default agent for this instance" }) agent?: string,
    @Option({ flags: "--dm-policy <policy>", description: "DM policy: open|pairing|closed (default: open)" })
    dmPolicy?: string,
    @Option({ flags: "--group-policy <policy>", description: "Group policy: open|allowlist|closed (default: open)" })
    groupPolicy?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (agent && !dbGetAgent(agent)) {
      fail(
        `Agent not found: ${agent}. Available: ${dbListAgents()
          .map((a) => a.id)
          .join(", ")}`,
      );
    }
    if (dmPolicy) {
      const r = DmPolicySchema.safeParse(dmPolicy);
      if (!r.success) fail(`Invalid dmPolicy: ${dmPolicy}. Valid: open, pairing, closed`);
    }
    if (groupPolicy) {
      const r = GroupPolicySchema.safeParse(groupPolicy);
      if (!r.success) fail(`Invalid groupPolicy: ${groupPolicy}. Valid: open, allowlist, closed`);
    }
    try {
      const instance = dbUpsertInstance({
        name,
        channel: channel ?? "whatsapp",
        agent: agent ?? undefined,
        dmPolicy: (dmPolicy ?? "open") as "open" | "pairing" | "closed",
        groupPolicy: (groupPolicy ?? "open") as "open" | "allowlist" | "closed",
      });
      if (asJson) {
        printJson({
          status: "created",
          instance,
          changedCount: 1,
        });
        emitConfigChanged();
        return;
      }
      console.log(`✓ Instance created: ${name} (channel: ${channel ?? "whatsapp"})`);
      if (agent) console.log(`  Agent: ${agent}`);
      emitConfigChanged();
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------
  @Command({ name: "get", description: "Get an instance property" })
  get(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("key", { description: `Property key (${SETTABLE_KEYS.join(", ")})` }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);
    const val = (inst as unknown as Record<string, unknown>)[key];
    if (val === undefined) fail(`Unknown key: ${key}. Valid keys: ${SETTABLE_KEYS.join(", ")}`);
    if (asJson) {
      printJson({
        instance: name,
        key,
        value: val ?? null,
      });
      return;
    }
    console.log(`${name}.${key}: ${val ?? "(not set)"}`);
  }

  // --------------------------------------------------------------------------
  // set
  // --------------------------------------------------------------------------
  @Command({ name: "set", description: "Set an instance property" })
  set(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("key", { description: `Property key (${SETTABLE_KEYS.join(", ")})` }) key: string,
    @Arg("value", { description: "Property value (use '-' to clear)" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!SETTABLE_KEYS.includes(key as SettableKey)) {
      fail(`Invalid key: ${key}. Valid keys: ${SETTABLE_KEYS.join(", ")}`);
    }
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}. Create it first with: ravi instances create ${name}`);

    const clear = value === "-" || value === "null";

    let jsonValue: unknown = clear ? null : value;

    if (key === "agent") {
      if (!clear && !dbGetAgent(value)) fail(`Agent not found: ${value}`);
      dbUpdateInstance(name, { agent: clear ? undefined : value });
    } else if (key === "dmPolicy") {
      const r = DmPolicySchema.safeParse(value);
      if (!r.success) fail(`Invalid dmPolicy: ${value}. Valid: open, pairing, closed`);
      dbUpdateInstance(name, { dmPolicy: r.data });
    } else if (key === "groupPolicy") {
      const r = GroupPolicySchema.safeParse(value);
      if (!r.success) fail(`Invalid groupPolicy: ${value}. Valid: open, allowlist, closed`);
      dbUpdateInstance(name, { groupPolicy: r.data });
    } else if (key === "dmScope") {
      if (!clear) {
        const r = DmScopeSchema.safeParse(value);
        if (!r.success) fail(`Invalid dmScope: ${value}. Valid: ${DmScopeSchema.options.join(", ")}`);
      }
      dbUpdateInstance(name, { dmScope: clear ? undefined : (value as typeof inst.dmScope) });
    } else if (key === "instanceId") {
      dbUpdateInstance(name, { instanceId: clear ? undefined : value });
    } else if (key === "channel") {
      jsonValue = value;
      dbUpdateInstance(name, { channel: value });
    } else if (key === "enabled") {
      if (clear) fail("enabled cannot be cleared");
      jsonValue = parseEnabledValue(value);
      dbUpdateInstance(name, { enabled: jsonValue as boolean });
    } else if (key === "defaults") {
      if (clear) {
        dbUpdateInstance(name, { defaults: null });
      } else {
        try {
          jsonValue = JSON.parse(value);
          if (typeof jsonValue !== "object" || jsonValue === null || Array.isArray(jsonValue)) {
            fail(`defaults must be a JSON object, e.g. '{"image_provider":"openai","image_model":"gpt-image-2"}'`);
          }
        } catch {
          fail(`defaults must be valid JSON object, e.g. '{"image_provider":"openai","image_model":"gpt-image-2"}'`);
        }
        dbUpdateInstance(name, { defaults: jsonValue as Record<string, unknown> });
      }
    }

    const updated = dbGetInstance(name);
    if (asJson) {
      printJson({
        status: "updated",
        key,
        value: jsonValue,
        instance: updated,
        changedCount: 1,
      });
      emitConfigChanged();
      return;
    }

    console.log(`✓ ${name}.${key} = ${clear ? "(cleared)" : value}`);
    emitConfigChanged();
  }

  // --------------------------------------------------------------------------
  // enable
  // --------------------------------------------------------------------------
  @Command({ name: "enable", description: "Enable an instance in Ravi without changing omni" })
  enable(
    @Arg("target", { description: "Instance name or omni instanceId" }) target: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = resolveInstanceByNameOrId(target);
    if (!inst) {
      const ignored = getIgnoredOmniInstanceIds();
      if (!ignored.includes(target)) fail(`Instance not found: ${target}`);
      saveIgnoredOmniInstanceIds(ignored.filter((instanceId) => instanceId !== target));
      if (asJson) {
        printJson({
          status: "ignored_removed",
          target,
          changedCount: 1,
          ignoredOmniInstanceIds: getIgnoredOmniInstanceIds(),
        });
        return;
      }
      console.log(`✓ Removed ignored unknown omni instanceId from ravi: ${target}`);
      return;
    }
    if (inst.enabled !== false) {
      if (asJson) {
        printJson({
          status: "unchanged",
          target,
          instance: inst,
          changedCount: 0,
        });
        return;
      }
      console.log(`Instance already enabled in ravi: ${inst.name}`);
      return;
    }
    const updated = dbUpdateInstance(inst.name, { enabled: true });
    if (asJson) {
      printJson({
        status: "enabled",
        target,
        instance: updated,
        changedCount: 1,
      });
      emitConfigChanged();
      return;
    }
    console.log(`✓ Instance enabled in ravi: ${inst.name}`);
    emitConfigChanged();
  }

  // --------------------------------------------------------------------------
  // disable
  // --------------------------------------------------------------------------
  @Command({ name: "disable", description: "Disable an instance in Ravi without changing omni" })
  disable(
    @Arg("target", { description: "Instance name or omni instanceId" }) target: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = resolveInstanceByNameOrId(target);
    if (!inst) {
      const ignored = getIgnoredOmniInstanceIds();
      if (ignored.includes(target)) {
        if (asJson) {
          printJson({
            status: "unchanged",
            target,
            changedCount: 0,
            ignoredOmniInstanceIds: ignored,
          });
          return;
        }
        console.log(`Unknown omni instanceId already ignored in ravi: ${target}`);
        return;
      }
      saveIgnoredOmniInstanceIds([...ignored, target]);
      if (asJson) {
        printJson({
          status: "ignored",
          target,
          changedCount: 1,
          ignoredOmniInstanceIds: getIgnoredOmniInstanceIds(),
        });
        return;
      }
      console.log(`✓ Ignoring unknown omni instanceId in ravi: ${target}`);
      return;
    }
    if (inst.enabled === false) {
      if (asJson) {
        printJson({
          status: "unchanged",
          target,
          instance: inst,
          changedCount: 0,
        });
        return;
      }
      console.log(`Instance already disabled in ravi: ${inst.name}`);
      return;
    }
    const updated = dbUpdateInstance(inst.name, { enabled: false });
    if (asJson) {
      printJson({
        status: "disabled",
        target,
        instance: updated,
        changedCount: 1,
      });
      emitConfigChanged();
      return;
    }
    console.log(`✓ Instance disabled in ravi: ${inst.name}`);
    emitConfigChanged();
  }

  // --------------------------------------------------------------------------
  // delete
  // --------------------------------------------------------------------------
  @Command({ name: "delete", description: "Delete an instance (soft-delete, recoverable)" })
  delete(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);
    const deleted = dbDeleteInstance(name);
    if (deleted) {
      if (asJson) {
        printJson({
          status: "deleted",
          instance: inst,
          changedCount: 1,
        });
        emitConfigChanged();
        return;
      }
      console.log(`✓ Instance deleted: ${name} (recoverable with: ravi instances restore ${name})`);
      emitConfigChanged();
    } else {
      fail(`Failed to delete instance: ${name}`);
    }
  }

  // --------------------------------------------------------------------------
  // restore
  // --------------------------------------------------------------------------
  @Command({ name: "restore", description: "Restore a soft-deleted instance" })
  restore(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ok = dbRestoreInstance(name);
    if (ok) {
      if (asJson) {
        printJson({
          status: "restored",
          instance: dbGetInstance(name),
          changedCount: 1,
        });
        emitConfigChanged();
        return;
      }
      console.log(`✓ Instance restored: ${name}`);
      emitConfigChanged();
    } else {
      fail(`Instance not found in deleted records: ${name}`);
    }
  }

  // --------------------------------------------------------------------------
  // deleted
  // --------------------------------------------------------------------------
  @Command({ name: "deleted", description: "List soft-deleted instances" })
  deleted(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const instances = dbListDeletedInstances();
    if (asJson) {
      printJson({
        total: instances.length,
        instances,
      });
      return;
    }
    if (instances.length === 0) {
      console.log("No deleted instances.");
      return;
    }
    console.log("\nDeleted Instances:\n");
    for (const inst of instances) {
      const deletedAt = new Date(inst.deletedAt!).toLocaleString();
      console.log(`  ${inst.name.padEnd(20)} channel: ${inst.channel.padEnd(12)} deleted: ${deletedAt}`);
    }
    console.log(`\nRestore with: ravi instances restore <name>`);
  }

  // --------------------------------------------------------------------------
  // connect
  // --------------------------------------------------------------------------
  @Command({ name: "connect", description: "Connect an instance to omni (QR code for WhatsApp)" })
  async connect(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--channel <channel>", description: "Channel type (default: whatsapp)" }) channelOpt?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route messages to" }) agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const TIMEOUT_MS = 120_000;
    const omni = getOmniClient();
    let createdOmniInstance = false;
    let createdAgent: { id: string; cwd: string } | null = null;

    let inst = dbGetInstance(name);
    const channel = channelOpt ?? inst?.channel ?? "whatsapp";
    const omniChannel = channel === "whatsapp" ? "whatsapp-baileys" : channel;

    // Resolve or create omni instance
    let instanceId = inst?.instanceId ?? "";
    if (!instanceId) {
      // Try to find existing in omni by name
      try {
        const result = await omni.instances.list({ channel: omniChannel });
        const existing = (result.items as Array<{ id?: string; name?: string }>).find((i) => i.name === name);
        if (existing?.id) instanceId = existing.id;
      } catch {
        /* omni offline */
      }
    }

    if (!instanceId) {
      if (!asJson) console.log(`Creating ${channel} instance "${name}" in omni...`);
      try {
        const created = (await omni.instances.create({ name, channel: omniChannel })) as { id?: string };
        instanceId = created.id ?? "";
        createdOmniInstance = true;
        if (!asJson) console.log(`✓ Instance created in omni: ${instanceId}`);
      } catch (err) {
        fail(`Failed to create instance in omni: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    // Upsert local instance record
    const agentId = agent ?? inst?.agent ?? (dbGetAgent(name) ? name : undefined);
    dbUpsertInstance({ name, instanceId, channel, agent: agentId ?? undefined, enabled: inst?.enabled !== false });
    if (agentId && !dbGetAgent(agentId)) {
      const cwd = `${homedir()}/ravi/${agentId}`;
      mkdirSync(cwd, { recursive: true });
      dbCreateAgent({ id: agentId, cwd });
      createdAgent = { id: agentId, cwd };
      if (!asJson) console.log(`✓ Created agent "${agentId}" at ${cwd}`);
    }

    emitConfigChanged();
    inst = dbGetInstance(name)!;
    if (!asJson) console.log(`Connecting: ${name} → agent ${inst.agent ?? "(default)"}  [${channel}]`);

    // Check if already connected
    try {
      const status = (await omni.instances.status(instanceId)) as { isConnected?: boolean; profileName?: string };
      if (status.isConnected) {
        if (asJson) {
          printJson({
            status: "connected",
            instance: inst,
            live: status,
            createdOmniInstance,
            createdAgent,
            changedCount: 1,
          });
          return;
        }
        const profile = status.profileName ? ` as ${status.profileName}` : "";
        console.log(`\n✓ Already connected${profile}`);
        return;
      }
    } catch {
      /* ignore */
    }

    // Initiate connection
    if (!asJson) console.log("Waiting for QR code...\n");
    try {
      await omni.instances.connect(instanceId, { whatsapp: { syncFullHistory: false } });
    } catch (err) {
      fail(`Failed to initiate connection: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const qrTopic = `ravi.whatsapp.qr.${instanceId}`;
    const connectedTopic = `ravi.whatsapp.connected.${instanceId}`;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (asJson) {
          reject(new Error("Timeout waiting for connection (120s)"));
          return;
        }
        console.error("\n✗ Timeout waiting for connection (120s)");
        process.exit(1);
      }, TIMEOUT_MS);

      (async () => {
        try {
          for await (const event of nats.subscribe(qrTopic, connectedTopic)) {
            if (settled) break;
            const data = event.data as Record<string, unknown>;
            if (event.topic === qrTopic && data.type === "qr") {
              if (asJson) {
                clearTimeout(timer);
                settled = true;
                printJson({
                  status: "qr_required",
                  instance: inst,
                  instanceId,
                  channel,
                  qr: data.qr ?? null,
                  createdOmniInstance,
                  createdAgent,
                  changedCount: 1,
                });
                resolve();
                return;
              }
              console.log("Scan this QR code:\n");
              qrcode.generate(data.qr as string, { small: true });
            } else if (event.topic === connectedTopic && data.type === "connected") {
              clearTimeout(timer);
              settled = true;
              if (asJson) {
                printJson({
                  status: "connected",
                  instance: inst,
                  live: data,
                  createdOmniInstance,
                  createdAgent,
                  changedCount: 1,
                });
                resolve();
                return;
              }
              const profile = data.profileName ? ` as ${data.profileName}` : "";
              console.log(`\n✓ Connected${profile}`);
              resolve();
              process.exit(0);
            }
          }
        } catch (err) {
          if (!settled) {
            clearTimeout(timer);
            settled = true;
            reject(err);
          }
        }
      })();
    });
  }

  // --------------------------------------------------------------------------
  // disconnect
  // --------------------------------------------------------------------------
  @Command({ name: "disconnect", description: "Disconnect an instance from omni" })
  async disconnect(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);
    if (!inst.instanceId) fail(`Instance "${name}" has no omni instanceId set`);
    try {
      const omni = getOmniClient();
      await omni.instances.disconnect(inst.instanceId!);
      if (asJson) {
        printJson({
          status: "disconnected",
          instance: inst,
          changedCount: 1,
        });
        return;
      }
      console.log(`✓ Disconnected: ${name}`);
    } catch (err) {
      fail(`Failed to disconnect: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // status
  // --------------------------------------------------------------------------
  @Command({ name: "status", description: "Show connection status for an instance" })
  async status(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);
    if (!inst.instanceId) {
      if (asJson) {
        printJson({
          instance: inst,
          live: null,
          status: "no_omni_id",
        });
        return;
      }
      console.log(`\nInstance: ${name}\n  instanceId: (not set — run "ravi instances connect ${name}")`);
      return;
    }
    try {
      const omni = getOmniClient();
      const s = (await omni.instances.status(inst.instanceId!)) as {
        isConnected?: boolean;
        profileName?: string;
        state?: string;
      };
      if (asJson) {
        printJson({
          instance: {
            ...inst,
            raviStatus: inst.enabled === false ? "disabled" : "enabled",
          },
          live: s,
          status: s.isConnected ? "connected" : "disconnected",
        });
        return;
      }
      console.log(`\nInstance: ${name}\n`);
      printInspectionField("Instance ID", inst.instanceId, CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("Channel", inst.channel, CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("Ravi", inst.enabled === false ? "disabled" : "enabled", CONFIG_DB_META, {
        labelWidth: 15,
      });
      printInspectionField("State", s.state ?? "unknown", LIVE_OMNI_META, { labelWidth: 15 });
      printInspectionField("Connected", s.isConnected ?? false, LIVE_OMNI_META, { labelWidth: 15 });
      if (s.profileName) printInspectionField("Profile", s.profileName, LIVE_OMNI_META, { labelWidth: 15 });
      printInspectionField("Agent", inst.agent ?? "(default)", CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("DM Policy", inst.dmPolicy, CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("Group Policy", inst.groupPolicy, CONFIG_DB_META, { labelWidth: 15 });
    } catch (err) {
      fail(`Error fetching status: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  @Command({ name: "target", description: "Explain which runtime, DB, and live instance this CLI would affect" })
  target(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({
      flags: "--pattern <pattern>",
      description: "Optional exact pattern to inspect against the live resolver (e.g. group:123456)",
    })
    pattern?: string,
    @Option({
      flags: "--channel <channel>",
      description: "Optional channel hint for live route inspection",
    })
    channel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (asJson) {
      printJson(buildRouteExplanationPayload(name, pattern, channel));
      return;
    }
    printRouteExplanation(name, pattern, channel);
  }
}

// ============================================================================
// routes top-level read-only group
// ============================================================================

@Group({
  name: "routes",
  description: "Inspect route config and live routing without drilling into instances",
  scope: "admin",
})
export class RoutesCommands {
  @Command({ name: "list", description: "List routes across all instances or for one instance" })
  list(
    @Arg("name", { description: "Instance name (omit for all)", required: false }) name?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (asJson) {
      printJson(buildRouteListPayload(name));
      return;
    }
    printRouteList(name);
  }

  @Command({ name: "show", description: "Show route details" })
  show(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (asJson) {
      printJson(buildRouteDetailsPayload(name, pattern));
      return;
    }
    printRouteDetails(name, pattern);
  }

  @Command({ name: "explain", description: "Explain how a pattern resolves in config and the live router" })
  explain(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({
      flags: "--channel <channel>",
      description: "Optional channel hint for live route inspection",
    })
    channel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (asJson) {
      printJson(buildRouteExplanationPayload(name, pattern, channel));
      return;
    }
    printRouteExplanation(name, pattern, channel);
  }
}

// ============================================================================
// instances.routes subgroup
// ============================================================================

@Group({
  name: "instances.routes",
  description: "Manage routes for an instance",
  scope: "admin",
})
export class InstancesRoutesCommands {
  @Command({ name: "list", description: "List routes for an instance" })
  list(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (asJson) {
      printJson(buildRouteListPayload(name));
      return;
    }
    printRouteList(name);
  }

  @Command({ name: "show", description: "Show route details" })
  show(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (asJson) {
      printJson(buildRouteDetailsPayload(name, pattern));
      return;
    }
    printRouteDetails(name, pattern);
  }

  @Command({ name: "add", description: "Add a route to an instance" })
  add(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern (e.g., group:123456, 5511*, thread:*, *)" }) pattern: string,
    @Arg("agent", { description: "Agent ID" }) agent: string,
    @Option({ flags: "--priority <n>", description: "Route priority (default: 0)" }) priority?: string,
    @Option({ flags: "--policy <policy>", description: "Policy override: open|pairing|closed|allowlist" })
    policy?: string,
    @Option({ flags: "--session <name>", description: "Force session name" }) session?: string,
    @Option({ flags: "--dm-scope <scope>", description: "DM scope override" }) dmScope?: string,
    @Option({
      flags: "--channel <channel>",
      description: "Limit route to a specific channel (e.g. whatsapp, telegram). Omit for all channels.",
    })
    channel?: string,
    @Option({
      flags: "--allow-runtime-mismatch",
      description: "Allow mutation even when the CLI bundle differs from the live daemon runtime",
    })
    allowRuntimeMismatch?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}. Create with: ravi instances create ${name}`);
    if (!dbGetAgent(agent))
      fail(
        `Agent not found: ${agent}. Available: ${dbListAgents()
          .map((a) => a.id)
          .join(", ")}`,
      );
    if (dmScope) {
      const r = DmScopeSchema.safeParse(dmScope);
      if (!r.success) fail(`Invalid dmScope: ${dmScope}. Valid: ${DmScopeSchema.options.join(", ")}`);
    }
    const pri = priority !== undefined ? parseInt(priority, 10) : 0;
    if (Number.isNaN(pri)) fail(`Invalid priority: ${priority}`);
    assertInstanceMutationRuntime(name, allowRuntimeMismatch);

    try {
      const route = dbCreateRoute({
        pattern,
        accountId: name,
        agent,
        priority: pri,
        policy: policy ?? undefined,
        session: session ?? undefined,
        dmScope: dmScope ? DmScopeSchema.parse(dmScope) : undefined,
        channel: channel ?? undefined,
      });
      emitConfigChanged();

      // Remove from pending if applicable
      let removedPending = removeAccountPending(name, pattern);
      if (!removedPending) {
        const contact = getContact(pattern);
        if (contact) {
          for (const id of contact.identities) {
            if (removeAccountPending(name, id.value)) {
              removedPending = true;
              break;
            }
          }
        }
      }

      // Clean conflicting sessions
      const cleaned = deleteConflictingSessions(pattern, agent, { silent: Boolean(asJson) });

      if (asJson) {
        printJson({
          status: "added",
          instance: name,
          route,
          target: inspectCliRuntimeTarget(name),
          liveEffect: getRouteLiveEffect(name, pattern, agent, channel),
          removedPending,
          cleanedSessions: cleaned,
          changedCount: 1,
        });
        return;
      }

      printInstanceMutationTarget(name);
      const policyLabel = policy ? ` [policy:${policy}]` : "";
      const channelLabel = channel ? ` [channel:${channel}]` : "";
      console.log(`✓ Route added: ${pattern} → ${agent} (instance: ${name})${policyLabel}${channelLabel}`);
      printRouteLiveEffect(name, pattern, agent, channel);
      if (removedPending) console.log(`✓ Removed from pending`);
      if (cleaned > 0) console.log(`✓ Cleaned ${cleaned} conflicting session(s)`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "remove", description: "Remove a route (soft-delete, recoverable)" })
  remove(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({
      flags: "--allow-runtime-mismatch",
      description: "Allow mutation even when the CLI bundle differs from the live daemon runtime",
    })
    allowRuntimeMismatch?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    assertInstanceMutationRuntime(name, allowRuntimeMismatch);
    const route = dbGetRoute(pattern, name);
    const deleted = dbDeleteRoute(pattern, name);
    if (deleted) {
      if (asJson) {
        printJson({
          status: "removed",
          instance: name,
          pattern,
          route,
          target: inspectCliRuntimeTarget(name),
          changedCount: 1,
        });
        emitConfigChanged();
        return;
      }
      printInstanceMutationTarget(name);
      console.log(
        `✓ Route removed: ${pattern} (instance: ${name}) — restore with: ravi instances routes restore ${name} "${pattern}"`,
      );
      emitConfigChanged();
    } else {
      fail(`Route not found: ${pattern} (instance: ${name})`);
    }
  }

  @Command({ name: "restore", description: "Restore a soft-deleted route" })
  restore(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({
      flags: "--allow-runtime-mismatch",
      description: "Allow mutation even when the CLI bundle differs from the live daemon runtime",
    })
    allowRuntimeMismatch?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertInstanceMutationRuntime(name, allowRuntimeMismatch);
    const ok = dbRestoreRoute(pattern, name);
    if (ok) {
      if (asJson) {
        printJson({
          status: "restored",
          instance: name,
          pattern,
          route: dbGetRoute(pattern, name),
          target: inspectCliRuntimeTarget(name),
          changedCount: 1,
        });
        emitConfigChanged();
        return;
      }
      printInstanceMutationTarget(name);
      console.log(`✓ Route restored: ${pattern} (instance: ${name})`);
      emitConfigChanged();
    } else {
      fail(`Route not found in deleted records: ${pattern} (instance: ${name})`);
    }
  }

  @Command({ name: "deleted", description: "List soft-deleted routes" })
  deleted(
    @Arg("name", { description: "Instance name (omit for all)", required: false }) name?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const routes = dbListDeletedRoutes(name);
    if (asJson) {
      printJson({
        instance: name ?? null,
        total: routes.length,
        routes,
      });
      return;
    }
    if (routes.length === 0) {
      console.log("No deleted routes.");
      return;
    }
    console.log("\nDeleted Routes:\n");
    for (const r of routes) {
      console.log(`  ${r.accountId.padEnd(16)} ${r.pattern.padEnd(24)} → ${r.agent}`);
    }
    console.log(`\nRestore with: ravi instances routes restore <instance> "<pattern>"`);
  }

  @Command({ name: "set", description: "Set a route property" })
  set(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Arg("key", { description: `Property key (${ROUTE_SETTABLE_KEYS.join(", ")})` }) key: string,
    @Arg("value", { description: "Property value (use '-' to clear)" }) value: string,
    @Option({
      flags: "--allow-runtime-mismatch",
      description: "Allow mutation even when the CLI bundle differs from the live daemon runtime",
    })
    allowRuntimeMismatch?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    if (!dbGetRoute(pattern, name)) fail(`Route not found: ${pattern} (instance: ${name})`);
    if (!ROUTE_SETTABLE_KEYS.includes(key as (typeof ROUTE_SETTABLE_KEYS)[number])) {
      fail(`Invalid key: ${key}. Valid keys: ${ROUTE_SETTABLE_KEYS.join(", ")}`);
    }

    const clear = value === "-" || value === "null";
    const updates: Record<string, unknown> = {};
    let jsonValue: unknown = clear ? null : value;

    if (key === "agent") {
      if (!dbGetAgent(value)) fail(`Agent not found: ${value}`);
      updates.agent = value;
    } else if (key === "priority") {
      const n = parseInt(value, 10);
      if (Number.isNaN(n)) fail(`Invalid priority: ${value}`);
      updates.priority = n;
      jsonValue = n;
    } else if (key === "dmScope") {
      if (!clear) {
        const r = DmScopeSchema.safeParse(value);
        if (!r.success) fail(`Invalid dmScope: ${value}. Valid: ${DmScopeSchema.options.join(", ")}`);
      }
      updates.dmScope = clear ? null : value;
    } else if (key === "session") {
      updates.session = clear ? null : value;
    } else if (key === "policy") {
      updates.policy = clear ? null : value;
    } else if (key === "channel") {
      updates.channel = clear ? null : value;
    }
    assertInstanceMutationRuntime(name, allowRuntimeMismatch);

    try {
      const route = dbUpdateRoute(pattern, updates, name);
      emitConfigChanged();

      let cleaned = 0;
      if (key === "agent") {
        cleaned = deleteConflictingSessions(pattern, value, { silent: Boolean(asJson) });
      }

      if (asJson) {
        printJson({
          status: "updated",
          instance: name,
          pattern,
          key,
          value: jsonValue,
          route,
          target: inspectCliRuntimeTarget(name),
          liveEffect: key === "agent" && !clear ? getRouteLiveEffect(name, pattern, value, undefined) : null,
          cleanedSessions: cleaned,
          changedCount: 1,
        });
        return;
      }

      printInstanceMutationTarget(name);
      console.log(`✓ ${key} set on route ${pattern} (instance: ${name}): ${clear ? "(cleared)" : value}`);
      if (key === "agent" && !clear) {
        printRouteLiveEffect(name, pattern, value, undefined);
      }
      if (cleaned > 0) console.log(`✓ Cleaned ${cleaned} conflicting session(s)`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ============================================================================
// instances.pending subgroup
// ============================================================================

@Group({
  name: "instances.pending",
  description: "Manage pending contacts/groups for an instance",
  scope: "admin",
})
export class InstancesPendingCommands {
  @Command({ name: "list", description: "List pending contacts/groups for an instance" })
  list(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    const pending = listAccountPending(name);

    if (asJson) {
      printJson({
        instance: name,
        total: pending.length,
        pending: pending.map((p) => ({
          ...p,
          type: p.isGroup ? "group" : "dm",
        })),
      });
      return;
    }

    if (pending.length === 0) {
      console.log(`No pending contacts for instance "${name}".`);
      return;
    }

    console.log(`\nPending for: ${name}\n`);
    console.log("  ID                                       TYPE    NAME");
    console.log("  ---------------------------------------  ------  --------------------");
    for (const p of pending as AccountPendingEntry[]) {
      const type = p.isGroup ? "group" : "dm";
      console.log(`  ${p.phone.padEnd(39)}  ${type.padEnd(6)}  ${p.name ?? "-"}`);
    }
    console.log(`\n  Total: ${pending.length}`);
    console.log(`\n  Approve: ravi instances pending approve ${name} <phone>`);
  }

  @Command({ name: "approve", description: "Approve a pending contact/group" })
  approve(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("contact", { description: "Contact ID or phone" }) contact: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    allowContact(contact);
    const removedPending = removeAccountPending(name, contact);
    if (asJson) {
      printJson({
        status: "approved",
        instance: name,
        contact,
        removedPending,
        changedCount: 1,
      });
      emitConfigChanged();
      return;
    }
    console.log(`✓ Approved: ${contact} (instance: ${name})`);
    emitConfigChanged();
  }

  @Command({ name: "reject", description: "Reject and remove a pending contact/group" })
  reject(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("contact", { description: "Contact ID or phone" }) contact: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    const removed = removeAccountPending(name, contact);
    if (removed) {
      if (asJson) {
        printJson({
          status: "rejected",
          instance: name,
          contact,
          removedPending: true,
          changedCount: 1,
        });
        return;
      }
      console.log(`✓ Rejected and removed: ${contact} (instance: ${name})`);
    } else {
      fail(`Pending entry not found: ${contact} (instance: ${name})`);
    }
  }
}
