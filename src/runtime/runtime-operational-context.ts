import type { ChannelContext } from "./message-types.js";
import { RAVI_CONTEXT_KEY_ENV, resolveRuntimeContext } from "./context-registry.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";

export interface RuntimeOperationalContextInput {
  agentId?: string | null;
  agentSource?: "runtime-input" | "legacy-environment";
  sessionName?: string | null;
  sessionSource?: "runtime-input" | "legacy-environment";
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
  const agentId = runtimeContext?.agentId ?? input.agentId ?? "-";
  const agentSource = runtimeContext?.agentId
    ? "context-registry"
    : input.agentId
      ? (input.agentSource ?? "runtime-input")
      : "unavailable";
  const sessionName = runtimeContext?.sessionName ?? input.sessionName ?? "-";
  const sessionSource = runtimeContext?.sessionName
    ? "context-registry"
    : input.sessionName
      ? (input.sessionSource ?? "runtime-input")
      : "unavailable";
  const cwd = input.cwd ?? "-";
  const source = runtimeContext?.source ? formatRuntimeSource(runtimeContext.source) : "-";
  const invocationSource = input.ctx ? formatChannelSource(input.ctx) : "-";
  const capabilities = runtimeContext?.capabilities ?? [];

  return [
    `This is the live operational contract for the current Ravi runtime. The same section is exposed by \`ravi --help\` so agents and operators can debug the runtime surface from the CLI.`,
    ``,
    `## Current Runtime`,
    ``,
    `- agent: \`${agentId}\``,
    `- agent source: ${agentSource}`,
    `- session: \`${sessionName}\``,
    `- session source: ${sessionSource}`,
    `- cwd: \`${cwd}\``,
    `- context source: ${source}`,
    `- invocation source: ${invocationSource}`,
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
    ...formatCapabilities(capabilities, Boolean(runtimeContext)),
    ``,
    `## Operating Rules`,
    ``,
    `- Prefer command-specific \`--help\` before using an unfamiliar command.`,
    `- Use \`--json\` only after choosing the command and needing structured output.`,
    `- Treat \`--dry-run\` as the safe first path for risky or state-changing commands when available.`,
    `- Do not expose context keys, credentials, tokens or raw secret env values.`,
  ].join("\n");
}

export function buildRootOperationalHelp(
  env: NodeJS.ProcessEnv = process.env,
  resolvedContext?: RuntimeOperationalContextInput["runtimeContext"],
): string {
  const contextKey = env[RAVI_CONTEXT_KEY_ENV];
  const runtimeContext =
    resolvedContext === undefined
      ? contextKey
        ? resolveRuntimeContext(contextKey, { readOnly: true, touch: false })
        : null
      : (resolvedContext ?? null);

  return [
    "",
    "Ravi Operational Context:",
    "",
    buildRuntimeOperationalContextContent({
      cwd: process.cwd(),
      runtimeContext,
    }),
  ].join("\n");
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

function formatCapabilities(capabilities: ContextCapability[], contextResolved: boolean): string[] {
  if (!contextResolved) {
    return [
      `- capabilities: unavailable because no runtime context was resolved.`,
      `- resolution: run \`ravi context whoami --json\`, then \`ravi self permissions --json\`.`,
    ];
  }
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
