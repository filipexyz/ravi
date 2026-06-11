export type TriggerTopicCategory =
  | "inbound"
  | "cli"
  | "approval"
  | "audit"
  | "delivery"
  | "inbox"
  | "watch"
  | "tasks"
  | "custom";

export type TriggerTopicSchemaFieldType = "string" | "number" | "boolean" | "object" | "array" | "null";

export interface TriggerTopicSchemaField {
  path: string;
  type: TriggerTopicSchemaFieldType | TriggerTopicSchemaFieldType[];
  required?: boolean;
  description: string;
  example?: unknown;
}

export interface TriggerTopicPayloadSchema {
  version: 1;
  fields: TriggerTopicSchemaField[];
}

export interface TriggerTopicMessageTemplate {
  id: string;
  description: string;
  template: string;
  variables: string[];
}

export interface TriggerTopicCatalogEntry {
  id: string;
  category: TriggerTopicCategory;
  pattern: string;
  title: string;
  description: string;
  payload: string;
  schema?: TriggerTopicPayloadSchema;
  messageTemplate?: TriggerTopicMessageTemplate;
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
    schema: {
      version: 1,
      fields: [
        {
          path: "targetMessageId",
          type: "string",
          required: true,
          description: "External message id that received the reaction.",
        },
        { path: "emoji", type: "string", required: true, description: "Reaction emoji text." },
        { path: "senderId", type: "string", required: true, description: "Channel sender identifier that reacted." },
      ],
    },
    examples: [
      'ravi triggers add "Approval by reaction" --topic "ravi.inbound.reaction" --filter \'data.emoji includes "👍"\' --message "..."',
    ],
    filters: [
      'data.emoji includes "👍"',
      'data.senderId == "5511999999999"',
      'data.senderId == "5511999999999" && data.emoji includes "👍"',
    ],
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
    schema: {
      version: 1,
      fields: [
        {
          path: "targetMessageId",
          type: "string",
          required: true,
          description: "External bot message id being replied to.",
        },
        { path: "text", type: "string", required: true, description: "Reply text extracted from the channel event." },
        {
          path: "senderId",
          type: "string",
          required: true,
          description: "Channel sender identifier that sent the reply.",
        },
      ],
    },
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
    schema: {
      version: 1,
      fields: [
        { path: "pollMessageId", type: "string", required: true, description: "External poll message id." },
        { path: "votes", type: "array", required: true, description: "Selected options with voter identifiers." },
        { path: "votes[].name", type: "string", description: "Poll option label." },
        { path: "votes[].voters", type: "array", description: "Voter identifiers for this option." },
      ],
    },
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
    schema: {
      version: 1,
      fields: [
        { path: "tool", type: "string", required: true, description: "CLI tool identifier." },
        { path: "input", type: "object", required: true, description: "Sanitized CLI input metadata." },
        { path: "isError", type: "boolean", required: true, description: "Whether the command failed." },
        { path: "status", type: "string", required: true, description: "Command status label." },
        { path: "durationMs", type: "number", description: "Command duration in milliseconds." },
        { path: "timestamp", type: "string", description: "Event timestamp." },
        { path: "sessionKey", type: "string", description: "Runtime session key that emitted the audit event." },
        { path: "cliInvocation", type: "object", description: "Sanitized invocation facts." },
      ],
    },
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
    schema: {
      version: 1,
      fields: [
        { path: "tool", type: "string", required: true, description: "CLI tool identifier." },
        { path: "input", type: "object", required: true, description: "Sanitized CLI input metadata." },
        { path: "isError", type: "boolean", required: true, description: "Whether the command failed." },
        { path: "status", type: "string", required: true, description: "Command status label." },
        { path: "durationMs", type: "number", description: "Command duration in milliseconds." },
        { path: "timestamp", type: "string", description: "Event timestamp." },
        { path: "sessionKey", type: ["string", "null"], description: "Runtime session key when available." },
        { path: "cliInvocation", type: "object", description: "Sanitized invocation facts." },
      ],
    },
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
    schema: {
      version: 1,
      fields: [
        { path: "type", type: "string", required: true, description: "Approval request type." },
        { path: "sessionName", type: "string", required: true, description: "Session requesting approval." },
        { path: "agentId", type: "string", required: true, description: "Agent requesting approval." },
        { path: "prompt", type: "string", description: "Safe approval prompt or summary." },
        { path: "timestamp", type: "string", description: "Event timestamp." },
      ],
    },
    examples: ['ravi triggers add "Approval requested" --topic "ravi.approval.request" --message "..."'],
  },
  {
    id: "approval.response",
    category: "approval",
    pattern: "ravi.approval.response",
    title: "Approval response",
    description: "Runtime approval decision.",
    payload: "{ type, sessionName, agentId, approved, reason?, answers?, timestamp }",
    schema: {
      version: 1,
      fields: [
        { path: "type", type: "string", required: true, description: "Approval response type." },
        { path: "sessionName", type: "string", required: true, description: "Session receiving the decision." },
        { path: "agentId", type: "string", required: true, description: "Agent receiving the decision." },
        { path: "approved", type: "boolean", required: true, description: "Whether the request was approved." },
        { path: "reason", type: "string", description: "Optional decision reason." },
        { path: "answers", type: "object", description: "Optional structured answers." },
        { path: "timestamp", type: "string", description: "Event timestamp." },
      ],
    },
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
    payload:
      "{ type, agentId, denied, reason, dedupeKey, command?, detail?, blockType?, missingPrincipals?, missingPrincipalDetails?, recommendedGrantSubjects?, denialId?, context?, timestamp }",
    schema: {
      version: 1,
      fields: [
        { path: "type", type: "string", required: true, description: "Audit event type." },
        { path: "agentId", type: "string", required: true, description: "Agent denied by policy." },
        { path: "denied", type: "string", required: true, description: "Denied capability or resource facts." },
        { path: "reason", type: "string", required: true, description: "Policy denial reason." },
        {
          path: "dedupeKey",
          type: "string",
          required: true,
          description: "Stable semantic key for repeated equivalent denials. It must not include denialId.",
        },
        { path: "command", type: "string", description: "CLI command or Bash command that triggered the denial." },
        {
          path: "detail",
          type: "string",
          description:
            "Optional safe semantic diagnosis. Scope denials describe the missing delegated branch when available.",
        },
        {
          path: "blockType",
          type: "string",
          description: "Optional normalized denial category, e.g. delegated_actor_surface_capabilities_empty.",
        },
        {
          path: "missingPrincipals",
          type: "array",
          description: "Optional machine principals that had no effective capabilities for the denied scope.",
        },
        {
          path: "missingPrincipalDetails",
          type: "array",
          description: "Optional branch/principal/displayName records for human-readable audit explanations.",
        },
        {
          path: "recommendedGrantSubjects",
          type: "array",
          description: "Optional subjects that should receive the denied grant when the denial is approved.",
        },
        { path: "denialId", type: "number", description: "Optional permission_denials ledger id." },
        {
          path: "context",
          type: "object",
          description:
            "Safe runtime provenance: contextId, kind, session, actorPrincipal, actorDisplayName, surfacePrincipal, surfaceDisplayName and capability counts. Never includes contextKey.",
        },
        { path: "timestamp", type: "string", description: "Event timestamp." },
      ],
    },
    examples: ['ravi triggers add "Permission alert" --topic "ravi.audit.denied" --message "..."'],
  },
  {
    id: "contacts.pending",
    category: "approval",
    pattern: "ravi.contacts.pending",
    title: "Pending contact",
    description: "New direct contact pending approval.",
    payload: "{ contactId, platformIdentityId?, channel, accountId, ... }",
    schema: {
      version: 1,
      fields: [
        { path: "contactId", type: "string", required: true, description: "Local contact id pending approval." },
        { path: "platformIdentityId", type: "string", description: "Platform identity id when known." },
        { path: "channel", type: "string", required: true, description: "Channel type." },
        { path: "accountId", type: "string", required: true, description: "Channel account or instance id." },
      ],
    },
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
    schema: {
      version: 1,
      fields: [
        { path: "chatId", type: "string", required: true, description: "Local chat id pending approval." },
        { path: "channel", type: "string", required: true, description: "Channel type." },
        { path: "accountId", type: "string", required: true, description: "Channel account or instance id." },
        { path: "groupId", type: "string", description: "Provider group id when available." },
        { path: "subject", type: "string", description: "Group/chat title when available." },
      ],
    },
    examples: ['ravi triggers add "Pending chat" --topic "ravi.chats.pending" --message "..."'],
  },
  {
    id: "instances.unregistered",
    category: "audit",
    pattern: "ravi.instances.unregistered",
    title: "Unregistered instance",
    description: "Inbound event arrived from an Omni instance not registered in Ravi.",
    payload: "{ instanceId, channelType, subject, from, chatId, isGroup, contentType, timestamp }",
    schema: {
      version: 1,
      fields: [
        {
          path: "instanceId",
          type: "string",
          required: true,
          description: "Omni instance id that emitted the inbound event.",
        },
        { path: "channelType", type: "string", required: true, description: "Channel type." },
        { path: "subject", type: "string", required: true, description: "Inbound NATS subject." },
        { path: "from", type: "string", description: "Raw sender id." },
        { path: "chatId", type: "string", description: "Raw chat id." },
        { path: "isGroup", type: "boolean", description: "Whether the event came from a group chat." },
        { path: "contentType", type: "string", description: "Inbound content type." },
        { path: "timestamp", type: "string", description: "Event timestamp." },
      ],
    },
    examples: ['ravi triggers add "Unknown instance" --topic "ravi.instances.unregistered" --message "..."'],
  },
  {
    id: "tts.request",
    category: "delivery",
    pattern: "ravi.tts",
    title: "Text-to-speech request",
    description: "ElevenLabs TTS request for extension playback.",
    payload: "{ id?, text, agentId?, sessionName?, sessionKey?, target?, playback?, voice?, metadata?, createdAt? }",
    schema: {
      version: 1,
      fields: [
        { path: "id", type: "string", description: "Optional request id; generated when omitted." },
        { path: "text", type: "string", required: true, description: "Text to synthesize." },
        { path: "agentId", type: "string", description: "Agent whose voice defaults should be used." },
        { path: "sessionName", type: "string", description: "Runtime session name associated with the audio." },
        { path: "sessionKey", type: "string", description: "Runtime session key associated with the audio." },
        {
          path: "target",
          type: "object",
          description: "Channel target metadata such as channel, accountId and chatId.",
        },
        {
          path: "playback",
          type: "object",
          description: "Playback target metadata; extension playback uses { target: 'extension', autoplay: true }.",
        },
        {
          path: "voice",
          type: "object",
          description:
            "ElevenLabs voice config: voiceId, modelId, lang, outputFormat, voiceSettings and full API options.",
        },
        { path: "metadata", type: "object", description: "Optional safe request provenance." },
        { path: "createdAt", type: "number", description: "Unix timestamp in milliseconds." },
      ],
    },
    examples: [
      'ravi triggers add "TTS requested" --topic "ravi.tts" --filter \'data.agentId == "main"\' --message "..."',
    ],
    notes: [
      "The gateway consumes this topic in a queue group, generates audio through ElevenLabs and emits ravi.tts.started, ravi.tts.ready or ravi.tts.failed.",
      "The WhatsApp overlay polls generated playback items and plays ravi.tts.ready audio in the browser.",
    ],
  },
  {
    id: "inbox.mail.received",
    category: "inbox",
    pattern: "ravi.inbox.mail.received",
    title: "Local inbox mail received",
    description: "New email projected into the native local inbox.",
    payload:
      "{ version, eventType, inboxItemId, sourceDomain, sourceType, sourceId, mail: { messageId, threadId, mailboxId, fromText, toText, subject, snippet, ... }, inbox, occurredAt, createdAt }",
    schema: {
      version: 1,
      fields: [
        { path: "version", type: "number", required: true, description: "Payload contract version." },
        { path: "eventType", type: "string", required: true, description: "Always inbox.mail.received." },
        { path: "inboxItemId", type: "string", required: true, description: "Native local inbox item id." },
        { path: "sourceDomain", type: "string", required: true, description: "Always mail for this topic." },
        { path: "sourceType", type: "string", required: true, description: "Always mail_message for this topic." },
        { path: "sourceId", type: "string", required: true, description: "Local mail message id." },
        {
          path: "mail.messageId",
          type: "string",
          required: true,
          description: "Local mail message id for ravi mail messages read.",
        },
        { path: "mail.threadId", type: "string", required: true, description: "Local mail thread id." },
        { path: "mail.mailboxId", type: "string", required: true, description: "Local mailbox id." },
        { path: "mail.accountId", type: "string", required: true, description: "Local mail account id." },
        { path: "mail.providerMessageId", type: ["string", "null"], description: "Provider message id when known." },
        { path: "mail.rfcMessageId", type: ["string", "null"], description: "RFC Message-ID when known." },
        { path: "mail.subject", type: ["string", "null"], description: "Safe email subject." },
        { path: "mail.snippet", type: ["string", "null"], description: "Safe email snippet." },
        {
          path: "mail.bodyRedactionStatus",
          type: "string",
          required: true,
          description: "Whether the body is stored/redacted.",
        },
        { path: "mail.receivedAt", type: ["number", "null"], description: "Received timestamp in ms when known." },
        { path: "mail.from", type: "array", required: true, description: "Safe sender addresses." },
        { path: "mail.fromText", type: "string", required: true, description: "Agent-facing sender address text." },
        { path: "mail.to", type: "array", required: true, description: "Safe recipient addresses." },
        { path: "mail.toText", type: "string", required: true, description: "Agent-facing recipient address text." },
        {
          path: "mail.attachments",
          type: "array",
          description: "Metadata-only attachment list; never raw bytes or remote URLs.",
        },
        { path: "inbox.title", type: ["string", "null"], description: "Native inbox item title." },
        { path: "inbox.summary", type: ["string", "null"], description: "Native inbox item summary." },
        { path: "inbox.status", type: "string", required: true, description: "Native inbox item status." },
        { path: "inbox.priority", type: "string", required: true, description: "Native inbox item priority." },
        { path: "occurredAt", type: ["string", "null"], description: "ISO occurrence timestamp." },
        { path: "createdAt", type: "string", required: true, description: "ISO local event creation timestamp." },
      ],
    },
    messageTemplate: {
      id: "mail-inbox-default",
      description: "Default agent-facing notification for a new local email.",
      template:
        "[ravi mail] novo email no inbox: {{data.mail.messageId}}. De: {{data.mail.fromText}}. Para: {{data.mail.toText}}. Assunto: {{data.mail.subject}}. Use ravi mail messages read {{data.mail.messageId}} para ler.",
      variables: ["data.mail.messageId", "data.mail.fromText", "data.mail.toText", "data.mail.subject"],
    },
    examples: ['ravi triggers add "New local email" --topic "ravi.inbox.mail.received"'],
    notes: [
      "Use this for email automations. ravi.console.inbox.item is only the Console delivery mirror and should not be the durable email trigger.",
      "Attachment entries are metadata-only. Use ravi mail commands to read/download attachment content explicitly.",
    ],
  },
  {
    id: "console.inbox.item",
    category: "watch",
    pattern: "ravi.console.inbox.item",
    title: "Console inbox item",
    description: "Delivered Console inbox item, including watch events.",
    payload: "{ eventId, eventType, source, payload, links, occurredAt, createdAt, ... }",
    schema: {
      version: 1,
      fields: [
        { path: "eventId", type: "string", required: true, description: "Console event id." },
        { path: "eventType", type: "string", required: true, description: "Console event type." },
        { path: "source", type: "object", description: "Console source metadata." },
        { path: "payload", type: "object", description: "Console-delivered payload." },
        { path: "links", type: "object", description: "Console link metadata." },
        { path: "occurredAt", type: "string", description: "ISO occurrence timestamp." },
        { path: "createdAt", type: "string", description: "ISO creation timestamp." },
      ],
    },
    examples: ['ravi triggers add "Console watch item" --topic "ravi.console.inbox.item" --message "..."'],
    notes: ["For local email, listen to ravi.inbox.mail.received instead."],
  },
  {
    id: "watch.event",
    category: "watch",
    pattern: "ravi.watch.*.*",
    title: "Normalized watch event",
    description: "Normalized event produced from a local or Console watch.",
    payload: "{ version, eventId, watchId, connector, placement, eventType, subject, source, payload, occurredAt }",
    schema: {
      version: 1,
      fields: [
        { path: "version", type: "number", required: true, description: "Payload contract version." },
        { path: "eventId", type: "string", required: true, description: "Local watch event id." },
        { path: "watchId", type: "string", required: true, description: "Watch definition id." },
        { path: "connector", type: "string", required: true, description: "Watch connector name." },
        { path: "placement", type: "string", description: "Where this watch event should be handled." },
        { path: "eventType", type: "string", required: true, description: "Connector event type." },
        { path: "subject", type: "string", required: true, description: "Event subject." },
        { path: "source", type: "object", description: "Connector source metadata." },
        { path: "payload", type: "object", description: "Connector payload." },
        { path: "occurredAt", type: "string", description: "ISO occurrence timestamp." },
      ],
    },
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
    schema: {
      version: 1,
      fields: [
        { path: "task", type: "object", required: true, description: "Task snapshot." },
        { path: "event", type: "object", required: true, description: "Task lifecycle event." },
        { path: "event.type", type: "string", description: "Lifecycle event type." },
        { path: "reportToSessionName", type: "string", description: "Session that should receive reports." },
        { path: "reportEvents", type: "array", description: "Requested report event types." },
      ],
    },
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
    schema: {
      version: 1,
      fields: [
        { path: "ruleId", type: "string", required: true, description: "Tag rule id." },
        { path: "targetType", type: "string", required: true, description: "Tagged target type." },
        { path: "targetId", type: "string", required: true, description: "Tagged target id." },
        { path: "tagSlug", type: "string", required: true, description: "Applied tag slug." },
        { path: "cascadeDepth", type: "number", description: "Cascade depth when the tag came from propagation." },
      ],
    },
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

function cloneTopicEntry(entry: TriggerTopicCatalogEntry): TriggerTopicCatalogEntry {
  return {
    ...entry,
    ...(entry.schema
      ? {
          schema: {
            ...entry.schema,
            fields: entry.schema.fields.map((field) => ({
              ...field,
              type: Array.isArray(field.type) ? [...field.type] : field.type,
            })),
          },
        }
      : {}),
    ...(entry.messageTemplate
      ? {
          messageTemplate: {
            ...entry.messageTemplate,
            variables: [...entry.messageTemplate.variables],
          },
        }
      : {}),
    examples: [...entry.examples],
    ...(entry.filters ? { filters: [...entry.filters] } : {}),
    ...(entry.notes ? { notes: [...entry.notes] } : {}),
  };
}

export function getTriggerTopicCatalog(): TriggerTopicCatalogEntry[] {
  return TOPICS.map(cloneTopicEntry);
}

export function findTriggerTopicCatalogEntry(topic: string): TriggerTopicCatalogEntry | undefined {
  const trimmed = topic.trim();
  const entry = TOPICS.find((item) => trimmed === item.pattern || matchesTopicPattern(trimmed, item.pattern));
  return entry ? cloneTopicEntry(entry) : undefined;
}

export function isTriggerTopicInCatalog(topic: string): boolean {
  return findTriggerTopicCatalogEntry(topic) !== undefined;
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
