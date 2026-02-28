/**
 * Instances Commands - Central config entity for all channels/accounts
 *
 * ravi instances list
 * ravi instances show <name>
 * ravi instances create <name> [--channel whatsapp] [--agent main]
 * ravi instances set <name> <key> <value>
 * ravi instances get <name> <key>
 * ravi instances connect <name> [--channel whatsapp]
 * ravi instances disconnect <name>
 * ravi instances status <name>
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
import { createOmniClient } from "@omni/sdk";
import {
  dbGetInstance,
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
  dbListAuditLog,
  DmScopeSchema,
  DmPolicySchema,
  GroupPolicySchema,
  getFirstAccountName,
} from "../../router/router-db.js";
import { resolveOmniConnection } from "../../omni-config.js";
import { getContact, listAccountPending, removeAccountPending, allowContact, type AccountPendingEntry } from "../../contacts.js";
import { listSessions, deleteSession } from "../../router/sessions.js";

function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

function deleteConflictingSessions(pattern: string, targetAgent: string): number {
  const sessions = listSessions();
  let deleted = 0;
  for (const session of sessions) {
    if (pattern.startsWith("group:")) {
      const groupId = pattern.replace("group:", "");
      if (session.sessionKey.includes(`group:${groupId}`) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        console.log(`  Deleted conflicting session: ${session.sessionKey}`);
        deleted++;
      }
    } else if (pattern.startsWith("lid:")) {
      const lid = pattern.replace("lid:", "");
      if (session.sessionKey.includes(`lid:${lid}`) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        console.log(`  Deleted conflicting session: ${session.sessionKey}`);
        deleted++;
      }
    } else if (pattern.includes("*")) {
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      const match = session.sessionKey.match(/dm:(\d+)/);
      if (match && regex.test(match[1]) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        console.log(`  Deleted conflicting session: ${session.sessionKey}`);
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

const SETTABLE_KEYS = ["agent", "dmPolicy", "groupPolicy", "dmScope", "instanceId", "channel"] as const;
type SettableKey = typeof SETTABLE_KEYS[number];

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
  async list() {
    const instances = dbListInstances();

    // Try to enrich with omni status
    let omniStatus: Record<string, { isConnected?: boolean; profileName?: string }> = {};
    try {
      const omni = getOmniClient();
      const result = await omni.instances.list({});
      for (const item of result.items as Array<{ id?: string; isActive?: boolean; profileName?: string }>) {
        if (item.id) omniStatus[item.id] = { isConnected: item.isActive, profileName: item.profileName };
      }
    } catch { /* omni offline */ }

    if (instances.length === 0) {
      console.log("No instances configured.");
      console.log("\nCreate one: ravi instances create <name> --channel whatsapp");
      return;
    }

    console.log("\nInstances:\n");
    console.log("  NAME                 CHANNEL       AGENT           DM           GROUP        STATUS");
    console.log("  -------------------- ------------- --------------- ------------ ------------ ----------");

    for (const inst of instances) {
      const status = inst.instanceId ? (omniStatus[inst.instanceId]?.isConnected ? "connected" : "disconnected") : "no-omni-id";
      const profile = inst.instanceId ? (omniStatus[inst.instanceId]?.profileName ?? "") : "";
      const label = profile ? `${status} (${profile})` : status;
      console.log(
        `  ${inst.name.padEnd(20)} ${inst.channel.padEnd(13)} ${(inst.agent ?? "-").padEnd(15)} ${inst.dmPolicy.padEnd(12)} ${inst.groupPolicy.padEnd(12)} ${label}`
      );
    }
    console.log(`\n  Total: ${instances.length}`);
  }

  // --------------------------------------------------------------------------
  // show
  // --------------------------------------------------------------------------
  @Command({ name: "show", description: "Show instance details" })
  async show(
    @Arg("name", { description: "Instance name" }) name: string
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);

    const routes = dbListRoutes(name);

    let omniInfo: { isConnected?: boolean; profileName?: string; state?: string } = {};
    if (inst.instanceId) {
      try {
        const omni = getOmniClient();
        omniInfo = await omni.instances.status(inst.instanceId) as typeof omniInfo;
      } catch { /* omni offline */ }
    }

    console.log(`\nInstance: ${inst.name}\n`);
    console.log(`  Channel:      ${inst.channel}`);
    console.log(`  Instance ID:  ${inst.instanceId ?? "(not set)"}`);
    console.log(`  Agent:        ${inst.agent ?? "(default)"}`);
    console.log(`  DM Policy:    ${inst.dmPolicy}`);
    console.log(`  Group Policy: ${inst.groupPolicy}`);
    if (inst.dmScope) console.log(`  DM Scope:     ${inst.dmScope}`);
    if (inst.instanceId) {
      console.log(`  Connected:    ${omniInfo.isConnected ?? "unknown"}`);
      if (omniInfo.profileName) console.log(`  Profile:      ${omniInfo.profileName}`);
    }
    console.log(`\n  Routes (${routes.length}):`);
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
    @Option({ flags: "--dm-policy <policy>", description: "DM policy: open|pairing|closed (default: open)" }) dmPolicy?: string,
    @Option({ flags: "--group-policy <policy>", description: "Group policy: open|allowlist|closed (default: open)" }) groupPolicy?: string,
  ) {
    if (agent && !dbGetAgent(agent)) {
      fail(`Agent not found: ${agent}. Available: ${dbListAgents().map(a => a.id).join(", ")}`);
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
      dbUpsertInstance({
        name,
        channel: channel ?? "whatsapp",
        agent: agent ?? undefined,
        dmPolicy: (dmPolicy ?? "open") as "open" | "pairing" | "closed",
        groupPolicy: (groupPolicy ?? "open") as "open" | "allowlist" | "closed",
      });
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
    @Arg("key", { description: `Property key (${SETTABLE_KEYS.join(", ")})` }) key: string
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);
    const val = (inst as Record<string, unknown>)[key];
    if (val === undefined) fail(`Unknown key: ${key}. Valid keys: ${SETTABLE_KEYS.join(", ")}`);
    console.log(`${name}.${key}: ${val ?? "(not set)"}`);
  }

  // --------------------------------------------------------------------------
  // set
  // --------------------------------------------------------------------------
  @Command({ name: "set", description: "Set an instance property" })
  set(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("key", { description: `Property key (${SETTABLE_KEYS.join(", ")})` }) key: string,
    @Arg("value", { description: "Property value (use '-' to clear)" }) value: string
  ) {
    if (!SETTABLE_KEYS.includes(key as SettableKey)) {
      fail(`Invalid key: ${key}. Valid keys: ${SETTABLE_KEYS.join(", ")}`);
    }
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}. Create it first with: ravi instances create ${name}`);

    const clear = value === "-" || value === "null";

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
      dbUpdateInstance(name, { dmScope: clear ? undefined : value as typeof inst.dmScope });
    } else if (key === "instanceId") {
      dbUpdateInstance(name, { instanceId: clear ? undefined : value });
    } else if (key === "channel") {
      dbUpdateInstance(name, { channel: value });
    }

    console.log(`✓ ${name}.${key} = ${clear ? "(cleared)" : value}`);
    emitConfigChanged();
  }

  // --------------------------------------------------------------------------
  // delete
  // --------------------------------------------------------------------------
  @Command({ name: "delete", description: "Delete an instance (soft-delete, recoverable)" })
  delete(
    @Arg("name", { description: "Instance name" }) name: string
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);
    const deleted = dbDeleteInstance(name);
    if (deleted) {
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
    @Arg("name", { description: "Instance name" }) name: string
  ) {
    const ok = dbRestoreInstance(name);
    if (ok) {
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
  deleted() {
    const instances = dbListDeletedInstances();
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
  ) {
    const TIMEOUT_MS = 120_000;
    const omni = getOmniClient();

    let inst = dbGetInstance(name);
    const channel = channelOpt ?? inst?.channel ?? "whatsapp";
    const omniChannel = channel === "whatsapp" ? "whatsapp-baileys" : channel;

    // Resolve or create omni instance
    let instanceId = inst?.instanceId ?? "";
    if (!instanceId) {
      // Try to find existing in omni by name
      try {
        const result = await omni.instances.list({ channel: omniChannel });
        const existing = (result.items as Array<{ id?: string; name?: string }>).find(i => i.name === name);
        if (existing?.id) instanceId = existing.id;
      } catch { /* omni offline */ }
    }

    if (!instanceId) {
      console.log(`Creating ${channel} instance "${name}" in omni...`);
      try {
        const created = await omni.instances.create({ name, channel: omniChannel }) as { id?: string };
        instanceId = created.id ?? "";
        console.log(`✓ Instance created in omni: ${instanceId}`);
      } catch (err) {
        fail(`Failed to create instance in omni: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    // Upsert local instance record
    const agentId = agent ?? inst?.agent ?? (dbGetAgent(name) ? name : undefined);
    dbUpsertInstance({ name, instanceId, channel, agent: agentId ?? undefined });
    if (agentId && !dbGetAgent(agentId)) {
      const cwd = `${homedir()}/ravi/${agentId}`;
      mkdirSync(cwd, { recursive: true });
      dbCreateAgent({ id: agentId, cwd });
      console.log(`✓ Created agent "${agentId}" at ${cwd}`);
    }

    emitConfigChanged();
    inst = dbGetInstance(name)!;
    console.log(`Connecting: ${name} → agent ${inst.agent ?? "(default)"}  [${channel}]`);

    // Check if already connected
    try {
      const status = await omni.instances.status(instanceId) as { isConnected?: boolean; profileName?: string };
      if (status.isConnected) {
        const profile = status.profileName ? ` as ${status.profileName}` : "";
        console.log(`\n✓ Already connected${profile}`);
        return;
      }
    } catch { /* ignore */ }

    // Initiate connection
    console.log("Waiting for QR code...\n");
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
        console.error("\n✗ Timeout waiting for connection (120s)");
        process.exit(1);
      }, TIMEOUT_MS);

      (async () => {
        try {
          for await (const event of nats.subscribe(qrTopic, connectedTopic)) {
            if (settled) break;
            const data = event.data as Record<string, unknown>;
            if (event.topic === qrTopic && data.type === "qr") {
              console.log("Scan this QR code:\n");
              qrcode.generate(data.qr as string, { small: true });
            } else if (event.topic === connectedTopic && data.type === "connected") {
              clearTimeout(timer);
              settled = true;
              const profile = data.profileName ? ` as ${data.profileName}` : "";
              console.log(`\n✓ Connected${profile}`);
              resolve();
              process.exit(0);
            }
          }
        } catch (err) {
          if (!settled) { clearTimeout(timer); settled = true; reject(err); }
        }
      })();
    });
  }

  // --------------------------------------------------------------------------
  // disconnect
  // --------------------------------------------------------------------------
  @Command({ name: "disconnect", description: "Disconnect an instance from omni" })
  async disconnect(
    @Arg("name", { description: "Instance name" }) name: string
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);
    if (!inst.instanceId) fail(`Instance "${name}" has no omni instanceId set`);
    try {
      const omni = getOmniClient();
      await omni.instances.disconnect(inst.instanceId!);
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
    @Arg("name", { description: "Instance name" }) name: string
  ) {
    const inst = dbGetInstance(name);
    if (!inst) fail(`Instance not found: ${name}`);
    if (!inst.instanceId) {
      console.log(`\nInstance: ${name}\n  instanceId: (not set — run "ravi instances connect ${name}")`);
      return;
    }
    try {
      const omni = getOmniClient();
      const s = await omni.instances.status(inst.instanceId!) as { isConnected?: boolean; profileName?: string; state?: string };
      console.log(`\nInstance: ${name}\n`);
      console.log(`  Instance ID: ${inst.instanceId}`);
      console.log(`  Channel:     ${inst.channel}`);
      console.log(`  State:       ${s.state ?? "unknown"}`);
      console.log(`  Connected:   ${s.isConnected ?? false}`);
      if (s.profileName) console.log(`  Profile:     ${s.profileName}`);
      console.log(`  Agent:       ${inst.agent ?? "(default)"}`);
      console.log(`  DM Policy:   ${inst.dmPolicy}`);
      console.log(`  Group Policy:${inst.groupPolicy}`);
    } catch (err) {
      fail(`Error fetching status: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    @Arg("name", { description: "Instance name" }) name: string
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    const routes = dbListRoutes(name);

    if (routes.length === 0) {
      console.log(`No routes for instance "${name}".`);
      console.log(`\nAdd a route: ravi instances routes add ${name} <pattern> <agent>`);
      return;
    }

    console.log(`\nRoutes for: ${name}\n`);
    console.log("  ST  PATTERN                              AGENT           POLICY       PRI  SESSION");
    console.log("  --  -----------------------------------  --------------  -----------  ---  -------");

    for (const route of routes) {
      const contact = getContact(route.pattern);
      const statusIcon = !contact ? "\x1b[33m?\x1b[0m"
        : contact.status === "allowed" ? "\x1b[32m✓\x1b[0m"
        : contact.status === "blocked" ? "\x1b[31m✗\x1b[0m"
        : "\x1b[36m○\x1b[0m";
      const policy = route.policy ?? "-";
      const session = route.session ?? "-";
      const channelLabel = route.channel ? ` [${route.channel}]` : "";
      console.log(`  ${statusIcon}   ${route.pattern.padEnd(35)} ${route.agent.padEnd(14)}  ${policy.padEnd(11)}  ${String(route.priority ?? 0).padEnd(3)}  ${session}${channelLabel}`);
    }

    console.log(`\n  Total: ${routes.length}`);
  }

  @Command({ name: "show", description: "Show route details" })
  show(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    const route = dbGetRoute(pattern, name);
    if (!route) fail(`Route not found: ${pattern} (instance: ${name})`);

    console.log(`\nRoute: ${route.pattern} (instance: ${name})\n`);
    console.log(`  Agent:     ${route.agent}`);
    console.log(`  Priority:  ${route.priority ?? 0}`);
    console.log(`  Policy:    ${route.policy ?? "(inherits from instance)"}`);
    console.log(`  DM Scope:  ${route.dmScope ?? "(inherits)"}`);
    console.log(`  Session:   ${route.session ?? "(auto)"}`);
    console.log(`  Channel:   ${route.channel ?? "(all channels)"}`);
  }

  @Command({ name: "add", description: "Add a route to an instance" })
  add(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern (e.g., group:123456, 5511*, thread:*, *)" }) pattern: string,
    @Arg("agent", { description: "Agent ID" }) agent: string,
    @Option({ flags: "--priority <n>", description: "Route priority (default: 0)" }) priority?: string,
    @Option({ flags: "--policy <policy>", description: "Policy override: open|pairing|closed|allowlist" }) policy?: string,
    @Option({ flags: "--session <name>", description: "Force session name" }) session?: string,
    @Option({ flags: "--dm-scope <scope>", description: "DM scope override" }) dmScope?: string,
    @Option({ flags: "--channel <channel>", description: "Limit route to a specific channel (e.g. whatsapp, telegram). Omit for all channels." }) channel?: string,
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}. Create with: ravi instances create ${name}`);
    if (!dbGetAgent(agent)) fail(`Agent not found: ${agent}. Available: ${dbListAgents().map(a => a.id).join(", ")}`);
    if (dmScope) {
      const r = DmScopeSchema.safeParse(dmScope);
      if (!r.success) fail(`Invalid dmScope: ${dmScope}. Valid: ${DmScopeSchema.options.join(", ")}`);
    }
    const pri = priority !== undefined ? parseInt(priority, 10) : 0;
    if (isNaN(pri)) fail(`Invalid priority: ${priority}`);

    try {
      dbCreateRoute({
        pattern,
        accountId: name,
        agent,
        priority: pri,
        policy: policy ?? undefined,
        session: session ?? undefined,
        dmScope: dmScope as typeof DmScopeSchema._type | undefined,
        channel: channel ?? undefined,
      });
      const policyLabel = policy ? ` [policy:${policy}]` : "";
      const channelLabel = channel ? ` [channel:${channel}]` : "";
      console.log(`✓ Route added: ${pattern} → ${agent} (instance: ${name})${policyLabel}${channelLabel}`);
      emitConfigChanged();

      // Remove from pending if applicable
      let removedPending = removeAccountPending(name, pattern);
      if (!removedPending) {
        const contact = getContact(pattern);
        if (contact) {
          for (const id of contact.identities) {
            if (removeAccountPending(name, id.value)) { removedPending = true; break; }
          }
        }
      }
      if (removedPending) console.log(`✓ Removed from pending`);

      // Clean conflicting sessions
      const cleaned = deleteConflictingSessions(pattern, agent);
      if (cleaned > 0) console.log(`✓ Cleaned ${cleaned} conflicting session(s)`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "remove", description: "Remove a route (soft-delete, recoverable)" })
  remove(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    const deleted = dbDeleteRoute(pattern, name);
    if (deleted) {
      console.log(`✓ Route removed: ${pattern} (instance: ${name}) — restore with: ravi instances routes restore ${name} "${pattern}"`);
      emitConfigChanged();
    } else {
      fail(`Route not found: ${pattern} (instance: ${name})`);
    }
  }

  @Command({ name: "restore", description: "Restore a soft-deleted route" })
  restore(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string
  ) {
    const ok = dbRestoreRoute(pattern, name);
    if (ok) {
      console.log(`✓ Route restored: ${pattern} (instance: ${name})`);
      emitConfigChanged();
    } else {
      fail(`Route not found in deleted records: ${pattern} (instance: ${name})`);
    }
  }

  @Command({ name: "deleted", description: "List soft-deleted routes" })
  deleted(
    @Arg("name", { description: "Instance name (omit for all)", required: false }) name?: string
  ) {
    const routes = dbListDeletedRoutes(name);
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
    @Arg("value", { description: "Property value (use '-' to clear)" }) value: string
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    if (!dbGetRoute(pattern, name)) fail(`Route not found: ${pattern} (instance: ${name})`);
    if (!ROUTE_SETTABLE_KEYS.includes(key as typeof ROUTE_SETTABLE_KEYS[number])) {
      fail(`Invalid key: ${key}. Valid keys: ${ROUTE_SETTABLE_KEYS.join(", ")}`);
    }

    const clear = value === "-" || value === "null";
    const updates: Record<string, unknown> = {};

    if (key === "agent") {
      if (!dbGetAgent(value)) fail(`Agent not found: ${value}`);
      updates.agent = value;
    } else if (key === "priority") {
      const n = parseInt(value, 10);
      if (isNaN(n)) fail(`Invalid priority: ${value}`);
      updates.priority = n;
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

    try {
      dbUpdateRoute(pattern, updates, name);
      console.log(`✓ ${key} set on route ${pattern} (instance: ${name}): ${clear ? "(cleared)" : value}`);
      emitConfigChanged();

      if (key === "agent") {
        const cleaned = deleteConflictingSessions(pattern, value);
        if (cleaned > 0) console.log(`✓ Cleaned ${cleaned} conflicting session(s)`);
      }
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
    @Arg("name", { description: "Instance name" }) name: string
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    const pending = listAccountPending(name);

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
    @Arg("contact", { description: "Contact ID or phone" }) contact: string
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    allowContact(contact);
    removeAccountPending(name, contact);
    console.log(`✓ Approved: ${contact} (instance: ${name})`);
    emitConfigChanged();
  }

  @Command({ name: "reject", description: "Reject and remove a pending contact/group" })
  reject(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("contact", { description: "Contact ID or phone" }) contact: string
  ) {
    if (!dbGetInstance(name)) fail(`Instance not found: ${name}`);
    const removed = removeAccountPending(name, contact);
    if (removed) {
      console.log(`✓ Rejected and removed: ${contact} (instance: ${name})`);
    } else {
      fail(`Pending entry not found: ${contact} (instance: ${name})`);
    }
  }
}
