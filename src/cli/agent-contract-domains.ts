/**
 * Command roots that follow the agent contract for Commander's own usage
 * errors (spec cli, "Every migrated Commander root is registered"):
 * `src/cli/index.ts` installs `installUsageContract` on each of them, so an
 * unknown option, a missing argument, an unknown subcommand or a group run
 * without a subcommand exits 2 with the error envelope instead of plain text
 * with exit 1. A root covers its whole subtree (`mcp` covers `mcp calls` and
 * `mcp skills`).
 */
export const AGENT_CONTRACT_DOMAINS = [
  "decisions",
  "access",
  "agents",
  "artifacts",
  "audio",
  "bridges",
  "bridge",
  "bug",
  "calendars",
  "channels",
  "chats",
  "cloud",
  "commands",
  "connectors",
  "contacts",
  "context",
  "costs",
  "credentials",
  "crm",
  "cron",
  "devin",
  "feedback",
  "gmail",
  "heartbeat",
  "hooks",
  "identity",
  "image",
  "inbox",
  "insights",
  "instances",
  "invites",
  "knowledge",
  "mail",
  "mcp",
  "media",
  "meetings",
  "metrics",
  "observers",
  "pages",
  "pr",
  "projects",
  "prox",
  "react",
  "routes",
  "rules",
  "runtime",
  "self",
  "sessions",
  "settings",
  "skill-gates",
  "skills",
  "slack",
  "specs",
  "stickers",
  "sync",
  "tag-rules",
  "tags",
  "tasks",
  "themes",
  "threads",
  "transcribe",
  "triggers",
  "video",
  "watch",
  "whatsapp",
  "widgets",
  "work-objects",
  "workflows",
  "yt",
] as const;

/**
 * Registered roots not migrated yet: Commander's default behaviour (plain
 * text, exit 1) still applies to their usage errors. This list only shrinks.
 * A new root goes into AGENT_CONTRACT_DOMAINS, never here; the registry test
 * fails for a root that is in neither list.
 */
export const AGENT_CONTRACT_UNMIGRATED_ROOTS = [
  "adapters",
  "agenda",
  "apps",
  "bases",
  "daemon",
  "db",
  "eval",
  "events",
  "jobs",
  "permissions",
  "sandbox",
  "sdk",
  "service",
  "signals",
  "tools",
] as const;
