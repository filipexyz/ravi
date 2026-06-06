import type { ChannelContext } from "./message-types.js";
import { RAVI_CONTEXT_KEY_ENV, resolveRuntimeContext } from "./context-registry.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";

export interface RuntimeOperationalContextInput {
  agentId?: string | null;
  sessionName?: string | null;
  cwd?: string | null;
  ctx?: ChannelContext;
  runtimeContext?: Pick<
    ContextRecord,
    "contextId" | "kind" | "agentId" | "sessionKey" | "sessionName" | "source" | "capabilities"
  > | null;
}

const CAPABILITY_PREVIEW_LIMIT = 18;

export function buildRuntimeOperationalContextContent(input: RuntimeOperationalContextInput): string {
  const runtimeContext = input.runtimeContext ?? null;
  const agentId = input.agentId ?? runtimeContext?.agentId ?? "-";
  const sessionName = input.sessionName ?? runtimeContext?.sessionName ?? "-";
  const cwd = input.cwd ?? "-";
  const source = input.ctx
    ? formatChannelSource(input.ctx)
    : runtimeContext?.source
      ? formatRuntimeSource(runtimeContext.source)
      : "-";
  const capabilities = runtimeContext?.capabilities ?? [];

  return [
    `This is the live operational contract for the current Ravi runtime. The same section is exposed by \`ravi --help\` so agents and operators can debug the runtime surface from the CLI.`,
    ``,
    `## Current Runtime`,
    ``,
    `- agent: \`${agentId}\``,
    `- session: \`${sessionName}\``,
    `- cwd: \`${cwd}\``,
    `- source: ${source}`,
    `- context: ${runtimeContext ? `\`${runtimeContext.contextId}\` (${runtimeContext.kind})` : "direct CLI or unavailable"}`,
    ``,
    `## How To Inspect Yourself`,
    ``,
    `- \`ravi --help\` — print this operational contract and the root CLI surface.`,
    `- \`ravi self whoami --json\` — inspect current agent, session, chat and route identity.`,
    `- \`ravi self context --json\` — inspect the full bounded self-context packet.`,
    `- \`ravi self permissions --json\` — inspect the full inherited capabilities/tool permissions.`,
    `- \`ravi sessions trace ${sessionName !== "-" ? sessionName : "<session>"}\` — debug the runtime prompt, trace and recent turn history.`,
    `- \`ravi sessions actions --json\` — inspect conversation actions available in this session.`,
    ``,
    `## Permissions Snapshot`,
    ``,
    ...formatCapabilities(capabilities),
    ``,
    `## Operating Rules`,
    ``,
    `- Prefer command-specific \`--help\` before using an unfamiliar command.`,
    `- Use \`--json\` only after choosing the command and needing structured output.`,
    `- Treat \`--dry-run\` as the safe first path for risky or state-changing commands when available.`,
    `- Do not expose context keys, credentials, tokens or raw secret env values.`,
  ].join("\n");
}

export function buildRootOperationalHelp(env: NodeJS.ProcessEnv = process.env): string {
  const contextKey = env[RAVI_CONTEXT_KEY_ENV];
  const runtimeContext = contextKey ? resolveRuntimeContext(contextKey, { readOnly: true, touch: false }) : null;

  return [
    "",
    "Ravi Operational Context:",
    "",
    buildRuntimeOperationalContextContent({
      agentId: env.RAVI_AGENT_ID ?? runtimeContext?.agentId,
      sessionName: env.RAVI_SESSION_NAME ?? runtimeContext?.sessionName,
      cwd: env.PWD ?? process.cwd(),
      runtimeContext,
      ctx: buildChannelContextFromEnv(env),
    }),
  ].join("\n");
}

function buildChannelContextFromEnv(env: NodeJS.ProcessEnv): ChannelContext | undefined {
  const channelId = env.RAVI_CHANNEL?.trim();
  const chatId = env.RAVI_CHAT_ID?.trim();
  if (!channelId && !chatId) return undefined;

  return {
    channelId: channelId ?? "unknown",
    channelName: channelId ?? "CLI",
    isGroup: Boolean(chatId?.includes("@g.us") || chatId?.startsWith("group:")),
  };
}

function formatChannelSource(ctx: ChannelContext): string {
  const parts = [
    ctx.channelName || ctx.channelId,
    ctx.groupId ? `groupId=${ctx.groupId}` : null,
    ctx.groupName ? `group=${ctx.groupName}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `\`${parts.join(" | ")}\`` : "-";
}

function formatRuntimeSource(source: ContextRecord["source"]): string {
  if (!source) return "-";
  const parts = [
    source.channel,
    source.accountId ? `account=${source.accountId}` : null,
    source.chatId ? `chat=${source.chatId}` : null,
    source.threadId ? `thread=${source.threadId}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `\`${parts.join(" | ")}\`` : "-";
}

function formatCapabilities(capabilities: ContextCapability[]): string[] {
  if (capabilities.length === 0) {
    return [
      `- capabilities: none materialized in this context.`,
      `- full list: run \`ravi self permissions --json\` inside an agent runtime context.`,
    ];
  }

  const toolCaps = capabilities.filter((cap) => cap.objectType === "tool");
  const groupCaps = capabilities.filter((cap) => cap.objectType === "group");
  const preview = [
    ...toolCaps,
    ...groupCaps,
    ...capabilities.filter((cap) => cap.objectType !== "tool" && cap.objectType !== "group"),
  ]
    .slice(0, CAPABILITY_PREVIEW_LIMIT)
    .map(formatCapability);

  return [
    `- capabilities: ${capabilities.length}`,
    `- tool capabilities: ${toolCaps.length}`,
    `- command-group capabilities: ${groupCaps.length}`,
    `- preview:`,
    ...preview.map((capability) => `  - \`${capability}\``),
    ...(capabilities.length > preview.length
      ? [
          `  - ... ${capabilities.length - preview.length} more; run \`ravi self permissions --json\` for the full list.`,
        ]
      : [`- full list: run \`ravi self permissions --json\`.`]),
  ];
}

function formatCapability(capability: ContextCapability): string {
  const source = capability.source ? ` source=${capability.source}` : "";
  return `${capability.permission}:${capability.objectType}:${capability.objectId}${source}`;
}
