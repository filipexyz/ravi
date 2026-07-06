import { matchRoute, type RouterConfig } from "../../router/index.js";

export interface SlackTopologyInput {
  readonly accountId: string;
  readonly channels: readonly unknown[];
  readonly routerConfig: RouterConfig;
  readonly getContactStatus?: (input: {
    readonly accountId: string;
    readonly peerKind: "dm" | "group";
    readonly peerId: string;
  }) => string | undefined;
}

export interface SlackTopology {
  readonly ok: true;
  readonly provider: "slack";
  readonly accountId: string;
  readonly channels: SlackTopologyChannel[];
  readonly ungroupedChannelIds: string[];
  readonly capabilities: Record<string, never>;
}

export interface SlackTopologyChannel {
  readonly id: string;
  readonly name: string;
  readonly createdAt?: string;
  readonly creator?: string;
  readonly isMember?: boolean;
  readonly isPrivate?: boolean;
  readonly isArchived?: boolean;
  readonly numMembers?: number;
  readonly ravi: SlackTopologyRoute;
}

export interface SlackTopologyRoute {
  readonly matched: boolean;
  readonly accountId: string;
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly routePattern?: string;
  readonly routeSession?: string;
  readonly dmScope?: string;
  readonly policy?: string;
  readonly channel?: string;
  readonly policyGate: SlackTopologyPolicyGate;
}

export interface SlackTopologyPolicyGate {
  readonly inboundAllowed: boolean;
  readonly reason:
    | "no_route"
    | "explicit_route"
    | "group_open"
    | "group_closed"
    | "group_allowlist_allowed"
    | "group_allowlist_pending"
    | "dm_open"
    | "dm_closed"
    | "dm_pairing_allowed"
    | "dm_pairing_pending";
  readonly explicitRoute: boolean;
  readonly effectivePolicy?: string;
  readonly instancePolicy?: string;
  readonly routePolicy?: string;
  readonly contactStatus?: string;
}

interface NormalizedSlackChannel {
  id: string;
  name: string;
  createdAt?: string;
  creator?: string;
  isMember?: boolean;
  isPrivate?: boolean;
  isArchived?: boolean;
  isIm?: boolean;
  isGroup?: boolean;
  userId?: string;
  numMembers?: number;
}

export function buildSlackTopology(input: SlackTopologyInput): SlackTopology {
  const channels = input.channels.map(normalizeSlackChannel).filter((item): item is NormalizedSlackChannel => !!item);

  const topologyChannels = channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    ...(channel.createdAt ? { createdAt: channel.createdAt } : {}),
    ...(channel.creator ? { creator: channel.creator } : {}),
    ...(channel.isMember !== undefined ? { isMember: channel.isMember } : {}),
    ...(channel.isPrivate !== undefined ? { isPrivate: channel.isPrivate } : {}),
    ...(channel.isArchived !== undefined ? { isArchived: channel.isArchived } : {}),
    ...(channel.numMembers !== undefined ? { numMembers: channel.numMembers } : {}),
    ravi: resolveSlackChannelRoute(channel, input.routerConfig, input.accountId, input.getContactStatus),
  }));

  return {
    ok: true,
    provider: "slack",
    accountId: input.accountId,
    channels: topologyChannels,
    ungroupedChannelIds: topologyChannels.map((channel) => channel.id),
    capabilities: {},
  };
}

function resolveSlackChannelRoute(
  channel: NormalizedSlackChannel,
  routerConfig: RouterConfig,
  accountId: string,
  getContactStatus?: SlackTopologyInput["getContactStatus"],
): SlackTopologyRoute {
  const isDm = channel.isIm === true;
  const peerKind = isDm ? "dm" : "group";
  const peerId = isDm ? (channel.userId ?? channel.id) : channel.id;
  const matched = matchRoute(routerConfig, {
    phone: channel.id,
    channel: "slack",
    accountId,
    isGroup: !isDm,
    groupId: isDm ? undefined : channel.id,
    peerKind,
  });

  if (!matched) {
    return {
      matched: false,
      accountId,
      policyGate: {
        inboundAllowed: false,
        reason: "no_route",
        explicitRoute: false,
        ...policyContext(routerConfig, accountId, peerKind, undefined),
      },
    };
  }

  const policyGate = resolvePolicyGate({
    routerConfig,
    accountId,
    peerKind,
    peerId,
    routePolicy: matched.route?.policy,
    routePattern: matched.route?.pattern,
    getContactStatus,
  });

  return {
    matched: true,
    accountId,
    agentId: matched.agentId,
    sessionKey: matched.sessionKey,
    dmScope: matched.dmScope,
    ...(matched.route?.pattern ? { routePattern: matched.route.pattern } : {}),
    ...(matched.route?.session ? { routeSession: matched.route.session } : {}),
    ...(matched.route?.policy ? { policy: matched.route.policy } : {}),
    ...(matched.route?.channel ? { channel: matched.route.channel } : {}),
    policyGate,
  };
}

function resolvePolicyGate(input: {
  readonly routerConfig: RouterConfig;
  readonly accountId: string;
  readonly peerKind: "dm" | "group";
  readonly peerId: string;
  readonly routePolicy?: string;
  readonly routePattern?: string;
  readonly getContactStatus?: SlackTopologyInput["getContactStatus"];
}): SlackTopologyPolicyGate {
  const context = policyContext(input.routerConfig, input.accountId, input.peerKind, input.routePolicy);
  const explicitRoute = Boolean(input.routePattern && input.routePattern !== "*");
  const contactStatus = input.getContactStatus?.({
    accountId: input.accountId,
    peerKind: input.peerKind,
    peerId: input.peerId,
  });

  if (input.peerKind === "group") {
    if (explicitRoute) {
      return compactPolicyGate({
        ...context,
        contactStatus,
        explicitRoute,
        inboundAllowed: true,
        reason: "explicit_route",
      });
    }
    if (context.effectivePolicy === "closed") {
      return compactPolicyGate({
        ...context,
        contactStatus,
        explicitRoute,
        inboundAllowed: false,
        reason: "group_closed",
      });
    }
    if (context.effectivePolicy === "allowlist") {
      const inboundAllowed = contactStatus === "allowed";
      return compactPolicyGate({
        ...context,
        contactStatus,
        explicitRoute,
        inboundAllowed,
        reason: inboundAllowed ? "group_allowlist_allowed" : "group_allowlist_pending",
      });
    }
    return compactPolicyGate({
      ...context,
      contactStatus,
      explicitRoute,
      inboundAllowed: true,
      reason: "group_open",
    });
  }

  if (context.effectivePolicy === "closed") {
    return compactPolicyGate({
      ...context,
      contactStatus,
      explicitRoute,
      inboundAllowed: false,
      reason: "dm_closed",
    });
  }
  if (context.effectivePolicy === "pairing") {
    const inboundAllowed = contactStatus === "allowed";
    return compactPolicyGate({
      ...context,
      contactStatus,
      explicitRoute,
      inboundAllowed,
      reason: inboundAllowed ? "dm_pairing_allowed" : "dm_pairing_pending",
    });
  }
  return compactPolicyGate({
    ...context,
    contactStatus,
    explicitRoute,
    inboundAllowed: true,
    reason: "dm_open",
  });
}

function policyContext(
  routerConfig: RouterConfig,
  accountId: string,
  peerKind: "dm" | "group",
  routePolicy: string | undefined,
): Pick<SlackTopologyPolicyGate, "effectivePolicy" | "instancePolicy" | "routePolicy"> {
  const instance = routerConfig.instances?.[accountId];
  const instancePolicy = peerKind === "dm" ? instance?.dmPolicy : instance?.groupPolicy;
  return {
    effectivePolicy: routePolicy ?? instancePolicy ?? "open",
    ...(instancePolicy ? { instancePolicy } : {}),
    ...(routePolicy ? { routePolicy } : {}),
  };
}

function compactPolicyGate(input: SlackTopologyPolicyGate): SlackTopologyPolicyGate {
  return {
    inboundAllowed: input.inboundAllowed,
    reason: input.reason,
    explicitRoute: input.explicitRoute,
    ...(input.effectivePolicy ? { effectivePolicy: input.effectivePolicy } : {}),
    ...(input.instancePolicy ? { instancePolicy: input.instancePolicy } : {}),
    ...(input.routePolicy ? { routePolicy: input.routePolicy } : {}),
    ...(input.contactStatus ? { contactStatus: input.contactStatus } : {}),
  };
}

function normalizeSlackChannel(value: unknown): NormalizedSlackChannel | undefined {
  const record = objectValue(value);
  const id = stringValue(record.id);
  if (!id) return undefined;
  const name = stringValue(record.name) ?? stringValue(record.user) ?? id;
  const created = numberValue(record.created);
  return {
    id,
    name,
    ...(created !== undefined ? { createdAt: new Date(created * 1000).toISOString() } : {}),
    ...(stringValue(record.creator) ? { creator: stringValue(record.creator)! } : {}),
    ...(booleanValue(record.is_member) !== undefined ? { isMember: booleanValue(record.is_member)! } : {}),
    ...(booleanValue(record.is_private) !== undefined ? { isPrivate: booleanValue(record.is_private)! } : {}),
    ...(booleanValue(record.is_archived) !== undefined ? { isArchived: booleanValue(record.is_archived)! } : {}),
    ...(booleanValue(record.is_im) !== undefined ? { isIm: booleanValue(record.is_im)! } : {}),
    ...(booleanValue(record.is_group) !== undefined ? { isGroup: booleanValue(record.is_group)! } : {}),
    ...(stringValue(record.user) ? { userId: stringValue(record.user)! } : {}),
    ...(numberValue(record.num_members) !== undefined ? { numMembers: numberValue(record.num_members)! } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
