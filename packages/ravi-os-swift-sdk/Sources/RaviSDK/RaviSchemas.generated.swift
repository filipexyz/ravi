// GENERATED FILE - DO NOT EDIT.
// Run `ravi sdk swift generate` to regenerate.
// Drift is detected by `ravi sdk swift check`.

import Foundation

public enum RaviSchemas {
  public static let AdaptersListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching adapters to skip (default: 0)",
        "type": "string"
      },
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
  }
  """#

  public static let AdaptersShowInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsCreateInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsDebounceInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsDebugInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsDeleteInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching agents to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical tag slug",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let AgentsResetInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsSessionInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsSetInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsShowInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsSpecModeInputSchema = #"""
  {
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
  }
  """#

  public static let AgentsSyncInstructionsInputSchema = #"""
  {
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
  }
  """#

  public static let ArtifactsArchiveInputSchema = #"""
  {
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
  }
  """#

  public static let ArtifactsAttachInputSchema = #"""
  {
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
  }
  """#

  public static let ArtifactsBlobInputSchema = #"""
  {
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
  }
  """#

  public static let ArtifactsCreateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "assetBase": {
        "description": "Package asset base intent when --path is a directory",
        "type": "string"
      },
      "basePath": {
        "description": "Package base path intent when --path is a directory",
        "type": "string"
      },
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
      "entrypoint": {
        "description": "Package entrypoint when --path is a directory",
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
        "description": "Optional semantic artifact kind, e.g. image, report, trace",
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
        "description": "Local file or directory to ingest into artifact blob storage",
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
    "type": "object"
  }
  """#

  public static let ArtifactsEventInputSchema = #"""
  {
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
  }
  """#

  public static let ArtifactsEventsInputSchema = #"""
  {
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
  }
  """#

  public static let ArtifactsListInputSchema = #"""
  {
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
        "description": "Filter rich projection by lifecycle: pending|running|completed|failed|archived",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500; rich max: 200)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching artifacts to skip (default: 0)",
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
  }
  """#

  public static let ArtifactsPublishInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "artifactVersion": {
        "description": "Local artifact version number (default: latest)",
        "type": "string"
      },
      "assetBase": {
        "description": "Package asset base intent",
        "type": "string"
      },
      "basePath": {
        "description": "Package base path intent",
        "type": "string"
      },
      "console": {
        "description": "Console base URL",
        "type": "string"
      },
      "description": {
        "description": "Published artifact description",
        "type": "string"
      },
      "entrypoint": {
        "description": "Package entrypoint path",
        "type": "string"
      },
      "idempotencyKey": {
        "description": "Idempotency key for Console retries",
        "type": "string"
      },
      "name": {
        "description": "Published artifact name",
        "type": "string"
      },
      "noActivate": {
        "default": true,
        "description": "Create publish records without activating a site release",
        "type": "boolean"
      },
      "project": {
        "description": "Console project id or slug",
        "type": "string"
      },
      "reason": {
        "description": "Release reason sent to Console",
        "type": "string"
      },
      "replaceRelease": {
        "description": "Replace the full active route map instead of merging",
        "type": "boolean"
      },
      "route": {
        "description": "Site route path to mount the artifact at",
        "type": "string"
      },
      "site": {
        "description": "Console site id or slug to release to",
        "type": "string"
      },
      "slug": {
        "description": "Published artifact slug",
        "type": "string"
      },
      "target": {
        "description": "Local artifact id, file, or directory",
        "type": "string"
      },
      "uploadSession": {
        "description": "Use an existing Console upload session",
        "type": "string"
      },
      "visibility": {
        "description": "Requested visibility: private|protected_link|public",
        "type": "string"
      }
    },
    "required": [
      "target"
    ],
    "type": "object"
  }
  """#

  public static let ArtifactsReleaseActivateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "console": {
        "description": "Console base URL",
        "type": "string"
      },
      "id": {
        "description": "Local artifact id",
        "type": "string"
      },
      "release": {
        "description": "Explicit Console release id to activate",
        "type": "string"
      },
      "site": {
        "description": "Console site id or slug, required when --release is not recorded locally",
        "type": "string"
      },
      "version": {
        "description": "Local artifact version whose recorded release should be activated",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let ArtifactsRestoreInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Artifact id",
        "type": "string"
      },
      "message": {
        "description": "Event message for the restore",
        "type": "string"
      },
      "version": {
        "description": "Version number to restore",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let ArtifactsShowInputSchema = #"""
  {
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
  }
  """#

  public static let ArtifactsSnapshotInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Artifact id",
        "type": "string"
      },
      "label": {
        "description": "Human label for this version",
        "type": "string"
      },
      "manifest": {
        "description": "Extra manifest JSON object",
        "type": "string"
      },
      "message": {
        "description": "Event message for the snapshot",
        "type": "string"
      },
      "metadata": {
        "description": "Version metadata JSON object",
        "type": "string"
      },
      "source": {
        "description": "Snapshot source",
        "type": "string"
      },
      "status": {
        "description": "Version status (default: active)",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let ArtifactsUpdateInputSchema = #"""
  {
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
  }
  """#

  public static let ArtifactsVersionInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Artifact id",
        "type": "string"
      },
      "version": {
        "description": "Version number (default: latest)",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let ArtifactsVersionsInputSchema = #"""
  {
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
  }
  """#

  public static let AudioGenerateInputSchema = #"""
  {
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
  }
  """#

  public static let ChatsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Filter by agent id",
        "type": "string"
      },
      "channel": {
        "description": "Filter by channel, e.g. whatsapp",
        "type": "string"
      },
      "contact": {
        "description": "Filter by contact id, phone, or identity",
        "type": "string"
      },
      "includeRaw": {
        "description": "Include raw provider ids and provenance in JSON output",
        "type": "boolean"
      },
      "instance": {
        "description": "Filter by instance name or Omni instance id",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 25, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching chats to skip (default: 0)",
        "type": "string"
      },
      "query": {
        "description": "Search chat ids, titles, and message content",
        "type": "string"
      },
      "type": {
        "description": "Filter by chat type: dm|group|thread|room",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ChatsListsAddInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "description": "Resolve chat within a channel",
        "type": "string"
      },
      "chat": {
        "description": "Chat id, phone, group id, or normalized chat id",
        "type": "string"
      },
      "includeRaw": {
        "description": "Include raw provider ids and provenance in JSON output",
        "type": "boolean"
      },
      "instance": {
        "description": "Resolve chat within an instance",
        "type": "string"
      },
      "list": {
        "description": "List id or name",
        "type": "string"
      },
      "owner": {
        "description": "Owner scope when resolving list by name",
        "type": "string"
      },
      "priority": {
        "description": "Sort priority (default: 0)",
        "type": "string"
      },
      "reason": {
        "description": "Why this chat is in the list",
        "type": "string"
      }
    },
    "required": [
      "chat",
      "list"
    ],
    "type": "object"
  }
  """#

  public static let ChatsListsCreateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "description": {
        "description": "List description",
        "type": "string"
      },
      "mode": {
        "description": "static|dynamic|hybrid (default: static)",
        "type": "string"
      },
      "name": {
        "description": "Reading list name",
        "type": "string"
      },
      "owner": {
        "description": "Owner scope (default: current agent or system:ravi)",
        "type": "string"
      },
      "visibility": {
        "description": "private|team|system (default: system)",
        "type": "string"
      }
    },
    "required": [
      "name"
    ],
    "type": "object"
  }
  """#

  public static let ChatsListsDeltaInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "description": "Resolve chat within a channel",
        "type": "string"
      },
      "chat": {
        "description": "Chat id, phone, group id, or normalized chat id",
        "type": "string"
      },
      "includeRaw": {
        "description": "Include raw provider ids and provenance in JSON output",
        "type": "boolean"
      },
      "instance": {
        "description": "Resolve chat within an instance",
        "type": "string"
      },
      "limit": {
        "description": "Max delta messages (default: 50, max: 500)",
        "type": "string"
      },
      "list": {
        "description": "List id or name",
        "type": "string"
      },
      "markRead": {
        "description": "Advance the cursor to the last returned message",
        "type": "boolean"
      },
      "owner": {
        "description": "Owner scope when resolving list by name",
        "type": "string"
      },
      "reader": {
        "description": "Reader cursor scope (default: current agent)",
        "type": "string"
      }
    },
    "required": [
      "chat",
      "list"
    ],
    "type": "object"
  }
  """#

  public static let ChatsListsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "includeArchived": {
        "description": "Include archived lists",
        "type": "boolean"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching lists to skip (default: 0)",
        "type": "string"
      },
      "owner": {
        "description": "Filter by owner, e.g. agent:ravi-crm",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ChatsListsMarkReadInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "description": "Resolve chat within a channel",
        "type": "string"
      },
      "chat": {
        "description": "Chat id, phone, group id, or normalized chat id",
        "type": "string"
      },
      "includeRaw": {
        "description": "Include raw provider ids and provenance in JSON output",
        "type": "boolean"
      },
      "instance": {
        "description": "Resolve chat within an instance",
        "type": "string"
      },
      "list": {
        "description": "List id or name",
        "type": "string"
      },
      "message": {
        "description": "Mark read through this durable message id (default: latest)",
        "type": "string"
      },
      "owner": {
        "description": "Owner scope when resolving list by name",
        "type": "string"
      },
      "reader": {
        "description": "Reader cursor scope (default: current agent)",
        "type": "string"
      },
      "reason": {
        "description": "Cursor update reason",
        "type": "string"
      }
    },
    "required": [
      "chat",
      "list"
    ],
    "type": "object"
  }
  """#

  public static let ChatsListsMembersInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "includeRaw": {
        "description": "Include raw provider ids and provenance in JSON output",
        "type": "boolean"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "list": {
        "description": "List id or name",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching members to skip (default: 0)",
        "type": "string"
      },
      "owner": {
        "description": "Owner scope when resolving list by name",
        "type": "string"
      },
      "reader": {
        "description": "Reader cursor scope (default: current agent)",
        "type": "string"
      }
    },
    "required": [
      "list"
    ],
    "type": "object"
  }
  """#

  public static let ChatsListsRemoveInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "description": "Resolve chat within a channel",
        "type": "string"
      },
      "chat": {
        "description": "Chat id, phone, group id, or normalized chat id",
        "type": "string"
      },
      "instance": {
        "description": "Resolve chat within an instance",
        "type": "string"
      },
      "list": {
        "description": "List id or name",
        "type": "string"
      },
      "owner": {
        "description": "Owner scope when resolving list by name",
        "type": "string"
      }
    },
    "required": [
      "chat",
      "list"
    ],
    "type": "object"
  }
  """#

  public static let ChatsReadInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "description": "Resolve chat within a channel",
        "type": "string"
      },
      "chat": {
        "description": "Chat id, platform chat id, phone, group id, or normalized chat id",
        "type": "string"
      },
      "includeRaw": {
        "description": "Include raw provider ids and provenance in JSON output",
        "type": "boolean"
      },
      "instance": {
        "description": "Resolve chat within an instance",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching messages to skip (default: 0)",
        "type": "string"
      },
      "order": {
        "description": "Message order (default: asc)",
        "type": "string"
      },
      "type": {
        "description": "Resolve chat type: dm|group|thread|room",
        "type": "string"
      }
    },
    "required": [
      "chat"
    ],
    "type": "object"
  }
  """#

  public static let CommandsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Resolve agent-scoped commands for this agent",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching commands to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical command tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let CommandsRunInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Resolve agent-scoped commands for this agent",
        "type": "string"
      },
      "args": {
        "description": "Command arguments",
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "name": {
        "description": "Command name, with or without #",
        "type": "string"
      }
    },
    "required": [
      "name"
    ],
    "type": "object"
  }
  """#

  public static let CommandsShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Resolve agent-scoped commands for this agent",
        "type": "string"
      },
      "name": {
        "description": "Command name, with or without #",
        "type": "string"
      }
    },
    "required": [
      "name"
    ],
    "type": "object"
  }
  """#

  public static let CommandsValidateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Resolve agent-scoped commands for this agent",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ContactsActivityInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching events to skip (default: 0)",
        "type": "string"
      },
      "raw": {
        "description": "Include low-level runtime/tool/adapter events",
        "type": "boolean"
      }
    },
    "required": [
      "contact"
    ],
    "type": "object"
  }
  """#

  public static let ContactsAddInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Restrict to agent(s), comma-separated",
        "type": "string"
      },
      "identity": {
        "description": "Phone number or WhatsApp identity",
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
  }
  """#

  public static let ContactsAllowInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsApproveInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsBackfillInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "apply": {
        "description": "Write canonical contacts and actor links. Without this, runs dry-run.",
        "type": "boolean"
      },
      "channel": {
        "description": "Limit to one channel, e.g. whatsapp",
        "type": "string"
      },
      "createList": {
        "description": "When applying, add linked chats to this reading list",
        "type": "string"
      },
      "dryRun": {
        "description": "Force preview mode even if --apply is present",
        "type": "boolean"
      },
      "instance": {
        "description": "Limit to one channel instance/account",
        "type": "string"
      },
      "limit": {
        "description": "Maximum candidates to inspect/apply",
        "type": "string"
      },
      "listOwner": {
        "description": "Owner for --create-list (default: agent:ravi-crm)",
        "type": "string"
      },
      "mode": {
        "description": "Contact intake status: pending|discovered (default: pending)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ContactsBlockInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsCheckInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsDuplicatesInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ContactsFindInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsGetInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsInfoInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsLinkInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching contacts to skip (default: 0)",
        "type": "string"
      },
      "status": {
        "description": "Filter by status",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ContactsMergeInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsMessagesInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching messages to skip (default: 0)",
        "type": "string"
      }
    },
    "required": [
      "contact"
    ],
    "type": "object"
  }
  """#

  public static let ContactsMetadataListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching metadata entries to skip (default: 0)",
        "type": "string"
      },
      "scope": {
        "description": "Filter by scoped context",
        "type": "string"
      }
    },
    "required": [
      "contact"
    ],
    "type": "object"
  }
  """#

  public static let ContactsMetadataRemoveInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "key": {
        "description": "Namespaced metadata key",
        "type": "string"
      },
      "scope": {
        "description": "Scoped context, e.g. project:ravi-web",
        "type": "string"
      },
      "source": {
        "description": "Event source (default: cli)",
        "type": "string"
      }
    },
    "required": [
      "contact",
      "key"
    ],
    "type": "object"
  }
  """#

  public static let ContactsMetadataSetInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "key": {
        "description": "Namespaced metadata key",
        "type": "string"
      },
      "scope": {
        "description": "Scoped context, e.g. project:ravi-web",
        "type": "string"
      },
      "source": {
        "description": "Event source (default: cli)",
        "type": "string"
      },
      "value": {
        "description": "JSON value",
        "type": "string"
      }
    },
    "required": [
      "contact",
      "key",
      "value"
    ],
    "type": "object"
  }
  """#

  public static let ContactsNoteInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "scope": {
        "description": "Scoped context for this note",
        "type": "string"
      },
      "source": {
        "description": "Event source (default: cli)",
        "type": "string"
      },
      "text": {
        "description": "Note text",
        "type": "string"
      }
    },
    "required": [
      "contact",
      "text"
    ],
    "type": "object"
  }
  """#

  public static let ContactsPendingInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "Filter by account",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ContactsProfileInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "includeCrm": {
        "description": "Include CRM profile/account/opportunity/task summary",
        "type": "boolean"
      },
      "limit": {
        "description": "Evidence rows per section (default: 10, max: 50)",
        "type": "string"
      }
    },
    "required": [
      "contact"
    ],
    "type": "object"
  }
  """#

  public static let ContactsRemoveInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsSessionsInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching sessions to skip (default: 0)",
        "type": "string"
      }
    },
    "required": [
      "contact"
    ],
    "type": "object"
  }
  """#

  public static let ContactsSetInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsTagInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsTimelineInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "event": {
        "description": "Filter by event type",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching events to skip (default: 0)",
        "type": "string"
      },
      "scope": {
        "description": "Filter by scoped context",
        "type": "string"
      }
    },
    "required": [
      "contact"
    ],
    "type": "object"
  }
  """#

  public static let ContactsUnlinkInputSchema = #"""
  {
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
  }
  """#

  public static let ContactsUntagInputSchema = #"""
  {
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
  }
  """#

  public static let ContextAuthorizeInputSchema = #"""
  {
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
  }
  """#

  public static let ContextCapabilitiesInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ContextCheckInputSchema = #"""
  {
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
  }
  """#

  public static let ContextCleanupAgentRuntimeInputSchema = #"""
  {
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
  }
  """#

  public static let ContextCodexBashHookInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ContextCredentialsAddInputSchema = #"""
  {
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
  }
  """#

  public static let ContextCredentialsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching credential entries to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ContextCredentialsRemoveInputSchema = #"""
  {
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
  }
  """#

  public static let ContextCredentialsSetDefaultInputSchema = #"""
  {
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
  }
  """#

  public static let ContextInfoInputSchema = #"""
  {
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
  }
  """#

  public static let ContextIssueInputSchema = #"""
  {
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
  }
  """#

  public static let ContextLineageInputSchema = #"""
  {
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
  }
  """#

  public static let ContextListInputSchema = #"""
  {
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
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching contexts to skip (default: 0)",
        "type": "string"
      },
      "session": {
        "description": "Filter by session key",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ContextRevokeInputSchema = #"""
  {
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
  }
  """#

  public static let ContextVisibilityInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ContextWhoamiInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let CostsAgentInputSchema = #"""
  {
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
  }
  """#

  public static let CostsAgentsInputSchema = #"""
  {
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
  }
  """#

  public static let CostsSessionInputSchema = #"""
  {
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
  }
  """#

  public static let CostsSummaryInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "hours": {
        "description": "Time window in hours (default: 24)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let CostsTopSessionsInputSchema = #"""
  {
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
  }
  """#

  public static let CrmAccountInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "CRM account ID or org contact ID",
        "type": "string"
      }
    },
    "required": [
      "account"
    ],
    "type": "object"
  }
  """#

  public static let CrmAccountCreateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Organization contact ID",
        "type": "string"
      },
      "domain": {
        "description": "Account domain",
        "type": "string"
      },
      "idempotencyKey": {
        "description": "Deduplicate repeated account creation",
        "type": "string"
      },
      "name": {
        "description": "Account name",
        "type": "string"
      },
      "owner": {
        "description": "Owner, e.g. agent:main",
        "type": "string"
      }
    },
    "required": [
      "name"
    ],
    "type": "object"
  }
  """#

  public static let CrmAccountLinkContactInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "CRM account ID",
        "type": "string"
      },
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "primary": {
        "description": "Mark as primary account contact",
        "type": "boolean"
      },
      "role": {
        "description": "Membership role (default: member)",
        "type": "string"
      }
    },
    "required": [
      "account",
      "contact"
    ],
    "type": "object"
  }
  """#

  public static let CrmAccountShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "CRM account ID or org contact ID",
        "type": "string"
      }
    },
    "required": [
      "account"
    ],
    "type": "object"
  }
  """#

  public static let CrmBoardInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let CrmContactInputSchema = #"""
  {
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
  }
  """#

  public static let CrmContactSetInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "field": {
        "description": "CRM field",
        "type": "string"
      },
      "source": {
        "description": "Mutation source (default: cli)",
        "type": "string"
      },
      "value": {
        "description": "Field value, '-' to clear nullable fields",
        "type": "string"
      }
    },
    "required": [
      "contact",
      "field",
      "value"
    ],
    "type": "object"
  }
  """#

  public static let CrmContactShowInputSchema = #"""
  {
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
  }
  """#

  public static let CrmContactsInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching contacts to skip (default: 0)",
        "type": "string"
      },
      "owner": {
        "description": "Filter by owner",
        "type": "string"
      },
      "status": {
        "description": "Filter by CRM lifecycle",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let CrmFactConfirmInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "fact": {
        "description": "CRM fact ID",
        "type": "string"
      }
    },
    "required": [
      "fact"
    ],
    "type": "object"
  }
  """#

  public static let CrmFactListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "Filter by CRM account",
        "type": "string"
      },
      "contact": {
        "description": "Filter by contact",
        "type": "string"
      },
      "entity": {
        "description": "Filter by CRM entity id",
        "type": "string"
      },
      "entityType": {
        "description": "Filter by CRM entity type",
        "type": "string"
      },
      "key": {
        "description": "Filter by fact key",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 25, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching facts to skip (default: 0)",
        "type": "string"
      },
      "opportunity": {
        "description": "Filter by CRM opportunity",
        "type": "string"
      },
      "status": {
        "description": "proposed|confirmed|rejected|superseded",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let CrmFactProposeInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "Related account",
        "type": "string"
      },
      "confidence": {
        "description": "Confidence between 0 and 1",
        "type": "string"
      },
      "contact": {
        "description": "Related contact",
        "type": "string"
      },
      "entity": {
        "description": "CRM entity id",
        "type": "string"
      },
      "entityType": {
        "description": "CRM entity type",
        "type": "string"
      },
      "idempotencyKey": {
        "description": "Deduplicate repeated fact writes",
        "type": "string"
      },
      "key": {
        "description": "Fact key",
        "type": "string"
      },
      "opportunity": {
        "description": "Related opportunity",
        "type": "string"
      },
      "status": {
        "description": "proposed|confirmed",
        "type": "string"
      },
      "value": {
        "description": "JSON value or plain string",
        "type": "string"
      }
    },
    "required": [
      "entity",
      "entityType",
      "key",
      "value"
    ],
    "type": "object"
  }
  """#

  public static let CrmFactRejectInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "fact": {
        "description": "CRM fact ID",
        "type": "string"
      }
    },
    "required": [
      "fact"
    ],
    "type": "object"
  }
  """#

  public static let CrmNextInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "Filter by account",
        "type": "string"
      },
      "contact": {
        "description": "Filter by contact",
        "type": "string"
      },
      "dueAfter": {
        "description": "Only actions with due_at >= <ts>",
        "type": "string"
      },
      "dueBefore": {
        "description": "Only actions with due_at < <ts>",
        "type": "string"
      },
      "dueToday": {
        "description": "Only actions whose due_at is today",
        "type": "boolean"
      },
      "limit": {
        "description": "Page size (default: 25, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching actions to skip (default: 0)",
        "type": "string"
      },
      "opportunity": {
        "description": "Filter by opportunity",
        "type": "string"
      },
      "owner": {
        "description": "Filter by owner, e.g. agent:main",
        "type": "string"
      },
      "taskType": {
        "description": "Filter by task_type (e.g. commitment, follow_up, call)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let CrmOpportunityInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "opportunity": {
        "description": "CRM opportunity ID",
        "type": "string"
      }
    },
    "required": [
      "opportunity"
    ],
    "type": "object"
  }
  """#

  public static let CrmOpportunityContactsInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "opportunity": {
        "description": "CRM opportunity ID",
        "type": "string"
      }
    },
    "required": [
      "opportunity"
    ],
    "type": "object"
  }
  """#

  public static let CrmOpportunityCreateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "CRM account ID",
        "type": "string"
      },
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "currency": {
        "description": "Currency (default: BRL)",
        "type": "string"
      },
      "idempotencyKey": {
        "description": "Deduplicate repeated opportunity creation",
        "type": "string"
      },
      "owner": {
        "description": "Owner, e.g. agent:main",
        "type": "string"
      },
      "stage": {
        "description": "Pipeline stage key or ID",
        "type": "string"
      },
      "title": {
        "description": "Opportunity title",
        "type": "string"
      },
      "value": {
        "description": "Opportunity value in cents",
        "type": "string"
      }
    },
    "required": [
      "title"
    ],
    "type": "object"
  }
  """#

  public static let CrmOpportunityLinkContactInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "CRM account ID",
        "type": "string"
      },
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "opportunity": {
        "description": "CRM opportunity ID",
        "type": "string"
      },
      "primary": {
        "description": "Mark as primary opportunity contact",
        "type": "boolean"
      },
      "role": {
        "description": "Opportunity role (default: stakeholder)",
        "type": "string"
      }
    },
    "required": [
      "contact",
      "opportunity"
    ],
    "type": "object"
  }
  """#

  public static let CrmOpportunityMoveInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "lostReason": {
        "description": "Lost reason when moving to lost",
        "type": "string"
      },
      "opportunity": {
        "description": "CRM opportunity ID",
        "type": "string"
      },
      "stage": {
        "description": "Pipeline stage key or ID",
        "type": "string"
      }
    },
    "required": [
      "opportunity",
      "stage"
    ],
    "type": "object"
  }
  """#

  public static let CrmOpportunityShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "opportunity": {
        "description": "CRM opportunity ID",
        "type": "string"
      }
    },
    "required": [
      "opportunity"
    ],
    "type": "object"
  }
  """#

  public static let CrmTaskCancelInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "reason": {
        "description": "Reason for cancellation (stored in event payload)",
        "type": "string"
      },
      "task": {
        "description": "CRM task ID",
        "type": "string"
      }
    },
    "required": [
      "task"
    ],
    "type": "object"
  }
  """#

  public static let CrmTaskCreateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "CRM account ID",
        "type": "string"
      },
      "body": {
        "description": "Task body / longer description",
        "type": "string"
      },
      "confidence": {
        "description": "Confidence in the task (0.0–1.0)",
        "type": "string"
      },
      "contact": {
        "description": "Contact ID or identity",
        "type": "string"
      },
      "due": {
        "description": "Due date/time",
        "type": "string"
      },
      "evidence": {
        "description": "Evidence JSON array attached to the task event",
        "type": "string"
      },
      "idempotencyKey": {
        "description": "Deduplicate repeated task creation",
        "type": "string"
      },
      "metadata": {
        "description": "Metadata JSON object stored on the task",
        "type": "string"
      },
      "opportunity": {
        "description": "CRM opportunity ID",
        "type": "string"
      },
      "owner": {
        "description": "Owner, e.g. agent:main",
        "type": "string"
      },
      "priority": {
        "description": "low|normal|high|urgent",
        "type": "string"
      },
      "source": {
        "description": "Source label (default: cli)",
        "type": "string"
      },
      "taskType": {
        "description": "Task type (e.g. follow_up, commitment, call)",
        "type": "string"
      },
      "title": {
        "description": "Task title",
        "type": "string"
      }
    },
    "required": [
      "title"
    ],
    "type": "object"
  }
  """#

  public static let CrmTaskDoneInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "task": {
        "description": "CRM task ID",
        "type": "string"
      }
    },
    "required": [
      "task"
    ],
    "type": "object"
  }
  """#

  public static let CrmTaskListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "Filter by account",
        "type": "string"
      },
      "contact": {
        "description": "Filter by contact",
        "type": "string"
      },
      "dueAfter": {
        "description": "Only tasks with due_at >= <ts>",
        "type": "string"
      },
      "dueBefore": {
        "description": "Only tasks with due_at < <ts>",
        "type": "string"
      },
      "dueToday": {
        "description": "Only tasks whose due_at is today",
        "type": "boolean"
      },
      "limit": {
        "description": "Page size (default: 25, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching tasks to skip (default: 0)",
        "type": "string"
      },
      "opportunity": {
        "description": "Filter by opportunity",
        "type": "string"
      },
      "owner": {
        "description": "Filter by owner, e.g. agent:main",
        "type": "string"
      },
      "status": {
        "description": "Filter by status (open, scheduled, done, canceled, snoozed)",
        "type": "string"
      },
      "taskType": {
        "description": "Filter by task_type",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let CrmTaskShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "task": {
        "description": "CRM task ID",
        "type": "string"
      }
    },
    "required": [
      "task"
    ],
    "type": "object"
  }
  """#

  public static let CrmTaskSnoozeInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "reason": {
        "description": "Reason for snoozing",
        "type": "string"
      },
      "task": {
        "description": "CRM task ID",
        "type": "string"
      },
      "until": {
        "description": "New due_at / snoozed_until (ISO timestamp)",
        "type": "string"
      }
    },
    "required": [
      "task"
    ],
    "type": "object"
  }
  """#

  public static let CronAddInputSchema = #"""
  {
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
  }
  """#

  public static let CronDisableInputSchema = #"""
  {
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
  }
  """#

  public static let CronEnableInputSchema = #"""
  {
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
  }
  """#

  public static let CronListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching cron jobs to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical cron job tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let CronRmInputSchema = #"""
  {
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
  }
  """#

  public static let CronRunInputSchema = #"""
  {
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
  }
  """#

  public static let CronSetInputSchema = #"""
  {
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
  }
  """#

  public static let CronShowInputSchema = #"""
  {
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
  }
  """#

  public static let DaemonEnvInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let DaemonInitAdminKeyInputSchema = #"""
  {
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
  }
  """#

  public static let DaemonInstallInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let DaemonLogsInputSchema = #"""
  {
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
  }
  """#

  public static let DaemonRestartInputSchema = #"""
  {
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
  }
  """#

  public static let DaemonStartInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let DaemonStatusInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let DaemonStopInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let DaemonUninstallInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let DevinAuthCheckInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let DevinSessionsArchiveInputSchema = #"""
  {
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
  }
  """#

  public static let DevinSessionsAttachmentsInputSchema = #"""
  {
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
  }
  """#

  public static let DevinSessionsCreateInputSchema = #"""
  {
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
  }
  """#

  public static let DevinSessionsInsightsInputSchema = #"""
  {
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
  }
  """#

  public static let DevinSessionsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Max sessions to show (default: 20)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching sessions to skip (default: 0)",
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
  }
  """#

  public static let DevinSessionsMessagesInputSchema = #"""
  {
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
  }
  """#

  public static let DevinSessionsSendInputSchema = #"""
  {
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
  }
  """#

  public static let DevinSessionsShowInputSchema = #"""
  {
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
  }
  """#

  public static let DevinSessionsSyncInputSchema = #"""
  {
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
  }
  """#

  public static let DevinSessionsTerminateInputSchema = #"""
  {
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
  }
  """#

  public static let EvalRunInputSchema = #"""
  {
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
  }
  """#

  public static let HeartbeatDisableInputSchema = #"""
  {
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
  }
  """#

  public static let HeartbeatEnableInputSchema = #"""
  {
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
  }
  """#

  public static let HeartbeatSetInputSchema = #"""
  {
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
  }
  """#

  public static let HeartbeatShowInputSchema = #"""
  {
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
  }
  """#

  public static let HeartbeatStatusInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let HeartbeatTriggerInputSchema = #"""
  {
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
  }
  """#

  public static let HooksCreateInputSchema = #"""
  {
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
  }
  """#

  public static let HooksDisableInputSchema = #"""
  {
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
  }
  """#

  public static let HooksEnableInputSchema = #"""
  {
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
  }
  """#

  public static let HooksListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching hooks to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical hook tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let HooksRmInputSchema = #"""
  {
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
  }
  """#

  public static let HooksShowInputSchema = #"""
  {
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
  }
  """#

  public static let HooksTestInputSchema = #"""
  {
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
  }
  """#

  public static let ImageAtlasSplitInputSchema = #"""
  {
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
  }
  """#

  public static let ImageGenerateInputSchema = #"""
  {
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
  }
  """#

  public static let InboxDisableInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let InboxEnableInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let InboxItemsInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Maximum items to return (default: 25, max: 500)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let InboxPollInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "once": {
        "description": "Run one cycle and exit (default)",
        "type": "boolean"
      }
    },
    "type": "object"
  }
  """#

  public static let InboxReplayInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "ref": {
        "description": "Local row id (number) or remote item id (uuid)",
        "type": "string"
      }
    },
    "required": [
      "ref"
    ],
    "type": "object"
  }
  """#

  public static let InboxStatusInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let InsightsCreateInputSchema = #"""
  {
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
      "tag": {
        "description": "Canonical tags; can be repeated or comma-separated",
        "items": {
          "type": "string"
        },
        "type": "array"
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
  }
  """#

  public static let InsightsListInputSchema = #"""
  {
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
      "offset": {
        "description": "Number of matching insights to skip (default: 0)",
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
      "tag": {
        "description": "Filter by canonical tag",
        "type": "string"
      },
      "task": {
        "description": "Filter by linked task",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let InsightsSearchInputSchema = #"""
  {
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
  }
  """#

  public static let InsightsShowInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesCreateInputSchema = #"""
  {
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
      "contactIntakeMode": {
        "description": "Inbound DM contact intake: off|discovered|pending (default: off)",
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
  }
  """#

  public static let InstancesDeleteInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesDeletedInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let InstancesDisableInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesDisconnectInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesEnableInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesGetInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "key": {
        "description": "Property key (agent, dmPolicy, groupPolicy, contactIntakeMode, defaultContactTags, dmScope, instanceId, channel, enabled, defaults)",
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
  }
  """#

  public static let InstancesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching instances to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical instance tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let InstancesPendingApproveInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesPendingListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "name": {
        "description": "Instance name",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching pending entries to skip (default: 0)",
        "type": "string"
      }
    },
    "required": [
      "name"
    ],
    "type": "object"
  }
  """#

  public static let InstancesPendingRejectInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesRestoreInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesRoutesAddInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesRoutesDeletedInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "name": {
        "description": "Instance name (omit for all)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let InstancesRoutesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "name": {
        "description": "Instance name",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching routes to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical route tag",
        "type": "string"
      }
    },
    "required": [
      "name"
    ],
    "type": "object"
  }
  """#

  public static let InstancesRoutesRemoveInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesRoutesRestoreInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesRoutesSetInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesRoutesShowInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesSetInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "key": {
        "description": "Property key (agent, dmPolicy, groupPolicy, contactIntakeMode, defaultContactTags, dmScope, instanceId, channel, enabled, defaults)",
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
  }
  """#

  public static let InstancesShowInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesStatusInputSchema = #"""
  {
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
  }
  """#

  public static let InstancesTargetInputSchema = #"""
  {
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
  }
  """#

  public static let MediaSendInputSchema = #"""
  {
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
  }
  """#

  public static let ObserversListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Filter by observer agent id",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching observer bindings to skip (default: 0)",
        "type": "string"
      },
      "session": {
        "description": "Filter by source session name/key",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ObserversProfilesInitInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "overwrite": {
        "description": "Overwrite existing profile files",
        "type": "boolean"
      },
      "profileId": {
        "description": "Observer profile id",
        "type": "string"
      },
      "source": {
        "description": "workspace|user",
        "type": "string"
      }
    },
    "required": [
      "profileId"
    ],
    "type": "object"
  }
  """#

  public static let ObserversProfilesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching observer profiles to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ObserversProfilesPreviewInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "event": {
        "description": "Observation event type to preview",
        "type": "string"
      },
      "profileId": {
        "description": "Observer profile id",
        "type": "string"
      }
    },
    "required": [
      "profileId"
    ],
    "type": "object"
  }
  """#

  public static let ObserversProfilesShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "profileId": {
        "description": "Observer profile id",
        "type": "string"
      }
    },
    "required": [
      "profileId"
    ],
    "type": "object"
  }
  """#

  public static let ObserversProfilesValidateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "profileId": {
        "description": "Optional observer profile id",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ObserversRefreshInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "session": {
        "description": "Source session name or key",
        "type": "string"
      }
    },
    "required": [
      "session"
    ],
    "type": "object"
  }
  """#

  public static let ObserversRulesDisableInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Observer rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let ObserversRulesEnableInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Observer rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let ObserversRulesExplainInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "session": {
        "description": "Source session name or key",
        "type": "string"
      }
    },
    "required": [
      "session"
    ],
    "type": "object"
  }
  """#

  public static let ObserversRulesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching observer rules to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ObserversRulesRmInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Observer rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let ObserversRulesSetInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "delivery": {
        "description": "realtime|debounce|end_of_turn|manual",
        "type": "string"
      },
      "disabled": {
        "description": "Create rule disabled",
        "type": "boolean"
      },
      "events": {
        "description": "Comma-separated observation event types",
        "type": "string"
      },
      "id": {
        "description": "Observer rule id",
        "type": "string"
      },
      "meta": {
        "description": "Free JSON metadata for the rule",
        "type": "string"
      },
      "mode": {
        "description": "observe|summarize|report",
        "type": "string"
      },
      "model": {
        "description": "Runtime model for observer execution; use 'clear' to inherit the observer agent model",
        "type": "string"
      },
      "observerAgentId": {
        "description": "Agent id for the observer session",
        "type": "string"
      },
      "permissions": {
        "description": "Comma-separated permission grants for observer",
        "type": "string"
      },
      "priority": {
        "description": "Lower priority wins",
        "type": "string"
      },
      "profile": {
        "description": "Observer profile id for Markdown prompt rendering; use 'clear' to use the default profile",
        "type": "string"
      },
      "provider": {
        "description": "Runtime provider id for observer execution; use 'clear' to inherit the observer agent provider",
        "type": "string"
      },
      "role": {
        "description": "Observer role. Defaults to rule id.",
        "type": "string"
      },
      "scope": {
        "description": "global|agent|session|task|profile|project|tag",
        "type": "string"
      },
      "sourceAgent": {
        "description": "Match source agent id",
        "type": "string"
      },
      "sourceProfile": {
        "description": "Match source task profile id",
        "type": "string"
      },
      "sourceProject": {
        "description": "Match source project id",
        "type": "string"
      },
      "sourceSession": {
        "description": "Match source session name/key",
        "type": "string"
      },
      "sourceTask": {
        "description": "Match source task id",
        "type": "string"
      },
      "tag": {
        "description": "Match tag slug for scope=tag",
        "type": "string"
      },
      "tagInherited": {
        "description": "Allow inherited tag matching",
        "type": "boolean"
      },
      "tagTarget": {
        "description": "agent|session|task|project|contact|profile|any",
        "type": "string"
      }
    },
    "required": [
      "id",
      "observerAgentId"
    ],
    "type": "object"
  }
  """#

  public static let ObserversRulesShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Observer rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let ObserversRulesValidateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ObserversShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "bindingId": {
        "description": "Observer binding id",
        "type": "string"
      }
    },
    "required": [
      "bindingId"
    ],
    "type": "object"
  }
  """#

  public static let PermissionsCheckInputSchema = #"""
  {
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
  }
  """#

  public static let PermissionsClearInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "all": {
        "description": "Clear ALL relations (including config)",
        "type": "boolean"
      }
    },
    "type": "object"
  }
  """#

  public static let PermissionsGrantInputSchema = #"""
  {
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
  }
  """#

  public static let PermissionsInitInputSchema = #"""
  {
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
  }
  """#

  public static let PermissionsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "object": {
        "description": "Filter by object (e.g., group:contacts)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching relations to skip (default: 0)",
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
  }
  """#

  public static let PermissionsRevokeInputSchema = #"""
  {
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
  }
  """#

  public static let PermissionsSyncInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ProjectsCreateInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsFixturesSeedInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "ownerAgent": {
        "description": "Owner agent for the seeded projects",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ProjectsInitInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsLinkInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching projects to skip (default: 0)",
        "type": "string"
      },
      "status": {
        "description": "Filter by status",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical project tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ProjectsNextInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "status": {
        "description": "Filter by project status",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical project tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ProjectsResourcesAddInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsResourcesImportInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsResourcesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching resources to skip (default: 0)",
        "type": "string"
      },
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
  }
  """#

  public static let ProjectsResourcesShowInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsShowInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsStatusInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsTasksAttachInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsTasksCreateInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsTasksDispatchInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsUpdateInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsWorkflowsAttachInputSchema = #"""
  {
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
  }
  """#

  public static let ProjectsWorkflowsStartInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsCancelInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsEventsInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsProfilesConfigureInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsProfilesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching call profiles to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical call profile tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ProxCallsProfilesShowInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsRequestInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsRulesInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "scope": {
        "description": "Rule scope type (global, project, person, profile, agent)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ProxCallsShowInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsToolsBindInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsToolsConfigureInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsToolsCreateInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsToolsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching call tools to skip (default: 0)",
        "type": "string"
      },
      "profile": {
        "description": "Filter tools by profile binding",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical call tool tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ProxCallsToolsRunInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsToolsRunsInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsToolsShowInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsToolsUnbindInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsTranscriptInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsVoiceAgentsBindToolInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsVoiceAgentsConfigureInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsVoiceAgentsCreateInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsVoiceAgentsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching voice agents to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical call voice agent tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ProxCallsVoiceAgentsShowInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsVoiceAgentsSyncInputSchema = #"""
  {
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
  }
  """#

  public static let ProxCallsVoiceAgentsUnbindToolInputSchema = #"""
  {
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
  }
  """#

  public static let ReactSendInputSchema = #"""
  {
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
  }
  """#

  public static let RoutesExplainInputSchema = #"""
  {
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
  }
  """#

  public static let RoutesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "name": {
        "description": "Instance name (omit for all)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching routes to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical route tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let RoutesShowInputSchema = #"""
  {
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
  }
  """#

  public static let SdkClientCheckInputSchema = #"""
  {
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
  }
  """#

  public static let SdkClientGenerateInputSchema = #"""
  {
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
  }
  """#

  public static let SdkOpenapiCheckInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "against": {
        "description": "Path to the stored spec to diff against",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SdkOpenapiEmitInputSchema = #"""
  {
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
  }
  """#

  public static let SdkSwiftCheckInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "out": {
        "default": "packages/ravi-os-swift-sdk/Sources/RaviSDK",
        "description": "Directory containing the generated Swift files",
        "type": "string"
      },
      "version": {
        "description": "SDK semver baked into RaviVersion.generated.swift",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SdkSwiftGenerateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "out": {
        "default": "packages/ravi-os-swift-sdk/Sources/RaviSDK",
        "description": "Target directory for the generated Swift files",
        "type": "string"
      },
      "version": {
        "description": "SDK semver baked into RaviVersion.generated.swift",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SelfChatInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "depth": {
        "description": "Depth: summary, normal, or full",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SelfContextInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "depth": {
        "description": "Depth: summary, normal, or full",
        "type": "string"
      },
      "limit": {
        "description": "Maximum recent messages to inspect",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SelfExplainInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let SelfKnowledgeInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let SelfPermissionsInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let SelfRecentInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Maximum recent messages to inspect",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SelfRouteInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let SelfWhoamiInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ServiceStartInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ServiceTuiInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "session": {
        "description": "Session key (default: agent:main:main)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ServiceWaInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let SessionsAnswerInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsAskInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsAttachInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "chat": {
        "description": "Canonical chat id (or platform/normalized id)",
        "type": "string"
      },
      "nameOrKey": {
        "description": "Session name or key",
        "type": "string"
      },
      "reason": {
        "description": "Why the chat is being attached (audit)",
        "type": "string"
      }
    },
    "required": [
      "nameOrKey"
    ],
    "type": "object"
  }
  """#

  public static let SessionsDeleteInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsDetachInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "chat": {
        "description": "Canonical chat id (or platform/normalized id)",
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
  }
  """#

  public static let SessionsExecuteInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsExtendInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsGoalInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "action": {
        "description": "get|set|create|pause|resume|complete|clear|account",
        "type": "string"
      },
      "budget": {
        "description": "Positive token budget for set/create",
        "type": "string"
      },
      "nameOrKey": {
        "description": "Session name or key",
        "type": "string"
      },
      "objective": {
        "description": "Goal objective for set/create",
        "type": "string"
      },
      "project": {
        "description": "Optional project id link for set/create",
        "type": "string"
      },
      "seconds": {
        "description": "Elapsed seconds delta for account",
        "type": "string"
      },
      "task": {
        "description": "Optional task id link for set/create",
        "type": "string"
      },
      "tokens": {
        "description": "Token delta for account",
        "type": "string"
      }
    },
    "required": [
      "action",
      "nameOrKey"
    ],
    "type": "object"
  }
  """#

  public static let SessionsInfoInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsInformInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsKeepInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Filter by agent ID",
        "type": "string"
      },
      "ephemeral": {
        "description": "Show only ephemeral sessions",
        "type": "boolean"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "live": {
        "description": "Include live runtime state snapshot",
        "type": "boolean"
      },
      "offset": {
        "description": "Number of matching sessions to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical session tag slug",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SessionsPruneInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Filter by agent ID",
        "type": "string"
      },
      "ephemeral": {
        "description": "Only match ephemeral sessions",
        "type": "boolean"
      },
      "execute": {
        "description": "Actually delete matching sessions; default is dry-run",
        "type": "boolean"
      },
      "inactiveFor": {
        "description": "Only match sessions inactive for this duration",
        "type": "string"
      },
      "namePrefix": {
        "description": "Only match sessions whose name or key starts with prefix",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SessionsReadInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsRenameInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsResetInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsRuntimeFollowUpInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsRuntimeForkInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsRuntimeInterruptInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsRuntimeListInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsRuntimeReadInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsRuntimeRollbackInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsRuntimeSteerInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsSendInputSchema = #"""
  {
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
      "thread": {
        "description": "Attach or auto-create a Ravi thread",
        "type": "string"
      },
      "threadOwner": {
        "description": "Owner for thread auto-create",
        "type": "string"
      },
      "threadScope": {
        "description": "Scope for thread lookup/create",
        "type": "string"
      },
      "threadSummary": {
        "description": "Initial summary when --thread auto-creates",
        "type": "string"
      },
      "threadTitle": {
        "description": "Title required when --thread auto-creates",
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
  }
  """#

  public static let SessionsSetDisplayInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsSetModelInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsSetThinkingInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsSetTtlInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsSubscriptionsInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsTraceInputSchema = #"""
  {
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
  }
  """#

  public static let SessionsVisibilityInputSchema = #"""
  {
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
  }
  """#

  public static let SettingsDeleteInputSchema = #"""
  {
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
  }
  """#

  public static let SettingsGetInputSchema = #"""
  {
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
  }
  """#

  public static let SettingsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "legacy": {
        "description": "Show legacy account.* settings shadowed by instances",
        "type": "boolean"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching settings to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SettingsSetInputSchema = #"""
  {
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
  }
  """#

  public static let SkillGatesDisableInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let SkillGatesEnableInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let SkillGatesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching skill gate rules to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical skill gate rule tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SkillGatesResetInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let SkillGatesRmInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let SkillGatesSetInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "command": {
        "description": "Exact shell command",
        "type": "string"
      },
      "commandPrefix": {
        "description": "Shell command prefix",
        "type": "string"
      },
      "commandRegex": {
        "description": "Regex against shell command text",
        "type": "string"
      },
      "groupRegex": {
        "description": "Alias for --pattern",
        "type": "string"
      },
      "id": {
        "description": "Rule id. Use a default id to override it, or a new id for a custom rule.",
        "type": "string"
      },
      "pattern": {
        "description": "Regex against normalized Ravi group/tool names",
        "type": "string"
      },
      "skill": {
        "description": "Skill name loaded by this gate",
        "type": "string"
      },
      "tool": {
        "description": "Exact runtime tool name",
        "type": "string"
      },
      "toolPrefix": {
        "description": "Runtime tool name prefix",
        "type": "string"
      },
      "toolRegex": {
        "description": "Regex against runtime tool names",
        "type": "string"
      }
    },
    "required": [
      "id",
      "skill"
    ],
    "type": "object"
  }
  """#

  public static let SkillGatesShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let SkillsInstallInputSchema = #"""
  {
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
  }
  """#

  public static let SkillsListInputSchema = #"""
  {
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
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching skills to skip (default: 0)",
        "type": "string"
      },
      "source": {
        "description": "List skills available in a GitHub URL, git URL or local path",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical skill tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SkillsShowInputSchema = #"""
  {
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
  }
  """#

  public static let SkillsSyncInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let SpecsGetInputSchema = #"""
  {
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
  }
  """#

  public static let SpecsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "domain": {
        "description": "Filter by domain",
        "type": "string"
      },
      "kind": {
        "description": "Filter by kind: domain|capability|feature",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching specs to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let SpecsNewInputSchema = #"""
  {
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
  }
  """#

  public static let SpecsSyncInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let StickersAddInputSchema = #"""
  {
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
  }
  """#

  public static let StickersListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching stickers to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let StickersRemoveInputSchema = #"""
  {
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
  }
  """#

  public static let StickersSendInputSchema = #"""
  {
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
  }
  """#

  public static let StickersShowInputSchema = #"""
  {
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
  }
  """#

  public static let TagRulesEvaluateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "apply": {
        "description": "Actually apply tag changes (default: dry-run)",
        "type": "boolean"
      },
      "file": {
        "description": "Load rule from a file path instead of the registry",
        "type": "string"
      },
      "ruleId": {
        "description": "Rule id to evaluate",
        "type": "string"
      },
      "target": {
        "description": "Target (e.g. contact:<id>)",
        "type": "string"
      }
    },
    "required": [
      "ruleId"
    ],
    "type": "object"
  }
  """#

  public static let TagRulesExplainInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "target": {
        "description": "Target (e.g. contact:<id>)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TagRulesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50)",
        "type": "string"
      },
      "offset": {
        "description": "Number of rules to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TagRulesShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "id": {
        "description": "Rule id",
        "type": "string"
      }
    },
    "required": [
      "id"
    ],
    "type": "object"
  }
  """#

  public static let TagRulesTickInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "apply": {
        "description": "Apply tag changes (default: dry-run)",
        "type": "boolean"
      },
      "limit": {
        "description": "Limit number of contacts processed",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TagRulesValidateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let TagsAttachInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Target agent id",
        "type": "string"
      },
      "artifact": {
        "description": "Target artifact id",
        "type": "string"
      },
      "callProfile": {
        "description": "Target prox call profile id",
        "type": "string"
      },
      "callRequest": {
        "description": "Target prox call request id",
        "type": "string"
      },
      "callTool": {
        "description": "Target prox call tool id",
        "type": "string"
      },
      "callVoiceAgent": {
        "description": "Target prox call voice agent id",
        "type": "string"
      },
      "chat": {
        "description": "Target canonical chat id",
        "type": "string"
      },
      "command": {
        "description": "Target Ravi command id",
        "type": "string"
      },
      "contact": {
        "description": "Target contact id",
        "type": "string"
      },
      "cronJob": {
        "description": "Target cron job id",
        "type": "string"
      },
      "devinSession": {
        "description": "Target Devin session id",
        "type": "string"
      },
      "hook": {
        "description": "Target hook id",
        "type": "string"
      },
      "insight": {
        "description": "Target insight id",
        "type": "string"
      },
      "instance": {
        "description": "Target Ravi channel instance name",
        "type": "string"
      },
      "meta": {
        "description": "Free JSON metadata for this binding",
        "type": "string"
      },
      "profile": {
        "description": "Target task profile id",
        "type": "string"
      },
      "project": {
        "description": "Target project id",
        "type": "string"
      },
      "route": {
        "description": "Target route id",
        "type": "string"
      },
      "session": {
        "description": "Target session name",
        "type": "string"
      },
      "skill": {
        "description": "Target skill name",
        "type": "string"
      },
      "skillGateRule": {
        "description": "Target skill gate rule id",
        "type": "string"
      },
      "slug": {
        "description": "Tag slug",
        "type": "string"
      },
      "source": {
        "description": "Binding provenance source",
        "type": "string"
      },
      "target": {
        "description": "Generic target selector, e.g. task:task-123 or workflow_run:wfr-123",
        "type": "string"
      },
      "task": {
        "description": "Target task id",
        "type": "string"
      },
      "taskAutomation": {
        "description": "Target task automation id",
        "type": "string"
      },
      "trigger": {
        "description": "Target trigger id",
        "type": "string"
      },
      "workflowNode": {
        "description": "Target workflow node id",
        "type": "string"
      },
      "workflowRun": {
        "description": "Target workflow run id",
        "type": "string"
      },
      "workflowSpec": {
        "description": "Target workflow spec id",
        "type": "string"
      }
    },
    "required": [
      "slug"
    ],
    "type": "object"
  }
  """#

  public static let TagsCreateInputSchema = #"""
  {
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
      },
      "source": {
        "description": "Tag definition provenance source",
        "type": "string"
      }
    },
    "required": [
      "slug"
    ],
    "type": "object"
  }
  """#

  public static let TagsDetachInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Target agent id",
        "type": "string"
      },
      "artifact": {
        "description": "Target artifact id",
        "type": "string"
      },
      "callProfile": {
        "description": "Target prox call profile id",
        "type": "string"
      },
      "callRequest": {
        "description": "Target prox call request id",
        "type": "string"
      },
      "callTool": {
        "description": "Target prox call tool id",
        "type": "string"
      },
      "callVoiceAgent": {
        "description": "Target prox call voice agent id",
        "type": "string"
      },
      "chat": {
        "description": "Target canonical chat id",
        "type": "string"
      },
      "command": {
        "description": "Target Ravi command id",
        "type": "string"
      },
      "contact": {
        "description": "Target contact id",
        "type": "string"
      },
      "cronJob": {
        "description": "Target cron job id",
        "type": "string"
      },
      "devinSession": {
        "description": "Target Devin session id",
        "type": "string"
      },
      "hook": {
        "description": "Target hook id",
        "type": "string"
      },
      "insight": {
        "description": "Target insight id",
        "type": "string"
      },
      "instance": {
        "description": "Target Ravi channel instance name",
        "type": "string"
      },
      "profile": {
        "description": "Target task profile id",
        "type": "string"
      },
      "project": {
        "description": "Target project id",
        "type": "string"
      },
      "route": {
        "description": "Target route id",
        "type": "string"
      },
      "session": {
        "description": "Target session name",
        "type": "string"
      },
      "skill": {
        "description": "Target skill name",
        "type": "string"
      },
      "skillGateRule": {
        "description": "Target skill gate rule id",
        "type": "string"
      },
      "slug": {
        "description": "Tag slug",
        "type": "string"
      },
      "source": {
        "description": "Detach audit/provenance source",
        "type": "string"
      },
      "target": {
        "description": "Generic target selector, e.g. task:task-123 or workflow_run:wfr-123",
        "type": "string"
      },
      "task": {
        "description": "Target task id",
        "type": "string"
      },
      "taskAutomation": {
        "description": "Target task automation id",
        "type": "string"
      },
      "trigger": {
        "description": "Target trigger id",
        "type": "string"
      },
      "workflowNode": {
        "description": "Target workflow node id",
        "type": "string"
      },
      "workflowRun": {
        "description": "Target workflow run id",
        "type": "string"
      },
      "workflowSpec": {
        "description": "Target workflow spec id",
        "type": "string"
      }
    },
    "required": [
      "slug"
    ],
    "type": "object"
  }
  """#

  public static let TagsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "cursor": {
        "description": "Opaque cursor returned by the previous page",
        "type": "string"
      },
      "kind": {
        "description": "Filter by kind: system|user",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 30, max: 500)",
        "type": "string"
      },
      "order": {
        "description": "Sort direction: asc|desc",
        "type": "string"
      },
      "query": {
        "description": "Search slug, label, or description",
        "type": "string"
      },
      "sort": {
        "description": "Sort field: updated|created",
        "type": "string"
      },
      "source": {
        "description": "Filter by provenance source",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TagsSearchInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "agent": {
        "description": "Filter by agent id",
        "type": "string"
      },
      "artifact": {
        "description": "Filter by artifact id",
        "type": "string"
      },
      "callProfile": {
        "description": "Filter by prox call profile id",
        "type": "string"
      },
      "callRequest": {
        "description": "Filter by prox call request id",
        "type": "string"
      },
      "callTool": {
        "description": "Filter by prox call tool id",
        "type": "string"
      },
      "callVoiceAgent": {
        "description": "Filter by prox call voice agent id",
        "type": "string"
      },
      "chat": {
        "description": "Filter by canonical chat id",
        "type": "string"
      },
      "command": {
        "description": "Filter by Ravi command id",
        "type": "string"
      },
      "contact": {
        "description": "Filter by contact id",
        "type": "string"
      },
      "cronJob": {
        "description": "Filter by cron job id",
        "type": "string"
      },
      "cursor": {
        "description": "Opaque cursor returned by the previous page",
        "type": "string"
      },
      "devinSession": {
        "description": "Filter by Devin session id",
        "type": "string"
      },
      "hook": {
        "description": "Filter by hook id",
        "type": "string"
      },
      "insight": {
        "description": "Filter by insight id",
        "type": "string"
      },
      "instance": {
        "description": "Filter by Ravi channel instance name",
        "type": "string"
      },
      "kind": {
        "description": "Filter by tag kind: system|user",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 30, max: 500)",
        "type": "string"
      },
      "order": {
        "description": "Sort direction: asc|desc",
        "type": "string"
      },
      "profile": {
        "description": "Filter by task profile id",
        "type": "string"
      },
      "project": {
        "description": "Filter by project id",
        "type": "string"
      },
      "route": {
        "description": "Filter by route id",
        "type": "string"
      },
      "session": {
        "description": "Filter by session name",
        "type": "string"
      },
      "skill": {
        "description": "Filter by skill name",
        "type": "string"
      },
      "skillGateRule": {
        "description": "Filter by skill gate rule id",
        "type": "string"
      },
      "sort": {
        "description": "Sort field: updated|created",
        "type": "string"
      },
      "source": {
        "description": "Filter by binding provenance source",
        "type": "string"
      },
      "tag": {
        "description": "Filter by tag slug",
        "type": "string"
      },
      "target": {
        "description": "Generic target selector, e.g. task:task-123 or workflow_run:wfr-123",
        "type": "string"
      },
      "task": {
        "description": "Filter by task id",
        "type": "string"
      },
      "taskAutomation": {
        "description": "Filter by task automation id",
        "type": "string"
      },
      "trigger": {
        "description": "Filter by trigger id",
        "type": "string"
      },
      "workflowNode": {
        "description": "Filter by workflow node id",
        "type": "string"
      },
      "workflowRun": {
        "description": "Filter by workflow run id",
        "type": "string"
      },
      "workflowSpec": {
        "description": "Filter by workflow spec id",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TagsSetInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "key": {
        "description": "Property: label, description, kind, source, metadata",
        "type": "string"
      },
      "slug": {
        "description": "Tag slug",
        "type": "string"
      },
      "value": {
        "description": "Property value",
        "type": "string"
      }
    },
    "required": [
      "key",
      "slug",
      "value"
    ],
    "type": "object"
  }
  """#

  public static let TagsShowInputSchema = #"""
  {
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
  }
  """#

  public static let TasksArchiveInputSchema = #"""
  {
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
  }
  """#

  public static let TasksAutomationsAddInputSchema = #"""
  {
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
  }
  """#

  public static let TasksAutomationsDisableInputSchema = #"""
  {
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
  }
  """#

  public static let TasksAutomationsEnableInputSchema = #"""
  {
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
  }
  """#

  public static let TasksAutomationsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching automations to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical task automation tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TasksAutomationsRmInputSchema = #"""
  {
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
  }
  """#

  public static let TasksAutomationsShowInputSchema = #"""
  {
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
  }
  """#

  public static let TasksBlockInputSchema = #"""
  {
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
  }
  """#

  public static let TasksCommentInputSchema = #"""
  {
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
  }
  """#

  public static let TasksCreateInputSchema = #"""
  {
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
      "tag": {
        "description": "Attach canonical task tags; repeat or pass comma-separated slugs",
        "items": {
          "type": "string"
        },
        "type": "array"
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
  }
  """#

  public static let TasksDepsAddInputSchema = #"""
  {
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
  }
  """#

  public static let TasksDepsLsInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching dependency edges to skip (default: 0)",
        "type": "string"
      },
      "taskId": {
        "description": "Task id to inspect",
        "type": "string"
      }
    },
    "required": [
      "taskId"
    ],
    "type": "object"
  }
  """#

  public static let TasksDepsRmInputSchema = #"""
  {
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
  }
  """#

  public static let TasksDispatchInputSchema = #"""
  {
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
  }
  """#

  public static let TasksDoneInputSchema = #"""
  {
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
  }
  """#

  public static let TasksFailInputSchema = #"""
  {
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
  }
  """#

  public static let TasksListInputSchema = #"""
  {
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
      "allTime": {
        "description": "Disable the default 1d updated_at window",
        "type": "boolean"
      },
      "archived": {
        "description": "List only archived tasks",
        "type": "boolean"
      },
      "cursor": {
        "description": "Opaque cursor returned by the previous page",
        "type": "string"
      },
      "last": {
        "description": "Number of newest tasks to show by default (default: 30; use 0 or \"all\" to disable)",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 30, max: 500)",
        "type": "string"
      },
      "mine": {
        "description": "Filter by current agent/session context",
        "type": "boolean"
      },
      "order": {
        "description": "Sort direction: asc|desc",
        "type": "string"
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
      "since": {
        "description": "Lower updated_at bound: 1d, epoch ms, or ISO datetime",
        "type": "string"
      },
      "sort": {
        "description": "Sort field: updated|created",
        "type": "string"
      },
      "status": {
        "description": "Filter by status",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical task tag",
        "type": "string"
      },
      "text": {
        "description": "Free-text match across id, title, instructions, summary, blocker, profile, agent and session",
        "type": "string"
      },
      "until": {
        "description": "Upper updated_at bound: 1d, epoch ms, or ISO datetime",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TasksProfilesInitInputSchema = #"""
  {
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
  }
  """#

  public static let TasksProfilesListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching profiles to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TasksProfilesPreviewInputSchema = #"""
  {
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
  }
  """#

  public static let TasksProfilesShowInputSchema = #"""
  {
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
  }
  """#

  public static let TasksProfilesValidateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "profileId": {
        "description": "Optional task profile id",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TasksReportInputSchema = #"""
  {
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
  }
  """#

  public static let TasksShowInputSchema = #"""
  {
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
  }
  """#

  public static let TasksUnarchiveInputSchema = #"""
  {
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
  }
  """#

  public static let ThreadsBriefInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "scope": {
        "description": "Scope when resolving a slug",
        "type": "string"
      },
      "thread": {
        "description": "Thread id or slug",
        "type": "string"
      }
    },
    "required": [
      "thread"
    ],
    "type": "object"
  }
  """#

  public static let ThreadsCloseInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "reason": {
        "description": "Closure reason",
        "type": "string"
      },
      "scope": {
        "description": "Scope when resolving a slug",
        "type": "string"
      },
      "thread": {
        "description": "Thread id or slug",
        "type": "string"
      }
    },
    "required": [
      "thread"
    ],
    "type": "object"
  }
  """#

  public static let ThreadsCommentInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "body": {
        "description": "Comment body",
        "type": "string"
      },
      "scope": {
        "description": "Scope when resolving a slug",
        "type": "string"
      },
      "thread": {
        "description": "Thread id or slug",
        "type": "string"
      },
      "visibility": {
        "description": "default|internal|private|restricted",
        "type": "string"
      }
    },
    "required": [
      "body",
      "thread"
    ],
    "type": "object"
  }
  """#

  public static let ThreadsCreateInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "defaultAgent": {
        "description": "Default agent id",
        "type": "string"
      },
      "owner": {
        "description": "Owner pointer",
        "type": "string"
      },
      "scope": {
        "description": "Scope pointer, e.g. chat:<id> or session:<key>",
        "type": "string"
      },
      "slug": {
        "description": "Thread slug",
        "type": "string"
      },
      "status": {
        "description": "Initial status",
        "type": "string"
      },
      "summary": {
        "description": "Initial thread summary",
        "type": "string"
      },
      "title": {
        "description": "Thread title",
        "type": "string"
      }
    },
    "required": [
      "slug"
    ],
    "type": "object"
  }
  """#

  public static let ThreadsEntriesInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size",
        "type": "string"
      },
      "offset": {
        "description": "Page offset",
        "type": "string"
      },
      "scope": {
        "description": "Scope when resolving a slug",
        "type": "string"
      },
      "thread": {
        "description": "Thread id or slug",
        "type": "string"
      }
    },
    "required": [
      "thread"
    ],
    "type": "object"
  }
  """#

  public static let ThreadsLinkInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "label": {
        "description": "Display label",
        "type": "string"
      },
      "role": {
        "description": "Link role",
        "type": "string"
      },
      "scope": {
        "description": "Scope when resolving a slug",
        "type": "string"
      },
      "target": {
        "description": "Target pointer, e.g. chat:<id>",
        "type": "string"
      },
      "thread": {
        "description": "Thread id or slug",
        "type": "string"
      },
      "visibility": {
        "description": "default|internal|private|restricted",
        "type": "string"
      }
    },
    "required": [
      "target",
      "thread"
    ],
    "type": "object"
  }
  """#

  public static let ThreadsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size",
        "type": "string"
      },
      "offset": {
        "description": "Page offset",
        "type": "string"
      },
      "owner": {
        "description": "Filter by owner",
        "type": "string"
      },
      "scope": {
        "description": "Filter by scope",
        "type": "string"
      },
      "search": {
        "description": "Search title, slug, or summary",
        "type": "string"
      },
      "status": {
        "description": "Filter by status",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ThreadsNoteInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "body": {
        "description": "Note body",
        "type": "string"
      },
      "scope": {
        "description": "Scope when resolving a slug",
        "type": "string"
      },
      "thread": {
        "description": "Thread id or slug",
        "type": "string"
      },
      "visibility": {
        "description": "default|internal|private|restricted",
        "type": "string"
      }
    },
    "required": [
      "body",
      "thread"
    ],
    "type": "object"
  }
  """#

  public static let ThreadsShowInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "entries": {
        "description": "Number of entries to include",
        "type": "string"
      },
      "scope": {
        "description": "Scope when resolving a slug",
        "type": "string"
      },
      "thread": {
        "description": "Thread id or slug",
        "type": "string"
      }
    },
    "required": [
      "thread"
    ],
    "type": "object"
  }
  """#

  public static let ToolsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching tools to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let ToolsManifestInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ToolsSchemaInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  }
  """#

  public static let ToolsShowInputSchema = #"""
  {
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
  }
  """#

  public static let ToolsTestInputSchema = #"""
  {
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
  }
  """#

  public static let TranscribeFileInputSchema = #"""
  {
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
  }
  """#

  public static let TriggersAddInputSchema = #"""
  {
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
  }
  """#

  public static let TriggersDisableInputSchema = #"""
  {
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
  }
  """#

  public static let TriggersEnableInputSchema = #"""
  {
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
  }
  """#

  public static let TriggersListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching triggers to skip (default: 0)",
        "type": "string"
      },
      "tag": {
        "description": "Filter by canonical trigger tag",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let TriggersRmInputSchema = #"""
  {
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
  }
  """#

  public static let TriggersSetInputSchema = #"""
  {
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
  }
  """#

  public static let TriggersShowInputSchema = #"""
  {
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
  }
  """#

  public static let TriggersTestInputSchema = #"""
  {
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
  }
  """#

  public static let VideoAnalyzeInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappDmAckInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "WhatsApp account ID",
        "type": "string"
      },
      "contact": {
        "description": "Contact ID, phone, or WhatsApp identity",
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
  }
  """#

  public static let WhatsappDmReadInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "WhatsApp account ID",
        "type": "string"
      },
      "contact": {
        "description": "Contact ID, phone, or WhatsApp identity",
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
  }
  """#

  public static let WhatsappDmSendInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "WhatsApp account ID",
        "type": "string"
      },
      "contact": {
        "description": "Contact ID, phone, or WhatsApp identity",
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
  }
  """#

  public static let WhatsappGroupAddInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupCreateInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupDemoteInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupDescriptionInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupInfoInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupInviteInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupJoinInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupLeaveInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "account": {
        "description": "WhatsApp account ID",
        "type": "string"
      },
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching groups to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let WhatsappGroupPromoteInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupRemoveInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupRenameInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupRevokeInviteInputSchema = #"""
  {
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
  }
  """#

  public static let WhatsappGroupSettingsInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsRunsArchiveNodeInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsRunsCancelInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsRunsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching workflow runs to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let WorkflowsRunsReleaseInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsRunsShowInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsRunsSkipInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsRunsStartInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsRunsTaskAttachInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsRunsTaskCreateInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsSpecsCreateInputSchema = #"""
  {
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
  }
  """#

  public static let WorkflowsSpecsListInputSchema = #"""
  {
    "additionalProperties": false,
    "properties": {
      "limit": {
        "description": "Page size (default: 50, max: 500)",
        "type": "string"
      },
      "offset": {
        "description": "Number of matching workflow specs to skip (default: 0)",
        "type": "string"
      }
    },
    "type": "object"
  }
  """#

  public static let WorkflowsSpecsShowInputSchema = #"""
  {
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
  }
  """#
}
