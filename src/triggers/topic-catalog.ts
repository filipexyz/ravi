export type TriggerTopicCategory = "inbound" | "cli" | "approval" | "audit" | "delivery" | "watch" | "tasks" | "custom";

export interface TriggerTopicCatalogEntry {
  id: string;
  category: TriggerTopicCategory;
  pattern: string;
  title: string;
  description: string;
  payload: string;
  examples: string[];
  filters?: string[];
  notes?: string[];
}

export interface TriggerTopicDiagnostic {
  level: "warning";
  message: string;
  suggestedPattern?: string;
}

const TOPICS: readonly TriggerTopicCatalogEntry[] = [
  {
    id: "inbound.reaction",
    category: "inbound",
    pattern: "ravi.inbound.reaction",
    title: "Inbound reaction",
    description: "Emoji reaction received from a channel.",
    payload: "{ targetMessageId, emoji, senderId }",
    examples: [
      'ravi triggers add "Approval by reaction" --topic "ravi.inbound.reaction" --filter \'data.emoji includes "👍"\' --message "..."',
    ],
    filters: ['data.emoji includes "👍"', 'data.senderId == "5511999999999"'],
    notes: [
      "This is the canonical reaction trigger subject.",
      "The payload identifies the reacted message as targetMessageId. Keep domain mappings keyed by external message id when a routine needs to recover business state.",
    ],
  },
  {
    id: "inbound.reply",
    category: "inbound",
    pattern: "ravi.inbound.reply",
    title: "Inbound quote reply",
    description: "Quote reply to a bot message.",
    payload: "{ targetMessageId, text, senderId }",
    examples: [
      'ravi triggers add "Reply approval" --topic "ravi.inbound.reply" --filter \'data.text includes "approve"\' --message "..."',
    ],
  },
  {
    id: "inbound.pollVote",
    category: "inbound",
    pattern: "ravi.inbound.pollVote",
    title: "Inbound poll vote",
    description: "Poll vote event from a supported channel.",
    payload: "{ pollMessageId, votes: [{ name, voters[] }] }",
    examples: ['ravi triggers add "Poll vote" --topic "ravi.inbound.pollVote" --message "..."'],
    notes: ["Subscriber support exists in approval flows; publisher availability depends on the channel provider."],
  },
  {
    id: "cli.session-command",
    category: "cli",
    pattern: "ravi.*.cli.*.*",
    title: "Session CLI command audit",
    description: "CLI command execution audit events emitted from an agent session.",
    payload: "{ tool, input, isError, status, durationMs, timestamp, sessionKey, cliInvocation }",
    examples: ['ravi triggers add "Agent contact CLI audit" --topic "ravi.*.cli.contacts.*" --message "..."'],
    filters: ['data.isError == "true"', 'data.sessionKey == "dev"', 'data.tool == "contacts_add"'],
    notes: [
      "The wildcard between ravi and cli matches the emitting session key.",
      "Standalone CLI invocations that are not tied to a session use ravi._cli.cli.<group>.<command>.",
    ],
  },
  {
    id: "cli.standalone-command",
    category: "cli",
    pattern: "ravi._cli.cli.*.*",
    title: "Standalone CLI command audit",
    description: "Ravi CLI command execution audit events emitted outside an agent session.",
    payload: "{ tool, input, isError, status, durationMs, timestamp, sessionKey, cliInvocation }",
    examples: ['ravi triggers add "Standalone contact CLI audit" --topic "ravi._cli.cli.contacts.*" --message "..."'],
    filters: ['data.isError == "true"', 'data.tool == "contacts_add"'],
  },
  {
    id: "approval.request",
    category: "approval",
    pattern: "ravi.approval.request",
    title: "Approval request",
    description: "Runtime approval request emitted by host hooks/services.",
    payload: "{ type, sessionName, agentId, prompt, timestamp, ... }",
    examples: ['ravi triggers add "Approval requested" --topic "ravi.approval.request" --message "..."'],
  },
  {
    id: "approval.response",
    category: "approval",
    pattern: "ravi.approval.response",
    title: "Approval response",
    description: "Runtime approval decision.",
    payload: "{ type, sessionName, agentId, approved, reason?, answers?, timestamp }",
    examples: [
      'ravi triggers add "Approval denied" --topic "ravi.approval.response" --filter \'data.approved == "false"\' --message "..."',
    ],
  },
  {
    id: "audit.denied",
    category: "audit",
    pattern: "ravi.audit.denied",
    title: "Permission denied",
    description: "Permission or policy denial event.",
    payload: "{ type, agentId, denied, reason, detail?, timestamp }",
    examples: ['ravi triggers add "Permission alert" --topic "ravi.audit.denied" --message "..."'],
  },
  {
    id: "contacts.pending",
    category: "approval",
    pattern: "ravi.contacts.pending",
    title: "Pending contact",
    description: "New direct contact pending approval.",
    payload: "{ contactId, platformIdentityId?, channel, accountId, ... }",
    examples: ['ravi triggers add "Pending contact" --topic "ravi.contacts.pending" --message "..."'],
    notes: [
      "Group/chat approvals use ravi.chats.pending. ravi.contacts.pending may be emitted as a deprecated compatibility alias for some group events.",
    ],
  },
  {
    id: "chats.pending",
    category: "approval",
    pattern: "ravi.chats.pending",
    title: "Pending chat",
    description: "New group/chat pending approval.",
    payload: "{ chatId, channel, accountId, groupId?, subject?, ... }",
    examples: ['ravi triggers add "Pending chat" --topic "ravi.chats.pending" --message "..."'],
  },
  {
    id: "instances.unregistered",
    category: "audit",
    pattern: "ravi.instances.unregistered",
    title: "Unregistered instance",
    description: "Inbound event arrived from an Omni instance not registered in Ravi.",
    payload: "{ instanceId, channelType, subject, from, chatId, isGroup, contentType, timestamp }",
    examples: ['ravi triggers add "Unknown instance" --topic "ravi.instances.unregistered" --message "..."'],
  },
  {
    id: "console.inbox.item",
    category: "watch",
    pattern: "ravi.console.inbox.item",
    title: "Console inbox item",
    description: "Delivered Console inbox item, including watch events.",
    payload: "{ eventId, eventType, source, payload, links, occurredAt, createdAt, ... }",
    examples: [
      'ravi triggers add "New mail" --topic "ravi.console.inbox.item" --filter \'data.eventType == "mail.message.received"\' --message "..."',
    ],
  },
  {
    id: "watch.event",
    category: "watch",
    pattern: "ravi.watch.*.*",
    title: "Normalized watch event",
    description: "Normalized event produced from a local or Console watch.",
    payload: "{ version, eventId, watchId, connector, placement, eventType, subject, source, payload, occurredAt }",
    examples: ['ravi triggers add "GitHub release" --topic "ravi.watch.github.release.published" --message "..."'],
    filters: ['data.watchId == "watch_123"'],
  },
  {
    id: "task.event",
    category: "tasks",
    pattern: "ravi.task.*.event",
    title: "Task event",
    description: "Task lifecycle event for one task id.",
    payload: "{ task, event, reportToSessionName?, reportEvents?, ... }",
    examples: [
      'ravi triggers add "Task done" --topic "ravi.task.*.event" --filter \'data.event.type == "task.completed"\' --message "..."',
    ],
  },
  {
    id: "tags.rule.applied",
    category: "custom",
    pattern: "ravi.tags.rule.applied",
    title: "Tag rule applied",
    description: "Auto-tagging rule applied a tag.",
    payload: "{ ruleId, targetType, targetId, tagSlug, cascadeDepth?, ... }",
    examples: ['ravi triggers add "Tag applied" --topic "ravi.tags.rule.applied" --message "..."'],
  },
];

const CHANNEL_ALIAS_RE = /^(whatsapp|matrix)(?:\.([*.>]|[^.]+))?\.(inbound|reaction)$/;

function matchesTopicPattern(topic: string, pattern: string): boolean {
  const topicParts = topic.split(".");
  const patternParts = pattern.split(".");

  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    if (patternPart === ">") return true;
    if (i >= topicParts.length) return false;
    if (patternPart === "*") continue;
    if (patternPart !== topicParts[i]) return false;
  }

  return topicParts.length === patternParts.length;
}

export function getTriggerTopicCatalog(): TriggerTopicCatalogEntry[] {
  return TOPICS.map((entry) => ({
    ...entry,
    examples: [...entry.examples],
    ...(entry.filters ? { filters: [...entry.filters] } : {}),
    ...(entry.notes ? { notes: [...entry.notes] } : {}),
  }));
}

export function isTriggerTopicInCatalog(topic: string): boolean {
  const trimmed = topic.trim();
  return TOPICS.some((entry) => trimmed === entry.pattern || matchesTopicPattern(trimmed, entry.pattern));
}

export function getTriggerTopicDiagnostic(topic: string): TriggerTopicDiagnostic | undefined {
  const trimmed = topic.trim();
  const channelAlias = trimmed.match(CHANNEL_ALIAS_RE);
  if (channelAlias) {
    const [, channel, , eventKind] = channelAlias;
    if (eventKind === "reaction") {
      return {
        level: "warning",
        suggestedPattern: "ravi.inbound.reaction",
        message: `Topic '${trimmed}' is not in the built-in templates. Ravi reactions are normally published as 'ravi.inbound.reaction' for ${channel} emoji reactions.`,
      };
    }
    return {
      level: "warning",
      message: `Topic '${trimmed}' is not in the built-in templates. Channel messages are normally consumed by the session router; custom NATS subjects are still accepted.`,
    };
  }

  if (/^ravi\.\*\.tool$/.test(trimmed) || /^ravi\.\*\.response$/.test(trimmed)) {
    return {
      level: "warning",
      message: `Topic '${trimmed}' is not in the built-in templates. Session runtime publishers usually live under 'ravi.session.*'; custom NATS subjects are still accepted.`,
    };
  }

  if (!isTriggerTopicInCatalog(trimmed)) {
    return {
      level: "warning",
      message: `Topic '${trimmed}' is not in the built-in trigger topic templates. It will be accepted as a custom NATS subject; make sure a publisher emits it.`,
    };
  }

  return undefined;
}
