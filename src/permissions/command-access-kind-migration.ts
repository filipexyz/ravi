export interface CliReadToMutateMigration {
  resource: string;
  action: string;
}

/**
 * Operations reclassified from read to mutate by the agent-first CLI work.
 *
 * This is migration data, not a policy language. Keep it in sync with the
 * authorization gate in command-access-kind.test.ts.
 */
export const CLI_READ_TO_MUTATE_MIGRATIONS: readonly CliReadToMutateMigration[] = [
  { resource: "agents", action: "debounce" },
  { resource: "agents", action: "spec-mode" },
  { resource: "artifacts", action: "snapshot" },
  { resource: "artifacts", action: "event" },
  { resource: "channels", action: "probe" },
  { resource: "chats.lists", action: "delta" },
  { resource: "contacts", action: "note" },
  { resource: "costs", action: "pricing" },
  { resource: "context", action: "authorize" },
  { resource: "context", action: "issue" },
  { resource: "crm.opportunity", action: "move" },
  { resource: "crm.fact", action: "propose" },
  { resource: "crm.fact", action: "confirm" },
  { resource: "crm.task", action: "snooze" },
  { resource: "daemon", action: "uninstall" },
  { resource: "daemon", action: "env" },
  { resource: "daemon", action: "logs" },
  { resource: "db", action: "locks" },
  { resource: "devin.sessions", action: "list" },
  { resource: "devin.sessions", action: "show" },
  { resource: "devin.sessions", action: "messages" },
  { resource: "devin.sessions", action: "attachments" },
  { resource: "devin.sessions", action: "insights" },
  { resource: "devin.sessions", action: "terminate" },
  { resource: "hooks", action: "test" },
  { resource: "image.atlas", action: "split" },
  { resource: "inbox", action: "snooze" },
  { resource: "instances", action: "disconnect" },
  { resource: "pages", action: "visibility" },
  { resource: "pages", action: "domains" },
  { resource: "prox.calls", action: "request" },
  { resource: "prox.calls", action: "transcript" },
  { resource: "prox.calls.profiles", action: "configure" },
  { resource: "prox.calls.voice-agents", action: "configure" },
  { resource: "prox.calls.voice-agents", action: "bind-tool" },
  { resource: "prox.calls.voice-agents", action: "unbind-tool" },
  { resource: "prox.calls.tools", action: "configure" },
  { resource: "prox.calls.tools", action: "bind" },
  { resource: "prox.calls.tools", action: "unbind" },
  { resource: "runtime.credentials", action: "classify" },
  { resource: "sdk.openapi", action: "emit" },
  { resource: "sessions", action: "goal" },
  { resource: "sessions", action: "extend" },
  { resource: "sessions", action: "keep" },
  { resource: "sessions", action: "ask" },
  { resource: "sessions", action: "answer" },
  { resource: "sessions", action: "inform" },
  { resource: "sessions.followups", action: "snooze" },
  { resource: "sessions.runtime", action: "steer" },
  { resource: "sessions.runtime", action: "follow-up" },
  { resource: "sessions.runtime", action: "interrupt" },
  { resource: "sessions.runtime", action: "rollback" },
  { resource: "sessions.runtime", action: "fork" },
  { resource: "threads", action: "note" },
  { resource: "threads", action: "close" },
  { resource: "transcribe", action: "file" },
  { resource: "specs", action: "new" },
  { resource: "tag-rules", action: "tick" },
  { resource: "tag-rules", action: "evaluate" },
  { resource: "metrics", action: "rollup" },
  { resource: "triggers", action: "test" },
  { resource: "video", action: "analyze" },
  { resource: "whatsapp.group", action: "join" },
  { resource: "whatsapp.group", action: "leave" },
  { resource: "whatsapp.group", action: "description" },
  { resource: "whatsapp.group", action: "settings" },
  { resource: "workflows.runs", action: "release" },
  { resource: "workflows.runs", action: "skip" },
] as const;

interface NormalizedCapability {
  permission: string;
  objectType: string;
  objectId: string;
  shape: "string" | "object";
  raw: unknown;
}

export interface CapabilityInputMigrationResult {
  capabilities: unknown[];
  changed: boolean;
  added: number;
  ambiguous: number;
}

export interface AgentDefaultsMigrationResult extends Omit<CapabilityInputMigrationResult, "capabilities"> {
  defaults: Record<string, unknown>;
}

export interface PermissionTagMetadataMigrationResult extends Omit<CapabilityInputMigrationResult, "capabilities"> {
  metadata: Record<string, unknown>;
}

export interface SerializedCapabilityMigrationResult extends Omit<CapabilityInputMigrationResult, "capabilities"> {
  serialized: string;
  valid: boolean;
}

export function migrateLegacyReadCapabilityInputs(capabilities: readonly unknown[]): CapabilityInputMigrationResult {
  const originals = [...capabilities];
  const additions: unknown[] = [];
  const ambiguous = 0;

  for (const raw of originals) {
    const capability = normalizeCapability(raw);
    if (!capability || capability.permission !== "read") continue;

    const exact = CLI_READ_TO_MUTATE_MIGRATIONS.find((migration) => isExactLegacyGrant(capability, migration));
    if (exact) {
      if (!hasMutateCoverage([...originals, ...additions], exact)) {
        additions.push(buildMutateCounterpart(capability));
      }
      continue;
    }

    const wildcardMatches = CLI_READ_TO_MUTATE_MIGRATIONS.filter((migration) => wildcardCovers(capability, migration));
    for (const migration of wildcardMatches) {
      if (!hasMutateCoverage([...originals, ...additions], migration)) {
        additions.push(buildExactMutateCounterpart(capability, migration));
      }
    }
  }

  return {
    capabilities: additions.length > 0 ? [...originals, ...additions] : originals,
    changed: additions.length > 0,
    added: additions.length,
    ambiguous,
  };
}

export function migrateAgentDefaultsRecord(defaults: Record<string, unknown>): AgentDefaultsMigrationResult {
  const runtimePermissions = isRecord(defaults.runtimePermissions) ? defaults.runtimePermissions : null;
  if (!runtimePermissions || !Array.isArray(runtimePermissions.capabilities)) {
    return { defaults, changed: false, added: 0, ambiguous: 0 };
  }

  const migration = migrateLegacyReadCapabilityInputs(runtimePermissions.capabilities);
  if (!migration.changed) {
    return { defaults, changed: false, added: 0, ambiguous: migration.ambiguous };
  }

  return {
    defaults: {
      ...defaults,
      runtimePermissions: { ...runtimePermissions, capabilities: migration.capabilities },
    },
    changed: true,
    added: migration.added,
    ambiguous: migration.ambiguous,
  };
}

export function migratePermissionTagMetadata(metadata: Record<string, unknown>): PermissionTagMetadataMigrationResult {
  const permissions = isRecord(metadata.permissions) ? metadata.permissions : null;
  const location =
    permissions && Array.isArray(permissions.capabilities)
      ? "permissions"
      : Array.isArray(metadata.capabilities)
        ? "capabilities"
        : Array.isArray(metadata.permissionCapabilities)
          ? "permissionCapabilities"
          : null;
  if (!location) return { metadata, changed: false, added: 0, ambiguous: 0 };

  const values =
    location === "permissions" ? (permissions!.capabilities as unknown[]) : (metadata[location] as unknown[]);
  const migration = migrateLegacyReadCapabilityInputs(values);
  if (!migration.changed) {
    return { metadata, changed: false, added: 0, ambiguous: migration.ambiguous };
  }

  const migratedMetadata =
    location === "permissions"
      ? { ...metadata, permissions: { ...permissions!, capabilities: migration.capabilities } }
      : { ...metadata, [location]: migration.capabilities };
  return {
    metadata: migratedMetadata,
    changed: true,
    added: migration.added,
    ambiguous: migration.ambiguous,
  };
}

export function migrateSerializedCapabilityArray(raw: string): SerializedCapabilityMigrationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { serialized: raw, changed: false, added: 0, ambiguous: 0, valid: false };
  }
  if (!Array.isArray(parsed)) {
    return { serialized: raw, changed: false, added: 0, ambiguous: 0, valid: false };
  }

  const migration = migrateLegacyReadCapabilityInputs(parsed);
  return {
    serialized: migration.changed ? JSON.stringify(migration.capabilities) : raw,
    changed: migration.changed,
    added: migration.added,
    ambiguous: migration.ambiguous,
    valid: true,
  };
}

function normalizeCapability(raw: unknown): NormalizedCapability | null {
  if (typeof raw === "string") {
    const [permission, objectType, ...objectIdParts] = raw.split(":");
    const objectId = objectIdParts.join(":");
    if (!permission?.trim() || !objectType?.trim() || !objectId.trim()) return null;
    return {
      permission: permission.trim(),
      objectType: objectType.trim(),
      objectId: objectId.trim(),
      shape: "string",
      raw,
    };
  }

  if (!isRecord(raw)) return null;
  const permission = cleanString(raw.permission);
  const objectType = cleanString(raw.objectType);
  const objectId = cleanString(raw.objectId);
  if (!permission || !objectType || !objectId) return null;
  return { permission, objectType, objectId, shape: "object", raw };
}

function isExactLegacyGrant(capability: NormalizedCapability, migration: CliReadToMutateMigration): boolean {
  return (
    (capability.objectType === migration.resource && capability.objectId === migration.action) ||
    (capability.objectType === `${migration.resource}.${migration.action}` && capability.objectId === "*")
  );
}

function wildcardCovers(capability: NormalizedCapability, migration: CliReadToMutateMigration): boolean {
  if (capability.objectType !== migration.resource) return false;
  return wildcardMatches(capability.objectId, migration.action);
}

function hasMutateCoverage(capabilities: readonly unknown[], migration: CliReadToMutateMigration): boolean {
  return capabilities.some((raw) => {
    const capability = normalizeCapability(raw);
    if (!capability) return false;
    if (capability.permission === "admin" && capability.objectType === "system" && capability.objectId === "*") {
      return true;
    }
    if (capability.permission !== "mutate") return false;
    if (capability.objectType === migration.resource) {
      return capability.objectId === migration.action || wildcardMatches(capability.objectId, migration.action);
    }
    return capability.objectType === `${migration.resource}.${migration.action}` && capability.objectId === "*";
  });
}

function buildMutateCounterpart(capability: NormalizedCapability): unknown {
  if (capability.shape === "string") {
    return `mutate:${capability.objectType}:${capability.objectId}`;
  }
  return { ...(capability.raw as Record<string, unknown>), permission: "mutate" };
}

function buildExactMutateCounterpart(capability: NormalizedCapability, migration: CliReadToMutateMigration): unknown {
  if (capability.shape === "string") {
    return `mutate:${migration.resource}:${migration.action}`;
  }
  return {
    ...(capability.raw as Record<string, unknown>),
    permission: "mutate",
    objectType: migration.resource,
    objectId: migration.action,
  };
}

function wildcardMatches(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return false;
  if (!pattern.endsWith("*")) return false;
  return value.startsWith(pattern.slice(0, -1));
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
