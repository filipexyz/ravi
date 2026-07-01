export interface PermissionProfileCapability {
  permission: string;
  objectType: string;
  objectId: string;
}

export interface BuiltinPermissionProfile {
  id: string;
  tagSlug: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high" | "destructive";
  defaultTtl: string;
  capabilities: PermissionProfileCapability[];
}

const BUILTIN_PERMISSION_PROFILES: BuiltinPermissionProfile[] = [
  {
    id: "image-generation",
    tagSlug: "permission-image-generation",
    label: "Image Generation",
    description: "Generate and edit images through Ravi image tools.",
    risk: "high",
    defaultTtl: "24h",
    capabilities: [
      { permission: "mutate", objectType: "image", objectId: "generate" },
      { permission: "use", objectType: "tool", objectId: "image_generate" },
    ],
  },
  {
    id: "web-publishing",
    tagSlug: "permission-web-publishing",
    label: "Web Publishing",
    description: "Publish web pages/artifacts and run the narrow post-publish HTTP checks.",
    risk: "high",
    defaultTtl: "24h",
    capabilities: [
      { permission: "read", objectType: "pages", objectId: "list" },
      { permission: "mutate", objectType: "pages", objectId: "create" },
      { permission: "mutate", objectType: "pages", objectId: "update" },
      { permission: "mutate", objectType: "pages", objectId: "publish" },
      { permission: "read", objectType: "artifacts", objectId: "show" },
      { permission: "read", objectType: "artifacts", objectId: "blob" },
      { permission: "mutate", objectType: "artifacts", objectId: "publish" },
      { permission: "execute", objectType: "executable", objectId: "curl" },
    ],
  },
  {
    id: "session-inspection",
    tagSlug: "permission-session-inspection",
    label: "Session Inspection",
    description: "Inspect Ravi self-context and session diagnostics without mutating sessions.",
    risk: "medium",
    defaultTtl: "24h",
    capabilities: [
      { permission: "read", objectType: "self", objectId: "*" },
      { permission: "read", objectType: "sessions", objectId: "info" },
      { permission: "read", objectType: "sessions", objectId: "list" },
      { permission: "read", objectType: "sessions", objectId: "trace" },
      { permission: "read", objectType: "sessions", objectId: "actions" },
    ],
  },
  {
    id: "repo-maintenance",
    tagSlug: "permission-repo-maintenance",
    label: "Repo Maintenance",
    description: "Operate local repository maintenance with narrow shell executable access.",
    risk: "high",
    defaultTtl: "8h",
    capabilities: [
      { permission: "execute", objectType: "executable", objectId: "bun" },
      { permission: "execute", objectType: "executable", objectId: "cat" },
      { permission: "execute", objectType: "executable", objectId: "find" },
      { permission: "execute", objectType: "executable", objectId: "git" },
      { permission: "execute", objectType: "executable", objectId: "head" },
      { permission: "execute", objectType: "executable", objectId: "ls" },
      { permission: "execute", objectType: "executable", objectId: "pwd" },
      { permission: "execute", objectType: "executable", objectId: "rg" },
      { permission: "execute", objectType: "executable", objectId: "sed" },
      { permission: "execute", objectType: "executable", objectId: "tail" },
      { permission: "execute", objectType: "executable", objectId: "wc" },
      { permission: "execute", objectType: "executable", objectId: "xargs" },
    ],
  },
  {
    id: "whatsapp-extension-runtime",
    tagSlug: "permission-whatsapp-extension-runtime",
    label: "WhatsApp Extension Runtime",
    description: "Operate the local WhatsApp overlay extension without daemon-wide bootstrap authority.",
    risk: "high",
    defaultTtl: "300d",
    capabilities: [
      { permission: "read", objectType: "self", objectId: "*" },
      { permission: "read", objectType: "context", objectId: "whoami" },
      { permission: "read", objectType: "context", objectId: "capabilities" },
      { permission: "read", objectType: "context", objectId: "visibility" },
      { permission: "read", objectType: "sessions", objectId: "list" },
      { permission: "read", objectType: "sessions", objectId: "info" },
      { permission: "read", objectType: "sessions", objectId: "read" },
      { permission: "read", objectType: "sessions", objectId: "trace" },
      { permission: "read", objectType: "sessions", objectId: "actions" },
      { permission: "mutate", objectType: "sessions", objectId: "send" },
      { permission: "mutate", objectType: "sessions", objectId: "reset" },
      { permission: "mutate", objectType: "sessions", objectId: "set-thinking" },
      { permission: "mutate", objectType: "sessions", objectId: "set-display" },
      { permission: "read", objectType: "sessions.runtime", objectId: "list" },
      { permission: "read", objectType: "sessions.runtime", objectId: "read" },
      { permission: "read", objectType: "sessions.runtime", objectId: "interrupt" },
      { permission: "access", objectType: "session", objectId: "*" },
      { permission: "modify", objectType: "session", objectId: "*" },
      { permission: "read", objectType: "agents", objectId: "list" },
      { permission: "read", objectType: "agents", objectId: "show" },
      { permission: "mutate", objectType: "agents", objectId: "set" },
      { permission: "view", objectType: "agent", objectId: "*" },
      { permission: "read", objectType: "tasks", objectId: "list" },
      { permission: "read", objectType: "tasks", objectId: "show" },
      { permission: "read", objectType: "tasks", objectId: "watch" },
      { permission: "mutate", objectType: "tasks", objectId: "dispatch" },
      { permission: "read", objectType: "artifacts", objectId: "list" },
      { permission: "read", objectType: "artifacts", objectId: "show" },
      { permission: "read", objectType: "artifacts", objectId: "blob" },
      { permission: "read", objectType: "insights", objectId: "list" },
      { permission: "read", objectType: "insights", objectId: "show" },
      { permission: "read", objectType: "insights", objectId: "search" },
      { permission: "read", objectType: "crm", objectId: "contacts" },
      { permission: "read", objectType: "crm", objectId: "next" },
      { permission: "read", objectType: "crm", objectId: "board" },
      { permission: "read", objectType: "crm", objectId: "contact" },
      { permission: "read", objectType: "crm", objectId: "account" },
      { permission: "read", objectType: "crm", objectId: "opportunity" },
      { permission: "read", objectType: "routes", objectId: "list" },
      { permission: "read", objectType: "routes", objectId: "show" },
      { permission: "read", objectType: "instances", objectId: "list" },
      { permission: "read", objectType: "instances", objectId: "show" },
      { permission: "read", objectType: "instances.routes", objectId: "list" },
      { permission: "read", objectType: "instances.routes", objectId: "show" },
      { permission: "mutate", objectType: "instances.routes", objectId: "add" },
      { permission: "mutate", objectType: "instances.routes", objectId: "set" },
      { permission: "read", objectType: "audio", objectId: "voices" },
      { permission: "read", objectType: "audio", objectId: "pending" },
      { permission: "read", objectType: "audio", objectId: "blob" },
      { permission: "mutate", objectType: "audio", objectId: "tts" },
      { permission: "mutate", objectType: "audio", objectId: "generate" },
      { permission: "view", objectType: "system", objectId: "events" },
      { permission: "view", objectType: "system", objectId: "tasks" },
      { permission: "view", objectType: "chat", objectId: "*" },
      { permission: "view", objectType: "instance", objectId: "*" },
    ],
  },
];

export function listBuiltinPermissionProfiles(): BuiltinPermissionProfile[] {
  return BUILTIN_PERMISSION_PROFILES.map(cloneProfile);
}

export function getBuiltinPermissionProfile(profileOrSlug: string | undefined | null): BuiltinPermissionProfile | null {
  const id = normalizePermissionProfileId(profileOrSlug);
  if (!id) return null;
  const profile = BUILTIN_PERMISSION_PROFILES.find((candidate) => candidate.id === id);
  return profile ? cloneProfile(profile) : null;
}

export function findBuiltinPermissionProfilesForCapability(
  capability: PermissionProfileCapability,
): BuiltinPermissionProfile[] {
  return BUILTIN_PERMISSION_PROFILES.filter((profile) =>
    profile.capabilities.some((candidate) => capabilityMatches(candidate, capability)),
  ).map(cloneProfile);
}

export function normalizePermissionProfileId(profileOrSlug: string | undefined | null): string | null {
  const normalized = profileOrSlug
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return null;
  if (normalized.startsWith("permission-")) return normalized.slice("permission-".length);
  if (normalized.startsWith("permission:")) return normalized.slice("permission:".length);
  return normalized;
}

function capabilityMatches(candidate: PermissionProfileCapability, requested: PermissionProfileCapability): boolean {
  if (candidate.permission !== requested.permission) return false;
  if (candidate.objectType !== requested.objectType) return false;
  return candidate.objectId === requested.objectId || candidate.objectId === "*";
}

function cloneProfile(profile: BuiltinPermissionProfile): BuiltinPermissionProfile {
  return {
    ...profile,
    capabilities: profile.capabilities.map((capability) => ({ ...capability })),
  };
}
