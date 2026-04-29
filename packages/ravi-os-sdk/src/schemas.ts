// GENERATED FILE — DO NOT EDIT.
// Run `ravi sdk client generate` to regenerate.
// Drift is detected by `ravi sdk client check` (CI).

/**
 * JSON Schema constants for every registry command. Emitted as `as const`
 * so callers can pair them with `ajv` / `zod-from-json-schema` / etc when
 * client-side validation is desired.
 */

export type SdkJsonSchema = Record<string, unknown>;

/** JSON Schema for the input body of `adapters.list`. */
export const AdaptersListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "session": {
      "description": "Filter by session key",
      "type": "string"
    },
    "status": {
      "description": "Filter by adapter status",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `adapters.show`. */
export const AdaptersShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "adapterId": {
      "description": "Adapter ID to inspect",
      "type": "string"
    }
  },
  "required": [
    "adapterId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.create`. */
export const AgentsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "allowRuntimeMismatch": {
      "description": "Allow mutation even when the CLI bundle differs from the live daemon runtime",
      "type": "boolean"
    },
    "cwd": {
      "description": "Working directory",
      "type": "string"
    },
    "id": {
      "description": "Agent ID",
      "type": "string"
    },
    "provider": {
      "description": "Runtime provider id",
      "type": "string"
    }
  },
  "required": [
    "cwd",
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.debounce`. */
export const AgentsDebounceInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    },
    "ms": {
      "description": "Debounce time in ms (0 to disable)",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.debug`. */
export const AgentsDebugInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name/key (omit for main)",
      "type": "string"
    },
    "turns": {
      "description": "Number of recent turns to show (default: 5)",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.delete`. */
export const AgentsDeleteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.list`. */
export const AgentsListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.reset`. */
export const AgentsResetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name/key, 'all' to reset all, or omit for main",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.session`. */
export const AgentsSessionInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.set`. */
export const AgentsSetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    },
    "key": {
      "description": "Property key",
      "type": "string"
    },
    "value": {
      "description": "Property value",
      "type": "string"
    }
  },
  "required": [
    "id",
    "key",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.show`. */
export const AgentsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.spec-mode`. */
export const AgentsSpecModeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "enabled": {
      "description": "true/false",
      "type": "string"
    },
    "id": {
      "description": "Agent ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `agents.sync-instructions`. */
export const AgentsSyncInstructionsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Sync only one agent",
      "type": "string"
    },
    "materializeMissing": {
      "description": "Create a default AGENTS.md stub when both instruction files are missing",
      "type": "boolean"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.archive`. */
export const ArtifactsArchiveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Artifact id",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.attach`. */
export const ArtifactsAttachInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Artifact id",
      "type": "string"
    },
    "metadata": {
      "description": "Link metadata JSON object",
      "type": "string"
    },
    "relation": {
      "description": "Relation name (default: related)",
      "type": "string"
    },
    "targetId": {
      "description": "Target id",
      "type": "string"
    },
    "targetType": {
      "description": "Target type, e.g. task, session, message, project",
      "type": "string"
    }
  },
  "required": [
    "id",
    "targetId",
    "targetType"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.blob`. */
export const ArtifactsBlobInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Artifact id",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.create`. */
export const ArtifactsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "command": {
      "description": "Command that produced the artifact",
      "type": "string"
    },
    "costUsd": {
      "description": "Known cost in USD",
      "type": "string"
    },
    "durationMs": {
      "description": "Generation duration in milliseconds",
      "type": "string"
    },
    "input": {
      "description": "Raw/structured input JSON",
      "type": "string"
    },
    "inputTokens": {
      "description": "Input token count",
      "type": "string"
    },
    "kind": {
      "description": "Artifact kind, e.g. image, audio, report, trace",
      "type": "string"
    },
    "lineage": {
      "description": "Lineage JSON object",
      "type": "string"
    },
    "message": {
      "description": "Channel message id",
      "type": "string"
    },
    "metadata": {
      "description": "Metadata JSON object",
      "type": "string"
    },
    "metrics": {
      "description": "Metrics JSON object",
      "type": "string"
    },
    "mime": {
      "description": "MIME type override",
      "type": "string"
    },
    "model": {
      "description": "Model that produced the artifact",
      "type": "string"
    },
    "output": {
      "description": "Raw/structured output JSON",
      "type": "string"
    },
    "outputTokens": {
      "description": "Output token count",
      "type": "string"
    },
    "path": {
      "description": "Local file to ingest into artifact blob storage",
      "type": "string"
    },
    "prompt": {
      "description": "Prompt or user instruction that generated the artifact",
      "type": "string"
    },
    "provider": {
      "description": "Provider that produced the artifact",
      "type": "string"
    },
    "session": {
      "description": "Override session key/name",
      "type": "string"
    },
    "summary": {
      "description": "Human summary",
      "type": "string"
    },
    "tags": {
      "description": "Comma-separated tags",
      "type": "string"
    },
    "task": {
      "description": "Task id",
      "type": "string"
    },
    "title": {
      "description": "Human title",
      "type": "string"
    },
    "totalTokens": {
      "description": "Total token count",
      "type": "string"
    },
    "uri": {
      "description": "External URI/reference",
      "type": "string"
    }
  },
  "required": [
    "kind"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.event`. */
export const ArtifactsEventInputSchema = {
  "additionalProperties": false,
  "properties": {
    "eventType": {
      "description": "Event type, e.g. started, completed, failed",
      "type": "string"
    },
    "id": {
      "description": "Artifact id",
      "type": "string"
    },
    "message": {
      "description": "Human-readable event message",
      "type": "string"
    },
    "payload": {
      "description": "Structured event payload JSON object",
      "type": "string"
    },
    "source": {
      "description": "Event source",
      "type": "string"
    },
    "status": {
      "description": "Lifecycle status for this event",
      "type": "string"
    }
  },
  "required": [
    "eventType",
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.events`. */
export const ArtifactsEventsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Artifact id",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.list`. */
export const ArtifactsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Filter rich projection by agent id",
      "type": "string"
    },
    "includeDeleted": {
      "description": "Include archived/deleted artifacts",
      "type": "boolean"
    },
    "kind": {
      "description": "Filter by artifact kind",
      "type": "string"
    },
    "lifecycle": {
      "description": "Filter rich projection by lifecycle: active|archived|stale",
      "type": "string"
    },
    "limit": {
      "description": "Max artifacts to list (default: 50)",
      "type": "string"
    },
    "rich": {
      "description": "Return rich projection with stats and per-item lineage (task/session/agent refs). Honors --kind/--session/--task/--limit/--lifecycle/--agent; ignores --tag/--include-deleted.",
      "type": "boolean"
    },
    "session": {
      "description": "Filter by session key or name",
      "type": "string"
    },
    "tag": {
      "description": "Filter by tag",
      "type": "string"
    },
    "task": {
      "description": "Filter by task id",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.show`. */
export const ArtifactsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Artifact id",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.update`. */
export const ArtifactsUpdateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "command": {
      "description": "Replace command",
      "type": "string"
    },
    "costUsd": {
      "description": "Replace known cost in USD",
      "type": "string"
    },
    "durationMs": {
      "description": "Replace duration in milliseconds",
      "type": "string"
    },
    "id": {
      "description": "Artifact id",
      "type": "string"
    },
    "input": {
      "description": "Replace raw/structured input JSON",
      "type": "string"
    },
    "inputTokens": {
      "description": "Replace input token count",
      "type": "string"
    },
    "lineage": {
      "description": "Merge lineage JSON object",
      "type": "string"
    },
    "message": {
      "description": "Replace channel message id",
      "type": "string"
    },
    "metadata": {
      "description": "Merge metadata JSON object",
      "type": "string"
    },
    "metrics": {
      "description": "Merge metrics JSON object",
      "type": "string"
    },
    "mime": {
      "description": "Replace MIME type",
      "type": "string"
    },
    "model": {
      "description": "Replace model",
      "type": "string"
    },
    "output": {
      "description": "Replace raw/structured output JSON",
      "type": "string"
    },
    "outputTokens": {
      "description": "Replace output token count",
      "type": "string"
    },
    "path": {
      "description": "Replace/ingest file path",
      "type": "string"
    },
    "prompt": {
      "description": "Replace prompt",
      "type": "string"
    },
    "provider": {
      "description": "Replace provider",
      "type": "string"
    },
    "session": {
      "description": "Replace session name/key reference",
      "type": "string"
    },
    "status": {
      "description": "Replace status",
      "type": "string"
    },
    "summary": {
      "description": "Replace summary",
      "type": "string"
    },
    "tags": {
      "description": "Replace tags",
      "type": "string"
    },
    "task": {
      "description": "Replace task id",
      "type": "string"
    },
    "title": {
      "description": "Replace title",
      "type": "string"
    },
    "totalTokens": {
      "description": "Replace total token count",
      "type": "string"
    },
    "uri": {
      "description": "Replace external URI/reference",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `artifacts.watch`. */
export const ArtifactsWatchInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Artifact id",
      "type": "string"
    },
    "intervalMs": {
      "description": "Polling interval in milliseconds (default: 1000)",
      "type": "string"
    },
    "timeoutMs": {
      "description": "Timeout in milliseconds (default: 300000)",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `audio.generate`. */
export const AudioGenerateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "caption": {
      "description": "Caption when sending (used with --send)",
      "type": "string"
    },
    "format": {
      "description": "Output format: mp3_44100_128 (default), mp3_22050_32, pcm_16000",
      "type": "string"
    },
    "lang": {
      "description": "Language code: pt, en, es, etc",
      "type": "string"
    },
    "model": {
      "description": "Model: eleven_multilingual_v2, eleven_turbo_v2_5, etc",
      "type": "string"
    },
    "output": {
      "description": "Output directory (default: /tmp)",
      "type": "string"
    },
    "send": {
      "description": "Auto-send generated audio to the current chat",
      "type": "boolean"
    },
    "speed": {
      "description": "Speech speed 0.5-2.0 (default: 1.0)",
      "type": "string"
    },
    "text": {
      "description": "Text to convert to speech",
      "type": "string"
    },
    "voice": {
      "description": "ElevenLabs voice ID",
      "type": "string"
    }
  },
  "required": [
    "text"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.add`. */
export const ContactsAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Restrict to agent(s), comma-separated",
      "type": "string"
    },
    "identity": {
      "description": "Phone number or LID",
      "type": "string"
    },
    "kind": {
      "description": "Contact kind: person or org",
      "type": "string"
    },
    "name": {
      "description": "Contact name",
      "type": "string"
    }
  },
  "required": [
    "identity"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.allow`. */
export const ContactsAllowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.approve`. */
export const ContactsApproveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Restrict to agent(s), comma-separated",
      "type": "string"
    },
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    },
    "mode": {
      "description": "Reply mode (auto|mention)",
      "type": "string"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.block`. */
export const ContactsBlockInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.check`. */
export const ContactsCheckInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.duplicates`. */
export const ContactsDuplicatesInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.find`. */
export const ContactsFindInputSchema = {
  "additionalProperties": false,
  "properties": {
    "query": {
      "description": "Tag name (with --tag) or search query",
      "type": "string"
    },
    "tag": {
      "description": "Search by tag",
      "type": "boolean"
    }
  },
  "required": [
    "query"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.get`. */
export const ContactsGetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.group-tag`. */
export const ContactsGroupTagInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    },
    "group": {
      "description": "Group contact ID or identity",
      "type": "string"
    },
    "tag": {
      "description": "Tag label",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "group",
    "tag"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.group-untag`. */
export const ContactsGroupUntagInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    },
    "group": {
      "description": "Group contact ID or identity",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "group"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.identity-add`. */
export const ContactsIdentityAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    },
    "platform": {
      "description": "Platform (phone, whatsapp_lid, telegram, email)",
      "type": "string"
    },
    "value": {
      "description": "Identity value",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "platform",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.identity-remove`. */
export const ContactsIdentityRemoveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "platform": {
      "description": "Platform",
      "type": "string"
    },
    "value": {
      "description": "Identity value",
      "type": "string"
    }
  },
  "required": [
    "platform",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.info`. */
export const ContactsInfoInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.link`. */
export const ContactsLinkInputSchema = {
  "additionalProperties": false,
  "properties": {
    "channel": {
      "description": "Channel, e.g. phone, whatsapp, telegram, email",
      "type": "string"
    },
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    },
    "id": {
      "description": "Platform user ID",
      "type": "string"
    },
    "instance": {
      "description": "Channel instance ID",
      "type": "string"
    },
    "reason": {
      "description": "Reason for the link audit event",
      "type": "string"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.list`. */
export const ContactsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "status": {
      "description": "Filter by status",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.merge`. */
export const ContactsMergeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "source": {
      "description": "Source contact ID (will be deleted)",
      "type": "string"
    },
    "target": {
      "description": "Target contact ID",
      "type": "string"
    }
  },
  "required": [
    "source",
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.pending`. */
export const ContactsPendingInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "Filter by account",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.remove`. */
export const ContactsRemoveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.set`. */
export const ContactsSetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    },
    "key": {
      "description": "Property key",
      "type": "string"
    },
    "value": {
      "description": "Property value",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "key",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.tag`. */
export const ContactsTagInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    },
    "tag": {
      "description": "Tag to add",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "tag"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.unlink`. */
export const ContactsUnlinkInputSchema = {
  "additionalProperties": false,
  "properties": {
    "channel": {
      "description": "Disambiguate identity value by channel",
      "type": "string"
    },
    "instance": {
      "description": "Disambiguate identity value by instance id",
      "type": "string"
    },
    "platformIdentity": {
      "description": "Platform identity ID or value",
      "type": "string"
    },
    "reason": {
      "description": "Reason for the unlink audit event",
      "type": "string"
    }
  },
  "required": [
    "platformIdentity"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `contacts.untag`. */
export const ContactsUntagInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact ID or identity",
      "type": "string"
    },
    "tag": {
      "description": "Tag to remove",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "tag"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.authorize`. */
export const ContextAuthorizeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "objectId": {
      "description": "Object identifier or pattern target",
      "type": "string"
    },
    "objectType": {
      "description": "Object type (e.g. group, session, tool)",
      "type": "string"
    },
    "permission": {
      "description": "Permission name (e.g. execute, access, use)",
      "type": "string"
    }
  },
  "required": [
    "objectId",
    "objectType",
    "permission"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.capabilities`. */
export const ContextCapabilitiesInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.check`. */
export const ContextCheckInputSchema = {
  "additionalProperties": false,
  "properties": {
    "objectId": {
      "description": "Object identifier or pattern target",
      "type": "string"
    },
    "objectType": {
      "description": "Object type (e.g. group, session, tool)",
      "type": "string"
    },
    "permission": {
      "description": "Permission name (e.g. execute, access, use)",
      "type": "string"
    }
  },
  "required": [
    "objectId",
    "objectType",
    "permission"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.cleanup-agent-runtime`. */
export const ContextCleanupAgentRuntimeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Filter by agent ID",
      "type": "string"
    },
    "olderThan": {
      "description": "Only include contexts whose last use or creation is older than this duration (default: 1h)",
      "type": "string"
    },
    "reason": {
      "description": "Revocation reason for audit metadata",
      "type": "string"
    },
    "revoke": {
      "description": "Actually revoke matching contexts; omitted means dry-run",
      "type": "boolean"
    },
    "session": {
      "description": "Filter by session key",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.codex-bash-hook`. */
export const ContextCodexBashHookInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.credentials.add`. */
export const ContextCredentialsAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contextKey": {
      "description": "Runtime context-key (rctx_*)",
      "type": "string"
    },
    "label": {
      "description": "Human label (defaults to hostname)",
      "type": "string"
    },
    "setDefault": {
      "description": "Mark this entry as the default",
      "type": "boolean"
    }
  },
  "required": [
    "contextKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.credentials.list`. */
export const ContextCredentialsListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.credentials.remove`. */
export const ContextCredentialsRemoveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contextKey": {
      "description": "Runtime context-key (rctx_*)",
      "type": "string"
    }
  },
  "required": [
    "contextKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.credentials.set-default`. */
export const ContextCredentialsSetDefaultInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contextKey": {
      "description": "Runtime context-key (rctx_*)",
      "type": "string"
    }
  },
  "required": [
    "contextKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.info`. */
export const ContextInfoInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contextId": {
      "description": "Context ID to inspect",
      "type": "string"
    }
  },
  "required": [
    "contextId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.issue`. */
export const ContextIssueInputSchema = {
  "additionalProperties": false,
  "properties": {
    "allow": {
      "description": "Comma-separated permission:objectType:objectId entries to lease to the child context",
      "type": "string"
    },
    "cliName": {
      "description": "Logical CLI name for audit and lineage",
      "type": "string"
    },
    "inherit": {
      "description": "Inherit all capabilities from the current context",
      "type": "boolean"
    },
    "ttl": {
      "description": "TTL like 30m, 2h or 1d (default: 1h, capped by the parent context)",
      "type": "string"
    }
  },
  "required": [
    "cliName"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.lineage`. */
export const ContextLineageInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contextId": {
      "description": "Context ID to inspect",
      "type": "string"
    }
  },
  "required": [
    "contextId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.list`. */
export const ContextListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Filter by agent ID",
      "type": "string"
    },
    "all": {
      "description": "Include revoked and expired contexts",
      "type": "boolean"
    },
    "kind": {
      "description": "Filter by context kind",
      "type": "string"
    },
    "session": {
      "description": "Filter by session key",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.revoke`. */
export const ContextRevokeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contextId": {
      "description": "Context ID to revoke",
      "type": "string"
    },
    "noCascade": {
      "default": true,
      "description": "Do not revoke descendant contexts (use only for narrow rotation; emits a loud warning)",
      "type": "boolean"
    },
    "reason": {
      "description": "Reason recorded in metadata for audit and forensics",
      "type": "string"
    }
  },
  "required": [
    "contextId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `context.whoami`. */
export const ContextWhoamiInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `costs.agent`. */
export const CostsAgentInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agentId": {
      "description": "Agent ID",
      "type": "string"
    },
    "hours": {
      "description": "Time window in hours (default: 24)",
      "type": "string"
    }
  },
  "required": [
    "agentId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `costs.agents`. */
export const CostsAgentsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "hours": {
      "description": "Time window in hours (default: 24)",
      "type": "string"
    },
    "limit": {
      "description": "Max agents to show (default: 20)",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `costs.session`. */
export const CostsSessionInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `costs.summary`. */
export const CostsSummaryInputSchema = {
  "additionalProperties": false,
  "properties": {
    "hours": {
      "description": "Time window in hours (default: 24)",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `costs.top-sessions`. */
export const CostsTopSessionsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "hours": {
      "description": "Time window in hours (default: 24)",
      "type": "string"
    },
    "limit": {
      "description": "Max sessions to show (default: 10)",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `cron.add`. */
export const CronAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "Account for channel delivery (auto-detected from agent)",
      "type": "string"
    },
    "agent": {
      "description": "Agent ID (default: default agent)",
      "type": "string"
    },
    "at": {
      "description": "One-shot time (e.g., 2025-02-01T15:00)",
      "type": "string"
    },
    "cron": {
      "description": "Cron expression (e.g., '0 9 * * *')",
      "type": "string"
    },
    "deleteAfter": {
      "description": "Delete job after first run",
      "type": "boolean"
    },
    "description": {
      "description": "Job description",
      "type": "string"
    },
    "every": {
      "description": "Interval (e.g., 30m, 1h)",
      "type": "string"
    },
    "isolated": {
      "description": "Run in isolated session",
      "type": "boolean"
    },
    "message": {
      "description": "Prompt message",
      "type": "string"
    },
    "name": {
      "description": "Job name",
      "type": "string"
    },
    "tz": {
      "description": "Timezone (e.g., America/Sao_Paulo)",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `cron.disable`. */
export const CronDisableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Job ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `cron.enable`. */
export const CronEnableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Job ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `cron.list`. */
export const CronListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `cron.rm`. */
export const CronRmInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Job ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `cron.run`. */
export const CronRunInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Job ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `cron.set`. */
export const CronSetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Job ID",
      "type": "string"
    },
    "key": {
      "description": "Property: name, message, cron, every, tz, agent, account, description, session, reply-session, delete-after",
      "type": "string"
    },
    "value": {
      "description": "Property value",
      "type": "string"
    }
  },
  "required": [
    "id",
    "key",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `cron.show`. */
export const CronShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Job ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.env`. */
export const DaemonEnvInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.init-admin-key`. */
export const DaemonInitAdminKeyInputSchema = {
  "additionalProperties": false,
  "properties": {
    "fromEnv": {
      "description": "Read RAVI_BOOTSTRAP_KEY from env. Imports it as the admin context key when the registry is empty; idempotent if it matches an existing live admin context; fails loud if it conflicts.",
      "type": "boolean"
    },
    "label": {
      "description": "Label for the bootstrap context (default: hostname)",
      "type": "string"
    },
    "noStore": {
      "default": true,
      "description": "Alias for --print-only (do not write to ~/.ravi/credentials.json)",
      "type": "boolean"
    },
    "printOnly": {
      "description": "Print the rctx key without writing it to the credentials file",
      "type": "boolean"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.install`. */
export const DaemonInstallInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.logs`. */
export const DaemonLogsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "clear": {
      "description": "Flush PM2 logs for ravi",
      "type": "boolean"
    },
    "follow": {
      "description": "Follow log output",
      "type": "boolean"
    },
    "path": {
      "description": "Print PM2 log file path",
      "type": "boolean"
    },
    "tail": {
      "default": "50",
      "description": "Number of lines to show",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.restart`. */
export const DaemonRestartInputSchema = {
  "additionalProperties": false,
  "properties": {
    "build": {
      "description": "Run build before restarting (dev mode)",
      "type": "boolean"
    },
    "message": {
      "description": "Restart reason to notify main agent",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.start`. */
export const DaemonStartInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.status`. */
export const DaemonStatusInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.stop`. */
export const DaemonStopInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `daemon.uninstall`. */
export const DaemonUninstallInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.auth.check`. */
export const DevinAuthCheckInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.archive`. */
export const DevinSessionsArchiveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "session": {
      "description": "Local id or devin-* id",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.attachments`. */
export const DevinSessionsAttachmentsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "cached": {
      "description": "Use local cache only",
      "type": "boolean"
    },
    "session": {
      "description": "Local id or devin-* id",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.create`. */
export const DevinSessionsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "advancedMode": {
      "description": "analyze|create|improve|batch|manage",
      "type": "string"
    },
    "asUser": {
      "description": "create_as_user_id",
      "type": "string"
    },
    "attachmentUrl": {
      "description": "Attachment URLs",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "bypassApproval": {
      "description": "Request bypass_approval=true",
      "type": "boolean"
    },
    "childPlaybook": {
      "description": "Child playbook ID",
      "type": "string"
    },
    "knowledge": {
      "description": "Knowledge note IDs",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "maxAcu": {
      "description": "Per-session max ACU ceiling",
      "type": "string"
    },
    "noMaxAcuLimit": {
      "default": true,
      "description": "Intentionally omit max_acu_limit",
      "type": "boolean"
    },
    "playbook": {
      "description": "Playbook ID",
      "type": "string"
    },
    "project": {
      "description": "Link to Ravi project",
      "type": "string"
    },
    "prompt": {
      "description": "Prompt for Devin",
      "type": "string"
    },
    "promptFile": {
      "description": "Read prompt from file",
      "type": "string"
    },
    "proxRun": {
      "description": "Link to prox run",
      "type": "string"
    },
    "repo": {
      "description": "Repos; can be repeated or comma-separated",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "secret": {
      "description": "Secret IDs",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "sessionLink": {
      "description": "Linked Devin sessions",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "structuredOutputSchema": {
      "description": "JSON schema for structured output",
      "type": "string"
    },
    "tag": {
      "description": "Tags; can be repeated or comma-separated",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "task": {
      "description": "Link to Ravi task",
      "type": "string"
    },
    "title": {
      "description": "Session title",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.insights`. */
export const DevinSessionsInsightsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "generate": {
      "description": "Ask Devin to generate/update insights before reading",
      "type": "boolean"
    },
    "session": {
      "description": "Local id or devin-* id",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.list`. */
export const DevinSessionsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "limit": {
      "description": "Max sessions to show (default: 20)",
      "type": "string"
    },
    "remote": {
      "description": "Fetch remote sessions and update local cache",
      "type": "boolean"
    },
    "status": {
      "description": "Filter local sessions by status",
      "type": "string"
    },
    "tag": {
      "description": "Filter sessions by tag",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.messages`. */
export const DevinSessionsMessagesInputSchema = {
  "additionalProperties": false,
  "properties": {
    "cached": {
      "description": "Use local cache only",
      "type": "boolean"
    },
    "session": {
      "description": "Local id or devin-* id",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.send`. */
export const DevinSessionsSendInputSchema = {
  "additionalProperties": false,
  "properties": {
    "asUser": {
      "description": "message_as_user_id",
      "type": "string"
    },
    "message": {
      "description": "Message text",
      "type": "string"
    },
    "session": {
      "description": "Local id or devin-* id",
      "type": "string"
    }
  },
  "required": [
    "message",
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.show`. */
export const DevinSessionsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "session": {
      "description": "Local id or devin-* id",
      "type": "string"
    },
    "sync": {
      "description": "Fetch latest remote state first",
      "type": "boolean"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.sync`. */
export const DevinSessionsSyncInputSchema = {
  "additionalProperties": false,
  "properties": {
    "artifacts": {
      "description": "Register a sync artifact",
      "type": "boolean"
    },
    "insights": {
      "description": "Fetch Devin session insights/activity summary",
      "type": "boolean"
    },
    "session": {
      "description": "Local id or devin-* id",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `devin.sessions.terminate`. */
export const DevinSessionsTerminateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "archive": {
      "description": "Archive after terminating",
      "type": "boolean"
    },
    "session": {
      "description": "Local id or devin-* id",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `eval.run`. */
export const EvalRunInputSchema = {
  "additionalProperties": false,
  "properties": {
    "output": {
      "description": "Optional output directory for run artifacts",
      "type": "string"
    },
    "specPath": {
      "description": "Path to the eval task spec JSON",
      "type": "string"
    }
  },
  "required": [
    "specPath"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `heartbeat.disable`. */
export const HeartbeatDisableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `heartbeat.enable`. */
export const HeartbeatEnableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    },
    "interval": {
      "description": "Interval (e.g., 30m, 1h)",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `heartbeat.set`. */
export const HeartbeatSetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    },
    "key": {
      "description": "Property: interval, model, account, active-hours",
      "type": "string"
    },
    "value": {
      "description": "Property value",
      "type": "string"
    }
  },
  "required": [
    "id",
    "key",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `heartbeat.show`. */
export const HeartbeatShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `heartbeat.status`. */
export const HeartbeatStatusInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `heartbeat.trigger`. */
export const HeartbeatTriggerInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Agent ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `hooks.create`. */
export const HooksCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "action": {
      "description": "Action: inject_context, send_session_event, append_history, comment_task",
      "type": "string"
    },
    "agent": {
      "description": "Agent scope value",
      "type": "string"
    },
    "async": {
      "description": "Run hook action asynchronously",
      "type": "boolean"
    },
    "barrier": {
      "description": "Delivery barrier for prompt actions",
      "type": "string"
    },
    "cooldown": {
      "description": "Cooldown (e.g. 5s, 1m)",
      "type": "string"
    },
    "dedupeKey": {
      "description": "Optional dedupe template",
      "type": "string"
    },
    "disabled": {
      "description": "Create hook disabled",
      "type": "boolean"
    },
    "event": {
      "description": "Event: SessionStart, PreToolUse, PostToolUse, CwdChanged, FileChanged, Stop",
      "type": "string"
    },
    "matcher": {
      "description": "Optional matcher (tool name, path, session, etc)",
      "type": "string"
    },
    "message": {
      "description": "Action message/body template",
      "type": "string"
    },
    "name": {
      "description": "Hook name",
      "type": "string"
    },
    "role": {
      "description": "append_history role: user or assistant",
      "type": "string"
    },
    "scope": {
      "description": "Scope: global, agent, session, workspace, task",
      "type": "string"
    },
    "session": {
      "description": "Session scope value",
      "type": "string"
    },
    "targetSession": {
      "description": "Target session for action payload",
      "type": "string"
    },
    "targetTask": {
      "description": "Target task for comment_task payload",
      "type": "string"
    },
    "task": {
      "description": "Task scope value",
      "type": "string"
    },
    "workspace": {
      "description": "Workspace scope value",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `hooks.disable`. */
export const HooksDisableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Hook ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `hooks.enable`. */
export const HooksEnableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Hook ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `hooks.list`. */
export const HooksListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `hooks.rm`. */
export const HooksRmInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Hook ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `hooks.show`. */
export const HooksShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Hook ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `hooks.test`. */
export const HooksTestInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Hook ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `image.atlas.split`. */
export const ImageAtlasSplitInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "Explicit Ravi/Omni account id for --send",
      "type": "string"
    },
    "background": {
      "description": "Trim mode padding background (default: auto)",
      "type": "string"
    },
    "caption": {
      "description": "Caption template for sent crops. Supports {name}",
      "type": "string"
    },
    "channel": {
      "description": "Explicit channel for --send",
      "type": "string"
    },
    "cols": {
      "description": "Grid columns (default: 3)",
      "type": "string"
    },
    "fit": {
      "description": "Trim mode square fit: contain or cover (default: contain)",
      "type": "string"
    },
    "fuzz": {
      "description": "ImageMagick trim fuzz percentage for trim mode (default: 3)",
      "type": "string"
    },
    "input": {
      "description": "Atlas/contact sheet image path",
      "type": "string"
    },
    "mode": {
      "description": "Split mode: raw or trim. Default: raw",
      "type": "string"
    },
    "names": {
      "description": "Comma-separated crop names, one per cell",
      "type": "string"
    },
    "output": {
      "description": "Output directory for crops and manifest",
      "type": "string"
    },
    "pad": {
      "description": "Padding around trimmed crop for trim mode (default: 0)",
      "type": "string"
    },
    "parentArtifact": {
      "description": "Atlas artifact id to use as provenance",
      "type": "string"
    },
    "rows": {
      "description": "Grid rows (default: 2)",
      "type": "string"
    },
    "send": {
      "description": "Send each crop to the current or explicit chat target",
      "type": "boolean"
    },
    "size": {
      "description": "Output square size for trim mode (default: 512)",
      "type": "string"
    },
    "threadId": {
      "description": "Explicit thread/topic id for --send",
      "type": "string"
    },
    "to": {
      "description": "Explicit chat id for --send",
      "type": "string"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `image.generate`. */
export const ImageGenerateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "artifactId": {
      "description": "Internal artifact id for async worker continuation",
      "type": "string"
    },
    "aspect": {
      "description": "Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9",
      "type": "string"
    },
    "async": {
      "description": "Compatibility no-op: image generation is async by default",
      "type": "boolean"
    },
    "asyncWorker": {
      "description": "Internal background worker mode",
      "type": "boolean"
    },
    "background": {
      "description": "OpenAI background: transparent, opaque, auto",
      "type": "string"
    },
    "caption": {
      "description": "Caption when sending (used with --send)",
      "type": "string"
    },
    "compression": {
      "description": "OpenAI jpeg/webp output compression",
      "type": "string"
    },
    "format": {
      "description": "OpenAI output format: png, jpeg, webp",
      "type": "string"
    },
    "mode": {
      "description": "Legacy quality mode: fast or quality. Default: fast",
      "type": "string"
    },
    "model": {
      "description": "Provider image model override",
      "type": "string"
    },
    "output": {
      "description": "Output directory (default: /tmp)",
      "type": "string"
    },
    "prompt": {
      "description": "Text prompt describing the image to generate",
      "type": "string"
    },
    "provider": {
      "description": "Image provider: gemini or openai",
      "type": "string"
    },
    "quality": {
      "description": "OpenAI quality: low, medium, high, auto",
      "type": "string"
    },
    "send": {
      "description": "Auto-send generated image to the current chat",
      "type": "boolean"
    },
    "size": {
      "description": "Image size: 1K, 2K, 4K (default: 1K)",
      "type": "string"
    },
    "source": {
      "description": "Source image path for editing/reference",
      "type": "string"
    },
    "sync": {
      "description": "Wait for provider completion before returning",
      "type": "boolean"
    }
  },
  "required": [
    "prompt"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `insights.create`. */
export const InsightsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Link the insight to an agent",
      "type": "string"
    },
    "artifact": {
      "description": "Link the insight to one artifact path",
      "type": "string"
    },
    "autoContext": {
      "description": "Auto-link the current runtime session and agent when present",
      "type": "boolean"
    },
    "comment": {
      "description": "Optional initial comment to append after creation",
      "type": "string"
    },
    "confidence": {
      "description": "low|medium|high",
      "type": "string"
    },
    "detail": {
      "description": "Longer explanation or evidence",
      "type": "string"
    },
    "importance": {
      "description": "low|normal|high",
      "type": "string"
    },
    "kind": {
      "description": "observation|pattern|win|problem|improvement",
      "type": "string"
    },
    "linkId": {
      "description": "Extra link target ID/path",
      "type": "string"
    },
    "linkType": {
      "description": "Extra link type: task|session|agent|artifact|profile",
      "type": "string"
    },
    "profile": {
      "description": "Link the insight to a task profile",
      "type": "string"
    },
    "session": {
      "description": "Link the insight to a session",
      "type": "string"
    },
    "summary": {
      "description": "Short actionable summary",
      "type": "string"
    },
    "task": {
      "description": "Link the insight to a task",
      "type": "string"
    }
  },
  "required": [
    "summary"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `insights.list`. */
export const InsightsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Filter by linked agent",
      "type": "string"
    },
    "confidence": {
      "description": "low|medium|high",
      "type": "string"
    },
    "importance": {
      "description": "low|normal|high",
      "type": "string"
    },
    "kind": {
      "description": "observation|pattern|win|problem|improvement",
      "type": "string"
    },
    "limit": {
      "default": "20",
      "description": "Result limit",
      "type": "string"
    },
    "profile": {
      "description": "Filter by linked profile",
      "type": "string"
    },
    "query": {
      "description": "Free-text search over summaries/details/comments",
      "type": "string"
    },
    "rich": {
      "description": "Return rich projection with stats, decorated lineage (task/session/agent refs), and per-link metadata. Honors --limit only; other filters are ignored.",
      "type": "boolean"
    },
    "session": {
      "description": "Filter by linked session",
      "type": "string"
    },
    "task": {
      "description": "Filter by linked task",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `insights.search`. */
export const InsightsSearchInputSchema = {
  "additionalProperties": false,
  "properties": {
    "limit": {
      "default": "20",
      "description": "Result limit",
      "type": "string"
    },
    "text": {
      "description": "Search text",
      "type": "string"
    }
  },
  "required": [
    "text"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `insights.show`. */
export const InsightsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Insight ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.create`. */
export const InstancesCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Default agent for this instance",
      "type": "string"
    },
    "channel": {
      "description": "Channel type (default: whatsapp)",
      "type": "string"
    },
    "dmPolicy": {
      "description": "DM policy: open|pairing|closed (default: open)",
      "type": "string"
    },
    "groupPolicy": {
      "description": "Group policy: open|allowlist|closed (default: open)",
      "type": "string"
    },
    "name": {
      "description": "Instance name (e.g., main, vendas)",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.delete`. */
export const InstancesDeleteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.deleted`. */
export const InstancesDeletedInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.disable`. */
export const InstancesDisableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "target": {
      "description": "Instance name or omni instanceId",
      "type": "string"
    }
  },
  "required": [
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.disconnect`. */
export const InstancesDisconnectInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.enable`. */
export const InstancesEnableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "target": {
      "description": "Instance name or omni instanceId",
      "type": "string"
    }
  },
  "required": [
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.get`. */
export const InstancesGetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "key": {
      "description": "Property key (agent, dmPolicy, groupPolicy, dmScope, instanceId, channel, enabled, defaults)",
      "type": "string"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "key",
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.list`. */
export const InstancesListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.pending.approve`. */
export const InstancesPendingApproveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Agent to route an approved chat to",
      "type": "string"
    },
    "contact": {
      "description": "Contact identity or chat route pattern",
      "type": "string"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.pending.list`. */
export const InstancesPendingListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.pending.reject`. */
export const InstancesPendingRejectInputSchema = {
  "additionalProperties": false,
  "properties": {
    "contact": {
      "description": "Contact identity or chat route pattern",
      "type": "string"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.restore`. */
export const InstancesRestoreInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.routes.add`. */
export const InstancesRoutesAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Agent ID",
      "type": "string"
    },
    "allowRuntimeMismatch": {
      "description": "Allow mutation even when the CLI bundle differs from the live daemon runtime",
      "type": "boolean"
    },
    "channel": {
      "description": "Limit route to a specific channel (e.g. whatsapp, telegram). Omit for all channels.",
      "type": "string"
    },
    "dmScope": {
      "description": "DM scope override",
      "type": "string"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "pattern": {
      "description": "Route pattern (e.g., group:123456, 5511*, thread:*, *)",
      "type": "string"
    },
    "policy": {
      "description": "Policy override: open|pairing|closed|allowlist",
      "type": "string"
    },
    "priority": {
      "description": "Route priority (default: 0)",
      "type": "string"
    },
    "session": {
      "description": "Force session name",
      "type": "string"
    }
  },
  "required": [
    "agent",
    "name",
    "pattern"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.routes.deleted`. */
export const InstancesRoutesDeletedInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name (omit for all)",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.routes.list`. */
export const InstancesRoutesListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.routes.remove`. */
export const InstancesRoutesRemoveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "allowRuntimeMismatch": {
      "description": "Allow mutation even when the CLI bundle differs from the live daemon runtime",
      "type": "boolean"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "pattern": {
      "description": "Route pattern",
      "type": "string"
    }
  },
  "required": [
    "name",
    "pattern"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.routes.restore`. */
export const InstancesRoutesRestoreInputSchema = {
  "additionalProperties": false,
  "properties": {
    "allowRuntimeMismatch": {
      "description": "Allow mutation even when the CLI bundle differs from the live daemon runtime",
      "type": "boolean"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "pattern": {
      "description": "Route pattern",
      "type": "string"
    }
  },
  "required": [
    "name",
    "pattern"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.routes.set`. */
export const InstancesRoutesSetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "allowRuntimeMismatch": {
      "description": "Allow mutation even when the CLI bundle differs from the live daemon runtime",
      "type": "boolean"
    },
    "key": {
      "description": "Property key (agent, priority, dmScope, session, policy, channel)",
      "type": "string"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "pattern": {
      "description": "Route pattern",
      "type": "string"
    },
    "value": {
      "description": "Property value (use '-' to clear)",
      "type": "string"
    }
  },
  "required": [
    "key",
    "name",
    "pattern",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.routes.show`. */
export const InstancesRoutesShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "pattern": {
      "description": "Route pattern",
      "type": "string"
    }
  },
  "required": [
    "name",
    "pattern"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.set`. */
export const InstancesSetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "key": {
      "description": "Property key (agent, dmPolicy, groupPolicy, dmScope, instanceId, channel, enabled, defaults)",
      "type": "string"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "value": {
      "description": "Property value (use '-' to clear)",
      "type": "string"
    }
  },
  "required": [
    "key",
    "name",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.show`. */
export const InstancesShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.status`. */
export const InstancesStatusInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `instances.target`. */
export const InstancesTargetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "channel": {
      "description": "Optional channel hint for live route inspection",
      "type": "string"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "pattern": {
      "description": "Optional exact pattern to inspect against the live resolver (e.g. group:123456)",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `media.send`. */
export const MediaSendInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "Ravi account/instance alias",
      "type": "string"
    },
    "caption": {
      "description": "Caption for the media",
      "type": "string"
    },
    "channel": {
      "description": "Target channel (informational override)",
      "type": "string"
    },
    "filePath": {
      "description": "Path to the file to send",
      "type": "string"
    },
    "ptt": {
      "description": "Send audio as voice note (PTT)",
      "type": "boolean"
    },
    "threadId": {
      "description": "Thread/topic ID override",
      "type": "string"
    },
    "to": {
      "description": "Target chat ID",
      "type": "string"
    }
  },
  "required": [
    "filePath"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `permissions.check`. */
export const PermissionsCheckInputSchema = {
  "additionalProperties": false,
  "properties": {
    "object": {
      "description": "Object (e.g., group:contacts, session:dev-grupo1)",
      "type": "string"
    },
    "permission": {
      "description": "Permission (e.g., execute, access, admin)",
      "type": "string"
    },
    "subject": {
      "description": "Subject (e.g., agent:dev)",
      "type": "string"
    }
  },
  "required": [
    "object",
    "permission",
    "subject"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `permissions.clear`. */
export const PermissionsClearInputSchema = {
  "additionalProperties": false,
  "properties": {
    "all": {
      "description": "Clear ALL relations (including config)",
      "type": "boolean"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `permissions.grant`. */
export const PermissionsGrantInputSchema = {
  "additionalProperties": false,
  "properties": {
    "object": {
      "description": "Object (e.g., system:*, group:contacts, session:dev-*)",
      "type": "string"
    },
    "relation": {
      "description": "Relation (e.g., admin, access, execute, write_contacts)",
      "type": "string"
    },
    "subject": {
      "description": "Subject (e.g., agent:dev)",
      "type": "string"
    }
  },
  "required": [
    "object",
    "relation",
    "subject"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `permissions.init`. */
export const PermissionsInitInputSchema = {
  "additionalProperties": false,
  "properties": {
    "subject": {
      "description": "Subject (e.g., agent:dev)",
      "type": "string"
    },
    "template": {
      "description": "Template: sdk-tools, all-tools, safe-executables, full-access, tool-groups",
      "type": "string"
    }
  },
  "required": [
    "subject",
    "template"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `permissions.list`. */
export const PermissionsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "object": {
      "description": "Filter by object (e.g., group:contacts)",
      "type": "string"
    },
    "relation": {
      "description": "Filter by relation",
      "type": "string"
    },
    "source": {
      "description": "Filter by source (config|manual)",
      "type": "string"
    },
    "subject": {
      "description": "Filter by subject (e.g., agent:dev)",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `permissions.revoke`. */
export const PermissionsRevokeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "object": {
      "description": "Object (e.g., system:*, group:contacts)",
      "type": "string"
    },
    "relation": {
      "description": "Relation",
      "type": "string"
    },
    "subject": {
      "description": "Subject (e.g., agent:dev)",
      "type": "string"
    }
  },
  "required": [
    "object",
    "relation",
    "subject"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `permissions.sync`. */
export const PermissionsSyncInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.create`. */
export const ProjectsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "hypothesis": {
      "description": "Current working hypothesis",
      "type": "string"
    },
    "lastSignalAt": {
      "description": "now, epoch ms, or ISO-8601",
      "type": "string"
    },
    "nextStep": {
      "description": "Next human step",
      "type": "string"
    },
    "ownerAgent": {
      "description": "Owning agent id",
      "type": "string"
    },
    "session": {
      "description": "Operator session name or key",
      "type": "string"
    },
    "slug": {
      "description": "Stable project slug",
      "type": "string"
    },
    "status": {
      "description": "active|paused|blocked|done|archived",
      "type": "string"
    },
    "summary": {
      "description": "Human summary for the workstream",
      "type": "string"
    },
    "title": {
      "description": "Project title",
      "type": "string"
    }
  },
  "required": [
    "title"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.fixtures.seed`. */
export const ProjectsFixturesSeedInputSchema = {
  "additionalProperties": false,
  "properties": {
    "ownerAgent": {
      "description": "Owner agent for the seeded projects",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.init`. */
export const ProjectsInitInputSchema = {
  "additionalProperties": false,
  "properties": {
    "hypothesis": {
      "description": "Current working hypothesis",
      "type": "string"
    },
    "lastSignalAt": {
      "description": "now, epoch ms, or ISO-8601",
      "type": "string"
    },
    "nextStep": {
      "description": "Next human step",
      "type": "string"
    },
    "ownerAgent": {
      "description": "Owning agent id or 'none' (defaults to current actor agent)",
      "type": "string"
    },
    "resource": {
      "description": "Resource links to attach: repo|worktree|notion_page|notion_database|file|url|group|contact",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "session": {
      "description": "Operator session name; links existing or creates one for the owner agent",
      "type": "string"
    },
    "slug": {
      "description": "Stable project slug",
      "type": "string"
    },
    "status": {
      "description": "active|paused|blocked|done|archived",
      "type": "string"
    },
    "summary": {
      "description": "Human summary for the workstream",
      "type": "string"
    },
    "title": {
      "description": "Project title",
      "type": "string"
    },
    "workflowRun": {
      "description": "Attach existing workflow run ids",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "workflowTemplate": {
      "description": "Instantiate canonical workflow templates: technical-change|gated-release|operational-response",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "title"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.link`. */
export const ProjectsLinkInputSchema = {
  "additionalProperties": false,
  "properties": {
    "assetType": {
      "description": "workflow|session|agent|resource|spec",
      "type": "string"
    },
    "label": {
      "description": "Human label for resource links",
      "type": "string"
    },
    "meta": {
      "description": "Free JSON metadata for this link",
      "type": "string"
    },
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "resourceType": {
      "description": "Required for resource links",
      "type": "string"
    },
    "role": {
      "description": "Optional role for this link",
      "type": "string"
    },
    "target": {
      "description": "Asset id, session, agent, or locator",
      "type": "string"
    }
  },
  "required": [
    "assetType",
    "project",
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.list`. */
export const ProjectsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "status": {
      "description": "Filter by status",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.next`. */
export const ProjectsNextInputSchema = {
  "additionalProperties": false,
  "properties": {
    "status": {
      "description": "Filter by project status",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.resources.add`. */
export const ProjectsResourcesAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "label": {
      "description": "Human label override",
      "type": "string"
    },
    "meta": {
      "description": "Free JSON metadata for this resource",
      "type": "string"
    },
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "role": {
      "description": "Optional role for this resource",
      "type": "string"
    },
    "target": {
      "description": "Path, URL, group id, or locator",
      "type": "string"
    },
    "type": {
      "description": "repo|worktree|file|url|group|contact|notion_page|notion_database",
      "type": "string"
    }
  },
  "required": [
    "project",
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.resources.import`. */
export const ProjectsResourcesImportInputSchema = {
  "additionalProperties": false,
  "properties": {
    "group": {
      "description": "One or more group:<id> or <id>@g.us locators",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "meta": {
      "description": "Common JSON metadata merged into every imported resource",
      "type": "string"
    },
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "repo": {
      "description": "One or more repo locators (path or canonical URL)",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "role": {
      "description": "Optional role applied to every imported resource",
      "type": "string"
    },
    "url": {
      "description": "One or more URLs",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "worktree": {
      "description": "One or more local worktree paths",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "project"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.resources.list`. */
export const ProjectsResourcesListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "type": {
      "description": "Optional resource type filter",
      "type": "string"
    }
  },
  "required": [
    "project"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.resources.show`. */
export const ProjectsResourcesShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "resource": {
      "description": "Resource link id, label, or locator",
      "type": "string"
    }
  },
  "required": [
    "project",
    "resource"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.show`. */
export const ProjectsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "project": {
      "description": "Project id or slug",
      "type": "string"
    }
  },
  "required": [
    "project"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.status`. */
export const ProjectsStatusInputSchema = {
  "additionalProperties": false,
  "properties": {
    "project": {
      "description": "Project id or slug",
      "type": "string"
    }
  },
  "required": [
    "project"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.tasks.attach`. */
export const ProjectsTasksAttachInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Override project owner agent for dispatch",
      "type": "string"
    },
    "dispatch": {
      "description": "Dispatch after attach using project defaults",
      "type": "boolean"
    },
    "nodeKey": {
      "description": "Workflow node key",
      "type": "string"
    },
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "session": {
      "description": "Override project operator session for dispatch",
      "type": "string"
    },
    "taskId": {
      "description": "Existing task id",
      "type": "string"
    },
    "workflow": {
      "description": "Linked workflow run id (defaults to project focus)",
      "type": "string"
    }
  },
  "required": [
    "nodeKey",
    "project",
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.tasks.create`. */
export const ProjectsTasksCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Override project owner agent for dispatch",
      "type": "string"
    },
    "dispatch": {
      "description": "Dispatch after create using project defaults",
      "type": "boolean"
    },
    "instructions": {
      "description": "Task instructions",
      "type": "string"
    },
    "nodeKey": {
      "description": "Workflow node key",
      "type": "string"
    },
    "priority": {
      "description": "low|normal|high|urgent",
      "type": "string"
    },
    "profile": {
      "description": "Task profile id",
      "type": "string"
    },
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "session": {
      "description": "Override project operator session for dispatch",
      "type": "string"
    },
    "title": {
      "description": "Task title",
      "type": "string"
    },
    "workflow": {
      "description": "Linked workflow run id (defaults to project focus)",
      "type": "string"
    }
  },
  "required": [
    "nodeKey",
    "project",
    "title"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.tasks.dispatch`. */
export const ProjectsTasksDispatchInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Override project owner agent",
      "type": "string"
    },
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "session": {
      "description": "Override project operator session",
      "type": "string"
    },
    "taskId": {
      "description": "Existing task id",
      "type": "string"
    }
  },
  "required": [
    "project",
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.update`. */
export const ProjectsUpdateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "hypothesis": {
      "description": "Working hypothesis",
      "type": "string"
    },
    "lastSignalAt": {
      "description": "now, epoch ms, or ISO-8601",
      "type": "string"
    },
    "nextStep": {
      "description": "Next human step",
      "type": "string"
    },
    "ownerAgent": {
      "description": "Owning agent id or 'none'",
      "type": "string"
    },
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "session": {
      "description": "Operator session name or 'none'",
      "type": "string"
    },
    "status": {
      "description": "active|paused|blocked|done|archived",
      "type": "string"
    },
    "summary": {
      "description": "Human summary",
      "type": "string"
    },
    "title": {
      "description": "New title",
      "type": "string"
    },
    "touchSignal": {
      "description": "Set last_signal_at to now",
      "type": "boolean"
    }
  },
  "required": [
    "project"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.workflows.attach`. */
export const ProjectsWorkflowsAttachInputSchema = {
  "additionalProperties": false,
  "properties": {
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "role": {
      "description": "primary|support (defaults from current project state)",
      "type": "string"
    },
    "runId": {
      "description": "Workflow run id",
      "type": "string"
    }
  },
  "required": [
    "project",
    "runId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `projects.workflows.start`. */
export const ProjectsWorkflowsStartInputSchema = {
  "additionalProperties": false,
  "properties": {
    "project": {
      "description": "Project id or slug",
      "type": "string"
    },
    "role": {
      "description": "primary|support (defaults from current project state)",
      "type": "string"
    },
    "runId": {
      "description": "Optional workflow run id",
      "type": "string"
    },
    "specId": {
      "description": "Workflow spec id",
      "type": "string"
    }
  },
  "required": [
    "project",
    "specId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.cancel`. */
export const ProxCallsCancelInputSchema = {
  "additionalProperties": false,
  "properties": {
    "call_request_id": {
      "type": "string"
    },
    "reason": {
      "description": "Cancellation reason",
      "type": "string"
    }
  },
  "required": [
    "call_request_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.events`. */
export const ProxCallsEventsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "call_request_id": {
      "type": "string"
    }
  },
  "required": [
    "call_request_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.profiles.configure`. */
export const ProxCallsProfilesConfigureInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agentId": {
      "description": "Provider agent ID (ElevenLabs agent ID or Agora pipeline_id)",
      "type": "string"
    },
    "dynamicPlaceholder": {
      "description": "Declare/update provider dynamic variable placeholders for this profile",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "firstMessage": {
      "description": "Provider greeting/first message for this profile",
      "type": "string"
    },
    "language": {
      "description": "Language code (e.g. pt-BR, en-US)",
      "type": "string"
    },
    "profile_id": {
      "type": "string"
    },
    "prompt": {
      "description": "Call prompt text",
      "type": "string"
    },
    "provider": {
      "description": "Provider name (e.g. elevenlabs_twilio, agora_sip, stub)",
      "type": "string"
    },
    "skipProviderSync": {
      "description": "Persist profile changes without syncing provider agent config",
      "type": "boolean"
    },
    "systemPromptPath": {
      "description": "Path to a system prompt file to sync to ElevenLabs",
      "type": "string"
    },
    "twilioNumberId": {
      "description": "Outbound number reference (ElevenLabs phone ID or Agora E.164 caller number)",
      "type": "string"
    },
    "voicemailPolicy": {
      "description": "Voicemail policy: leave_message, hangup, skip",
      "type": "string"
    }
  },
  "required": [
    "profile_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.profiles.list`. */
export const ProxCallsProfilesListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.profiles.show`. */
export const ProxCallsProfilesShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "profile_id": {
      "type": "string"
    }
  },
  "required": [
    "profile_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.request`. */
export const ProxCallsRequestInputSchema = {
  "additionalProperties": false,
  "properties": {
    "force": {
      "description": "Bypass call rules for an explicit operator-requested live call",
      "type": "boolean"
    },
    "person": {
      "description": "Target person ID",
      "type": "string"
    },
    "phone": {
      "description": "Target phone number in E.164 format (temporary MVP, e.g. +5511999999999)",
      "type": "string"
    },
    "priority": {
      "description": "Priority level (low, normal, high, urgent)",
      "type": "string"
    },
    "profile": {
      "description": "Call profile ID",
      "type": "string"
    },
    "reason": {
      "description": "Reason for the call",
      "type": "string"
    },
    "skipOriginNotify": {
      "description": "Do not inform the originating session when the call reaches a terminal state",
      "type": "boolean"
    },
    "var": {
      "description": "Dynamic variable sent to the voice agent; accepts repeated key=value pairs",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.rules`. */
export const ProxCallsRulesInputSchema = {
  "additionalProperties": false,
  "properties": {
    "scope": {
      "description": "Rule scope type (global, project, person, profile, agent)",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.show`. */
export const ProxCallsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "call_request_id": {
      "type": "string"
    }
  },
  "required": [
    "call_request_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.tools.bind`. */
export const ProxCallsToolsBindInputSchema = {
  "additionalProperties": false,
  "properties": {
    "profile_id": {
      "type": "string"
    },
    "providerToolName": {
      "description": "Provider-facing tool name",
      "type": "string"
    },
    "required": {
      "description": "Mark tool as required for the profile",
      "type": "boolean"
    },
    "toolPrompt": {
      "description": "Profile-specific prompt for this tool",
      "type": "string"
    },
    "tool_id": {
      "type": "string"
    }
  },
  "required": [
    "profile_id",
    "tool_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.tools.configure`. */
export const ProxCallsToolsConfigureInputSchema = {
  "additionalProperties": false,
  "properties": {
    "enabled": {
      "description": "Enable or disable (true|false)",
      "type": "string"
    },
    "timeoutMs": {
      "description": "Execution timeout in milliseconds",
      "type": "string"
    },
    "tool_id": {
      "type": "string"
    }
  },
  "required": [
    "tool_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.tools.create`. */
export const ProxCallsToolsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "description": {
      "description": "Tool description for voice agents",
      "type": "string"
    },
    "executor": {
      "description": "Executor type: native|bash|http|context",
      "type": "string"
    },
    "inputSchema": {
      "description": "Path to JSON input schema file",
      "type": "string"
    },
    "name": {
      "description": "Tool display name",
      "type": "string"
    },
    "outputSchema": {
      "description": "Path to JSON output schema file",
      "type": "string"
    },
    "sideEffect": {
      "description": "Side-effect class: read_only|write_internal|external_message|external_call|external_irreversible",
      "type": "string"
    },
    "tool_id": {
      "type": "string"
    }
  },
  "required": [
    "tool_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.tools.list`. */
export const ProxCallsToolsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "profile": {
      "description": "Filter tools by profile binding",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.tools.run`. */
export const ProxCallsToolsRunInputSchema = {
  "additionalProperties": false,
  "properties": {
    "dryRun": {
      "description": "Validate without executing",
      "type": "boolean"
    },
    "input": {
      "description": "Tool input as JSON string or path to JSON file",
      "type": "string"
    },
    "profile": {
      "description": "Profile context for policy evaluation",
      "type": "string"
    },
    "tool_id": {
      "type": "string"
    }
  },
  "required": [
    "tool_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.tools.runs`. */
export const ProxCallsToolsRunsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "call_request_id": {
      "type": "string"
    }
  },
  "required": [
    "call_request_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.tools.show`. */
export const ProxCallsToolsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "tool_id": {
      "type": "string"
    }
  },
  "required": [
    "tool_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.tools.unbind`. */
export const ProxCallsToolsUnbindInputSchema = {
  "additionalProperties": false,
  "properties": {
    "profile_id": {
      "type": "string"
    },
    "tool_id": {
      "type": "string"
    }
  },
  "required": [
    "profile_id",
    "tool_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.transcript`. */
export const ProxCallsTranscriptInputSchema = {
  "additionalProperties": false,
  "properties": {
    "call_request_id": {
      "type": "string"
    },
    "sync": {
      "description": "Force provider sync before reading transcript",
      "type": "boolean"
    }
  },
  "required": [
    "call_request_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.voice-agents.bind-tool`. */
export const ProxCallsVoiceAgentsBindToolInputSchema = {
  "additionalProperties": false,
  "properties": {
    "providerToolName": {
      "description": "Provider-facing tool name",
      "type": "string"
    },
    "tool_id": {
      "type": "string"
    },
    "voice_agent_id": {
      "type": "string"
    }
  },
  "required": [
    "tool_id",
    "voice_agent_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.voice-agents.configure`. */
export const ProxCallsVoiceAgentsConfigureInputSchema = {
  "additionalProperties": false,
  "properties": {
    "firstMessage": {
      "description": "First message template",
      "type": "string"
    },
    "providerAgentId": {
      "description": "Provider-side agent/pipeline ID",
      "type": "string"
    },
    "systemPromptPath": {
      "description": "Path to system prompt file",
      "type": "string"
    },
    "voiceId": {
      "description": "Provider voice ID",
      "type": "string"
    },
    "voice_agent_id": {
      "type": "string"
    }
  },
  "required": [
    "voice_agent_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.voice-agents.create`. */
export const ProxCallsVoiceAgentsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Voice agent display name",
      "type": "string"
    },
    "provider": {
      "description": "Provider (e.g. elevenlabs, agora_sip)",
      "type": "string"
    },
    "systemPromptPath": {
      "description": "Path to system prompt file",
      "type": "string"
    },
    "voiceId": {
      "description": "Provider voice ID",
      "type": "string"
    },
    "voice_agent_id": {
      "type": "string"
    }
  },
  "required": [
    "voice_agent_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.voice-agents.list`. */
export const ProxCallsVoiceAgentsListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.voice-agents.show`. */
export const ProxCallsVoiceAgentsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "voice_agent_id": {
      "type": "string"
    }
  },
  "required": [
    "voice_agent_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.voice-agents.sync`. */
export const ProxCallsVoiceAgentsSyncInputSchema = {
  "additionalProperties": false,
  "properties": {
    "dryRun": {
      "description": "Show intended changes without mutating",
      "type": "boolean"
    },
    "provider": {
      "description": "Push changes to provider",
      "type": "boolean"
    },
    "voice_agent_id": {
      "type": "string"
    }
  },
  "required": [
    "voice_agent_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `prox.calls.voice-agents.unbind-tool`. */
export const ProxCallsVoiceAgentsUnbindToolInputSchema = {
  "additionalProperties": false,
  "properties": {
    "tool_id": {
      "type": "string"
    },
    "voice_agent_id": {
      "type": "string"
    }
  },
  "required": [
    "tool_id",
    "voice_agent_id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `react.send`. */
export const ReactSendInputSchema = {
  "additionalProperties": false,
  "properties": {
    "emoji": {
      "description": "Emoji to react with",
      "type": "string"
    },
    "messageId": {
      "description": "Message ID to react to (from [mid:ID] tag)",
      "type": "string"
    }
  },
  "required": [
    "emoji",
    "messageId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `routes.explain`. */
export const RoutesExplainInputSchema = {
  "additionalProperties": false,
  "properties": {
    "channel": {
      "description": "Optional channel hint for live route inspection",
      "type": "string"
    },
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "pattern": {
      "description": "Route pattern",
      "type": "string"
    }
  },
  "required": [
    "name",
    "pattern"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `routes.list`. */
export const RoutesListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name (omit for all)",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `routes.show`. */
export const RoutesShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Instance name",
      "type": "string"
    },
    "pattern": {
      "description": "Route pattern",
      "type": "string"
    }
  },
  "required": [
    "name",
    "pattern"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sdk.client.check`. */
export const SdkClientCheckInputSchema = {
  "additionalProperties": false,
  "properties": {
    "out": {
      "default": "packages/ravi-os-sdk/src",
      "description": "Directory containing the generated files",
      "type": "string"
    },
    "version": {
      "description": "SDK semver baked into version.ts",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sdk.client.generate`. */
export const SdkClientGenerateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "out": {
      "default": "packages/ravi-os-sdk/src",
      "description": "Target directory for the generated files",
      "type": "string"
    },
    "version": {
      "description": "SDK semver baked into version.ts",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sdk.openapi.check`. */
export const SdkOpenapiCheckInputSchema = {
  "additionalProperties": false,
  "properties": {
    "against": {
      "description": "Path to the stored spec to diff against",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sdk.openapi.emit`. */
export const SdkOpenapiEmitInputSchema = {
  "additionalProperties": false,
  "properties": {
    "out": {
      "description": "Write spec JSON to this path",
      "type": "string"
    },
    "stdout": {
      "description": "Print spec JSON to stdout",
      "type": "boolean"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `service.start`. */
export const ServiceStartInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `service.tui`. */
export const ServiceTuiInputSchema = {
  "additionalProperties": false,
  "properties": {
    "session": {
      "description": "Session key (default: agent:main:main)",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `service.wa`. */
export const ServiceWaInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.answer`. */
export const SessionsAnswerInputSchema = {
  "additionalProperties": false,
  "properties": {
    "barrier": {
      "description": "Delivery barrier: p0|p1|p2|p3",
      "type": "string"
    },
    "channel": {
      "description": "Override delivery channel",
      "type": "string"
    },
    "message": {
      "description": "Answer to send back",
      "type": "string"
    },
    "sender": {
      "description": "Who is answering (for attribution)",
      "type": "string"
    },
    "target": {
      "description": "Target session name (the one that asked)",
      "type": "string"
    },
    "to": {
      "description": "Override delivery target",
      "type": "string"
    }
  },
  "required": [
    "message",
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.ask`. */
export const SessionsAskInputSchema = {
  "additionalProperties": false,
  "properties": {
    "barrier": {
      "description": "Delivery barrier: p0|p1|p2|p3",
      "type": "string"
    },
    "channel": {
      "description": "Override delivery channel",
      "type": "string"
    },
    "message": {
      "description": "Question to ask",
      "type": "string"
    },
    "sender": {
      "description": "Who originally asked (for attribution)",
      "type": "string"
    },
    "target": {
      "description": "Target session name",
      "type": "string"
    },
    "to": {
      "description": "Override delivery target",
      "type": "string"
    }
  },
  "required": [
    "message",
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.delete`. */
export const SessionsDeleteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.execute`. */
export const SessionsExecuteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "barrier": {
      "description": "Delivery barrier: p0|p1|p2|p3",
      "type": "string"
    },
    "channel": {
      "description": "Override delivery channel",
      "type": "string"
    },
    "message": {
      "description": "Task to execute",
      "type": "string"
    },
    "target": {
      "description": "Target session name",
      "type": "string"
    },
    "to": {
      "description": "Override delivery target",
      "type": "string"
    }
  },
  "required": [
    "message",
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.extend`. */
export const SessionsExtendInputSchema = {
  "additionalProperties": false,
  "properties": {
    "duration": {
      "description": "Duration to add (default: 5h)",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.info`. */
export const SessionsInfoInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.inform`. */
export const SessionsInformInputSchema = {
  "additionalProperties": false,
  "properties": {
    "barrier": {
      "description": "Delivery barrier: p0|p1|p2|p3",
      "type": "string"
    },
    "channel": {
      "description": "Override delivery channel",
      "type": "string"
    },
    "message": {
      "description": "Information to send",
      "type": "string"
    },
    "target": {
      "description": "Target session name",
      "type": "string"
    },
    "to": {
      "description": "Override delivery target",
      "type": "string"
    }
  },
  "required": [
    "message",
    "target"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.keep`. */
export const SessionsKeepInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.list`. */
export const SessionsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Filter by agent ID",
      "type": "string"
    },
    "ephemeral": {
      "description": "Show only ephemeral sessions",
      "type": "boolean"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.read`. */
export const SessionsReadInputSchema = {
  "additionalProperties": false,
  "properties": {
    "count": {
      "description": "Number of messages to show (default: 20)",
      "type": "string"
    },
    "messageId": {
      "description": "Return metadata for a single message (transcription, mediaType) using session history as fallback",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    },
    "workspace": {
      "description": "Return workspace projection: merged provider+chat history with flat timeline (history-only)",
      "type": "boolean"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.rename`. */
export const SessionsRenameInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    },
    "newName": {
      "description": "New canonical session name",
      "type": "string"
    }
  },
  "required": [
    "nameOrKey",
    "newName"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.reset`. */
export const SessionsResetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.runtime.follow-up`. */
export const SessionsRuntimeFollowUpInputSchema = {
  "additionalProperties": false,
  "properties": {
    "expectedTurn": {
      "description": "Expected active runtime turn id",
      "type": "string"
    },
    "session": {
      "description": "Ravi session name or key",
      "type": "string"
    },
    "text": {
      "description": "Follow-up text to run after the active turn",
      "type": "string"
    },
    "thread": {
      "description": "Expected runtime thread id",
      "type": "string"
    },
    "turn": {
      "description": "Runtime turn id",
      "type": "string"
    }
  },
  "required": [
    "session",
    "text"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.runtime.fork`. */
export const SessionsRuntimeForkInputSchema = {
  "additionalProperties": false,
  "properties": {
    "cwd": {
      "description": "Working directory for the fork",
      "type": "string"
    },
    "path": {
      "description": "Runtime fork path",
      "type": "string"
    },
    "session": {
      "description": "Ravi session name or key",
      "type": "string"
    },
    "threadId": {
      "description": "Runtime thread id; defaults to current thread",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.runtime.interrupt`. */
export const SessionsRuntimeInterruptInputSchema = {
  "additionalProperties": false,
  "properties": {
    "session": {
      "description": "Ravi session name or key",
      "type": "string"
    },
    "thread": {
      "description": "Expected runtime thread id",
      "type": "string"
    },
    "turn": {
      "description": "Runtime turn id",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.runtime.list`. */
export const SessionsRuntimeListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "archived": {
      "description": "Only include archived threads",
      "type": "boolean"
    },
    "cursor": {
      "description": "Pagination cursor",
      "type": "string"
    },
    "cwd": {
      "description": "Filter by Codex working directory",
      "type": "string"
    },
    "limit": {
      "description": "Maximum number of threads to return",
      "type": "string"
    },
    "search": {
      "description": "Search runtime thread text",
      "type": "string"
    },
    "session": {
      "description": "Ravi session name or key",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.runtime.read`. */
export const SessionsRuntimeReadInputSchema = {
  "additionalProperties": false,
  "properties": {
    "session": {
      "description": "Ravi session name or key",
      "type": "string"
    },
    "summaryOnly": {
      "description": "Do not include runtime turns",
      "type": "boolean"
    },
    "threadId": {
      "description": "Runtime thread id; defaults to current thread",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.runtime.rollback`. */
export const SessionsRuntimeRollbackInputSchema = {
  "additionalProperties": false,
  "properties": {
    "session": {
      "description": "Ravi session name or key",
      "type": "string"
    },
    "thread": {
      "description": "Runtime thread id; defaults to current thread",
      "type": "string"
    },
    "turns": {
      "description": "Number of completed turns to rollback",
      "type": "string"
    }
  },
  "required": [
    "session"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.runtime.steer`. */
export const SessionsRuntimeSteerInputSchema = {
  "additionalProperties": false,
  "properties": {
    "expectedTurn": {
      "description": "Expected active runtime turn id",
      "type": "string"
    },
    "session": {
      "description": "Ravi session name or key",
      "type": "string"
    },
    "text": {
      "description": "Steering text to append to the active turn",
      "type": "string"
    },
    "thread": {
      "description": "Expected runtime thread id",
      "type": "string"
    },
    "turn": {
      "description": "Runtime turn id",
      "type": "string"
    }
  },
  "required": [
    "session",
    "text"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.send`. */
export const SessionsSendInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Agent to use when creating a new session",
      "type": "string"
    },
    "barrier": {
      "description": "Delivery barrier: p0|p1|p2|p3",
      "type": "string"
    },
    "channel": {
      "description": "Override delivery channel",
      "type": "string"
    },
    "interactive": {
      "description": "Interactive mode",
      "type": "boolean"
    },
    "nameOrKey": {
      "description": "Session name",
      "type": "string"
    },
    "prompt": {
      "description": "Prompt to send (omit for interactive mode)",
      "type": "string"
    },
    "to": {
      "description": "Override delivery target",
      "type": "string"
    },
    "wait": {
      "description": "Wait for response (chat mode)",
      "type": "boolean"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.set-display`. */
export const SessionsSetDisplayInputSchema = {
  "additionalProperties": false,
  "properties": {
    "displayName": {
      "description": "Display label",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "displayName",
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.set-model`. */
export const SessionsSetModelInputSchema = {
  "additionalProperties": false,
  "properties": {
    "model": {
      "description": "Model name (sonnet, opus, haiku) or 'clear' to remove override",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "model",
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.set-thinking`. */
export const SessionsSetThinkingInputSchema = {
  "additionalProperties": false,
  "properties": {
    "level": {
      "description": "Thinking level (off, normal, verbose) or 'clear'",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "level",
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.set-ttl`. */
export const SessionsSetTtlInputSchema = {
  "additionalProperties": false,
  "properties": {
    "duration": {
      "description": "TTL duration (e.g. 5h, 30m, 1d)",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    }
  },
  "required": [
    "duration",
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `sessions.trace`. */
export const SessionsTraceInputSchema = {
  "additionalProperties": false,
  "properties": {
    "correlation": {
      "description": "Filter by payload correlation/request id",
      "type": "string"
    },
    "explain": {
      "description": "Explain likely interruption, abort, timeout, or delivery issues",
      "type": "boolean"
    },
    "includeStream": {
      "description": "Include provider stream/delta events",
      "type": "boolean"
    },
    "limit": {
      "description": "Show only the latest N timeline rows after filters",
      "type": "string"
    },
    "message": {
      "description": "Filter by source message id",
      "type": "string"
    },
    "nameOrKey": {
      "description": "Session name or key",
      "type": "string"
    },
    "only": {
      "description": "Only show an event group or event type, e.g. adapter/tools/delivery",
      "type": "string"
    },
    "raw": {
      "description": "Include raw payloads and request blobs",
      "type": "boolean"
    },
    "run": {
      "description": "Filter by run id",
      "type": "string"
    },
    "showSystemPrompt": {
      "description": "Include full system prompt blob when available",
      "type": "boolean"
    },
    "showUserPrompt": {
      "description": "Include full user prompt blob when available",
      "type": "boolean"
    },
    "since": {
      "description": "Start time: ISO, epoch ms, or duration like 2h",
      "type": "string"
    },
    "turn": {
      "description": "Filter by turn id",
      "type": "string"
    },
    "until": {
      "description": "End time: ISO, epoch ms, or duration like 30m",
      "type": "string"
    }
  },
  "required": [
    "nameOrKey"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `settings.delete`. */
export const SettingsDeleteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "key": {
      "description": "Setting key",
      "type": "string"
    }
  },
  "required": [
    "key"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `settings.get`. */
export const SettingsGetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "key": {
      "description": "Setting key",
      "type": "string"
    }
  },
  "required": [
    "key"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `settings.list`. */
export const SettingsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "legacy": {
      "description": "Show legacy account.* settings shadowed by instances",
      "type": "boolean"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `settings.set`. */
export const SettingsSetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "key": {
      "description": "Setting key",
      "type": "string"
    },
    "value": {
      "description": "Setting value",
      "type": "string"
    }
  },
  "required": [
    "key",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `skills.install`. */
export const SkillsInstallInputSchema = {
  "additionalProperties": false,
  "properties": {
    "all": {
      "description": "Install all skills found in source",
      "type": "boolean"
    },
    "name": {
      "description": "Skill name. Defaults to the Ravi catalog unless --source is passed",
      "type": "string"
    },
    "overwrite": {
      "description": "Replace existing installed skill",
      "type": "boolean"
    },
    "plugin": {
      "description": "User plugin bucket (default: ravi-user-skills)",
      "type": "string"
    },
    "skill": {
      "description": "Legacy alias for the skill name",
      "type": "string"
    },
    "skipCodexSync": {
      "description": "Do not immediately sync materialized Codex skills",
      "type": "boolean"
    },
    "source": {
      "description": "Install from a GitHub URL, git URL or local path",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `skills.list`. */
export const SkillsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "codex": {
      "description": "Include materialized Codex skills",
      "type": "boolean"
    },
    "installed": {
      "description": "List operator-installed skills instead of the Ravi catalog",
      "type": "boolean"
    },
    "source": {
      "description": "List skills available in a GitHub URL, git URL or local path",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `skills.show`. */
export const SkillsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "installed": {
      "description": "Inspect only operator-installed/materialized skills",
      "type": "boolean"
    },
    "name": {
      "description": "Catalog skill name, installed skill name, or source skill name",
      "type": "string"
    },
    "source": {
      "description": "Inspect skill from a GitHub URL, git URL or local path",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `skills.sync`. */
export const SkillsSyncInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `specs.get`. */
export const SpecsGetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Spec id: domain[/capability[/feature]]",
      "type": "string"
    },
    "mode": {
      "default": "rules",
      "description": "rules|full|checks|why|runbook",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `specs.list`. */
export const SpecsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "domain": {
      "description": "Filter by domain",
      "type": "string"
    },
    "kind": {
      "description": "Filter by kind: domain|capability|feature",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `specs.new`. */
export const SpecsNewInputSchema = {
  "additionalProperties": false,
  "properties": {
    "full": {
      "description": "Create WHY.md, RUNBOOK.md, and CHECKS.md companions",
      "type": "boolean"
    },
    "id": {
      "description": "Spec id: domain[/capability[/feature]]",
      "type": "string"
    },
    "kind": {
      "description": "domain|capability|feature",
      "type": "string"
    },
    "title": {
      "description": "Spec title",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `specs.sync`. */
export const SpecsSyncInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `stickers.add`. */
export const StickersAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agents": {
      "description": "Agent allowlist (default: all agents)",
      "type": "string"
    },
    "avoid": {
      "description": "When not to use this sticker",
      "type": "string"
    },
    "channels": {
      "description": "Channel allowlist (default: whatsapp)",
      "type": "string"
    },
    "description": {
      "description": "Natural usage description for prompts",
      "type": "string"
    },
    "disabled": {
      "description": "Add the sticker disabled",
      "type": "boolean"
    },
    "id": {
      "description": "Stable sticker id (lowercase, digits, dash or underscore)",
      "type": "string"
    },
    "label": {
      "description": "Human label shown to operators",
      "type": "string"
    },
    "mediaPath": {
      "description": "Local sticker media file path",
      "type": "string"
    },
    "overwrite": {
      "description": "Overwrite an existing sticker id",
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "mediaPath"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `stickers.list`. */
export const StickersListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `stickers.remove`. */
export const StickersRemoveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Sticker id",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `stickers.send`. */
export const StickersSendInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "Explicit channel account id",
      "type": "string"
    },
    "channel": {
      "description": "Explicit target channel",
      "type": "string"
    },
    "id": {
      "description": "Sticker id",
      "type": "string"
    },
    "session": {
      "description": "Resolve target from a session route",
      "type": "string"
    },
    "to": {
      "description": "Explicit target chat id",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `stickers.show`. */
export const StickersShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Sticker id",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tags.attach`. */
export const TagsAttachInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Target agent id",
      "type": "string"
    },
    "meta": {
      "description": "Free JSON metadata for this binding",
      "type": "string"
    },
    "session": {
      "description": "Target session name",
      "type": "string"
    },
    "slug": {
      "description": "Tag slug",
      "type": "string"
    }
  },
  "required": [
    "slug"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tags.create`. */
export const TagsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "description": {
      "description": "Optional description",
      "type": "string"
    },
    "kind": {
      "default": "user",
      "description": "system|user",
      "type": "string"
    },
    "label": {
      "description": "Display label",
      "type": "string"
    },
    "meta": {
      "description": "Free JSON metadata for the tag definition",
      "type": "string"
    },
    "slug": {
      "description": "Stable tag slug",
      "type": "string"
    }
  },
  "required": [
    "slug"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tags.detach`. */
export const TagsDetachInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Target agent id",
      "type": "string"
    },
    "session": {
      "description": "Target session name",
      "type": "string"
    },
    "slug": {
      "description": "Tag slug",
      "type": "string"
    }
  },
  "required": [
    "slug"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tags.list`. */
export const TagsListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tags.search`. */
export const TagsSearchInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Filter by agent id",
      "type": "string"
    },
    "session": {
      "description": "Filter by session name",
      "type": "string"
    },
    "tag": {
      "description": "Filter by tag slug",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tags.show`. */
export const TagsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "slug": {
      "description": "Tag slug",
      "type": "string"
    }
  },
  "required": [
    "slug"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.archive`. */
export const TasksArchiveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "reason": {
      "description": "Why this task should leave the default list",
      "type": "string"
    },
    "taskId": {
      "description": "Task ID",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.automations.add`. */
export const TasksAutomationsAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Auto-dispatch follow-up tasks to this agent",
      "type": "string"
    },
    "checkpoint": {
      "description": "Override follow-up checkpoint interval",
      "type": "string"
    },
    "detached": {
      "description": "Do not link the follow-up task as a child of the trigger task",
      "type": "boolean"
    },
    "disabled": {
      "description": "Create the automation disabled",
      "type": "boolean"
    },
    "filter": {
      "description": "Optional filter expression on task event data",
      "type": "string"
    },
    "freshCheckpoint": {
      "description": "Do not inherit the trigger task checkpoint",
      "type": "boolean"
    },
    "freshReportEvents": {
      "description": "Do not inherit the trigger task report events",
      "type": "boolean"
    },
    "freshReportTo": {
      "description": "Do not inherit the trigger task report target",
      "type": "boolean"
    },
    "freshWorktree": {
      "description": "Do not inherit the trigger task worktree",
      "type": "boolean"
    },
    "input": {
      "description": "Profile input templates for the follow-up task",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "instructions": {
      "description": "Follow-up task instructions template",
      "type": "string"
    },
    "name": {
      "description": "Task automation name",
      "type": "string"
    },
    "on": {
      "description": "Comma-separated events: task.blocked,task.done,task.failed,task.child.blocked,task.child.done,task.child.failed",
      "type": "string"
    },
    "priority": {
      "description": "low|normal|high|urgent (default: inherit trigger task)",
      "type": "string"
    },
    "profile": {
      "description": "Follow-up task profile (default: inherit trigger task profile)",
      "type": "string"
    },
    "reportEvents": {
      "description": "Comma-separated report events: blocked,done,failed",
      "type": "string"
    },
    "reportTo": {
      "description": "Override follow-up report target session",
      "type": "string"
    },
    "session": {
      "description": "Optional session name template for auto-dispatch",
      "type": "string"
    },
    "title": {
      "description": "Follow-up task title template",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.automations.disable`. */
export const TasksAutomationsDisableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Task automation ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.automations.enable`. */
export const TasksAutomationsEnableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Task automation ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.automations.list`. */
export const TasksAutomationsListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.automations.rm`. */
export const TasksAutomationsRmInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Task automation ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.automations.show`. */
export const TasksAutomationsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Task automation ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.block`. */
export const TasksBlockInputSchema = {
  "additionalProperties": false,
  "properties": {
    "reason": {
      "description": "Concrete blocker reason",
      "type": "string"
    },
    "taskId": {
      "description": "Task ID",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.comment`. */
export const TasksCommentInputSchema = {
  "additionalProperties": false,
  "properties": {
    "body": {
      "description": "Comment body",
      "type": "string"
    },
    "taskId": {
      "description": "Task ID",
      "type": "string"
    }
  },
  "required": [
    "body",
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.create`. */
export const TasksCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Auto-dispatch to this agent immediately",
      "type": "string"
    },
    "assignee": {
      "description": "Alias for --agent",
      "type": "string"
    },
    "checkpoint": {
      "description": "Assignment checkpoint interval (e.g. 5m, 30s, 1h)",
      "type": "string"
    },
    "dependsOn": {
      "description": "Gate this task on upstream tasks; repeat or pass multiple ids",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "effort": {
      "description": "Runtime effort: low|medium|high|xhigh",
      "type": "string"
    },
    "input": {
      "description": "Profile input values pinned to the task",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "instructions": {
      "description": "Detailed instructions for the task",
      "type": "string"
    },
    "model": {
      "description": "Task runtime model override",
      "type": "string"
    },
    "parent": {
      "description": "Create this task as a child of another task",
      "type": "string"
    },
    "priority": {
      "default": "normal",
      "description": "low|normal|high|urgent",
      "type": "string"
    },
    "profile": {
      "description": "Task profile id (defaults to default)",
      "type": "string"
    },
    "reportEvents": {
      "description": "Comma-separated report events: blocked,done,failed",
      "type": "string"
    },
    "reportTo": {
      "description": "Session to receive explicit task reports",
      "type": "string"
    },
    "session": {
      "description": "Working session name to use when auto-dispatching",
      "type": "string"
    },
    "thinking": {
      "description": "Runtime thinking: off|normal|verbose",
      "type": "string"
    },
    "title": {
      "description": "Short task title",
      "type": "string"
    },
    "worktreeBranch": {
      "description": "Optional branch label for the contextual worktree",
      "type": "string"
    },
    "worktreeMode": {
      "description": "Worktree metadata mode: inherit|path",
      "type": "string"
    },
    "worktreePath": {
      "description": "Worktree metadata path (resolved relative to agent cwd if needed; does not override session cwd)",
      "type": "string"
    }
  },
  "required": [
    "title"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.deps.add`. */
export const TasksDepsAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "dependencyTaskId": {
      "description": "Upstream task id that must reach done",
      "type": "string"
    },
    "taskId": {
      "description": "Downstream task id",
      "type": "string"
    }
  },
  "required": [
    "dependencyTaskId",
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.deps.ls`. */
export const TasksDepsLsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "taskId": {
      "description": "Task id to inspect",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.deps.rm`. */
export const TasksDepsRmInputSchema = {
  "additionalProperties": false,
  "properties": {
    "dependencyTaskId": {
      "description": "Upstream task id to remove from gating",
      "type": "string"
    },
    "taskId": {
      "description": "Downstream task id",
      "type": "string"
    }
  },
  "required": [
    "dependencyTaskId",
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.dispatch`. */
export const TasksDispatchInputSchema = {
  "additionalProperties": false,
  "properties": {
    "actorSession": {
      "description": "Attribute the dispatch to a specific session (overrides RAVI_TASK_ACTOR; useful when a UI dispatches on behalf of a session)",
      "type": "string"
    },
    "agent": {
      "description": "Agent ID to receive the task",
      "type": "string"
    },
    "checkpoint": {
      "description": "Override the assignment checkpoint interval",
      "type": "string"
    },
    "effort": {
      "description": "Runtime effort: low|medium|high|xhigh",
      "type": "string"
    },
    "model": {
      "description": "Dispatch runtime model override",
      "type": "string"
    },
    "reportEvents": {
      "description": "Override report events for this assignment",
      "type": "string"
    },
    "reportTo": {
      "description": "Override the report target for this assignment",
      "type": "string"
    },
    "session": {
      "description": "Target session name (defaults to task-specific session)",
      "type": "string"
    },
    "taskId": {
      "description": "Task ID",
      "type": "string"
    },
    "thinking": {
      "description": "Runtime thinking: off|normal|verbose",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.done`. */
export const TasksDoneInputSchema = {
  "additionalProperties": false,
  "properties": {
    "summary": {
      "description": "Completion summary",
      "type": "string"
    },
    "taskId": {
      "description": "Task ID",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.fail`. */
export const TasksFailInputSchema = {
  "additionalProperties": false,
  "properties": {
    "reason": {
      "description": "Failure reason",
      "type": "string"
    },
    "taskId": {
      "description": "Task ID",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.list`. */
export const TasksListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Filter by assigned agent",
      "type": "string"
    },
    "all": {
      "description": "Include archived and visible tasks",
      "type": "boolean"
    },
    "archived": {
      "description": "List only archived tasks",
      "type": "boolean"
    },
    "last": {
      "description": "Number of newest tasks to show by default (default: 30; use 0 or \"all\" to disable)",
      "type": "string"
    },
    "mine": {
      "description": "Filter by current agent/session context",
      "type": "boolean"
    },
    "parent": {
      "description": "Filter direct children of one parent task",
      "type": "string"
    },
    "profile": {
      "description": "Filter by task profile",
      "type": "string"
    },
    "root": {
      "description": "Filter one task tree (root task plus descendants)",
      "type": "string"
    },
    "roots": {
      "description": "Show only root tasks (no parent)",
      "type": "boolean"
    },
    "session": {
      "description": "Filter by assigned session",
      "type": "string"
    },
    "status": {
      "description": "Filter by status",
      "type": "string"
    },
    "text": {
      "description": "Free-text match across id, title, instructions, summary, blocker, profile, agent and session",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.profiles.init`. */
export const TasksProfilesInitInputSchema = {
  "additionalProperties": false,
  "properties": {
    "preset": {
      "description": "doc-first|brainstorm|runtime-only|content",
      "type": "string"
    },
    "profileId": {
      "description": "Task profile id",
      "type": "string"
    },
    "source": {
      "default": "workspace",
      "description": "workspace|user",
      "type": "string"
    }
  },
  "required": [
    "profileId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.profiles.list`. */
export const TasksProfilesListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.profiles.preview`. */
export const TasksProfilesPreviewInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Agent id for session context",
      "type": "string"
    },
    "input": {
      "description": "Profile input values",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "instructions": {
      "description": "Preview task instructions",
      "type": "string"
    },
    "profileId": {
      "description": "Task profile id",
      "type": "string"
    },
    "session": {
      "description": "Session name for preview",
      "type": "string"
    },
    "title": {
      "description": "Preview task title",
      "type": "string"
    },
    "worktreeBranch": {
      "description": "Optional contextual worktree branch",
      "type": "string"
    },
    "worktreeMode": {
      "description": "inherit|path",
      "type": "string"
    },
    "worktreePath": {
      "description": "Contextual worktree path",
      "type": "string"
    }
  },
  "required": [
    "profileId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.profiles.show`. */
export const TasksProfilesShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "profileId": {
      "description": "Task profile id",
      "type": "string"
    }
  },
  "required": [
    "profileId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.profiles.validate`. */
export const TasksProfilesValidateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "profileId": {
      "description": "Optional task profile id",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.report`. */
export const TasksReportInputSchema = {
  "additionalProperties": false,
  "properties": {
    "message": {
      "description": "Progress update message",
      "type": "string"
    },
    "progress": {
      "description": "Progress percentage 0-100",
      "type": "string"
    },
    "taskId": {
      "description": "Task ID",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.show`. */
export const TasksShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "last": {
      "description": "Number of recent history items to show (default: 12; use 0 or \"all\" to disable)",
      "type": "string"
    },
    "taskId": {
      "description": "Task ID",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tasks.unarchive`. */
export const TasksUnarchiveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "taskId": {
      "description": "Task ID",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tmux.list`. */
export const TmuxListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tmux.open`. */
export const TmuxOpenInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Agent ID",
      "type": "string"
    },
    "session": {
      "description": "Optional Ravi session name/key",
      "type": "string"
    }
  },
  "required": [
    "agent"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tools.list`. */
export const ToolsListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tools.manifest`. */
export const ToolsManifestInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tools.schema`. */
export const ToolsSchemaInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tools.show`. */
export const ToolsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "name": {
      "description": "Tool name (e.g., agents_list)",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `tools.test`. */
export const ToolsTestInputSchema = {
  "additionalProperties": false,
  "properties": {
    "args": {
      "description": "JSON args (optional)",
      "type": "string"
    },
    "name": {
      "description": "Tool name",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `transcribe.file`. */
export const TranscribeFileInputSchema = {
  "additionalProperties": false,
  "properties": {
    "lang": {
      "default": "pt",
      "description": "Language code (default: pt)",
      "type": "string"
    },
    "path": {
      "description": "Path to audio file",
      "type": "string"
    }
  },
  "required": [
    "path"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `triggers.add`. */
export const TriggersAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "Account for channel delivery (auto-detected from agent)",
      "type": "string"
    },
    "agent": {
      "description": "Agent ID (default: default agent)",
      "type": "string"
    },
    "cooldown": {
      "description": "Cooldown between fires (e.g., 5s, 30s, 1m)",
      "type": "string"
    },
    "filter": {
      "description": "Filter expression (e.g. 'data.cwd == \"/path/to/workspace\"')",
      "type": "string"
    },
    "message": {
      "description": "Prompt message",
      "type": "string"
    },
    "name": {
      "description": "Trigger name",
      "type": "string"
    },
    "session": {
      "description": "Session: main or isolated (default: isolated)",
      "type": "string"
    },
    "topic": {
      "description": "Notif topic pattern to subscribe to",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `triggers.disable`. */
export const TriggersDisableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Trigger ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `triggers.enable`. */
export const TriggersEnableInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Trigger ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `triggers.list`. */
export const TriggersListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `triggers.rm`. */
export const TriggersRmInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Trigger ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `triggers.set`. */
export const TriggersSetInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Trigger ID",
      "type": "string"
    },
    "key": {
      "description": "Property: name, message, topic, agent, account, session, cooldown",
      "type": "string"
    },
    "value": {
      "description": "Property value",
      "type": "string"
    }
  },
  "required": [
    "id",
    "key",
    "value"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `triggers.show`. */
export const TriggersShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Trigger ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `triggers.test`. */
export const TriggersTestInputSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Trigger ID",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `video.analyze`. */
export const VideoAnalyzeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "output": {
      "description": "Output file path (default: auto-generated in cwd)",
      "type": "string"
    },
    "prompt": {
      "description": "Custom analysis prompt",
      "type": "string"
    },
    "url": {
      "description": "YouTube URL or local file path",
      "type": "string"
    }
  },
  "required": [
    "url"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.dm.ack`. */
export const WhatsappDmAckInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "contact": {
      "description": "Contact ID, phone, or LID",
      "type": "string"
    },
    "messageId": {
      "description": "Message ID to mark as read",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "messageId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.dm.read`. */
export const WhatsappDmReadInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "contact": {
      "description": "Contact ID, phone, or LID",
      "type": "string"
    },
    "last": {
      "description": "Number of messages to read (default: 10)",
      "type": "string"
    },
    "noAck": {
      "default": true,
      "description": "Don't send read receipt",
      "type": "boolean"
    }
  },
  "required": [
    "contact"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.dm.send`. */
export const WhatsappDmSendInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "contact": {
      "description": "Contact ID, phone, or LID",
      "type": "string"
    },
    "message": {
      "description": "Message text",
      "type": "string"
    }
  },
  "required": [
    "contact",
    "message"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.add`. */
export const WhatsappGroupAddInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    },
    "participants": {
      "description": "Phone numbers to add (comma-separated)",
      "type": "string"
    }
  },
  "required": [
    "groupId",
    "participants"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.create`. */
export const WhatsappGroupCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "agent": {
      "description": "Agent to route this group chat to",
      "type": "string"
    },
    "name": {
      "description": "Group name/subject",
      "type": "string"
    },
    "participants": {
      "description": "Phone numbers to add (comma-separated)",
      "type": "string"
    }
  },
  "required": [
    "name",
    "participants"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.demote`. */
export const WhatsappGroupDemoteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    },
    "participants": {
      "description": "Phone numbers to demote (comma-separated)",
      "type": "string"
    }
  },
  "required": [
    "groupId",
    "participants"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.description`. */
export const WhatsappGroupDescriptionInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    },
    "text": {
      "description": "New description",
      "type": "string"
    }
  },
  "required": [
    "groupId",
    "text"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.info`. */
export const WhatsappGroupInfoInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    }
  },
  "required": [
    "groupId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.invite`. */
export const WhatsappGroupInviteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    }
  },
  "required": [
    "groupId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.join`. */
export const WhatsappGroupJoinInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "code": {
      "description": "Invite code or full link",
      "type": "string"
    }
  },
  "required": [
    "code"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.leave`. */
export const WhatsappGroupLeaveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    }
  },
  "required": [
    "groupId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.list`. */
export const WhatsappGroupListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    }
  },
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.promote`. */
export const WhatsappGroupPromoteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    },
    "participants": {
      "description": "Phone numbers to promote (comma-separated)",
      "type": "string"
    }
  },
  "required": [
    "groupId",
    "participants"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.remove`. */
export const WhatsappGroupRemoveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    },
    "participants": {
      "description": "Phone numbers to remove (comma-separated)",
      "type": "string"
    }
  },
  "required": [
    "groupId",
    "participants"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.rename`. */
export const WhatsappGroupRenameInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    },
    "name": {
      "description": "New group name",
      "type": "string"
    }
  },
  "required": [
    "groupId",
    "name"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.revoke-invite`. */
export const WhatsappGroupRevokeInviteInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    }
  },
  "required": [
    "groupId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `whatsapp.group.settings`. */
export const WhatsappGroupSettingsInputSchema = {
  "additionalProperties": false,
  "properties": {
    "account": {
      "description": "WhatsApp account ID",
      "type": "string"
    },
    "groupId": {
      "description": "Group ID or JID",
      "type": "string"
    },
    "setting": {
      "description": "Setting: announcement, not_announcement, locked, unlocked",
      "type": "string"
    }
  },
  "required": [
    "groupId",
    "setting"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.archive-node`. */
export const WorkflowsRunsArchiveNodeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nodeKey": {
      "description": "Node key",
      "type": "string"
    },
    "runId": {
      "description": "Workflow run id",
      "type": "string"
    }
  },
  "required": [
    "nodeKey",
    "runId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.cancel`. */
export const WorkflowsRunsCancelInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nodeKey": {
      "description": "Node key",
      "type": "string"
    },
    "runId": {
      "description": "Workflow run id",
      "type": "string"
    }
  },
  "required": [
    "nodeKey",
    "runId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.list`. */
export const WorkflowsRunsListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.release`. */
export const WorkflowsRunsReleaseInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nodeKey": {
      "description": "Node key",
      "type": "string"
    },
    "runId": {
      "description": "Workflow run id",
      "type": "string"
    }
  },
  "required": [
    "nodeKey",
    "runId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.show`. */
export const WorkflowsRunsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "runId": {
      "description": "Workflow run id",
      "type": "string"
    }
  },
  "required": [
    "runId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.skip`. */
export const WorkflowsRunsSkipInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nodeKey": {
      "description": "Node key",
      "type": "string"
    },
    "runId": {
      "description": "Workflow run id",
      "type": "string"
    }
  },
  "required": [
    "nodeKey",
    "runId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.start`. */
export const WorkflowsRunsStartInputSchema = {
  "additionalProperties": false,
  "properties": {
    "runId": {
      "description": "Optional workflow run id",
      "type": "string"
    },
    "specId": {
      "description": "Workflow spec id",
      "type": "string"
    }
  },
  "required": [
    "specId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.task-attach`. */
export const WorkflowsRunsTaskAttachInputSchema = {
  "additionalProperties": false,
  "properties": {
    "nodeKey": {
      "description": "Task node key",
      "type": "string"
    },
    "runId": {
      "description": "Workflow run id",
      "type": "string"
    },
    "taskId": {
      "description": "Existing task id",
      "type": "string"
    }
  },
  "required": [
    "nodeKey",
    "runId",
    "taskId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.runs.task-create`. */
export const WorkflowsRunsTaskCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "agent": {
      "description": "Optional agent to dispatch immediately",
      "type": "string"
    },
    "instructions": {
      "description": "Task instructions",
      "type": "string"
    },
    "nodeKey": {
      "description": "Task node key",
      "type": "string"
    },
    "priority": {
      "default": "normal",
      "description": "low|normal|high|urgent",
      "type": "string"
    },
    "profile": {
      "description": "Task profile id",
      "type": "string"
    },
    "runId": {
      "description": "Workflow run id",
      "type": "string"
    },
    "session": {
      "description": "Optional session name for immediate dispatch",
      "type": "string"
    },
    "title": {
      "description": "Task title",
      "type": "string"
    }
  },
  "required": [
    "nodeKey",
    "runId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.specs.create`. */
export const WorkflowsSpecsCreateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "definition": {
      "description": "Inline JSON definition with title/nodes/edges/policy",
      "type": "string"
    },
    "file": {
      "description": "Path to a JSON workflow definition",
      "type": "string"
    },
    "specId": {
      "description": "Stable workflow spec id",
      "type": "string"
    }
  },
  "required": [
    "specId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.specs.list`. */
export const WorkflowsSpecsListInputSchema = {
  "additionalProperties": false,
  "properties": {},
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `workflows.specs.show`. */
export const WorkflowsSpecsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "specId": {
      "description": "Workflow spec id",
      "type": "string"
    }
  },
  "required": [
    "specId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;
