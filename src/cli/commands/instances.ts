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
 * ravi instances logout <name> [--execute]
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
 * ravi instances pending approve <name> <contact-or-chat> [--agent <id>]
 * ravi instances pending reject <name> <contact-or-chat>
 */

import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import qrcode from "qrcode-terminal";
import { z } from "zod";
import { Group, Command, CommandAccess, CliOnly, Arg, Option } from "../decorators.js";
import { CONTRACT_EXIT_USAGE, contractDryRun, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { fail } from "../context.js";
import { CliExpectedError } from "../expected-error.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  commandEnvelopeReturnSchema,
  declareCommandReturns,
  routeExplainReturnSchema,
  routeShowReturnSchema,
  routesListReturnSchema,
} from "./operational-return-schemas.js";
import { ensureConnected, nats } from "../../nats.js";
import {
  bridgeConnectedTopic,
  bridgeQrTopic,
  whatsappConnectedTopic,
  whatsappQrTopic,
} from "../../channels/inbound/topics.js";
import {
  createWhatsAppClient,
  WHATSAPP_CLIENT_TIMEOUTS_MS,
  type WhatsAppClient,
} from "../../channels/whatsapp/client.js";
import {
  WHATSAPP_RPC_ERROR_CODES,
  findWhatsAppChannelForInstance,
  isWhatsAppChannelType,
  isWhatsAppFamilyChannelType,
  isWhatsAppInstanceConfig,
} from "../../channels/whatsapp/contract.js";
import { isWhatsAppRpcError, isWhatsAppRunnerUnavailable } from "../../channels/whatsapp/errors.js";
import {
  ensureWhatsAppInstance,
  isWhatsAppProvisioningError,
  WHATSAPP_INSTANCE_CONFLICT,
  WHATSAPP_INSTANCE_DELETED,
  type EnsureWhatsAppInstanceOptions,
  type WhatsAppInstanceResult,
  type WhatsAppInstanceSettings,
} from "../../channels/whatsapp/provisioning.js";
import { WHATSAPP_RUNNER_UNAVAILABLE_MESSAGE } from "../../channels/whatsapp/rpc-client.js";
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
  ContactIntakeModeSchema,
  dbGetSetting,
  dbSetSetting,
  dbUpdateChannel,
  type InstanceConfig,
} from "../../router/router-db.js";
import { loadRouterConfig, matchRoute } from "../../router/index.js";
import {
  IGNORED_OMNI_INSTANCE_IDS_SETTING,
  parseIgnoredOmniInstanceIds,
  serializeIgnoredOmniInstanceIds,
} from "../../router/omni-ignore.js";
import {
  getContact,
  listAccountPending,
  removeAccountPending,
  allowContact,
  normalizePhone,
  type AccountPendingEntry,
} from "../../contacts.js";
import {
  detachRouteBookkeepingSubscriptions,
  listRouteStickyOverrides,
  sessionHasExplicitAttach,
  type RouteStickyOverride,
} from "../../router/route-sticky-attach.js";
import { listSessions, deleteSession } from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import { filterItemsByCanonicalTag } from "../../tags/helpers.js";
import { searchTagBindingsForSelector } from "../../tags/service.js";
import type { TagBinding } from "../../tags/types.js";
import { normalizeRoutePattern } from "../../utils/phone.js";
import { formatCliRuntimeTarget, getCliRuntimeMismatchMessage, inspectCliRuntimeTarget } from "../runtime-target.js";
import { formatInspectionSection, printInspectionField } from "../inspection-output.js";

const CONFIG_DB_META = { source: "config-db", freshness: "persisted" } as const;
const LIVE_OMNI_META = { source: "live-omni", freshness: "live" } as const;
const LIVE_WHATSAPP_META = { source: "live-whatsapp", freshness: "live", via: "whatsapp-runner-rpc" } as const;
type ListedRoute = ReturnType<typeof dbListRoutes>[number];

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

function normalizePendingChatPattern(entry: Pick<AccountPendingEntry, "phone" | "chatId" | "isGroup">): string {
  const raw = (entry.chatId || entry.phone || "").trim();
  const normalized = normalizePhone(raw);
  if (normalized.startsWith("group:")) return normalized;
  if (entry.isGroup) {
    const bareGroupId = (normalized || raw).replace(/^group:/, "").replace(/@.*$/, "");
    if (/^\d+(?:-\d+)?$/.test(bareGroupId)) return `group:${bareGroupId}`;
  }
  return normalized || raw;
}

function findPendingReviewEntry(instanceName: string, ref: string): AccountPendingEntry | null {
  const normalizedRef = normalizePhone(ref);
  return (
    listAccountPending(instanceName).find((entry) => {
      if (entry.phone === ref || entry.chatId === ref) return true;
      const entryPhone = normalizePhone(entry.phone);
      const entryChat = entry.chatId ? normalizePhone(entry.chatId) : "";
      return Boolean(normalizedRef && (entryPhone === normalizedRef || entryChat === normalizedRef));
    }) ?? null
  );
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

// ============================================================
// Agent-first contract helpers (Manual v2): typed not-found errors with the
// {success:false, error:{code, ...suggestions}} envelope. Exit taxonomy:
// 1 not-found/provider · 2 usage · 3 policy (write brake / dry-run).
// ============================================================

/**
 * Instance names are public through `instances list` (no per-agent visibility
 * cloak — only the optional tag filter), so INSTANCE_NOT_FOUND enriches the
 * envelope with real similar names and omni instanceIds.
 */
function failInstanceNotFound(op: string, ref: string, asJson?: boolean): never {
  const candidates = dbListInstances().flatMap((inst) => [inst.name, inst.instanceId ?? null]);
  contractFail(op, "INSTANCE_NOT_FOUND", `Instance not found: ${ref}`, {
    asJson,
    details: {
      suggestedAction: "Check the instance name (see suggestions; list with: ravi instances list --json)",
      suggestions: suggestSimilar(ref, candidates),
    },
  });
}

/** Route patterns are scoped per instance; suggestions come from that instance's real routes. */
function failRouteNotFound(op: string, name: string, pattern: string, asJson?: boolean): never {
  const candidates = dbListRoutes(name).map((route) => route.pattern);
  contractFail(op, "ROUTE_NOT_FOUND", `Route not found: ${pattern} (instance: ${name})`, {
    asJson,
    details: {
      suggestedAction: `Check the route pattern (see suggestions; list with: ravi routes list ${name} --json)`,
      suggestions: suggestSimilar(pattern, candidates),
    },
  });
}

function requireInstance(op: string, name: string, asJson?: boolean) {
  const instance = dbGetInstance(name);
  if (!instance) failInstanceNotFound(op, name, asJson);
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
    const suggestedAction = "Re-run with the repo CLI/runtime or pass --allow-runtime-mismatch if you really mean it.";
    fail(`${mismatch}\nTarget instance: ${name}\n${suggestedAction}`, suggestedAction);
  }
}

function canonicalizeRoutePatternArg(pattern: string): string {
  return normalizeRoutePattern(pattern);
}

function isExactSimulatedRoutePattern(pattern: string): boolean {
  const canonical = canonicalizeRoutePatternArg(pattern);
  if (canonical.includes("*")) return false;
  return canonical.startsWith("group:") || canonical.startsWith("lid:") || /^\d+$/.test(canonical);
}

function inspectRouteLiveWinner(
  name: string,
  pattern: string,
  channel?: string,
): { winningPattern: string; winningAgent: string } | null {
  const config = loadRouterConfig();
  const canonical = canonicalizeRoutePatternArg(pattern);

  if (canonical.startsWith("group:")) {
    const groupId = canonical.slice("group:".length);
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

  if (canonical.startsWith("lid:") || (!canonical.includes("*") && /^\d+$/.test(canonical))) {
    const resolved = matchRoute(config, {
      phone: canonical,
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
    return {
      status: isExactSimulatedRoutePattern(pattern) ? "unresolved" : "skipped_broad_pattern",
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

function stickyAttachForPattern(name: string, pattern: string, channel?: string) {
  const overrides = listRouteStickyOverrides({ accountId: name, pattern, channel });
  return { overrides };
}

function printStickyAttachWarning(overrides: RouteStickyOverride[]): void {
  if (overrides.length === 0) return;
  console.log("  Sticky attach: an active subscription still overrides the live route agent");
  for (const override of overrides) {
    const kind = override.explicit ? "explicit attach" : (override.attachedReason ?? override.attachedByType);
    console.log(`    ${override.chatId} → ${override.sessionKey} (agent ${override.agentId}, ${kind})`);
    console.log(`    Detach: ${override.detachCommand}`);
  }
}

function releaseRouteAgentStickiness(
  name: string,
  pattern: string,
  targetAgent: string,
  channel: string | undefined,
  asJson?: boolean,
): {
  detachedSubscriptions: number;
  cleanedSessions: number;
  stickyAttach: { overrides: RouteStickyOverride[] };
} {
  const released = detachRouteBookkeepingSubscriptions({
    accountId: name,
    pattern,
    targetAgent,
    channel,
  });
  const cleanedSessions = deleteConflictingSessions(pattern, targetAgent, {
    accountId: name,
    silent: Boolean(asJson),
  });
  return {
    detachedSubscriptions: released.detached,
    cleanedSessions,
    stickyAttach: stickyAttachForPattern(name, pattern, channel),
  };
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

function filterRoutesByTag(routes: ListedRoute[], tagSlug?: string): ListedRoute[] {
  return filterItemsByCanonicalTag(routes, "route", tagSlug, (route) => String(route.id));
}

function listRouteTags(routeId: string | number): TagBinding[] {
  return searchTagBindingsForSelector({ selector: { target: `route:${String(routeId)}` } }).bindings;
}

function listInstanceTags(name: string): TagBinding[] {
  return searchTagBindingsForSelector({ selector: { instance: name } }).bindings;
}

function printRouteList(
  op: string,
  name?: string,
  tagSlug?: string,
  limit?: string,
  offset?: string,
  baseCommand: Array<string | null | undefined> = ["ravi", "routes", "list", name],
): void {
  if (name) {
    requireInstance(op, name);
    const routes = filterRoutesByTag(dbListRoutes(name), tagSlug);
    const page = paginateCliItems(routes, { limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand,
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--tag", tagSlug?.trim() || null],
    });

    if (page.items.length === 0) {
      console.log(
        tagSlug ? `No routes tagged "${tagSlug}" for instance "${name}".` : `No routes for instance "${name}".`,
      );
      console.log(`\nAdd a route: ravi instances routes add ${name} <pattern> <agent>`);
      return;
    }

    console.log(tagSlug ? `\nRoutes for: ${name} tagged ${tagSlug}\n` : `\nRoutes for: ${name}\n`);
    printRouteTable(page.items, false);
    console.log(`\n  Total: ${page.total} (${page.items.length} returned, limit ${page.limit}, offset ${page.offset})`);
    if (pagination.nextCommand) {
      console.log("\n  Next page:");
      console.log(`    ${pagination.nextCommand}`);
    }
    console.log(`  Show one: ravi routes show ${name} "<pattern>"`);
    console.log(`  Explain:  ravi routes explain ${name} "<pattern>"`);
    console.log(`  Mutate:   ravi instances routes set ${name} "<pattern>" <key> <value>`);
    return;
  }

  const routes = filterRoutesByTag(dbListRoutes(), tagSlug);
  const page = paginateCliItems(routes, { limit, offset });
  const pagination = buildCliOffsetPagination({
    baseCommand,
    limit: page.limit,
    offset: page.offset,
    returned: page.items.length,
    total: page.total,
    options: ["--tag", tagSlug?.trim() || null],
  });
  if (page.items.length === 0) {
    console.log(tagSlug ? `No routes tagged "${tagSlug}".` : "No routes configured.");
    console.log(`\nAdd one: ravi instances routes add <instance> <pattern> <agent>`);
    return;
  }

  console.log(tagSlug ? `\nRoutes across all instances tagged ${tagSlug}:\n` : "\nRoutes across all instances:\n");
  printRouteTable(page.items, true);
  console.log(`\n  Total: ${page.total} (${page.items.length} returned, limit ${page.limit}, offset ${page.offset})`);
  if (pagination.nextCommand) {
    console.log("\n  Next page:");
    console.log(`    ${pagination.nextCommand}`);
  }
  console.log(`  Show one: ravi routes show <instance> "<pattern>"`);
  console.log(`  Explain:  ravi routes explain <instance> "<pattern>"`);
  console.log(`  Mutate:   ravi instances routes add <instance> <pattern> <agent>`);
}

function buildRouteListPayload(
  op: string,
  name?: string,
  tagSlug?: string,
  limit?: string,
  offset?: string,
  baseCommand: Array<string | null | undefined> = ["ravi", "routes", "list", name],
  fields?: string,
  asJson?: boolean,
) {
  if (name) {
    requireInstance(op, name, asJson);
  }
  const routes = filterRoutesByTag(dbListRoutes(name), tagSlug);
  const page = paginateCliItems(routes, { limit, offset });
  const pagination = buildCliOffsetPagination({
    fields,
    baseCommand,
    limit: page.limit,
    offset: page.offset,
    returned: page.items.length,
    total: page.total,
    options: ["--tag", tagSlug?.trim() || null],
  });
  const routeRows = pickFields(
    page.items.map((route) => ({
      ...route,
      tags: listRouteTags(route.id),
    })),
    fields,
  );
  return {
    instance: name ?? null,
    filter: { tagSlug: tagSlug?.trim() || null },
    total: page.total,
    pagination,
    items: routeRows,
    routes: routeRows,
  };
}

function printRouteDetails(op: string, name: string, pattern: string): void {
  requireInstance(op, name);
  const routePattern = canonicalizeRoutePatternArg(pattern);
  const route = dbGetRoute(routePattern, name);
  if (!route) failRouteNotFound(op, name, routePattern);

  console.log(`\nRoute: ${route.pattern} (instance: ${name})\n`);
  console.log(`  Agent:     ${route.agent}`);
  console.log(`  Priority:  ${route.priority ?? 0}`);
  console.log(`  Policy:    ${route.policy ?? "(inherits from instance)"}`);
  console.log(`  DM Scope:  ${route.dmScope ?? "(inherits)"}`);
  console.log(`  Session:   ${route.session ?? "(auto)"}`);
  console.log(`  Channel:   ${route.channel ?? "(all channels)"}`);
  const routeTags = listRouteTags(route.id);
  console.log(`  Tags:      ${routeTags.length > 0 ? routeTags.map((tag) => tag.tagSlug).join(", ") : "-"}`);
  console.log(`\n  Explain live routing: ravi routes explain ${name} "${routePattern}"`);
  console.log(`  Mutate config:        ravi instances routes set ${name} "${routePattern}" <key> <value>`);
}

function buildRouteDetailsPayload(op: string, name: string, pattern: string, asJson?: boolean) {
  requireInstance(op, name, asJson);
  const routePattern = canonicalizeRoutePatternArg(pattern);
  const route = dbGetRoute(routePattern, name);
  if (!route) failRouteNotFound(op, name, routePattern, asJson);
  return {
    instance: name,
    pattern: routePattern,
    route: {
      ...route,
      tags: listRouteTags(route.id),
    },
  };
}

function buildRouteExplanationPayload(op: string, name: string, pattern?: string, channel?: string, asJson?: boolean) {
  const target = inspectCliRuntimeTarget(name);

  if (!target.instance?.exists) {
    failInstanceNotFound(op, name, asJson);
  }

  if (!pattern) {
    return {
      target,
      instance: name,
      pattern: null,
      channel: channel ?? null,
      configuredRoute: null,
      liveEffect: null,
      stickyAttach: null,
    };
  }

  const routePattern = canonicalizeRoutePatternArg(pattern);
  const configuredRoute = dbGetRoute(routePattern, name);
  if (configuredRoute) {
    const effectChannel = channel ?? configuredRoute.channel ?? undefined;
    return {
      target,
      instance: name,
      pattern: routePattern,
      channel: channel ?? configuredRoute.channel ?? null,
      configuredRoute,
      liveEffect: getRouteLiveEffect(name, routePattern, configuredRoute.agent, effectChannel),
      stickyAttach: stickyAttachForPattern(name, routePattern, effectChannel),
    };
  }

  const winner = inspectRouteLiveWinner(name, routePattern, channel);
  return {
    target,
    instance: name,
    pattern: routePattern,
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
    stickyAttach: stickyAttachForPattern(name, routePattern, channel),
  };
}

function printRouteExplanation(op: string, name: string, pattern?: string, channel?: string): void {
  const summary = inspectCliRuntimeTarget(name);
  for (const line of formatCliRuntimeTarget(summary)) {
    console.log(line);
  }

  if (!summary.instance?.exists) {
    failInstanceNotFound(op, name);
  }

  if (!pattern) {
    console.log(`\n  Discover routes: ravi routes list ${name}`);
    console.log(`  Explain one:     ravi routes explain ${name} "<pattern>"`);
    return;
  }

  const routePattern = canonicalizeRoutePatternArg(pattern);
  const configuredRoute = dbGetRoute(routePattern, name);
  if (configuredRoute) {
    const effectChannel = channel ?? configuredRoute.channel ?? undefined;
    console.log(`  Config route:  ${configuredRoute.pattern} → ${configuredRoute.agent}`);
    printRouteLiveEffect(name, routePattern, configuredRoute.agent, effectChannel);
    printStickyAttachWarning(stickyAttachForPattern(name, routePattern, effectChannel).overrides);
    console.log(`\n  Route details: ravi routes show ${name} "${routePattern}"`);
    console.log(`  Mutate config: ravi instances routes set ${name} "${routePattern}" <key> <value>`);
    return;
  }

  const winner = inspectRouteLiveWinner(name, routePattern, channel);
  if (!winner) {
    if (isExactSimulatedRoutePattern(routePattern)) {
      console.log(`  Live effect:   unresolved for ${routePattern} on instance ${name}`);
    } else {
      console.log(`  Live effect:   broad pattern — exact winner check skipped for ${routePattern}`);
    }
    printStickyAttachWarning(stickyAttachForPattern(name, routePattern, channel).overrides);
    console.log(`\n  Route details: ravi routes show ${name} "${routePattern}"`);
    console.log(`  Mutate config: ravi instances routes add ${name} "${routePattern}" <agent>`);
    return;
  }

  console.log("  Config route:  (none)");
  console.log("  Live effect:   different winner");
  console.log(`  Winning route: ${winner.winningPattern}`);
  console.log(`  Winning agent: ${winner.winningAgent}`);
  printStickyAttachWarning(stickyAttachForPattern(name, routePattern, channel).overrides);
  console.log(`\n  Route details: ravi routes show ${name} "${routePattern}"`);
  console.log(`  Mutate config: ravi instances routes add ${name} "${routePattern}" <agent>`);
}

function sessionKeyHasDmPeer(sessionKey: string, peerId: string): boolean {
  const escaped = peerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|:)dm:${escaped}(?:$|:)`, "i").test(sessionKey);
}

function sessionKeyAccountId(sessionKey: string): string | null {
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts.length >= 5 ? parts[3] : null;
}

function sessionBelongsToRouteAccount(session: SessionEntry, accountId: string): boolean {
  return (
    session.accountId === accountId ||
    session.lastAccountId === accountId ||
    sessionKeyAccountId(session.sessionKey) === accountId
  );
}

function isSharedMainSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(":");
  return parts.length === 3 && parts[0] === "agent" && parts[2] === "main";
}

function deleteConflictingSessions(
  pattern: string,
  targetAgent: string,
  opts: { accountId: string; silent?: boolean },
): number {
  const sessions = listSessions();
  let deleted = 0;
  const canonical = canonicalizeRoutePatternArg(pattern);
  const normalizedPattern = canonical.toLowerCase();
  for (const session of sessions) {
    if (!sessionBelongsToRouteAccount(session, opts.accountId)) continue;
    if (session.agentId === targetAgent) continue;
    if (isSharedMainSessionKey(session.sessionKey)) continue;

    const normalizedSessionKey = session.sessionKey.toLowerCase();
    const sessionName = (session.name ?? "").toLowerCase();
    let shouldDelete = false;

    if (normalizedPattern.startsWith("group:")) {
      const groupId = normalizedPattern.slice("group:".length);
      shouldDelete = normalizedSessionKey.includes(`group:${groupId}`);
    } else if (normalizedPattern.startsWith("lid:")) {
      const digits = normalizedPattern.slice("lid:".length);
      const last6 = digits.slice(-6);
      const hasLidToken = normalizedSessionKey.includes(`lid:${digits}`);
      const hasLegacyDmPeer =
        normalizedSessionKey.includes(`:dm:${digits}`) || normalizedSessionKey.endsWith(`dm:${digits}`);
      const hasLegacyName = last6.length > 0 && sessionName.includes(`-dm-${last6}`);
      shouldDelete = hasLidToken || hasLegacyDmPeer || hasLegacyName;
    } else if (canonical.includes("*")) {
      const regex = new RegExp(canonical.replace(/\*/g, ".*"), "i");
      const match = session.sessionKey.match(/dm:(\d+)/);
      shouldDelete = Boolean(match && regex.test(match[1]));
    } else if (/^\d+$/.test(canonical)) {
      // Exact phone DMs (`5511…`) never matched the group/LID/wildcard branches,
      // so the previous agent's session — and its chat subscription — survived
      // a route-agent migration.
      shouldDelete = sessionKeyHasDmPeer(session.sessionKey, canonical);
    }

    if (shouldDelete) {
      // An explicit `sessions attach` on this session must keep winning.
      // Deleting the row would cascade the subscription away.
      if (sessionHasExplicitAttach(session.sessionKey)) continue;
      deleteSession(session.sessionKey);
      if (!opts.silent) console.log(`  Deleted conflicting session: ${session.sessionKey}`);
      deleted++;
    }
  }
  return deleted;
}

// ============================================================================
// Transport: WhatsApp runs in the ravi channels runner; Telegram/Discord go
// through the legacy bridge (Omni), loaded only when one of them needs it.
// ============================================================================

type PairingEvent = { topic: string; data: Record<string, unknown> };
type InstanceTransport = "whatsapp" | "omni";
type LiveStatus = { isConnected?: boolean; profileName?: string | null; state?: string };

/** Legacy bridge instance record (subset of Omni's). */
interface LegacyInstanceRecord {
  id?: string;
  name?: string;
  channel?: string;
  isActive?: boolean;
  profileName?: string | null;
  state?: string;
}

/** The subset of the Omni client's `instances` API used by Telegram/Discord. */
interface LegacyInstancesClient {
  list(params?: Record<string, string | number | boolean | undefined>): Promise<{ items: LegacyInstanceRecord[] }>;
  create(body: { name: string; channel: string }): Promise<LegacyInstanceRecord>;
  status(id: string): Promise<{ state: string; isConnected: boolean; profileName?: string | null }>;
  connect(id: string, body?: unknown): Promise<{ status: string; message: string }>;
  disconnect(id: string): Promise<void>;
}

export interface InstancesTransportDependencies {
  /** WhatsApp runner client (resolves an instance to its WhatsApp channel binding). */
  whatsapp(): WhatsAppClient;
  /** Legacy bridge client for Telegram/Discord; null when the bridge is not configured. */
  legacy(): Promise<LegacyInstancesClient | null>;
  /** Make an instance a WhatsApp instance served by the runner (instance UUID + channel row). */
  provision(name: string, options: EnsureWhatsAppInstanceOptions): WhatsAppInstanceResult;
  /** Wipe the saved WhatsApp credentials of an instance locally (runner not answering). Returns rows removed. */
  clearWhatsAppAuthState(instanceId: string): Promise<number>;
  subscribe(...topics: string[]): AsyncIterable<PairingEvent>;
  /** Opens the NATS connection before the pairing subscription starts. */
  ensureNats(): Promise<unknown>;
  emitConfigChanged(): void;
  sleep(ms: number): Promise<void>;
  printQr(qr: string): void;
  exit(code: number): void;
  /** How long WhatsApp `connect` keeps retrying while the runner hot-adds the channel. */
  runnerRetryTimeoutMs: number;
  runnerRetryIntervalMs: number;
  pairingTimeoutMs: number;
}

async function loadLegacyInstancesClient(): Promise<LegacyInstancesClient | null> {
  const [{ resolveOmniConnection }, { createOmniClient }] = await Promise.all([
    import("../../omni-config.js"),
    import("../../omni/client.js"),
  ]);
  const connection = resolveOmniConnection();
  if (!connection) return null;
  return createOmniClient({ baseUrl: connection.apiUrl, apiKey: connection.apiKey }).instances;
}

async function clearSavedWhatsAppCredentials(instanceId: string): Promise<number> {
  const { clearWhatsAppAuthState } = await import("../../channels/whatsapp/lib/auth-store.js");
  return clearWhatsAppAuthState(instanceId);
}

function defaultInstancesTransportDependencies(): InstancesTransportDependencies {
  return {
    whatsapp: () => createWhatsAppClient(),
    legacy: loadLegacyInstancesClient,
    provision: (name, options) => ensureWhatsAppInstance(name, options),
    clearWhatsAppAuthState: clearSavedWhatsAppCredentials,
    subscribe: (...topics) => nats.subscribe(...topics),
    ensureNats: () => ensureConnected(),
    emitConfigChanged,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    printQr: (qr) => qrcode.generate(qr, { small: true }),
    exit: (code) => process.exit(code),
    runnerRetryTimeoutMs: 15_000,
    runnerRetryIntervalMs: 1_000,
    pairingTimeoutMs: 120_000,
  };
}

let transportDependencyOverrides: Partial<InstancesTransportDependencies> = {};

export function setInstancesTransportDependenciesForTests(overrides?: Partial<InstancesTransportDependencies>): void {
  transportDependencyOverrides = overrides ?? {};
}

function transportDeps(): InstancesTransportDependencies {
  return { ...defaultInstancesTransportDependencies(), ...transportDependencyOverrides };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isWhatsAppNotBound(err: unknown): boolean {
  return isWhatsAppRpcError(err) && err.code === WHATSAPP_RPC_ERROR_CODES.notBound;
}

/** "whatsapp" for canonical WhatsApp, "omni" for legacy-bridge channels, null for unsupported WhatsApp-family types. */
function instanceTransport(inst: Pick<InstanceConfig, "channel">): InstanceTransport | null {
  if (isWhatsAppChannelType(inst.channel)) return "whatsapp";
  if (isWhatsAppFamilyChannelType(inst.channel)) return null;
  return "omni";
}

function liveStatusMeta(transport: InstanceTransport | null) {
  return transport === "whatsapp" ? LIVE_WHATSAPP_META : LIVE_OMNI_META;
}

function transportLabel(transport: InstanceTransport | null): string {
  if (transport === "whatsapp") return "WhatsApp (ravi channels runner)";
  if (transport === "omni") return "Legacy bridge (Omni)";
  return "unsupported";
}

function unsupportedWhatsAppFamilyMessage(channel: string): string {
  return `Channel "${channel}" is not supported. WhatsApp runs natively in ravi: use --channel whatsapp.`;
}

/** twilio-whatsapp, gupshup, whatsapp-cloud, …: refused before any RPC, DB write or bridge import. */
function failUnsupportedWhatsAppFamily(op: string, name: string, channel: string, asJson?: boolean): never {
  contractFail(op, "USAGE_ERROR", unsupportedWhatsAppFamilyMessage(channel), {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: {
      suggestedAction: `Retry with the native WhatsApp channel: ravi instances connect ${name} --channel whatsapp`,
    },
  });
}

function failLegacyBridgeNotConfigured(): never {
  fail(
    "Legacy bridge (Omni) not configured. Telegram/Discord instances need it: is omni running?",
    "Install or start the legacy bridge (ravi setup), or set OMNI_API_URL and OMNI_API_KEY.",
  );
}

function failProvisioning(op: string, name: string, err: unknown, asJson?: boolean): never {
  if (isWhatsAppProvisioningError(err) && err.code === WHATSAPP_INSTANCE_DELETED) {
    contractFail(op, "USAGE_ERROR", err.message, {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: { suggestedAction: `Restore the instance first: ravi instances restore ${name}` },
    });
  }
  if (isWhatsAppProvisioningError(err)) {
    contractFail(op, WHATSAPP_INSTANCE_CONFLICT, err.message, {
      asJson,
      details: {
        suggestedAction: `Inspect the instance and its channel: ravi instances show ${name}; ravi channels list`,
      },
    });
  }
  fail(`Failed to provision WhatsApp instance "${name}": ${errorText(err)}`);
}

/** Live status of one instance through its transport. Throws when the transport cannot answer. */
async function readLiveStatus(
  deps: InstancesTransportDependencies,
  instanceId: string,
  transport: InstanceTransport,
): Promise<LiveStatus> {
  if (transport === "whatsapp") {
    const status = await deps.whatsapp().connection.status(instanceId, {});
    return { state: status.state, isConnected: status.isConnected, profileName: status.profileName };
  }
  const legacy = await deps.legacy();
  if (!legacy) failLegacyBridgeNotConfigured();
  return legacy.status(instanceId);
}

interface PairingWaitOptions {
  instanceId: string;
  qrTopic: string;
  connectedTopic: string;
  asJson?: boolean;
  deps: InstancesTransportDependencies;
  qrPayload(qr: unknown): Record<string, unknown>;
  connectedPayload(live: Record<string, unknown>): Record<string, unknown>;
  timeoutSuggestion: string;
}

interface PairingWait {
  done: Promise<void>;
  cancel(): void;
}

/**
 * Wait for the pairing relay the daemon publishes: `ravi.whatsapp.qr|connected.<uuid>` for
 * WhatsApp, `ravi.bridge.qr|connected.<uuid>` for the legacy bridge. With `--json` it resolves
 * on the first QR code; otherwise it prints each QR and exits on connect.
 */
function waitForPairing(options: PairingWaitOptions): PairingWait {
  const { asJson, deps, qrTopic, connectedTopic } = options;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const done = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        contractFail("instances connect", "INSTANCE_CONNECT_TIMEOUT", "Timed out waiting for instance connection.", {
          asJson,
          details: {
            retryable: true,
            timeoutSeconds: deps.pairingTimeoutMs / 1_000,
            suggestedAction: options.timeoutSuggestion,
          },
        });
      } catch (error) {
        reject(error);
      }
    }, deps.pairingTimeoutMs);

    (async () => {
      try {
        for await (const event of deps.subscribe(qrTopic, connectedTopic)) {
          if (settled) break;
          const data = event.data;
          if (event.topic === qrTopic && data.type === "qr") {
            if (asJson) {
              if (timer) clearTimeout(timer);
              settled = true;
              printJson(options.qrPayload(data.qr ?? null));
              resolve();
              return;
            }
            console.log("Scan this QR code:\n");
            deps.printQr(String(data.qr ?? ""));
          } else if (event.topic === connectedTopic && data.type === "connected") {
            if (timer) clearTimeout(timer);
            settled = true;
            if (asJson) {
              printJson(options.connectedPayload(data));
              resolve();
              return;
            }
            const profile = data.profileName ? ` as ${data.profileName}` : "";
            console.log(`\n✓ Connected${profile}`);
            resolve();
            deps.exit(0);
            return;
          }
        }
      } catch (err) {
        if (!settled) {
          if (timer) clearTimeout(timer);
          settled = true;
          reject(err);
        }
      }
    })();
  });

  // Callers may await `done` only after the connect request; mark it handled meanwhile.
  done.catch(() => {});
  return {
    done,
    cancel() {
      settled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function failRunnerUnavailable(name: string, err: unknown, asJson?: boolean): never {
  contractFail("instances connect", WHATSAPP_RPC_ERROR_CODES.runnerUnavailable, WHATSAPP_RUNNER_UNAVAILABLE_MESSAGE, {
    asJson,
    details: {
      retryable: true,
      cause: errorText(err),
      suggestedAction: `Start the channel runner with \`ravi channels start\` (or \`ravi channels restart\` if it is already running), make sure the ravi daemon is up, then retry: ravi instances connect ${name}`,
    },
  });
}

/**
 * Call a WhatsApp RPC, retrying while the runner is unavailable: right after provisioning
 * the runner needs a moment to hot-add the channel (it reconciles on `ravi.config.changed`)
 * before it answers for the new instance.
 */
async function withRunnerRetry<T>(deps: InstancesTransportDependencies, call: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + deps.runnerRetryTimeoutMs;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      if (!isWhatsAppRunnerUnavailable(err) || Date.now() + deps.runnerRetryIntervalMs > deadline) throw err;
      await deps.sleep(deps.runnerRetryIntervalMs);
    }
  }
}

/**
 * `unlinked`: WhatsApp was asked to unlink the device. Only a connected runtime can do that; in
 * every other case the device stays listed on the phone (WhatsApp > Linked devices).
 */
type WhatsAppLogoutOutcome =
  | { via: "runner"; unlinked: boolean; clearedKeys: null; cause: null }
  | { via: "auth-store"; unlinked: false; clearedKeys: number; cause: string };

const REMOVE_LINKED_DEVICE_HINT = "Remove the linked device on the phone: WhatsApp > Linked devices.";

/**
 * Ask the runner to log the instance out (wipes its credentials; unlinks the device when the
 * instance is connected). When the runner cannot do it (not answering, channel not bound, or —
 * with `fallbackOnAnyError` — any other failure) the saved credentials are wiped locally; the
 * linked device then has to be removed on the phone.
 */
async function logoutWhatsApp(
  deps: InstancesTransportDependencies,
  instanceId: string,
  fallbackOnAnyError: boolean,
): Promise<WhatsAppLogoutOutcome> {
  try {
    const result = await deps.whatsapp().connection.logout(instanceId, {});
    return { via: "runner", unlinked: result?.unlinked === true, clearedKeys: null, cause: null };
  } catch (err) {
    if (!fallbackOnAnyError && !isWhatsAppRunnerUnavailable(err) && !isWhatsAppNotBound(err)) throw err;
    const clearedKeys = await deps.clearWhatsAppAuthState(instanceId);
    return { via: "auth-store", unlinked: false, clearedKeys, cause: errorText(err) };
  }
}

/**
 * D18: a WhatsApp instance's channel row follows `instances enable|disable` (and `delete` /
 * `restore`), so the runner starts or stops its runtime. Returns null for non-WhatsApp
 * instances or when no channel exists.
 */
function syncWhatsAppChannelEnabled(
  inst: InstanceConfig,
  enabled: boolean,
): { name: string; enabled: boolean; changed: boolean } | null {
  if (!isWhatsAppInstanceConfig(inst)) return null;
  const channel = findWhatsAppChannelForInstance(loadRouterConfig(), inst.name);
  if (!channel) return null;
  if ((channel.enabled !== false) === enabled) return { name: channel.name, enabled, changed: false };
  dbUpdateChannel(channel.name, { enabled });
  return { name: channel.name, enabled, changed: true };
}

const SETTABLE_KEYS = [
  "agent",
  "dmPolicy",
  "groupPolicy",
  "contactIntakeMode",
  "defaultContactTags",
  "dmScope",
  "instanceId",
  "channel",
  "enabled",
  "defaults",
] as const;
type SettableKey = (typeof SETTABLE_KEYS)[number];

function parseDefaultContactTagsInput(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        fail("defaultContactTags JSON must be an array of strings");
      }
      return (parsed as unknown[])
        .filter((entry): entry is string => typeof entry === "string")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    } catch {
      fail("defaultContactTags must be valid JSON when starting with '['");
    }
  }
  return trimmed
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function ensureConnectAgent(agentId: string | undefined, asJson?: boolean): { id: string; cwd: string } | null {
  if (!agentId || dbGetAgent(agentId)) return null;
  const cwd = `${homedir()}/ravi/${agentId}`;
  mkdirSync(cwd, { recursive: true });
  dbCreateAgent({ id: agentId, cwd });
  if (!asJson) console.log(`✓ Created agent "${agentId}" at ${cwd}`);
  return { id: agentId, cwd };
}

/**
 * Legacy bridge (Telegram/Discord): resolve or create the instance in Omni, then wait for
 * the `ravi.bridge.qr|connected.<uuid>` relay. WhatsApp never comes here (exported for tests).
 */
export async function connectViaLegacyBridge(
  name: string,
  channel: string,
  agent: string | undefined,
  asJson: boolean | undefined,
  deps: InstancesTransportDependencies,
): Promise<void> {
  if (isWhatsAppFamilyChannelType(channel)) {
    contractFail(
      "instances connect",
      "USAGE_ERROR",
      `WhatsApp does not use the legacy bridge (channel "${channel}"). WhatsApp runs natively in ravi: use --channel whatsapp.`,
      {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: `ravi instances connect ${name} --channel whatsapp` },
      },
    );
  }
  const legacy = await deps.legacy();
  if (!legacy) failLegacyBridgeNotConfigured();
  let createdOmniInstance = false;

  let inst = dbGetInstance(name);

  // Resolve or create the bridge instance
  let instanceId = inst?.instanceId ?? "";
  if (!instanceId) {
    // Try to find an existing one in the bridge by name
    try {
      const result = await legacy.list({ channel });
      const existing = result.items.find((i) => i.name === name);
      if (existing?.id) instanceId = existing.id;
    } catch {
      /* bridge offline */
    }
  }

  if (!instanceId) {
    if (!asJson) console.log(`Creating ${channel} instance "${name}" in the legacy bridge...`);
    try {
      const created = await legacy.create({ name, channel });
      instanceId = created.id ?? "";
      createdOmniInstance = true;
      if (!asJson) console.log(`✓ Instance created in the legacy bridge: ${instanceId}`);
    } catch (err) {
      fail(`Failed to create instance in the legacy bridge: ${errorText(err)}`);
    }
  }

  // The agent must exist before the instance row references it.
  const agentId = agent ?? inst?.agent ?? (dbGetAgent(name) ? name : undefined);
  const createdAgent = ensureConnectAgent(agentId, asJson);
  dbUpsertInstance({ name, instanceId, channel, agent: agentId ?? undefined, enabled: inst?.enabled !== false });

  deps.emitConfigChanged();
  const stored = dbGetInstance(name);
  if (!stored) fail(`Instance "${name}" could not be stored (is it soft-deleted? ravi instances deleted)`);
  inst = stored;
  if (!asJson) console.log(`Connecting: ${name} → agent ${inst.agent ?? "(default)"}  [${channel}]`);
  const bridge = { transport: "omni" as const, createdOmniInstance, createdAgent };

  // Check if already connected
  try {
    const status = await legacy.status(instanceId);
    if (status.isConnected) {
      if (asJson) {
        printJson({ status: "connected", instance: inst, live: status, ...bridge, changedCount: 1 });
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
    await legacy.connect(instanceId, {});
  } catch (err) {
    fail(`Failed to initiate connection: ${errorText(err)}`);
  }

  const connectedInstance = inst;
  await waitForPairing({
    instanceId,
    qrTopic: bridgeQrTopic(instanceId),
    connectedTopic: bridgeConnectedTopic(instanceId),
    asJson,
    deps,
    timeoutSuggestion: `Check the legacy bridge connection, then retry: ravi instances connect ${name}`,
    qrPayload: (qr) => ({
      status: "qr_required",
      instance: connectedInstance,
      instanceId,
      channel,
      qr,
      ...bridge,
      changedCount: 1,
    }),
    connectedPayload: (live) => ({
      status: "connected",
      instance: connectedInstance,
      live,
      ...bridge,
      changedCount: 1,
    }),
  }).done;
}

/**
 * WhatsApp: make the instance a WhatsApp instance served by the runner (instance UUID +
 * `whatsapp` channel row), then ask the channel runner over NATS RPC to connect it. QR codes
 * and the connected event come back through the daemon on `ravi.whatsapp.qr|connected.<uuid>`.
 */
async function connectWhatsApp(
  name: string,
  agent: string | undefined,
  asJson: boolean | undefined,
  deps: InstancesTransportDependencies,
): Promise<void> {
  const before = dbGetInstance(name);
  const agentId = agent ?? before?.agent ?? (dbGetAgent(name) ? name : undefined);
  // The agent must exist before the instance row references it.
  const createdAgent = ensureConnectAgent(agentId, asJson);

  let provisioned: WhatsAppInstanceResult;
  try {
    provisioned = deps.provision(name, {
      ...(agentId ? { agent: agentId } : {}),
      emitConfigChanged: deps.emitConfigChanged,
    });
  } catch (err) {
    failProvisioning("instances connect", name, err, asJson);
  }
  const { instanceId } = provisioned;
  const inst = dbGetInstance(name) ?? provisioned.instance;
  const provisioning = {
    transport: "whatsapp" as const,
    channelName: provisioned.channel.name,
    createdInstance: provisioned.createdInstance,
    createdChannel: provisioned.createdChannel,
    mintedInstanceId: provisioned.mintedInstanceId,
    createdAgent,
  };

  if (!asJson) {
    if (provisioned.createdInstance) console.log(`✓ Instance created: ${name} (${instanceId})`);
    else if (provisioned.mintedInstanceId) console.log(`✓ Instance id minted: ${instanceId}`);
    if (provisioned.createdChannel) console.log(`✓ WhatsApp channel created: ${provisioned.channel.name}`);
    console.log(`Connecting: ${name} → agent ${inst.agent ?? "(default)"}  [whatsapp]`);
  }

  const client = deps.whatsapp();
  // The runner hot-adds the channel on ravi.config.changed; retry while it has no responder.
  let status: LiveStatus;
  try {
    status = await withRunnerRetry(deps, () => client.connection.status(instanceId, {}));
  } catch (err) {
    if (isWhatsAppRunnerUnavailable(err)) failRunnerUnavailable(name, err, asJson);
    fail(`Failed to read WhatsApp status: ${errorText(err)}`);
  }

  if (status.isConnected) {
    if (asJson) {
      printJson({ status: "connected", instance: inst, instanceId, live: status, ...provisioning, changedCount: 1 });
      return;
    }
    const profile = status.profileName ? ` as ${status.profileName}` : "";
    console.log(`\n✓ Already connected${profile}`);
    return;
  }

  // Subscribe before asking for a socket so the first QR code is not missed.
  await deps.ensureNats();
  const pairing = waitForPairing({
    instanceId,
    qrTopic: whatsappQrTopic(instanceId),
    connectedTopic: whatsappConnectedTopic(instanceId),
    asJson,
    deps,
    timeoutSuggestion: `Make sure the ravi daemon and the channel runner are running (ravi daemon status; ravi channels status), then retry: ravi instances connect ${name}`,
    qrPayload: (qr) => ({
      status: "qr_required",
      instance: inst,
      instanceId,
      channel: "whatsapp",
      qr,
      ...provisioning,
      changedCount: 1,
    }),
    connectedPayload: (live) => ({
      status: "connected",
      instance: inst,
      instanceId,
      live,
      ...provisioning,
      changedCount: 1,
    }),
  });

  if (!asJson) console.log("Waiting for QR code...\n");
  let connectResult: { status: string; message: string };
  try {
    connectResult = await withRunnerRetry(deps, () =>
      client.connection.connect(instanceId, { whatsapp: { syncFullHistory: false } }),
    );
  } catch (err) {
    pairing.cancel();
    if (isWhatsAppRunnerUnavailable(err)) failRunnerUnavailable(name, err, asJson);
    fail(`Failed to initiate connection: ${errorText(err)}`);
  }

  if (connectResult.status === "connected") {
    pairing.cancel();
    const live = await client.connection.status(instanceId, {}).catch(() => null);
    if (asJson) {
      printJson({
        status: "connected",
        instance: inst,
        instanceId,
        live: live ?? connectResult,
        ...provisioning,
        changedCount: 1,
      });
      return;
    }
    const profile = live?.profileName ? ` as ${live.profileName}` : "";
    console.log(`\n✓ Connected${profile}`);
    return;
  }

  await pairing.done;
}

/**
 * `instances create --channel whatsapp`: the instance UUID and its runner channel row are
 * created together (ensureWhatsAppInstance), so the instance is ready for `connect`.
 */
function createWhatsAppInstance(name: string, asJson: boolean | undefined, settings: WhatsAppInstanceSettings) {
  const deps = transportDeps();
  let result: WhatsAppInstanceResult;
  try {
    result = deps.provision(name, { ...settings, emitConfigChanged: deps.emitConfigChanged });
  } catch (err) {
    failProvisioning("instances create", name, err, asJson);
  }
  const instanceChanged = result.createdInstance || result.mintedInstanceId || result.updatedInstance;
  const changedCount = (instanceChanged ? 1 : 0) + (result.createdChannel ? 1 : 0);
  let status: "created" | "updated" | "unchanged" = "unchanged";
  if (result.createdInstance) status = "created";
  else if (changedCount > 0) status = "updated";
  const payload = {
    status,
    instance: result.instance,
    instanceId: result.instanceId,
    transport: "whatsapp" as const,
    channel: { name: result.channel.name, created: result.createdChannel },
    changedCount,
  };
  if (asJson) {
    printJson(payload);
  } else {
    const verb = status === "unchanged" ? "already exists" : status;
    console.log(`✓ Instance ${verb}: ${name} (channel: whatsapp, instanceId: ${result.instanceId})`);
    if (result.createdChannel) console.log(`  WhatsApp channel created: ${result.channel.name}`);
    if (settings.agent) console.log(`  Agent: ${settings.agent}`);
    console.log(`  Connect it: ravi instances connect ${name}`);
  }
  return payload;
}

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
  @CommandAccess({ kind: "read", resource: "instances", action: "list", risk: "low" })
  async list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical instance tag" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching instances to skip (default: 0)" })
    offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each instance" })
    fields?: string,
  ) {
    const instances = filterItemsByCanonicalTag(dbListInstances(), "instance", tagSlug, (inst) => inst.name);
    const page = paginateCliItems(instances, { limit, offset });
    const pageInstances = page.items;
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "instances", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageInstances.length,
      total: page.total,
      options: ["--tag", tagSlug?.trim() || null],
    });
    const ignoredOmniInstanceIds = getIgnoredOmniInstanceIds();

    // Live status: WhatsApp rows ask the channel runner (short timeout, offline when it
    // does not answer); legacy-bridge rows share one Omni list call when it is configured.
    const deps = transportDeps();
    const liveByName: Record<string, LiveStatus> = {};
    const whatsappRows = pageInstances.filter((inst) => instanceTransport(inst) === "whatsapp" && inst.instanceId);
    if (whatsappRows.length > 0) {
      const whatsapp = deps.whatsapp();
      await Promise.all(
        whatsappRows.map(async (inst) => {
          try {
            const status = await whatsapp.connection.status(
              inst.instanceId as string,
              {},
              { timeoutMs: WHATSAPP_CLIENT_TIMEOUTS_MS.listStatus },
            );
            liveByName[inst.name] = {
              isConnected: status.isConnected,
              profileName: status.profileName ?? undefined,
              state: status.state,
            };
          } catch {
            liveByName[inst.name] = { isConnected: false, state: "disconnected" };
          }
        }),
      );
    }
    const legacyRows = pageInstances.filter((inst) => instanceTransport(inst) === "omni" && inst.instanceId);
    if (legacyRows.length > 0) {
      try {
        const legacy = await deps.legacy();
        const result = legacy ? await legacy.list({}) : { items: [] };
        const bridgeItems = new Map<string, LegacyInstanceRecord>();
        for (const item of result.items) {
          // WhatsApp-family bridge records never describe a ravi instance any more.
          if (item.id && !isWhatsAppFamilyChannelType(item.channel)) bridgeItems.set(item.id, item);
        }
        for (const inst of legacyRows) {
          const item = bridgeItems.get(inst.instanceId as string);
          if (item) liveByName[inst.name] = { isConnected: item.isActive, profileName: item.profileName ?? undefined };
        }
      } catch {
        /* legacy bridge offline */
      }
    }

    const instanceRows = pickFields(
      pageInstances.map((inst) => ({
        ...inst,
        tags: listInstanceTags(inst.name),
        raviStatus: inst.enabled === false ? "disabled" : "enabled",
        transport: instanceTransport(inst),
        live: inst.instanceId ? (liveByName[inst.name] ?? null) : null,
      })),
      fields,
    );
    const payload = {
      filter: { tagSlug: tagSlug?.trim() || null },
      total: page.total,
      pagination,
      items: instanceRows,
      instances: instanceRows,
      ignoredOmniInstanceIds,
    };

    if (asJson) {
      printJson(payload);
    } else if (pageInstances.length === 0) {
      console.log(tagSlug ? `No registered instances tagged "${tagSlug}".` : "No registered instances configured.");
      if (ignoredOmniInstanceIds.length > 0) {
        console.log("\nIgnored unknown omni instanceIds:\n");
        for (const instanceId of ignoredOmniInstanceIds) {
          console.log(`  ${instanceId}`);
        }
      } else {
        console.log("\nCreate one: ravi instances create <name> --channel whatsapp");
      }
    } else {
      console.log("\nInstances:\n");
      console.log(
        "  NAME                 CHANNEL       AGENT           RAVI      DM           GROUP        INTAKE       STATUS",
      );
      console.log(
        "  -------------------- ------------- --------------- --------- ------------ ------------ ------------ ----------",
      );

      for (const inst of pageInstances) {
        const live = liveByName[inst.name];
        let status: string;
        if (instanceTransport(inst) === null) status = "unsupported";
        else if (!inst.instanceId) status = "no-instance-id";
        else status = live?.isConnected ? "connected" : "disconnected";
        const profile = inst.instanceId ? (live?.profileName ?? "") : "";
        const label = profile ? `${status} (${profile})` : status;
        console.log(
          `  ${inst.name.padEnd(20)} ${inst.channel.padEnd(13)} ${(inst.agent ?? "-").padEnd(15)} ${(inst.enabled === false ? "disabled" : "enabled").padEnd(9)} ${inst.dmPolicy.padEnd(12)} ${inst.groupPolicy.padEnd(12)} ${inst.contactIntakeMode.padEnd(12)} ${label}`,
        );
      }
      console.log(
        `\n  Total: ${page.total} (${pageInstances.length} returned, limit ${page.limit}, offset ${page.offset})`,
      );
      if (pagination.nextCommand) {
        console.log("\n  Next page:");
        console.log(`    ${pagination.nextCommand}`);
      }

      if (ignoredOmniInstanceIds.length > 0) {
        console.log("\nIgnored unknown omni instanceIds:\n");
        for (const instanceId of ignoredOmniInstanceIds) {
          console.log(`  ${instanceId}`);
        }
      }
    }
    return payload;
  }

  // --------------------------------------------------------------------------
  // show
  // --------------------------------------------------------------------------
  @Command({ name: "show", description: "Show instance details" })
  @CommandAccess({ kind: "read", resource: "instances", action: "show", risk: "low" })
  async show(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = requireInstance("instances show", name, asJson);

    const routes = dbListRoutes(name);

    let live: LiveStatus = {};
    const transport = instanceTransport(inst);
    if (inst.instanceId && transport) {
      try {
        live = await readLiveStatus(transportDeps(), inst.instanceId, transport);
      } catch {
        /* the channel runner or the legacy bridge is offline */
      }
    }

    const payload = {
      instance: {
        ...inst,
        tags: listInstanceTags(inst.name),
        raviStatus: inst.enabled === false ? "disabled" : "enabled",
      },
      routes,
      transport,
      live: inst.instanceId ? live : null,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nInstance: ${inst.name}\n`);
      printInspectionField("Channel", inst.channel, CONFIG_DB_META);
      printInspectionField("Instance ID", inst.instanceId ?? "(not set)", CONFIG_DB_META);
      printInspectionField("Ravi", inst.enabled === false ? "disabled" : "enabled", CONFIG_DB_META);
      printInspectionField("Agent", inst.agent ?? "(default)", CONFIG_DB_META);
      printInspectionField("DM Policy", inst.dmPolicy, CONFIG_DB_META);
      printInspectionField("Group Policy", inst.groupPolicy, CONFIG_DB_META);
      printInspectionField("Contact Intake", inst.contactIntakeMode, CONFIG_DB_META);
      const defaultContactTagList =
        inst.defaultContactTags && inst.defaultContactTags.length > 0 ? inst.defaultContactTags.join(", ") : "-";
      printInspectionField("Default Contact Tags", defaultContactTagList, CONFIG_DB_META);
      const instanceTags = listInstanceTags(inst.name);
      printInspectionField(
        "Tags",
        instanceTags.length > 0 ? instanceTags.map((tag) => tag.tagSlug).join(", ") : "-",
        CONFIG_DB_META,
      );
      if (inst.dmScope) printInspectionField("DM Scope", inst.dmScope, CONFIG_DB_META);
      if (inst.defaults && Object.keys(inst.defaults).length > 0) {
        printInspectionField("Defaults", JSON.stringify(inst.defaults), CONFIG_DB_META);
      }
      printInspectionField("Transport", transportLabel(transport), CONFIG_DB_META);
      if (inst.instanceId && transport) {
        const meta = liveStatusMeta(transport);
        printInspectionField("Connected", live.isConnected ?? "unknown", meta);
        if (live.profileName) printInspectionField("Profile", live.profileName, meta);
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
    return payload;
  }

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------
  @Command({ name: "create", description: "Create a new instance" })
  @CommandAccess({ kind: "mutate", resource: "instances", action: "create", risk: "medium" })
  create(
    @Arg("name", { description: "Instance name (e.g., main, vendas)" }) name: string,
    @Option({ flags: "--channel <channel>", description: "Channel type (default: whatsapp)" }) channel?: string,
    @Option({ flags: "--agent <id>", description: "Default agent for this instance" }) agent?: string,
    @Option({ flags: "--dm-policy <policy>", description: "DM policy: open|pairing|closed (default: open)" })
    dmPolicy?: string,
    @Option({ flags: "--group-policy <policy>", description: "Group policy: open|allowlist|closed (default: open)" })
    groupPolicy?: string,
    @Option({
      flags: "--contact-intake-mode <mode>",
      description: "Inbound DM contact intake: off|discovered|pending (default: off)",
    })
    contactIntakeMode?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const resolvedChannel = channel ?? "whatsapp";
    if (!isWhatsAppChannelType(resolvedChannel) && isWhatsAppFamilyChannelType(resolvedChannel)) {
      failUnsupportedWhatsAppFamily("instances create", name, resolvedChannel, asJson);
    }
    if (agent && !dbGetAgent(agent)) {
      fail(
        `Agent not found: ${agent}. Available: ${dbListAgents()
          .map((a) => a.id)
          .join(", ")}`,
      );
    }
    let parsedDmPolicy: InstanceConfig["dmPolicy"] | undefined;
    if (dmPolicy) {
      const r = DmPolicySchema.safeParse(dmPolicy);
      if (!r.success) fail(`Invalid dmPolicy: ${dmPolicy}. Valid: open, pairing, closed`);
      parsedDmPolicy = r.data;
    }
    let parsedGroupPolicy: InstanceConfig["groupPolicy"] | undefined;
    if (groupPolicy) {
      const r = GroupPolicySchema.safeParse(groupPolicy);
      if (!r.success) fail(`Invalid groupPolicy: ${groupPolicy}. Valid: open, allowlist, closed`);
      parsedGroupPolicy = r.data;
    }
    let parsedIntakeMode: InstanceConfig["contactIntakeMode"] | undefined;
    if (contactIntakeMode) {
      const r = ContactIntakeModeSchema.safeParse(contactIntakeMode);
      if (!r.success) fail(`Invalid contactIntakeMode: ${contactIntakeMode}. Valid: off, discovered, pending`);
      parsedIntakeMode = r.data;
    }

    if (isWhatsAppChannelType(resolvedChannel)) {
      return createWhatsAppInstance(name, asJson, {
        ...(agent ? { agent } : {}),
        ...(parsedDmPolicy ? { dmPolicy: parsedDmPolicy } : {}),
        ...(parsedGroupPolicy ? { groupPolicy: parsedGroupPolicy } : {}),
        ...(parsedIntakeMode ? { contactIntakeMode: parsedIntakeMode } : {}),
      });
    }

    try {
      const instance = dbUpsertInstance({
        name,
        channel: resolvedChannel,
        agent: agent ?? undefined,
        dmPolicy: parsedDmPolicy ?? "open",
        groupPolicy: parsedGroupPolicy ?? "open",
        contactIntakeMode: parsedIntakeMode ?? "off",
      });
      const payload = {
        status: "created" as const,
        instance,
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Instance created: ${name} (channel: ${resolvedChannel})`);
        if (agent) console.log(`  Agent: ${agent}`);
      }
      emitConfigChanged();
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------
  @Command({ name: "get", description: "Get an instance property" })
  @CommandAccess({ kind: "read", resource: "instances", action: "get", risk: "low" })
  get(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("key", { description: `Property key (${SETTABLE_KEYS.join(", ")})` }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = dbGetInstance(name);
    if (!inst) failInstanceNotFound("instances get", name, asJson);
    const val = (inst as unknown as Record<string, unknown>)[key];
    if (val === undefined) fail(`Unknown key: ${key}. Valid keys: ${SETTABLE_KEYS.join(", ")}`);
    const payload = {
      instance: name,
      key,
      value: val ?? null,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`${name}.${key}: ${val ?? "(not set)"}`);
    }
    return payload;
  }

  // --------------------------------------------------------------------------
  // set
  // --------------------------------------------------------------------------
  @Command({ name: "set", description: "Set an instance property" })
  @CommandAccess({ kind: "mutate", resource: "instances", action: "set", risk: "medium" })
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
    if (!inst) failInstanceNotFound("instances set", name, asJson);

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
    } else if (key === "contactIntakeMode") {
      const r = ContactIntakeModeSchema.safeParse(value);
      if (!r.success) fail(`Invalid contactIntakeMode: ${value}. Valid: off, discovered, pending`);
      dbUpdateInstance(name, { contactIntakeMode: r.data });
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
    } else if (key === "defaultContactTags") {
      if (clear) {
        jsonValue = [];
        dbUpdateInstance(name, { defaultContactTags: null });
      } else {
        const tags = parseDefaultContactTagsInput(value);
        jsonValue = tags;
        dbUpdateInstance(name, { defaultContactTags: tags });
      }
    }

    const updated = dbGetInstance(name);
    const payload = {
      status: "updated" as const,
      key,
      value: jsonValue,
      instance: updated,
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ ${name}.${key} = ${clear ? "(cleared)" : value}`);
    }
    emitConfigChanged();
    return payload;
  }

  // --------------------------------------------------------------------------
  // enable
  // --------------------------------------------------------------------------
  @Command({ name: "enable", description: "Enable an instance in Ravi (WhatsApp: also starts its runner channel)" })
  @CommandAccess({ kind: "mutate", resource: "instances", action: "enable", risk: "medium" })
  enable(
    @Arg("target", { description: "Instance name or instanceId" }) target: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = resolveInstanceByNameOrId(target);
    if (!inst) {
      const ignored = getIgnoredOmniInstanceIds();
      if (!ignored.includes(target)) failInstanceNotFound("instances enable", target, asJson);
      saveIgnoredOmniInstanceIds(ignored.filter((instanceId) => instanceId !== target));
      const payload = {
        status: "ignored_removed" as const,
        target,
        changedCount: 1,
        ignoredOmniInstanceIds: getIgnoredOmniInstanceIds(),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Removed ignored unknown omni instanceId from ravi: ${target}`);
      }
      return payload;
    }
    const instanceChanged = inst.enabled === false;
    const updated = instanceChanged ? dbUpdateInstance(inst.name, { enabled: true }) : inst;
    const channel = syncWhatsAppChannelEnabled(updated, true);
    const changedCount = (instanceChanged ? 1 : 0) + (channel?.changed ? 1 : 0);
    const payload = {
      status: changedCount > 0 ? ("enabled" as const) : ("unchanged" as const),
      target,
      instance: updated,
      channel,
      changedCount,
    };
    if (asJson) {
      printJson(payload);
    } else if (changedCount === 0) {
      console.log(`Instance already enabled in ravi: ${inst.name}`);
    } else {
      console.log(`✓ Instance enabled in ravi: ${inst.name}`);
      if (channel?.changed) console.log(`  WhatsApp channel enabled: ${channel.name} (the channel runner starts it)`);
    }
    if (changedCount > 0) emitConfigChanged();
    return payload;
  }

  // --------------------------------------------------------------------------
  // disable
  // --------------------------------------------------------------------------
  @Command({
    name: "disable",
    description:
      "Disable an instance in Ravi (WhatsApp: also stops its runner channel; legacy-bridge connections are not changed)",
  })
  @CommandAccess({ kind: "mutate", resource: "instances", action: "disable", risk: "medium" })
  disable(
    @Arg("target", { description: "Instance name or instanceId" }) target: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = resolveInstanceByNameOrId(target);
    if (!inst) {
      const ignored = getIgnoredOmniInstanceIds();
      if (ignored.includes(target)) {
        const payload = {
          status: "unchanged" as const,
          target,
          changedCount: 0,
          ignoredOmniInstanceIds: ignored,
        };
        if (asJson) {
          printJson(payload);
        } else {
          console.log(`Unknown omni instanceId already ignored in ravi: ${target}`);
        }
        return payload;
      }
      saveIgnoredOmniInstanceIds([...ignored, target]);
      const payload = {
        status: "ignored" as const,
        target,
        changedCount: 1,
        ignoredOmniInstanceIds: getIgnoredOmniInstanceIds(),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Ignoring unknown omni instanceId in ravi: ${target}`);
      }
      return payload;
    }
    const instanceChanged = inst.enabled !== false;
    const updated = instanceChanged ? dbUpdateInstance(inst.name, { enabled: false }) : inst;
    const channel = syncWhatsAppChannelEnabled(updated, false);
    const changedCount = (instanceChanged ? 1 : 0) + (channel?.changed ? 1 : 0);
    const payload = {
      status: changedCount > 0 ? ("disabled" as const) : ("unchanged" as const),
      target,
      instance: updated,
      channel,
      changedCount,
    };
    if (asJson) {
      printJson(payload);
    } else if (changedCount === 0) {
      console.log(`Instance already disabled in ravi: ${inst.name}`);
    } else {
      console.log(`✓ Instance disabled in ravi: ${inst.name}`);
      if (channel?.changed) console.log(`  WhatsApp channel disabled: ${channel.name} (the channel runner stops it)`);
    }
    if (changedCount > 0) emitConfigChanged();
    return payload;
  }

  // --------------------------------------------------------------------------
  // delete
  // --------------------------------------------------------------------------
  @Command({
    name: "delete",
    description:
      "Delete an instance (soft-delete, recoverable; WhatsApp: also logs out, wipes its credentials and disables its channel)",
  })
  @CommandAccess({ kind: "mutate", resource: "instances", action: "delete", risk: "medium" })
  async delete(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = dbGetInstance(name);
    if (!inst) failInstanceNotFound("instances delete", name, asJson);

    // A deleted WhatsApp instance must not keep a linked device or credentials behind.
    let whatsappLogout:
      | WhatsAppLogoutOutcome
      | { via: "failed"; unlinked: false; clearedKeys: null; cause: string }
      | null = null;
    if (isWhatsAppInstanceConfig(inst) && inst.instanceId) {
      try {
        whatsappLogout = await logoutWhatsApp(transportDeps(), inst.instanceId, true);
      } catch (err) {
        whatsappLogout = { via: "failed", unlinked: false, clearedKeys: null, cause: errorText(err) };
      }
    }

    const deleted = dbDeleteInstance(name);
    if (!deleted) fail(`Failed to delete instance: ${name}`);
    // Before the config change: the runner then stops the channel instead of retrying an
    // unbound start (a deleted instance has no binding) and reporting itself degraded.
    const channel = syncWhatsAppChannelEnabled(inst, false);
    const payload = {
      status: "deleted" as const,
      instance: inst,
      whatsappLogout,
      channel,
      changedCount: 1 + (channel?.changed ? 1 : 0),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Instance deleted: ${name} (recoverable with: ravi instances restore ${name})`);
      if (channel?.changed) console.log(`  WhatsApp channel disabled: ${channel.name} (the channel runner stops it)`);
      if (whatsappLogout?.via === "runner" && whatsappLogout.unlinked) {
        console.log("  WhatsApp logged out: device unlinked, credentials wiped");
      }
      if (whatsappLogout?.via === "runner" && !whatsappLogout.unlinked) {
        console.log("  WhatsApp credentials wiped (the instance was not connected, so the device was not unlinked).");
        console.log(`  ${REMOVE_LINKED_DEVICE_HINT}`);
      }
      if (whatsappLogout?.via === "auth-store") {
        console.log("  WhatsApp credentials wiped locally (the channel runner did not log out).");
        console.log(`  ${REMOVE_LINKED_DEVICE_HINT}`);
      }
      if (whatsappLogout?.via === "failed") {
        console.log(`  Warning: WhatsApp credentials were not wiped: ${whatsappLogout.cause}`);
      }
    }
    emitConfigChanged();
    return payload;
  }

  // --------------------------------------------------------------------------
  // restore
  // --------------------------------------------------------------------------
  @Command({
    name: "restore",
    description: "Restore a soft-deleted instance (WhatsApp: re-enables its channel when the instance is enabled)",
  })
  @CommandAccess({ kind: "mutate", resource: "instances", action: "restore", risk: "medium" })
  restore(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ok = dbRestoreInstance(name);
    if (ok) {
      const restored = dbGetInstance(name);
      // `delete` disabled the WhatsApp channel; it follows the restored instance's state again.
      const channel = restored ? syncWhatsAppChannelEnabled(restored, restored.enabled !== false) : null;
      const payload = {
        status: "restored" as const,
        instance: restored,
        channel,
        changedCount: 1 + (channel?.changed ? 1 : 0),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Instance restored: ${name}`);
        if (channel?.changed && channel.enabled) {
          console.log(`  WhatsApp channel enabled: ${channel.name} (the channel runner starts it)`);
          console.log(`  Pair it again if delete wiped its credentials: ravi instances connect ${name}`);
        }
      }
      emitConfigChanged();
      return payload;
    } else {
      contractFail("instances restore", "INSTANCE_NOT_FOUND", `Instance not found in deleted records: ${name}`, {
        asJson,
        details: {
          suggestedAction: "Check deleted instances (see suggestions; list with: ravi instances deleted --json)",
          suggestions: suggestSimilar(
            name,
            dbListDeletedInstances().map((inst) => inst.name),
          ),
        },
      });
    }
  }

  // --------------------------------------------------------------------------
  // deleted
  // --------------------------------------------------------------------------
  @Command({ name: "deleted", description: "List soft-deleted instances" })
  @CommandAccess({ kind: "read", resource: "instances", action: "deleted", risk: "low" })
  deleted(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const instances = dbListDeletedInstances();
    const payload = {
      total: instances.length,
      instances,
    };
    if (asJson) {
      printJson(payload);
    } else if (instances.length === 0) {
      console.log("No deleted instances.");
    } else {
      console.log("\nDeleted Instances:\n");
      for (const inst of instances) {
        const deletedAt = new Date(inst.deletedAt!).toLocaleString();
        console.log(`  ${inst.name.padEnd(20)} channel: ${inst.channel.padEnd(12)} deleted: ${deletedAt}`);
      }
      console.log(`\nRestore with: ravi instances restore <name>`);
    }
    return payload;
  }

  // --------------------------------------------------------------------------
  // connect
  // --------------------------------------------------------------------------
  @Command({
    name: "connect",
    description: "Connect an instance (QR code for WhatsApp, served by the ravi channels runner)",
  })
  @CommandAccess({ kind: "mutate", resource: "instances", action: "connect", risk: "high", input: ["name"] })
  @CliOnly()
  async connect(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--channel <channel>", description: "Channel type (default: whatsapp)" }) channelOpt?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route messages to" }) agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const deps = transportDeps();
    const channel = channelOpt ?? dbGetInstance(name)?.channel ?? "whatsapp";
    if (isWhatsAppChannelType(channel)) return connectWhatsApp(name, agent, asJson, deps);
    if (isWhatsAppFamilyChannelType(channel)) failUnsupportedWhatsAppFamily("instances connect", name, channel, asJson);
    return connectViaLegacyBridge(name, channel, agent, asJson, deps);
  }

  // --------------------------------------------------------------------------
  // disconnect
  // --------------------------------------------------------------------------
  @Command({ name: "disconnect", description: "Disconnect an instance (WhatsApp runner or legacy bridge)" })
  @CommandAccess({ kind: "mutate", resource: "instances", action: "disconnect", risk: "medium" })
  async disconnect(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = dbGetInstance(name);
    if (!inst) failInstanceNotFound("instances disconnect", name, asJson);
    const transport = instanceTransport(inst);
    if (!transport) failUnsupportedWhatsAppFamily("instances disconnect", name, inst.channel, asJson);
    const instanceId = inst.instanceId;
    if (!instanceId) fail(`Instance "${name}" has no instanceId set`);
    const deps = transportDeps();
    const legacy = transport === "omni" ? await deps.legacy() : null;
    if (transport === "omni" && !legacy) failLegacyBridgeNotConfigured();
    try {
      if (legacy) await legacy.disconnect(instanceId);
      else await deps.whatsapp().connection.disconnect(instanceId, {});
    } catch (err) {
      fail(`Failed to disconnect: ${errorText(err)}`);
    }
    const payload = {
      status: "disconnected" as const,
      instance: inst,
      transport,
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Disconnected: ${name}`);
      if (transport === "whatsapp") {
        // R4: the runner persists a manual disconnect; it does not auto-connect again until `connect`.
        console.log(`  Stays disconnected across runner restarts. Reconnect with: ravi instances connect ${name}`);
      }
    }
    return payload;
  }

  // --------------------------------------------------------------------------
  // logout
  // --------------------------------------------------------------------------
  @Command({
    name: "logout",
    description:
      "Log a WhatsApp instance out: wipe its saved credentials and unlink the device when connected (dry-run without --execute)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "instances",
    action: "logout",
    risk: "destructive",
    requiresConfirmation: true,
  })
  async logout(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually log out and wipe the credentials; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const inst = requireInstance("instances logout", name, asJson);
    if (!isWhatsAppInstanceConfig(inst)) {
      contractFail(
        "instances logout",
        "USAGE_ERROR",
        `instances logout only supports WhatsApp (channel "${inst.channel}")`,
        {
          asJson,
          exitCode: CONTRACT_EXIT_USAGE,
          details: { suggestedAction: `Disconnect it instead: ravi instances disconnect ${name}` },
        },
      );
    }
    const instanceId = inst.instanceId;
    if (!instanceId) {
      contractFail("instances logout", "USAGE_ERROR", `Instance "${name}" has no instanceId: nothing to log out`, {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: `Pair it first: ravi instances connect ${name}` },
      });
    }
    if (execute !== true) {
      // Write brake: logging out wipes the credentials and unlinks a connected device (a new QR pairing is needed).
      contractDryRun(
        "instances logout",
        {
          instance: name,
          instanceId,
          transport: "whatsapp",
          actions: [
            "ask the channel runner to log out (wipes the saved credentials; unlinks the device when connected)",
            "when the runner does not answer: wipe the saved credentials locally",
          ],
        },
        { asJson },
      );
    }

    let outcome: WhatsAppLogoutOutcome;
    try {
      outcome = await logoutWhatsApp(transportDeps(), instanceId, false);
    } catch (err) {
      fail(`Failed to log out: ${errorText(err)}`);
    }
    const payload = {
      status: "logged_out" as const,
      instance: name,
      instanceId,
      transport: "whatsapp" as const,
      logout: outcome,
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else if (outcome.via === "runner" && outcome.unlinked) {
      console.log(`✓ Logged out: ${name} (device unlinked, credentials wiped)`);
    } else if (outcome.via === "runner") {
      console.log(
        `✓ Logged out: ${name} (credentials wiped; the instance was not connected, so the device was not unlinked)`,
      );
      console.log(`  ${REMOVE_LINKED_DEVICE_HINT}`);
    } else {
      console.log(`✓ Credentials wiped locally: ${name} (the channel runner did not answer: ${outcome.cause})`);
      console.log(`  ${REMOVE_LINKED_DEVICE_HINT}`);
    }
    return payload;
  }

  // --------------------------------------------------------------------------
  // status
  // --------------------------------------------------------------------------
  @Command({ name: "status", description: "Show connection status for an instance" })
  @CommandAccess({ kind: "read", resource: "instances", action: "status", risk: "low" })
  async status(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const inst = dbGetInstance(name);
    if (!inst) failInstanceNotFound("instances status", name, asJson);
    const transport = instanceTransport(inst);
    if (!transport) failUnsupportedWhatsAppFamily("instances status", name, inst.channel, asJson);
    const instanceId = inst.instanceId;
    if (!instanceId) {
      const payload = {
        instance: inst,
        transport,
        live: null,
        status: "no_instance_id" as const,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`\nInstance: ${name}\n  instanceId: (not set — run "ravi instances connect ${name}")`);
      }
      return payload;
    }
    let s: LiveStatus;
    try {
      s = await readLiveStatus(transportDeps(), instanceId, transport);
    } catch (err) {
      if (err instanceof CliExpectedError) throw err;
      fail(`Error fetching status: ${errorText(err)}`);
    }
    const meta = liveStatusMeta(transport);
    const payload = {
      instance: {
        ...inst,
        raviStatus: inst.enabled === false ? "disabled" : "enabled",
      },
      transport,
      live: s,
      status: (s.isConnected ? "connected" : "disconnected") as "connected" | "disconnected",
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nInstance: ${name}\n`);
      printInspectionField("Instance ID", instanceId, CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("Channel", inst.channel, CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("Ravi", inst.enabled === false ? "disabled" : "enabled", CONFIG_DB_META, {
        labelWidth: 15,
      });
      printInspectionField("Transport", transportLabel(transport), CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("State", s.state ?? "unknown", meta, { labelWidth: 15 });
      printInspectionField("Connected", s.isConnected ?? false, meta, { labelWidth: 15 });
      if (s.profileName) printInspectionField("Profile", s.profileName, meta, { labelWidth: 15 });
      printInspectionField("Agent", inst.agent ?? "(default)", CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("DM Policy", inst.dmPolicy, CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("Group Policy", inst.groupPolicy, CONFIG_DB_META, { labelWidth: 15 });
      printInspectionField("Contact Intake", inst.contactIntakeMode, CONFIG_DB_META, { labelWidth: 15 });
    }
    return payload;
  }

  @Command({ name: "target", description: "Explain which runtime, DB, and live instance this CLI would affect" })
  @CommandAccess({ kind: "read", resource: "instances", action: "target", risk: "low" })
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
    const payload = buildRouteExplanationPayload("instances target", name, pattern, channel, asJson);
    if (asJson) {
      printJson(payload);
    } else {
      printRouteExplanation("instances target", name, pattern, channel);
    }
    return payload;
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
  @CommandAccess({ kind: "read", resource: "routes", action: "list", risk: "low" })
  list(
    @Arg("name", { description: "Instance name (omit for all)", required: false }) name?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical route tag" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching routes to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each route" })
    fields?: string,
  ) {
    const payload = buildRouteListPayload("routes list", name, tagSlug, limit, offset, undefined, fields, asJson);
    if (asJson) {
      printJson(payload);
    } else {
      printRouteList("routes list", name, tagSlug, limit, offset);
    }
    return payload;
  }

  @Command({ name: "show", description: "Show route details" })
  @CommandAccess({ kind: "read", resource: "routes", action: "show", risk: "low" })
  show(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const payload = buildRouteDetailsPayload("routes show", name, pattern, asJson);
    if (asJson) {
      printJson(payload);
    } else {
      printRouteDetails("routes show", name, pattern);
    }
    return payload;
  }

  @Command({ name: "explain", description: "Explain how a pattern resolves in config and the live router" })
  @CommandAccess({ kind: "read", resource: "routes", action: "explain", risk: "low" })
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
    const payload = buildRouteExplanationPayload("routes explain", name, pattern, channel, asJson);
    if (asJson) {
      printJson(payload);
    } else {
      printRouteExplanation("routes explain", name, pattern, channel);
    }
    return payload;
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
  @CommandAccess({ kind: "read", resource: "instances.routes", action: "list", risk: "low" })
  list(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical route tag" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching routes to skip (default: 0)" }) offset?: string,
  ) {
    const baseCommand = ["ravi", "instances", "routes", "list", name];
    const payload = buildRouteListPayload(
      "instances routes list",
      name,
      tagSlug,
      limit,
      offset,
      baseCommand,
      undefined,
      asJson,
    );
    if (asJson) {
      printJson(payload);
    } else {
      printRouteList("instances routes list", name, tagSlug, limit, offset, baseCommand);
    }
    return payload;
  }

  @Command({ name: "show", description: "Show route details" })
  @CommandAccess({ kind: "read", resource: "instances.routes", action: "show", risk: "low" })
  show(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const payload = buildRouteDetailsPayload("instances routes show", name, pattern, asJson);
    if (asJson) {
      printJson(payload);
    } else {
      printRouteDetails("instances routes show", name, pattern);
    }
    return payload;
  }

  @Command({ name: "add", description: "Add a route to an instance" })
  @CommandAccess({ kind: "mutate", resource: "instances.routes", action: "add", risk: "medium" })
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
    if (!dbGetInstance(name)) failInstanceNotFound("instances routes add", name, asJson);
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
    const storedPattern = canonicalizeRoutePatternArg(pattern);

    try {
      const route = dbCreateRoute({
        pattern: storedPattern,
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
      let removedPending = removeAccountPending(name, storedPattern);
      if (!removedPending) {
        const contact = getContact(storedPattern) ?? getContact(pattern);
        if (contact) {
          for (const id of contact.identities) {
            if (removeAccountPending(name, id.value)) {
              removedPending = true;
              break;
            }
          }
        }
      }

      // Drop inbound subscriptions that would keep this chat on the previous
      // agent, then delete sessions the pattern heuristic still owns.
      const released = releaseRouteAgentStickiness(name, storedPattern, agent, channel, asJson);

      const payload = {
        status: "added" as const,
        instance: name,
        route,
        target: inspectCliRuntimeTarget(name),
        liveEffect: getRouteLiveEffect(name, storedPattern, agent, channel),
        removedPending,
        cleanedSessions: released.cleanedSessions,
        detachedSubscriptions: released.detachedSubscriptions,
        stickyAttach: released.stickyAttach,
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        printInstanceMutationTarget(name);
        const policyLabel = policy ? ` [policy:${policy}]` : "";
        const channelLabel = channel ? ` [channel:${channel}]` : "";
        console.log(`✓ Route added: ${storedPattern} → ${agent} (instance: ${name})${policyLabel}${channelLabel}`);
        printRouteLiveEffect(name, storedPattern, agent, channel);
        if (removedPending) console.log(`✓ Removed from pending`);
        if (released.detachedSubscriptions > 0) {
          console.log(`✓ Detached ${released.detachedSubscriptions} route subscription(s)`);
        }
        printStickyAttachWarning(released.stickyAttach.overrides);
        if (released.cleanedSessions > 0) {
          console.log(`✓ Cleaned ${released.cleanedSessions} conflicting session(s)`);
        }
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "remove", description: "Remove a route (soft-delete, recoverable)" })
  @CommandAccess({ kind: "mutate", resource: "instances.routes", action: "remove", risk: "high" })
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
    if (!dbGetInstance(name)) failInstanceNotFound("instances routes remove", name, asJson);
    const routePattern = canonicalizeRoutePatternArg(pattern);
    const route = dbGetRoute(routePattern, name);
    if (!route) failRouteNotFound("instances routes remove", name, routePattern, asJson);
    assertInstanceMutationRuntime(name, allowRuntimeMismatch);
    const deleted = dbDeleteRoute(routePattern, name);
    if (deleted) {
      const payload = {
        status: "removed" as const,
        instance: name,
        pattern: routePattern,
        route,
        target: inspectCliRuntimeTarget(name),
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        printInstanceMutationTarget(name);
        console.log(
          `✓ Route removed: ${routePattern} (instance: ${name}) — restore with: ravi instances routes restore ${name} "${routePattern}"`,
        );
      }
      emitConfigChanged();
      return payload;
    } else {
      failRouteNotFound("instances routes remove", name, routePattern, asJson);
    }
  }

  @Command({ name: "restore", description: "Restore a soft-deleted route" })
  @CommandAccess({ kind: "mutate", resource: "instances.routes", action: "restore", risk: "medium" })
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
    const routePattern = canonicalizeRoutePatternArg(pattern);
    const ok = dbRestoreRoute(routePattern, name);
    if (ok) {
      const payload = {
        status: "restored" as const,
        instance: name,
        pattern: routePattern,
        route: dbGetRoute(routePattern, name),
        target: inspectCliRuntimeTarget(name),
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        printInstanceMutationTarget(name);
        console.log(`✓ Route restored: ${routePattern} (instance: ${name})`);
      }
      emitConfigChanged();
      return payload;
    } else {
      contractFail(
        "instances routes restore",
        "ROUTE_NOT_FOUND",
        `Route not found in deleted records: ${routePattern} (instance: ${name})`,
        {
          asJson,
          details: {
            suggestedAction: "Check deleted routes (see suggestions; list with: ravi instances routes deleted --json)",
            suggestions: suggestSimilar(
              routePattern,
              dbListDeletedRoutes(name).map((route) => route.pattern),
            ),
          },
        },
      );
    }
  }

  @Command({ name: "deleted", description: "List soft-deleted routes" })
  @CommandAccess({ kind: "read", resource: "instances.routes", action: "deleted", risk: "low" })
  deleted(
    @Arg("name", { description: "Instance name (omit for all)", required: false }) name?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const routes = dbListDeletedRoutes(name);
    const payload = {
      instance: name ?? null,
      total: routes.length,
      routes,
    };
    if (asJson) {
      printJson(payload);
    } else if (routes.length === 0) {
      console.log("No deleted routes.");
    } else {
      console.log("\nDeleted Routes:\n");
      for (const r of routes) {
        console.log(`  ${r.accountId.padEnd(16)} ${r.pattern.padEnd(24)} → ${r.agent}`);
      }
      console.log(`\nRestore with: ravi instances routes restore <instance> "<pattern>"`);
    }
    return payload;
  }

  @Command({ name: "set", description: "Set a route property" })
  @CommandAccess({ kind: "mutate", resource: "instances.routes", action: "set", risk: "medium" })
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
    if (!dbGetInstance(name)) failInstanceNotFound("instances routes set", name, asJson);
    const routePattern = canonicalizeRoutePatternArg(pattern);
    if (!dbGetRoute(routePattern, name)) failRouteNotFound("instances routes set", name, routePattern, asJson);
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
      const route = dbUpdateRoute(routePattern, updates, name);
      emitConfigChanged();

      const routeChannel = typeof route?.channel === "string" ? route.channel : undefined;
      const released =
        key === "agent" && !clear
          ? releaseRouteAgentStickiness(name, routePattern, value, routeChannel, asJson)
          : { detachedSubscriptions: 0, cleanedSessions: 0, stickyAttach: { overrides: [] as RouteStickyOverride[] } };

      const payload = {
        status: "updated" as const,
        instance: name,
        pattern: routePattern,
        key,
        value: jsonValue,
        route,
        target: inspectCliRuntimeTarget(name),
        liveEffect: key === "agent" && !clear ? getRouteLiveEffect(name, routePattern, value, routeChannel) : null,
        cleanedSessions: released.cleanedSessions,
        detachedSubscriptions: released.detachedSubscriptions,
        stickyAttach: key === "agent" && !clear ? released.stickyAttach : null,
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        printInstanceMutationTarget(name);
        console.log(`✓ ${key} set on route ${routePattern} (instance: ${name}): ${clear ? "(cleared)" : value}`);
        if (key === "agent" && !clear) {
          printRouteLiveEffect(name, routePattern, value, routeChannel);
          if (released.detachedSubscriptions > 0) {
            console.log(`✓ Detached ${released.detachedSubscriptions} route subscription(s)`);
          }
          printStickyAttachWarning(released.stickyAttach.overrides);
        }
        if (released.cleanedSessions > 0) {
          console.log(`✓ Cleaned ${released.cleanedSessions} conflicting session(s)`);
        }
      }
      return payload;
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
  description: "Manage pending contact and chat review for an instance",
  scope: "admin",
})
export class InstancesPendingCommands {
  @Command({ name: "list", description: "List pending contacts and chats for an instance" })
  @CommandAccess({ kind: "read", resource: "instances.pending", action: "list", risk: "low" })
  list(
    @Arg("name", { description: "Instance name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching pending entries to skip (default: 0)" })
    offset?: string,
  ) {
    if (!dbGetInstance(name)) failInstanceNotFound("instances pending list", name, asJson);
    const pending = listAccountPending(name);
    const page = paginateCliItems(pending, { limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "instances", "pending", "list", name],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
    });
    const pendingContacts = page.items.filter((entry) => entry.pendingKind === "contact");
    const pendingChats = page.items.filter((entry) => entry.pendingKind === "chat");
    const allPendingContacts = pending.filter((entry) => entry.pendingKind === "contact");
    const allPendingChats = pending.filter((entry) => entry.pendingKind === "chat");

    const payload = {
      instance: name,
      total: page.total,
      pagination,
      counts: {
        contacts: allPendingContacts.length,
        chats: allPendingChats.length,
      },
      contacts: pendingContacts.map((p) => ({
        ...p,
        type: p.chatType,
      })),
      chats: pendingChats.map((p) => ({
        ...p,
        type: p.chatType,
        routePattern: normalizePendingChatPattern(p),
      })),
      items: page.items.map((p) => ({
        ...p,
        type: p.chatType,
        ...(p.pendingKind === "chat" ? { routePattern: normalizePendingChatPattern(p) } : {}),
      })),
      pending: page.items.map((p) => ({
        ...p,
        type: p.chatType,
        ...(p.pendingKind === "chat" ? { routePattern: normalizePendingChatPattern(p) } : {}),
      })),
    };

    if (asJson) {
      printJson(payload);
    } else if (page.items.length === 0) {
      console.log(`No pending contacts or chats for instance "${name}".`);
    } else {
      if (pendingContacts.length > 0) {
        console.log(`\nPending contacts for: ${name}\n`);
        console.log("  ID                                       TYPE    NAME");
        console.log("  ---------------------------------------  ------  --------------------");
        for (const p of pendingContacts as AccountPendingEntry[]) {
          console.log(`  ${p.phone.padEnd(39)}  ${p.chatType.padEnd(6)}  ${p.name ?? "-"}`);
        }
      }

      if (pendingChats.length > 0) {
        console.log(`\nPending chats for: ${name}\n`);
        console.log("  ROUTE PATTERN                            TYPE    NAME");
        console.log("  ---------------------------------------  ------  --------------------");
        for (const p of pendingChats as AccountPendingEntry[]) {
          const pattern = normalizePendingChatPattern(p);
          console.log(`  ${pattern.padEnd(39)}  ${p.chatType.padEnd(6)}  ${p.name ?? "-"}`);
        }
      }
      console.log(
        `\n  Total: ${page.total} (${page.items.length} returned, limit ${page.limit}, offset ${page.offset})`,
      );
      if (pagination.nextCommand) {
        console.log("\n  Next page:");
        console.log(`    ${pagination.nextCommand}`);
      }
      console.log(`\n  Approve contact: ravi instances pending approve ${name} <phone>`);
      console.log(`  Approve chat:    ravi instances pending approve ${name} <chat> --agent <agent>`);
    }
    return payload;
  }

  @Command({ name: "approve", description: "Approve a pending contact or chat" })
  @CommandAccess({ kind: "mutate", resource: "instances.pending", action: "approve", risk: "medium" })
  approve(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("contact", { description: "Contact identity or chat route pattern" }) contact: string,
    @Option({ flags: "--agent <id>", description: "Agent to route an approved chat to" }) agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const instance = dbGetInstance(name);
    if (!instance) failInstanceNotFound("instances pending approve", name, asJson);
    const pending = findPendingReviewEntry(name, contact);
    const normalizedContact = normalizePhone(contact);
    const isChatApproval = pending?.pendingKind === "chat" || normalizedContact.startsWith("group:");

    if (isChatApproval) {
      const routeAgent = agent ?? instance.agent;
      if (!routeAgent) {
        fail("Approving a pending chat requires --agent because the instance has no default agent.");
      }
      if (!dbGetAgent(routeAgent)) {
        fail(
          `Agent not found: ${routeAgent}. Available: ${dbListAgents()
            .map((a) => a.id)
            .join(", ")}`,
        );
      }
      const routePattern = pending ? normalizePendingChatPattern(pending) : normalizedContact;
      let route = dbGetRoute(routePattern, name);
      let routeCreated = false;
      if (!route) {
        dbCreateRoute({
          pattern: routePattern,
          accountId: name,
          agent: routeAgent,
          priority: 0,
          channel: instance.channel,
        });
        route = dbGetRoute(routePattern, name);
        if (!route) fail(`Created route could not be loaded: ${routePattern} (instance: ${name})`);
        routeCreated = true;
      }
      const removedPending = pending ? removeAccountPending(name, pending.phone) : removeAccountPending(name, contact);
      emitConfigChanged();
      const payload = {
        status: "approved" as const,
        reviewKind: "chat" as const,
        instance: name,
        chat: contact,
        routePattern,
        route,
        routeCreated,
        removedPending,
        changedCount: routeCreated || removedPending ? 1 : 0,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Chat approved: ${routePattern} → ${routeAgent} (instance: ${name})`);
        if (removedPending) console.log(`✓ Removed from pending`);
      }
      return payload;
    }

    allowContact(contact);
    const removedPending = pending ? removeAccountPending(name, pending.phone) : removeAccountPending(name, contact);
    const payload = {
      status: "approved" as const,
      reviewKind: "contact" as const,
      instance: name,
      contact,
      removedPending,
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Approved: ${contact} (instance: ${name})`);
    }
    emitConfigChanged();
    return payload;
  }

  @Command({ name: "reject", description: "Reject and remove a pending contact or chat" })
  @CommandAccess({
    kind: "mutate",
    resource: "instances.pending",
    action: "reject",
    risk: "destructive",
    requiresConfirmation: true,
  })
  reject(
    @Arg("name", { description: "Instance name" }) name: string,
    @Arg("contact", { description: "Contact identity or chat route pattern" }) contact: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description:
        "Actually reject and remove the pending entry; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (!dbGetInstance(name)) failInstanceNotFound("instances pending reject", name, asJson);
    const pending = findPendingReviewEntry(name, contact);
    if (execute !== true) {
      // Write brake (Manual v2 7.8): rejecting discards the pending entry with
      // no restore path, so dry-run by default and exit 3 before any removal.
      contractDryRun(
        "instances pending reject",
        {
          instance: name,
          contactPresent: contact.length > 0,
          pendingFound: Boolean(pending),
          kind: pending?.pendingKind ?? null,
          phonePresent: Boolean(pending?.phone),
          chatIdPresent: Boolean(pending?.chatId),
          namePresent: Boolean(pending?.name),
        },
        { asJson },
      );
    }
    const removed = pending ? removeAccountPending(name, pending.phone) : removeAccountPending(name, contact);
    if (removed) {
      const payload = {
        status: "rejected" as const,
        reviewKind: pending?.pendingKind ?? "unknown",
        instance: name,
        contact,
        removedPending: true,
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Rejected and removed: ${contact} (instance: ${name})`);
      }
      return payload;
    } else {
      fail(`Pending entry not found: ${contact} (instance: ${name})`);
    }
  }
}

const instancesLogoutReturnSchema = z.object({
  status: z.literal("logged_out"),
  instance: z.string(),
  instanceId: z.string(),
  transport: z.literal("whatsapp"),
  logout: z.discriminatedUnion("via", [
    z.object({ via: z.literal("runner"), clearedKeys: z.null(), cause: z.null() }),
    z.object({ via: z.literal("auth-store"), clearedKeys: z.number().int().nonnegative(), cause: z.string() }),
  ]),
  changedCount: z.number().int().nonnegative(),
});

declareCommandReturns(InstancesCommands, {
  create: commandEnvelopeReturnSchema,
  delete: commandEnvelopeReturnSchema,
  deleted: commandEnvelopeReturnSchema,
  disable: commandEnvelopeReturnSchema,
  disconnect: commandEnvelopeReturnSchema,
  enable: commandEnvelopeReturnSchema,
  get: commandEnvelopeReturnSchema,
  list: commandEnvelopeReturnSchema,
  logout: instancesLogoutReturnSchema,
  restore: commandEnvelopeReturnSchema,
  set: commandEnvelopeReturnSchema,
  show: commandEnvelopeReturnSchema,
  status: commandEnvelopeReturnSchema,
  target: commandEnvelopeReturnSchema,
});

declareCommandReturns(RoutesCommands, {
  explain: routeExplainReturnSchema,
  list: routesListReturnSchema,
  show: routeShowReturnSchema,
});

declareCommandReturns(InstancesRoutesCommands, {
  add: commandEnvelopeReturnSchema,
  deleted: commandEnvelopeReturnSchema,
  list: commandEnvelopeReturnSchema,
  remove: commandEnvelopeReturnSchema,
  restore: commandEnvelopeReturnSchema,
  set: commandEnvelopeReturnSchema,
  show: commandEnvelopeReturnSchema,
});

declareCommandReturns(InstancesPendingCommands, {
  approve: commandEnvelopeReturnSchema,
  list: commandEnvelopeReturnSchema,
  reject: commandEnvelopeReturnSchema,
});
