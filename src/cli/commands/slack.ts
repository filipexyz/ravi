/**
 * Slack Commands - native Slack operations through Ravi channel credentials.
 */

import "reflect-metadata";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import {
  buildSlackBlockKitShowcasePayload,
  normalizeSlackBlockKitMessagePayload,
  normalizeSlackBlockKitValidationPayload,
  parseSlackBlockKitJson,
} from "../../channels/slack/block-kit.js";
import {
  normalizeSlackNativeWorkObjectDetailMetadata,
  normalizeSlackNativeWorkObjectMessagePayload,
  normalizeSlackNativeWorkObjectMetadata,
  normalizeSlackNativeWorkObjectUnfurlPayload,
} from "../../channels/slack/work-objects.js";
import { respondToSlackInteraction } from "../../channels/slack/interactions.js";
import {
  SlackWebApiClient,
  type SlackCanvasAccessLevel,
  type SlackCanvasEditChange,
  type SlackCanvasEditOperation,
} from "../../channels/slack/client.js";
import { SlackSocketModeService } from "../../channels/slack/socket-mode.js";
import { buildSlackTopology } from "../../channels/slack/topology.js";
import type { SlackSocketEnvelope } from "../../channels/slack/types.js";
import { configStore } from "../../config-store.js";
import { getContact } from "../../contacts.js";
import { resolveSlackCredentialConfigFromEnv, type SlackCredentialConfig } from "../../channels/slack/credentials.js";
import { dbFindChat, dbFindChatMessage, type ChannelConfig } from "../../router/router-db.js";
import {
  appendArtifactEvent,
  attachArtifact,
  createArtifact,
  createArtifactVersion,
  getArtifactDetails,
  getArtifactVersion,
  inspectArtifactPublishStateReadOnly,
  listArtifacts,
  updateArtifact,
  type ArtifactRecord,
  type ArtifactVersion,
} from "../../artifacts/store.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { contractDryRun, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { fail, getContext } from "../context.js";
import { jsonObjectSchema, jsonValueSchema } from "../return-schemas.js";

const slackPaginationReturnSchema = z
  .object({
    limit: z.number(),
    cursor: z.string().nullable(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

const slackListReturnSchema = z
  .object({
    ok: z.boolean(),
    provider: z.literal("slack"),
    connection: z.string(),
    source: z.string(),
    items: z.array(jsonValueSchema),
    pagination: slackPaginationReturnSchema,
    raw: jsonObjectSchema.optional(),
  })
  .strict();

const slackObjectReturnSchema = z
  .object({
    ok: z.boolean(),
    provider: z.literal("slack"),
    connection: z.string(),
    source: z.string(),
    item: jsonValueSchema.optional(),
    raw: jsonObjectSchema.optional(),
  })
  .strict();

const slackMutationReturnSchema = z
  .object({
    ok: z.boolean(),
    provider: z.literal("slack"),
    connection: z.string(),
    source: z.string(),
    dryRun: z.boolean(),
    method: z.string(),
    request: jsonObjectSchema,
    item: jsonValueSchema.optional(),
    raw: jsonObjectSchema.optional(),
  })
  .strict();

const slackTopologyReturnSchema = z
  .object({
    ok: z.literal(true),
    provider: z.literal("slack"),
    connection: z.string(),
    source: z.string(),
    accountId: z.string(),
    channels: z.array(jsonValueSchema),
    ungroupedChannelIds: z.array(z.string()),
    capabilities: jsonObjectSchema,
  })
  .strict();

const slackCanvasArtifactStatusReturnSchema = z
  .object({
    ok: z.literal(true),
    provider: z.literal("slack"),
    item: jsonObjectSchema,
  })
  .strict();

const slackWorkObjectReturnSchema = z
  .object({
    ok: z.literal(true),
    provider: z.literal("slack"),
    dryRun: z.boolean().optional(),
    item: jsonValueSchema.optional(),
    outputFile: z.string().optional(),
  })
  .strict();

interface SlackOpsContext {
  client: SlackWebApiClient;
  config: SlackCredentialConfig;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function summarizeSlackDryRunRequest(request: Record<string, unknown>): Record<string, unknown> {
  const text = typeof request.text === "string" ? request.text : undefined;
  const markdown = typeof request.markdown === "string" ? request.markdown : undefined;
  const blocks = Array.isArray(request.blocks) ? request.blocks : undefined;
  const changes = Array.isArray(request.changes) ? request.changes : undefined;
  const name = typeof request.name === "string" ? request.name : undefined;
  const userIds = Array.isArray(request.userIds) ? request.userIds : undefined;
  const accessTargetIds = Array.isArray(request.userIds)
    ? { kind: "users" as const, count: request.userIds.length }
    : Array.isArray(request.channelIds)
      ? { kind: "channels" as const, count: request.channelIds.length }
      : undefined;
  const destinationProvided = [request.channel, request.channelId, request.canvasId].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );

  return {
    ...(destinationProvided ? { destinationProvided: true } : {}),
    ...(typeof request.ts === "string" ? { tsProvided: true } : {}),
    ...(typeof request.threadTs === "string" ? { threadProvided: true } : {}),
    ...(typeof request.viewId === "string" || typeof request.externalId === "string" ? { viewProvided: true } : {}),
    ...(text !== undefined ? { textChars: text.length } : {}),
    ...(markdown !== undefined ? { markdownChars: markdown.length } : {}),
    ...(blocks ? { blockCount: blocks.length } : {}),
    ...(changes ? { changeCount: changes.length } : {}),
    ...(typeof request.file === "string" ? { fileProvided: true } : {}),
    ...(name !== undefined
      ? typeof request.channel === "string"
        ? { newNameChars: name.length }
        : { channelNameChars: name.length }
      : {}),
    ...(typeof request.isPrivate === "boolean" ? { isPrivate: request.isPrivate } : {}),
    ...(userIds && typeof request.canvasId !== "string" ? { userCount: userIds.length } : {}),
    ...(typeof request.accessLevel === "string" ? { accessLevel: request.accessLevel } : {}),
    ...(typeof request.canvasId === "string" && accessTargetIds
      ? { accessTargetKind: accessTargetIds.kind, accessTargetCount: accessTargetIds.count }
      : {}),
    ...(request.payload && typeof request.payload === "object" ? { payloadProvided: true } : {}),
    fieldCount: Object.keys(request).length,
  };
}

function summarizeSlackDryRunItem(item: unknown): Record<string, unknown> {
  if (Array.isArray(item)) return { itemCount: item.length };
  if (!item || typeof item !== "object") return { provided: item !== undefined };
  return { fieldCount: Object.keys(item as Record<string, unknown>).length };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`Invalid positive integer: ${value}`);
  return parsed;
}

function resolveSlackChannelConfig(channelName?: string): ChannelConfig | undefined {
  const channels = configStore.getConfig().channels ?? {};
  const context = getContext();
  const resolvedName =
    channelName?.trim() || (context?.source?.channel === "slack" ? context.source.accountId?.trim() : undefined);
  if (!resolvedName) return undefined;
  return Object.values(channels).find(
    (channel) => channel.enabled !== false && channel.provider === "slack" && channel.name === resolvedName,
  );
}

/** Enabled Slack channel-config names from the LOCAL config store (cheap source for suggestions). */
function listLocalSlackChannelNames(): string[] {
  const channels = configStore.getConfig().channels ?? {};
  return Object.values(channels)
    .filter((channel) => channel.enabled !== false && channel.provider === "slack")
    .map((channel) => channel.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

interface SlackContractContext {
  readonly op: string;
  readonly asJson?: boolean;
}

/**
 * Resolve the Ravi Slack channel config + credentials and build the Web API
 * client. Everything here is LOCAL (config store + credential broker/SQLite):
 * no Slack Web API call happens before the write brake in mutating commands.
 * Failures follow the Manual v2 envelope: CHANNEL_NOT_FOUND with suggestions
 * from the local config store, CREDENTIALS_NOT_CONFIGURED for broker gaps.
 */
async function createSlackOpsContext(
  channelName: string | undefined,
  action: string,
  contract: SlackContractContext,
): Promise<SlackOpsContext> {
  const channels = configStore.getConfig().channels ?? {};
  const channel = resolveSlackChannelConfig(channelName);
  if (!channel) {
    const known = listLocalSlackChannelNames();
    const requested = channelName?.trim();
    contractFail(
      contract.op,
      "CHANNEL_NOT_FOUND",
      requested
        ? `Slack channel config not found: ${requested}`
        : "Slack channel not resolved. Pass --channel <name> or run from a Slack-sourced context.",
      {
        asJson: contract.asJson,
        details: {
          suggestedAction: "List channel configs with: ravi channels list --json",
          suggestions: requested ? suggestSimilar(requested, known) : known.slice(0, 3),
        },
      },
    );
  }
  const config = await resolveSlackCredentialConfigFromEnv(process.env, { action, channel, channels });
  if (!config) {
    contractFail(
      contract.op,
      "CREDENTIALS_NOT_CONFIGURED",
      `Slack credentials not configured for channel ${channel.name}. Set channel credentialConnection first.`,
      {
        asJson: contract.asJson,
        details: {
          suggestedAction: `Set credentialConnection for channel ${channel.name} (see: ravi channels list --json)`,
        },
      },
    );
  }
  return {
    config,
    client: new SlackWebApiClient({
      appToken: config.appToken,
      botToken: config.botToken,
    }),
  };
}

function connectionLabel(config: SlackCredentialConfig): string {
  return config.accountId || config.instanceId;
}

function pagination(limit: number, cursor: string | undefined, nextCursor: unknown, hasMore?: boolean) {
  const next = typeof nextCursor === "string" && nextCursor.trim() ? nextCursor.trim() : undefined;
  return {
    limit,
    cursor: cursor || null,
    nextCursor: next ?? null,
    hasMore: Boolean(hasMore ?? next),
  };
}

function summarizeConversation(item: unknown): string {
  if (!item || typeof item !== "object") return String(item);
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "?";
  const name = typeof record.name === "string" ? record.name : typeof record.user === "string" ? record.user : "";
  const flags = [
    record.is_channel ? "channel" : null,
    record.is_group ? "private" : null,
    record.is_im ? "dm" : null,
    record.is_archived ? "archived" : null,
  ].filter(Boolean);
  return [id, name, flags.length ? `(${flags.join(",")})` : ""].filter(Boolean).join(" ");
}

function parseCsvOption(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

function parseRequiredCsvOption(value: string, label: string): string[] {
  const items = parseCsvOption(value);
  if (!items) fail(`Missing ${label}`);
  return items;
}

function readSlackBlockKitJsonFile(path: string): unknown {
  return parseSlackBlockKitJson(readFileSync(path, "utf8"));
}

function readJsonObjectFile(path: string, label: string): Record<string, unknown> {
  const parsed = parseSlackBlockKitJson(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function readSlackViewJsonFile(path: string): Record<string, unknown> {
  const validation = normalizeSlackBlockKitValidationPayload(readSlackBlockKitJsonFile(path), "view");
  if (!validation.view) fail("Block Kit view payload must be a JSON object");
  return validation.view;
}

export function redactSlackPrivateMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSlackPrivateMetadata(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    redacted[key] =
      key === "private_metadata" && child !== undefined && child !== null && child !== ""
        ? "[redacted]"
        : redactSlackPrivateMetadata(child);
  }
  return redacted;
}

function slackBlockKitValidationRequest(
  payload: ReturnType<typeof normalizeSlackBlockKitValidationPayload>,
): Record<string, unknown> {
  if (payload.target === "blocks") return { blocks: payload.blocks ?? [] };
  if (payload.target === "view") return { view: payload.view ?? {} };
  return { message: payload.message ?? {} };
}

export function slackViewMutationItem(raw: Record<string, unknown>): Record<string, unknown> {
  const safeRaw = redactSlackPrivateMetadata(raw) as Record<string, unknown>;
  const view = recordValue(safeRaw.view);
  if (!view) return { ok: safeRaw.ok === true };
  return {
    viewId: stringField(view, "id") ?? null,
    hash: stringField(view, "hash") ?? null,
    callbackId: stringField(view, "callback_id") ?? null,
    externalId: stringField(view, "external_id") ?? null,
    type: stringField(view, "type") ?? null,
  };
}

function formatSlackViewMutationItem(item: Record<string, unknown>): string {
  const viewId = typeof item.viewId === "string" ? item.viewId : undefined;
  const hash = typeof item.hash === "string" ? item.hash : undefined;
  return [viewId, hash].filter(Boolean).join(" ") || JSON.stringify(item, null, 2);
}

const SLACK_CANVAS_EDIT_OPERATIONS = new Set<SlackCanvasEditOperation>([
  "insert_after",
  "insert_before",
  "insert_at_start",
  "insert_at_end",
  "replace",
  "delete",
  "rename",
]);

const SLACK_CANVAS_ACCESS_LEVELS = new Set<SlackCanvasAccessLevel>(["read", "write", "owner"]);
const SLACK_CANVAS_SHOWCASE_TITLE = "Ravi Channels Canvas Showcase :white_check_mark:";
const SLACK_CANVAS_ARTIFACT_KIND = "slack.canvas.markdown";
const SLACK_CANVAS_REMOTE_EXPORT_LIMITATION =
  "Slack Canvas Web API nao expoe, nesta integracao, export Markdown completo ou stream de eventos de edicao manual suficiente para sync bidirecional automatico.";

export function parseSlackCanvasEditOperation(value: string): SlackCanvasEditOperation {
  const operation = value.trim() as SlackCanvasEditOperation;
  if (!SLACK_CANVAS_EDIT_OPERATIONS.has(operation)) {
    throw new Error(
      `Invalid canvas edit operation: ${value}. Expected one of ${[...SLACK_CANVAS_EDIT_OPERATIONS].join(", ")}`,
    );
  }
  return operation;
}

export function parseSlackCanvasAccessLevel(value: string): SlackCanvasAccessLevel {
  const accessLevel = value.trim() as SlackCanvasAccessLevel;
  if (!SLACK_CANVAS_ACCESS_LEVELS.has(accessLevel)) {
    throw new Error(`Invalid canvas access level: ${value}. Expected one of read, write, owner`);
  }
  return accessLevel;
}

export function parseSlackCanvasAccessTargets(
  usersValue: string | undefined,
  channelsValue: string | undefined,
): { userIds?: string[]; channelIds?: string[] } {
  const userIds = parseCsvOption(usersValue);
  const channelIds = parseCsvOption(channelsValue);
  if (userIds && channelIds) {
    throw new Error("Pass only one of --users or --channels for Slack Canvas access");
  }
  if (!userIds && !channelIds) {
    throw new Error("Pass one of --users or --channels for Slack Canvas access");
  }
  return userIds ? { userIds } : { channelIds };
}

export function validateSlackCanvasAccessLevelTargets(
  accessLevel: SlackCanvasAccessLevel,
  targets: { readonly userIds?: readonly string[]; readonly channelIds?: readonly string[] },
): void {
  if (accessLevel === "owner" && targets.channelIds) {
    throw new Error("Slack Canvas owner access can only target users");
  }
}

export function resolveSlackCanvasMarkdownInput(
  markdown: string | undefined,
  markdownFile: string | undefined,
  artifactId?: string,
): string | undefined {
  validateSlackCanvasMarkdownSourceSelection(markdown, markdownFile, artifactId);
  if (artifactId !== undefined) {
    if (!isSlackCanvasArtifactId(artifactId)) throw new Error("--artifact must be a Ravi artifact id");
    const source = resolveSlackCanvasArtifactSource({
      artifactOrFile: artifactId,
      execute: false,
      refreshSource: false,
    });
    if (source.sourceKind !== "artifact") throw new Error("--artifact must be a Ravi artifact id");
    return source.markdown;
  }
  if (markdownFile !== undefined) {
    return readFileSync(markdownFile, "utf8");
  }
  return markdown;
}

function validateSlackCanvasMarkdownSourceSelection(
  markdown: string | undefined,
  markdownFile: string | undefined,
  artifactId?: string,
): void {
  const selected = [markdown !== undefined, markdownFile !== undefined, artifactId !== undefined].filter(Boolean);
  if (selected.length > 1) {
    throw new Error("Pass only one of --markdown, --markdown-file or --artifact");
  }
}

export function buildSlackCanvasEditChange(input: {
  readonly operation: string;
  readonly sectionId?: string;
  readonly markdown?: string;
  readonly title?: string;
}): SlackCanvasEditChange {
  const operation = parseSlackCanvasEditOperation(input.operation);
  const sectionId = input.sectionId?.trim() || undefined;
  const markdown = input.markdown?.trim() ? input.markdown : undefined;
  const title = input.title?.trim() ? input.title : undefined;

  if (operation === "rename") {
    if (!title) throw new Error("Slack Canvas rename requires --title");
    if (markdown) throw new Error("Slack Canvas rename does not accept --markdown");
    if (sectionId) throw new Error("Slack Canvas rename does not accept --section-id");
    return { operation, title };
  }

  if (operation === "delete") {
    if (!sectionId) throw new Error("Slack Canvas delete requires --section-id");
    if (markdown) throw new Error("Slack Canvas delete does not accept --markdown");
    if (title) throw new Error("Slack Canvas delete does not accept --title");
    return { operation, sectionId };
  }

  if (operation === "insert_after" || operation === "insert_before") {
    if (!sectionId) throw new Error(`Slack Canvas ${operation} requires --section-id`);
    if (!markdown) throw new Error(`Slack Canvas ${operation} requires --markdown, --markdown-file or --artifact`);
    if (title) throw new Error(`Slack Canvas ${operation} does not accept --title`);
    return { operation, sectionId, markdown };
  }

  if (operation === "insert_at_start" || operation === "insert_at_end") {
    if (sectionId) throw new Error(`Slack Canvas ${operation} does not accept --section-id`);
    if (!markdown) throw new Error(`Slack Canvas ${operation} requires --markdown, --markdown-file or --artifact`);
    if (title) throw new Error(`Slack Canvas ${operation} does not accept --title`);
    return { operation, markdown };
  }

  if (!markdown) throw new Error("Slack Canvas replace requires --markdown, --markdown-file or --artifact");
  if (title) throw new Error("Slack Canvas replace does not accept --title");
  return sectionId ? { operation, sectionId, markdown } : { operation, markdown };
}

export function extractSlackCanvasIdFromConversationInfo(
  channel: unknown,
  preferredLabel?: string,
): string | undefined {
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) return undefined;
  const record = channel as Record<string, unknown>;
  const preferred = preferredLabel?.trim();
  const directCanvas = record.canvas;
  if (!preferred && typeof directCanvas === "string" && directCanvas.trim()) return directCanvas.trim();
  if (directCanvas && typeof directCanvas === "object" && !Array.isArray(directCanvas)) {
    const canvasRecord = directCanvas as Record<string, unknown>;
    if (!preferred || slackCanvasRecordMatchesLabel(canvasRecord, preferred)) {
      return (
        stringField(canvasRecord, "id") ??
        stringField(canvasRecord, "canvas_id") ??
        stringField(canvasRecord, "file_id")
      );
    }
  }
  const properties = record.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const canvasTabId = extractSlackCanvasTabId(properties as Record<string, unknown>, preferred);
  if (canvasTabId) return canvasTabId;
  if (preferred) return undefined;
  const canvas = (properties as Record<string, unknown>).canvas;
  if (typeof canvas === "string" && canvas.trim()) return canvas.trim();
  if (!canvas || typeof canvas !== "object" || Array.isArray(canvas)) return undefined;
  const canvasRecord = canvas as Record<string, unknown>;
  return (
    stringField(canvasRecord, "id") ?? stringField(canvasRecord, "canvas_id") ?? stringField(canvasRecord, "file_id")
  );
}

function extractSlackCanvasTabId(properties: Record<string, unknown>, preferredLabel?: string): string | undefined {
  const tabs = Array.isArray(properties.tabs)
    ? properties.tabs
    : Array.isArray(properties.tabz)
      ? properties.tabz
      : undefined;
  if (!tabs) return undefined;

  const canvasTabs = tabs
    .filter((tab): tab is Record<string, unknown> => Boolean(tab && typeof tab === "object" && !Array.isArray(tab)))
    .filter((tab) => tab.type === "canvas");
  if (canvasTabs.length === 0) return undefined;

  const preferred = preferredLabel?.trim();
  const selected = preferred ? canvasTabs.find((tab) => slackCanvasRecordMatchesLabel(tab, preferred)) : canvasTabs[0];
  if (!selected) return undefined;
  const data = selected.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return stringField(data as Record<string, unknown>, "file_id") ?? stringField(data as Record<string, unknown>, "id");
}

function slackCanvasRecordMatchesLabel(record: Record<string, unknown>, label: string): boolean {
  return [stringField(record, "label"), stringField(record, "title"), stringField(record, "name")].includes(label);
}

export function buildSlackCanvasShowcaseMarkdown(input: {
  readonly canvasId?: string;
  readonly channelId?: string;
  readonly title?: string;
}): string {
  const title = input.title?.trim() || SLACK_CANVAS_SHOWCASE_TITLE;
  const canvasId = input.canvasId?.trim() || "pending";
  const channelId = input.channelId?.trim() || "not-bound";
  return [
    `# ${title}`,
    "",
    "> Showcase do Slack Canvas nativo no Ravi. Este documento e gerado por comando, nao por montagem manual.",
    "",
    "## Status honesto",
    "",
    "| Area | Status | Observacao |",
    "|---|---:|---|",
    "| Criar channel canvas | :white_check_mark: | `conversations.canvases.create` |",
    "| Criar standalone canvas | :white_check_mark: | `canvases.create` |",
    "| Editar canvas inteiro | :white_check_mark: | `canvases.edit` com `replace` sem `section_id` |",
    "| Editar por secao | :white_check_mark: | `replace`, `insert_before`, `insert_after`, `insert_at_start`, `insert_at_end`, `delete` |",
    "| Renomear canvas | :white_check_mark: | `rename` + `title_content` |",
    "| Localizar secoes | :white_check_mark: | `canvases.sections.lookup` |",
    "| Acesso standalone | :white_check_mark: | `canvases.access.set` e `canvases.access.delete` |",
    "| Delete standalone | :white_check_mark: | `canvases.delete` |",
    "| Showcase repetivel | :white_check_mark: | `canvas-showcase` e `canvas-channel-showcase` |",
    "| Artifact Markdown como fonte | :white_check_mark: | `canvas-create`, `canvas-channel-create` e `canvas-edit` aceitam `--artifact` |",
    "| Status local de publish | :white_check_mark: | `canvas-artifact-status` mostra hash/local drift conhecido |",
    "| Modelo `ChannelCanvas` completo | :construction: | Falta schema canonico com anchors, ownership e policies finas |",
    "| Sync bidirecional manual Slack -> Ravi | :construction: | Slack ainda nao fornece export/eventos suficientes nesta integracao |",
    "",
    "## Showcase de formatacao",
    "",
    "Texto com **bold**, *italic*, ~~strikethrough~~ e `inline code`.",
    "",
    "- Bullet list",
    "- Outro item",
    "  - Subitem",
    "",
    "1. Ordered list",
    "2. Segundo passo",
    "3. Terceiro passo",
    "",
    "- [x] Criar Canvas no canal",
    "- [x] Encontrar secao via lookup",
    "- [x] Substituir conteudo inteiro",
    "- [x] Publicar showcase por comando",
    "- [ ] Evoluir para templates Ravi",
    "- [ ] Sincronizar estado canonico local",
    "",
    "---",
    "",
    "## Tabela de operacoes nativas",
    "",
    "| Comando Ravi | Metodo Slack | Mutacao |",
    "|---|---|---:|",
    "| `ravi slack canvas-create --artifact` | `canvases.create` | sim |",
    "| `ravi slack canvas-channel-create --artifact` | `conversations.canvases.create` | sim |",
    "| `ravi slack canvas-showcase` | `canvases.edit` | sim |",
    "| `ravi slack canvas-channel-showcase` | `conversations.canvases.create` + `canvases.edit` | sim |",
    "| `ravi slack canvas-edit --artifact` | `canvases.edit` | sim |",
    "| `ravi slack canvas-sections-lookup` | `canvases.sections.lookup` | nao |",
    "| `ravi slack canvas-access-set` | `canvases.access.set` | sim |",
    "| `ravi slack canvas-access-delete` | `canvases.access.delete` | sim |",
    "| `ravi slack canvas-delete` | `canvases.delete` | sim |",
    "| `ravi slack canvas-artifact-status` | artifact ledger | nao |",
    "",
    "## Quote block",
    "",
    "> Canvas no Ravi deve ser documento nativo do canal, nao dependencia semantica de gateway legado.",
    "",
    "## Code block",
    "",
    "```ts",
    "await slack.canvasesEdit({",
    `  canvasId: "${canvasId}",`,
    "  changes: [{",
    '    operation: "replace",',
    '    markdown: "# Novo conteudo"',
    "  }],",
    "});",
    "```",
    "",
    "## Links, mentions e unfurls",
    "",
    channelId !== "not-bound" ? `- Canal atual: <#${channelId}>` : "- Canal atual: nao informado",
    "- Docs `canvases.create`: https://docs.slack.dev/reference/methods/canvases.create/",
    "- Docs `canvases.edit`: https://docs.slack.dev/reference/methods/canvases.edit/",
    "- Docs `canvases.sections.lookup`: https://docs.slack.dev/reference/methods/canvases.sections.lookup/",
    "",
    "## O que falta para 100% Ravi Canvas",
    "",
    "1. Modelo canonico `ChannelCanvas`, com ownership, source, versao, anchors e policies finas.",
    "2. Anchors semanticos locais para nao depender de `section_id` temporario.",
    "3. Renderers Ravi especializados para specs, runbooks, PR summaries e status.",
    "4. Diff/patch minimo entre artifact canonico local e Canvas publicado.",
    "5. Observabilidade e replay idempotente de create/edit/access/delete.",
    "6. Policies Ravi por agent, sessao, canal e canvas.",
    "7. Reconciliacao de edicoes manuais feitas diretamente no Slack, se a API suportar sinais suficientes.",
    "8. User tokens e ownership quando bot token nao for suficiente.",
    "9. SDK/codegen a partir do contrato canonical.",
    "10. Testes live controlados com cleanup.",
    "",
    "## Resultado deste teste",
    "",
    `- Canvas: \`${canvasId}\``,
    `- Channel: \`${channelId}\``,
    "- Criacao, lookup, rename e replace ja foram executados com sucesso.",
  ].join("\n");
}

interface SlackCanvasArtifactSource {
  readonly artifact?: ArtifactRecord;
  readonly version?: ArtifactVersion | null;
  readonly markdown: string;
  readonly markdownSha256: string;
  readonly markdownChars: number;
  readonly sourcePath?: string;
  readonly sourceKind: "artifact" | "file";
  readonly refreshed: boolean;
  readonly liveFileSha256?: string;
  readonly sourceFileChanged: boolean;
}

interface SlackCanvasMarkdownSource {
  readonly artifact?: ArtifactRecord;
  readonly version?: ArtifactVersion | null;
  readonly markdown?: string;
  readonly markdownSha256?: string;
  readonly markdownChars?: number;
  readonly sourcePath?: string;
  readonly sourceKind: "none" | "inline" | "file" | "artifact";
  readonly refreshed: boolean;
  readonly liveFileSha256?: string;
  readonly sourceFileChanged: boolean;
}

interface SlackCanvasArtifactPublishState {
  readonly provider: "slack";
  readonly syncDirection: "artifact_to_slack";
  readonly publishMode: "replace";
  readonly canvasId: string;
  readonly channelId: string | null;
  readonly connection: string;
  readonly credentialSource: string;
  readonly title: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly artifactVersionNumber: number;
  readonly markdownSha256: string;
  readonly markdownChars: number;
  readonly publishedAt: string;
  readonly remoteContentExportSupported: false;
}

export function hashSlackCanvasMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

export function isSlackCanvasArtifactId(value: string): boolean {
  return /^art_[a-z0-9]+_[a-z0-9]+$/.test(value.trim());
}

export function extractSlackCanvasArtifactPublishState(artifact: ArtifactRecord): Record<string, unknown> | null {
  const metadata = recordValue(artifact.metadata);
  const slackCanvas = recordValue(metadata?.slackCanvas);
  const current = recordValue(slackCanvas?.current);
  return current ?? null;
}

export function buildSlackCanvasArtifactPublishMetadata(
  state: SlackCanvasArtifactPublishState,
): Record<string, unknown> {
  return {
    slackCanvas: {
      current: state,
      limitation: SLACK_CANVAS_REMOTE_EXPORT_LIMITATION,
    },
  };
}

function createSlackCanvasMarkdownArtifact(filePath: string, title?: string): ArtifactRecord {
  const ctx = getContext();
  return createArtifact({
    kind: SLACK_CANVAS_ARTIFACT_KIND,
    title: title?.trim() || basename(filePath),
    summary: "Markdown source published to Slack Canvas",
    filePath,
    mimeType: "text/markdown",
    command: "ravi slack canvas-artifact-publish",
    ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx?.sessionName ? { sessionName: ctx.sessionName } : {}),
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.source?.channel ? { channel: ctx.source.channel } : {}),
    ...(ctx?.source?.accountId ? { accountId: ctx.source.accountId } : {}),
    ...(ctx?.source?.chatId ? { chatId: ctx.source.chatId } : {}),
    metadata: {
      slackCanvas: {
        source: "markdown-file",
        limitation: SLACK_CANVAS_REMOTE_EXPORT_LIMITATION,
      },
    },
    lineage: {
      source: "slack.canvas.artifact",
      filePath,
    },
    tags: ["slack", "canvas", "markdown"],
  });
}

/** Local (SQLite) artifact ids/titles most similar to the missing id — cheap NOT_FOUND suggestions. */
function slackArtifactSuggestions(query: string): string[] {
  const candidates = listArtifacts({ kind: SLACK_CANVAS_ARTIFACT_KIND, limit: 50 }).map((artifact) => artifact.id);
  return suggestSimilar(query, candidates);
}

function failSlackArtifactNotFound(
  artifactId: string,
  contract?: SlackContractContext,
  readOnlyCandidates?: string[],
): never {
  if (!contract) fail(`Artifact not found: ${artifactId}`);
  contractFail(contract.op, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`, {
    asJson: contract.asJson,
    details: {
      suggestedAction: "List local artifacts with: ravi artifacts list --json",
      suggestions: readOnlyCandidates
        ? suggestSimilar(artifactId, readOnlyCandidates)
        : slackArtifactSuggestions(artifactId),
    },
  });
}

function resolveSlackCanvasArtifactSource(input: {
  readonly artifactOrFile: string;
  readonly title?: string;
  readonly execute: boolean;
  readonly refreshSource: boolean;
  readonly contract?: SlackContractContext;
}): SlackCanvasArtifactSource {
  const value = input.artifactOrFile.trim();
  if (!value) fail("Missing artifact id or markdown file path.");

  if (!isSlackCanvasArtifactId(value)) {
    const markdown = readFileSync(value, "utf8");
    const artifact = input.execute ? createSlackCanvasMarkdownArtifact(value, input.title) : undefined;
    const version = artifact ? getArtifactVersion(artifact.id) : null;
    return {
      ...(artifact ? { artifact } : {}),
      ...(version ? { version } : {}),
      markdown,
      markdownSha256: hashSlackCanvasMarkdown(markdown),
      markdownChars: markdown.length,
      sourcePath: value,
      sourceKind: "file",
      refreshed: Boolean(artifact),
      liveFileSha256: hashSlackCanvasMarkdown(markdown),
      sourceFileChanged: false,
    };
  }

  const inspection = inspectArtifactPublishStateReadOnly(value);
  if (!inspection.artifact) failSlackArtifactNotFound(value, input.contract, inspection.candidates);
  let artifact = inspection.artifact;
  let version = inspection.version;
  let refreshed = false;
  const liveFileSha256 = artifact.filePath ? hashFileContent(artifact.filePath) : undefined;
  const sourceFileChanged = Boolean(liveFileSha256 && artifact.sha256 && liveFileSha256 !== artifact.sha256);

  if (input.execute && input.refreshSource && sourceFileChanged && artifact.filePath) {
    artifact = updateArtifact(
      artifact.id,
      {
        filePath: artifact.filePath,
      },
      {
        actor: getContext()?.agentId,
        mergeMetadata: true,
        mergeLineage: true,
      },
    );
    version = getArtifactVersion(artifact.id);
    refreshed = true;
  }

  const markdownSource = readMarkdownFromArtifact(artifact, version);
  return {
    artifact,
    ...(version ? { version } : {}),
    markdown: markdownSource.markdown,
    markdownSha256: hashSlackCanvasMarkdown(markdownSource.markdown),
    markdownChars: markdownSource.markdown.length,
    ...(markdownSource.sourcePath ? { sourcePath: markdownSource.sourcePath } : {}),
    sourceKind: "artifact",
    refreshed,
    ...(liveFileSha256 ? { liveFileSha256 } : {}),
    sourceFileChanged,
  };
}

function resolveSlackCanvasMarkdownSource(input: {
  readonly markdown?: string;
  readonly markdownFile?: string;
  readonly artifactId?: string;
  readonly execute: boolean;
  readonly refreshSource: boolean;
  readonly contract?: SlackContractContext;
}): SlackCanvasMarkdownSource {
  validateSlackCanvasMarkdownSourceSelection(input.markdown, input.markdownFile, input.artifactId);

  if (input.artifactId !== undefined) {
    const artifactId = input.artifactId.trim();
    if (!artifactId) fail("Missing Ravi artifact id for --artifact.");
    if (!isSlackCanvasArtifactId(artifactId)) fail("--artifact must be a Ravi artifact id like art_xxx_xxx.");
    const source = resolveSlackCanvasArtifactSource({
      artifactOrFile: artifactId,
      execute: input.execute,
      refreshSource: input.refreshSource,
      ...(input.contract ? { contract: input.contract } : {}),
    });
    return {
      artifact: source.artifact,
      ...(source.version ? { version: source.version } : {}),
      markdown: source.markdown,
      markdownSha256: source.markdownSha256,
      markdownChars: source.markdownChars,
      ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
      sourceKind: "artifact",
      refreshed: source.refreshed,
      ...(source.liveFileSha256 ? { liveFileSha256: source.liveFileSha256 } : {}),
      sourceFileChanged: source.sourceFileChanged,
    };
  }

  if (input.markdownFile !== undefined) {
    const markdown = readFileSync(input.markdownFile, "utf8");
    return {
      markdown,
      markdownSha256: hashSlackCanvasMarkdown(markdown),
      markdownChars: markdown.length,
      sourcePath: input.markdownFile,
      sourceKind: "file",
      refreshed: false,
      liveFileSha256: hashSlackCanvasMarkdown(markdown),
      sourceFileChanged: false,
    };
  }

  if (input.markdown !== undefined) {
    return {
      markdown: input.markdown,
      markdownSha256: hashSlackCanvasMarkdown(input.markdown),
      markdownChars: input.markdown.length,
      sourceKind: "inline",
      refreshed: false,
      sourceFileChanged: false,
    };
  }

  return {
    sourceKind: "none",
    refreshed: false,
    sourceFileChanged: false,
  };
}

function slackCanvasMarkdownSourceRequest(source: SlackCanvasMarkdownSource): Record<string, unknown> {
  if (source.sourceKind === "none") return {};
  return {
    markdownSource: source.sourceKind,
    artifactId: source.artifact?.id ?? null,
    artifactVersionNumber: source.version?.versionNumber ?? null,
    sourcePath: source.sourcePath ?? null,
    markdownSha256: source.markdownSha256 ?? null,
    markdownChars: source.markdownChars ?? null,
    refreshed: source.refreshed,
    sourceFileChanged: source.sourceFileChanged,
  };
}

function canRecordSlackCanvasArtifactPublish(source: SlackCanvasMarkdownSource): source is SlackCanvasMarkdownSource & {
  artifact: ArtifactRecord;
  markdownSha256: string;
  markdownChars: number;
} {
  return Boolean(source.artifact && source.markdownSha256 && typeof source.markdownChars === "number");
}

function isWholeCanvasReplace(change: SlackCanvasEditChange): boolean {
  return change.operation === "replace" && !("sectionId" in change);
}

function readMarkdownFromArtifact(
  artifact: ArtifactRecord,
  version: ArtifactVersion | null,
): { markdown: string; sourcePath?: string } {
  if (typeof artifact.output === "string") return { markdown: artifact.output };
  const output = recordValue(artifact.output);
  const outputMarkdown = output?.markdown;
  if (typeof outputMarkdown === "string") return { markdown: outputMarkdown };

  const primaryAsset = version?.assets.find((asset) => asset.role === "primary") ?? version?.assets[0];
  const sourcePath = primaryAsset?.blobPath ?? artifact.blobPath ?? primaryAsset?.filePath ?? artifact.filePath;
  if (!sourcePath) {
    throw new Error(`Artifact ${artifact.id} does not expose Markdown text, filePath or blobPath`);
  }
  return { markdown: readFileSync(sourcePath, "utf8"), sourcePath };
}

function hashFileContent(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildSlackCanvasArtifactStatus(artifactId: string, contract?: SlackContractContext): Record<string, unknown> {
  const details = getArtifactDetails(artifactId);
  if (!details) failSlackArtifactNotFound(artifactId, contract);
  const version = getArtifactVersion(artifactId);
  const source = readMarkdownFromArtifact(details.artifact, version);
  const markdownSha256 = hashSlackCanvasMarkdown(source.markdown);
  const current = extractSlackCanvasArtifactPublishState(details.artifact);
  const publishedHash = typeof current?.markdownSha256 === "string" ? current.markdownSha256 : null;
  const liveFileSha256 = details.artifact.filePath ? hashFileContent(details.artifact.filePath) : null;
  return {
    artifactId,
    artifactTitle: details.artifact.title ?? null,
    artifactKind: details.artifact.kind,
    latestVersionNumber: version?.versionNumber ?? null,
    sourcePath: source.sourcePath ?? null,
    markdownSha256,
    markdownChars: source.markdown.length,
    liveFileSha256,
    sourceFileChanged: Boolean(liveFileSha256 && details.artifact.sha256 && liveFileSha256 !== details.artifact.sha256),
    published: current,
    localDiffersFromPublished: Boolean(publishedHash && publishedHash !== markdownSha256),
    remoteContentReadable: false,
    limitation: SLACK_CANVAS_REMOTE_EXPORT_LIMITATION,
  };
}

function recordSlackCanvasArtifactPublish(input: {
  readonly artifact: ArtifactRecord;
  readonly canvasId: string;
  readonly channelId?: string;
  readonly config: SlackCredentialConfig;
  readonly title: string;
  readonly markdownSha256: string;
  readonly markdownChars: number;
}): { artifact: ArtifactRecord; version: ArtifactVersion; state: SlackCanvasArtifactPublishState } {
  const version = createArtifactVersion(input.artifact.id, {
    label: `Slack Canvas ${input.canvasId}`,
    source: "slack.canvas.publish",
    message: `Published artifact to Slack Canvas ${input.canvasId}`,
    createdBy: getContext()?.agentId,
    metadata: {
      canvasId: input.canvasId,
      channelId: input.channelId ?? null,
      markdownSha256: input.markdownSha256,
      publishMode: "replace",
    },
  });
  const state: SlackCanvasArtifactPublishState = {
    provider: "slack",
    syncDirection: "artifact_to_slack",
    publishMode: "replace",
    canvasId: input.canvasId,
    channelId: input.channelId ?? null,
    connection: connectionLabel(input.config),
    credentialSource: input.config.source,
    title: input.title,
    artifactId: input.artifact.id,
    artifactVersionId: version.id,
    artifactVersionNumber: version.versionNumber,
    markdownSha256: input.markdownSha256,
    markdownChars: input.markdownChars,
    publishedAt: new Date().toISOString(),
    remoteContentExportSupported: false,
  };
  const updated = updateArtifact(
    input.artifact.id,
    {
      metadata: buildSlackCanvasArtifactPublishMetadata(state),
      lineage: {
        slackCanvas: {
          canvasId: input.canvasId,
          channelId: input.channelId ?? null,
          connection: connectionLabel(input.config),
        },
      },
    },
    { actor: getContext()?.agentId, mergeMetadata: true, mergeLineage: true },
  );
  const statePayload = state as unknown as Record<string, unknown>;
  appendArtifactEvent(input.artifact.id, {
    eventType: "slack.canvas.published",
    status: "published",
    source: "slack.canvas",
    actor: getContext()?.agentId,
    message: `Published to Slack Canvas ${input.canvasId}`,
    payload: statePayload,
  });
  attachArtifact(input.artifact.id, "slack_canvas", input.canvasId, "published-to", statePayload);
  if (input.channelId) {
    attachArtifact(input.artifact.id, "slack_channel", input.channelId, "published-in", statePayload);
  }
  return { artifact: updated, version, state };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slackTsToEventTime(ts: string): number {
  const parsed = Number(ts);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Math.trunc(Date.now() / 1000);
}

async function fetchSlackMessageByTs(
  client: SlackWebApiClient,
  channel: string,
  ts: string,
): Promise<Record<string, unknown> | null> {
  const raw = await client.conversationsHistory({
    channel,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 10,
  });
  const messages = raw.messages ?? [];
  return (
    messages.find((message): message is Record<string, unknown> => {
      return Boolean(
        message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          stringField(message as Record<string, unknown>, "ts") === ts,
      );
    }) ?? null
  );
}

export function buildSlackReplayEnvelope(input: {
  connection: string;
  channel: string;
  message: Record<string, unknown>;
}): SlackSocketEnvelope {
  const ts = stringField(input.message, "ts");
  if (!ts) throw new Error("Slack message is missing ts");
  const event = {
    ...input.message,
    type: stringField(input.message, "type") ?? "message",
    channel: input.channel,
    channel_type: stringField(input.message, "channel_type") ?? "channel",
    ts,
  };
  return {
    envelope_id: `replay:${input.connection}:${input.channel}:${ts}`,
    type: "events_api",
    payload: {
      type: "event_callback",
      team_id: stringField(input.message, "team"),
      event_id: `replay:${input.channel}:${ts}`,
      event_time: slackTsToEventTime(ts),
      event,
    },
  };
}

function summarizeSlackFile(file: unknown): Record<string, unknown> {
  if (!file || typeof file !== "object" || Array.isArray(file)) return { type: typeof file };
  const record = file as Record<string, unknown>;
  return {
    id: stringField(record, "id") ?? null,
    name: stringField(record, "name") ?? null,
    title: stringField(record, "title") ?? null,
    mimeType: stringField(record, "mimetype") ?? null,
    fileType: stringField(record, "filetype") ?? null,
    slackSubtype: stringField(record, "subtype") ?? null,
    mediaDisplayType: stringField(record, "media_display_type") ?? null,
    sizeBytes: numberField(record, "size") ?? null,
    durationMs: numberField(record, "duration_ms") ?? null,
  };
}

function summarizeSlackMessage(message: Record<string, unknown>): Record<string, unknown> {
  const text = stringField(message, "text") ?? "";
  const files = Array.isArray(message.files) ? message.files.map(summarizeSlackFile) : [];
  return {
    ts: stringField(message, "ts") ?? null,
    type: stringField(message, "type") ?? null,
    subtype: stringField(message, "subtype") ?? null,
    user: stringField(message, "user") ?? null,
    threadTs: stringField(message, "thread_ts") ?? null,
    hasText: text.trim().length > 0,
    textLength: text.length,
    files,
  };
}

function findLocalSlackMessage(config: SlackCredentialConfig, channel: string, message: Record<string, unknown>) {
  const ts = stringField(message, "ts");
  if (!ts) return { chat: null, message: null };
  const instanceId = config.instanceId || config.accountId;
  const channelType = stringField(message, "channel_type") ?? "channel";
  const threadTs = stringField(message, "thread_ts");
  const routeThreadTs = threadTs && threadTs !== ts ? threadTs : undefined;
  const chatType = routeThreadTs ? "thread" : channelType === "im" ? "dm" : "group";
  const platformChatId = routeThreadTs ? `${channel}#${routeThreadTs}` : channel;
  const chat = dbFindChat({
    channel: "slack",
    instanceId,
    platformChatId,
    chatType,
  });
  const stored = chat
    ? dbFindChatMessage({
        channel: "slack",
        instanceId,
        chatId: chat.id,
        providerMessageId: ts,
      })
    : null;
  return {
    chat: chat
      ? {
          id: chat.id,
          platformChatId: chat.platformChatId,
          chatType: chat.chatType,
        }
      : null,
    message: stored
      ? {
          id: stored.id,
          providerMessageId: stored.providerMessageId,
          messageType: stored.messageType,
          actorType: stored.actorType,
          ingestedAt: stored.ingestedAt,
          updatedAt: stored.updatedAt,
        }
      : null,
  };
}

@Group({
  name: "slack",
  description: "Native Slack workspace operations",
  scope: "admin",
})
export class SlackCommands {
  @Command({ name: "permissions-list", description: "List OAuth scopes granted to the configured Slack bot token" })
  @CommandAccess({ kind: "read", resource: "slack.permissions", action: "list", risk: "low" })
  @Returns(slackObjectReturnSchema)
  async permissionsList(
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { client, config } = await createSlackOpsContext(raviChannel, "auth.test", {
      op: "slack permissions-list",
      asJson,
    });
    const raw = await client.authTest();
    const scopes = raw.scopes ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      item: {
        team: raw.team,
        teamId: raw.team_id,
        user: raw.user,
        userId: raw.user_id,
        botId: raw.bot_id,
        scopes,
        acceptedScopes: raw.acceptedScopes ?? [],
      },
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const scope of scopes) console.log(scope);
    }
    return payload;
  }

  @Command({ name: "channels-list", description: "List Slack conversations visible to the configured bot" })
  @CommandAccess({
    kind: "read",
    resource: "slack.channels",
    action: "list",
    risk: "low",
    redactions: ["raviChannel", "cursor"],
  })
  @Returns(slackListReturnSchema)
  async channelsList(
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({
      flags: "--types <types>",
      description: "Slack conversation types",
      defaultValue: "public_channel,private_channel,im,mpim",
    })
    types?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "100" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--include-archived", description: "Include archived conversations" }) includeArchived?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 100);
    const { client, config } = await createSlackOpsContext(raviChannel, "conversations.list", {
      op: "slack channels-list",
      asJson,
    });
    const raw = await client.conversationsList({
      types,
      limit,
      cursor,
      excludeArchived: !includeArchived,
    });
    const items = raw.channels ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      // Compact mode (Manual v2 7.9): narrows the JSON items only; the text
      // summary below keeps rendering from the full records.
      items: pickFields(items, fields),
      pagination: pagination(limit, cursor, raw.response_metadata?.next_cursor),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const item of items) console.log(summarizeConversation(item));
    }
    return payload;
  }

  @Command({ name: "messages-send", description: "Send a Slack message; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.messages",
    action: "send",
    risk: "high",
    redactions: ["channel", "text", "raviChannel", "threadTs", "ephemeralUser"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async messagesSend(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("text", { description: "Message text" }) text: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--thread-ts <ts>", description: "Send inside a Slack thread" }) threadTs?: string,
    @Option({
      flags: "--ephemeral-user <user>",
      description: "Send as an ephemeral message visible only to this Slack user",
    })
    ephemeralUser?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack messages-send";
    const method = ephemeralUser ? "chat.postEphemeral" : "chat.postMessage";
    const request = { channel, text, ...(threadTs ? { threadTs } : {}), ...(ephemeralUser ? { ephemeralUser } : {}) };
    const { client, config } = await createSlackOpsContext(raviChannel, method, { op, asJson });
    if (!execute) this.brakeDryRun(op, config, method, request, asJson);
    const raw = ephemeralUser
      ? await client.postEphemeral({ channel, user: ephemeralUser, text, ...(threadTs ? { threadTs } : {}) })
      : await client.postMessage({ channel, text, ...(threadTs ? { threadTs } : {}) });
    const payload = this.mutationPayload(config, false, method, request, raw, raw.raw);
    if (asJson) printJson(payload);
    else console.log(`${raw.channel} ${raw.ts}`);
    return payload;
  }

  @Command({ name: "blocks-validate", description: "Validate Slack Block Kit JSON with Slack blocks.validate" })
  @CommandAccess({
    kind: "read",
    resource: "slack.block-kit",
    action: "validate",
    risk: "medium",
    redactions: ["file", "raviChannel"],
  })
  @Returns(slackObjectReturnSchema)
  async blocksValidate(
    @Arg("file", { description: "Path to a Block Kit JSON file" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--target <target>", description: "Validation target: blocks, message or view" }) target?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const validation = normalizeSlackBlockKitValidationPayload(readSlackBlockKitJsonFile(file), target);
    const request = slackBlockKitValidationRequest(validation);
    const { client, config } = await createSlackOpsContext(raviChannel, "blocks.validate", {
      op: "slack blocks-validate",
      asJson,
    });
    const raw = await client.blocksValidate(request);
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      item: {
        target: validation.target,
        file,
        valid: raw.ok === true,
      },
      raw,
    };
    if (asJson) printJson(payload);
    else console.log(raw.ok === true ? "valid" : JSON.stringify(raw, null, 2));
    return payload;
  }

  @Command({ name: "blocks-send", description: "Send a Slack Block Kit message; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.block-kit",
    action: "send",
    risk: "high",
    redactions: ["channel", "file", "raviChannel", "connection", "text", "blocks", "threadTs", "ephemeralUser"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async blocksSend(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("file", { description: "Path to a Block Kit message JSON file" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--connection <name>", description: "Ravi channel config; SDK-safe alias for --channel" })
    connection?: string,
    @Option({ flags: "--text <text>", description: "Top-level fallback text for notifications/accessibility" })
    text?: string,
    @Option({ flags: "--thread-ts <ts>", description: "Send inside a Slack thread" }) threadTs?: string,
    @Option({
      flags: "--ephemeral-user <user>",
      description: "Send as an ephemeral message visible only to this Slack user",
    })
    ephemeralUser?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack blocks-send";
    const message = normalizeSlackBlockKitMessagePayload(readSlackBlockKitJsonFile(file), text);
    const method = ephemeralUser ? "chat.postEphemeral" : "chat.postMessage";
    const request = {
      channel,
      file,
      text: message.text,
      blocks: message.blocks,
      ...(threadTs ? { threadTs } : {}),
      ...(ephemeralUser ? { ephemeralUser } : {}),
    };
    const { client, config } = await createSlackOpsContext(connection || raviChannel, method, { op, asJson });
    if (!execute) this.brakeDryRun(op, config, method, request, asJson);
    const raw = ephemeralUser
      ? await client.postEphemeral({
          channel,
          user: ephemeralUser,
          text: message.text,
          blocks: message.blocks,
          ...(threadTs ? { threadTs } : {}),
        })
      : await client.postMessage({
          channel,
          text: message.text,
          blocks: message.blocks,
          ...(threadTs ? { threadTs } : {}),
        });
    const payload = this.mutationPayload(config, false, method, request, raw, raw.raw);
    if (asJson) printJson(payload);
    else console.log(`${raw.channel} ${raw.ts}`);
    return payload;
  }

  @Command({
    name: "blocks-update",
    description: "Update a Slack message with Block Kit; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.block-kit",
    action: "update",
    risk: "high",
    redactions: ["channel", "ts", "file", "raviChannel", "text", "blocks"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async blocksUpdate(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("ts", { description: "Slack message timestamp" }) ts: string,
    @Arg("file", { description: "Path to a Block Kit message JSON file" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--text <text>", description: "Top-level fallback text for notifications/accessibility" })
    text?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack blocks-update";
    const message = normalizeSlackBlockKitMessagePayload(readSlackBlockKitJsonFile(file), text);
    const request = { channel, ts, file, text: message.text, blocks: message.blocks };
    const { client, config } = await createSlackOpsContext(raviChannel, "chat.update", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "chat.update", request, asJson);
    const raw = await client.updateMessage({
      channel,
      ts,
      text: message.text,
      blocks: message.blocks,
    });
    const payload = this.mutationPayload(config, false, "chat.update", request, raw, raw.raw);
    if (asJson) printJson(payload);
    else console.log(`${raw.channel} ${raw.ts}`);
    return payload;
  }

  @Command({
    name: "interactions-respond",
    description: "Respond to a Slack interaction response handle; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.interactions",
    action: "respond",
    risk: "high",
    redactions: ["responseUrlId", "file", "payload", "raviChannel"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async interactionsRespond(
    @Arg("responseUrlId", { description: "Opaque Slack interaction response URL handle" }) responseUrlId: string,
    @Arg("file", { description: "Path to a JSON response payload" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const responsePayload = readSlackBlockKitJsonFile(file);
    if (!responsePayload || typeof responsePayload !== "object" || Array.isArray(responsePayload)) {
      fail("Slack interaction response payload must be a JSON object");
    }
    const op = "slack interactions-respond";
    const request = { responseUrlId, file, payload: responsePayload as Record<string, unknown> };
    const { config } = await createSlackOpsContext(raviChannel, "slack.interactions.respond", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "slack.interactions.respond", request, asJson);
    const raw = await respondToSlackInteraction({
      responseUrlId,
      payload: responsePayload as Record<string, unknown>,
    });
    const payload = this.mutationPayload(config, false, "slack.interactions.respond", request, raw, raw);
    if (asJson) printJson(payload);
    else console.log(`responded ${responseUrlId}`);
    return payload;
  }

  @Command({
    name: "modals-open",
    description: "Open a Slack modal from an interaction trigger_id; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.modals",
    action: "open",
    risk: "high",
    redactions: ["triggerId", "file", "view", "raviChannel"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async modalsOpen(
    @Arg("triggerId", { description: "Slack interaction trigger_id" }) triggerId: string,
    @Arg("file", { description: "Path to a Block Kit view JSON file" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack modals-open";
    const view = readSlackViewJsonFile(file);
    const request = { triggerId, file, view: redactSlackPrivateMetadata(view) };
    const { client, config } = await createSlackOpsContext(raviChannel, "views.open", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "views.open", request, asJson);
    const raw = await client.viewsOpen({ triggerId, view });
    const safeRaw = redactSlackPrivateMetadata(raw) as Record<string, unknown>;
    const item = slackViewMutationItem(safeRaw);
    const payload = this.mutationPayload(config, false, "views.open", request, item, safeRaw);
    if (asJson) printJson(payload);
    else console.log(formatSlackViewMutationItem(item));
    return payload;
  }

  @Command({
    name: "modals-update",
    description: "Update a Slack modal view; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.modals",
    action: "update",
    risk: "high",
    redactions: ["view", "file", "raviChannel", "externalId", "hash"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async modalsUpdate(
    @Arg("view", { description: "Slack view_id, or external_id when --external-id is set" }) viewTarget: string,
    @Arg("file", { description: "Path to a Block Kit view JSON file" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--external-id", description: "Treat <view> as an external_id instead of a view_id" })
    useExternalId?: boolean,
    @Option({ flags: "--hash <hash>", description: "Slack view.hash for optimistic concurrency control" })
    hash?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack modals-update";
    const view = readSlackViewJsonFile(file);
    const request = {
      ...(useExternalId ? { externalId: viewTarget } : { viewId: viewTarget }),
      file,
      ...(hash ? { hash } : {}),
      view: redactSlackPrivateMetadata(view),
    };
    const { client, config } = await createSlackOpsContext(raviChannel, "views.update", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "views.update", request, asJson);
    const raw = await client.viewsUpdate({
      view,
      viewId: useExternalId ? undefined : viewTarget,
      externalId: useExternalId ? viewTarget : undefined,
      hash,
    });
    const safeRaw = redactSlackPrivateMetadata(raw) as Record<string, unknown>;
    const item = slackViewMutationItem(safeRaw);
    const payload = this.mutationPayload(config, false, "views.update", request, item, safeRaw);
    if (asJson) printJson(payload);
    else console.log(formatSlackViewMutationItem(item));
    return payload;
  }

  @Command({
    name: "modals-push",
    description: "Push a Slack modal view onto an existing modal stack; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.modals",
    action: "push",
    risk: "high",
    redactions: ["triggerId", "file", "view", "raviChannel"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async modalsPush(
    @Arg("triggerId", { description: "Slack interaction trigger_id" }) triggerId: string,
    @Arg("file", { description: "Path to a Block Kit view JSON file" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack modals-push";
    const view = readSlackViewJsonFile(file);
    const request = { triggerId, file, view: redactSlackPrivateMetadata(view) };
    const { client, config } = await createSlackOpsContext(raviChannel, "views.push", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "views.push", request, asJson);
    const raw = await client.viewsPush({ triggerId, view });
    const safeRaw = redactSlackPrivateMetadata(raw) as Record<string, unknown>;
    const item = slackViewMutationItem(safeRaw);
    const payload = this.mutationPayload(config, false, "views.push", request, item, safeRaw);
    if (asJson) printJson(payload);
    else console.log(formatSlackViewMutationItem(item));
    return payload;
  }

  @Command({ name: "blocks-showcase", description: "Send a Slack Block Kit showcase; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.block-kit",
    action: "showcase",
    risk: "high",
    redactions: ["channel", "raviChannel", "threadTs"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async blocksShowcase(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--thread-ts <ts>", description: "Send inside a Slack thread" }) threadTs?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack blocks-showcase";
    const message = buildSlackBlockKitShowcasePayload();
    const request = { channel, text: message.text, blocks: message.blocks, ...(threadTs ? { threadTs } : {}) };
    const { client, config } = await createSlackOpsContext(raviChannel, "chat.postMessage", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "slack.block-kit.showcase", request, asJson);
    const raw = await client.postMessage({
      channel,
      text: message.text,
      blocks: message.blocks,
      ...(threadTs ? { threadTs } : {}),
    });
    const payload = this.mutationPayload(config, false, "slack.block-kit.showcase", request, raw, raw.raw);
    if (asJson) printJson(payload);
    else console.log(`${raw.channel} ${raw.ts}`);
    return payload;
  }

  @Command({ name: "work-objects-validate", description: "Validate Slack native Work Object metadata JSON" })
  @CommandAccess({
    kind: "read",
    resource: "slack.work-objects",
    action: "validate",
    risk: "low",
    redactions: ["file"],
  })
  @Returns(slackWorkObjectReturnSchema)
  async workObjectsValidate(
    @Arg("file", { description: "Path to Slack native Work Object metadata JSON" }) file: string,
    @Option({
      flags: "--target <target>",
      description: "Validation target: message or detail",
      defaultValue: "message",
    })
    target?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const input = readJsonObjectFile(file, "Slack Work Object metadata");
    const normalizedTarget = target?.trim() || "message";
    if (normalizedTarget !== "message" && normalizedTarget !== "detail") {
      fail("Slack Work Object validation target must be message or detail.");
    }
    const normalized =
      normalizedTarget === "detail"
        ? normalizeSlackNativeWorkObjectDetailMetadata(input)
        : normalizeSlackNativeWorkObjectMetadata(input);
    const payload = {
      ok: true,
      provider: "slack" as const,
      item: {
        file,
        target: normalizedTarget,
        metadata: normalized,
      },
    };
    if (asJson) printJson(payload);
    else console.log("valid");
    return payload;
  }

  @Command({
    name: "work-objects-send",
    description: "Send Slack native Work Object metadata with chat.postMessage; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.work-objects",
    action: "send",
    risk: "high",
    redactions: ["channel", "file", "raviChannel", "connection", "text", "metadata", "threadTs"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async workObjectsSend(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("file", { description: "Path to Slack native Work Object message JSON" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--connection <name>", description: "Ravi channel config; SDK-safe alias for --channel" })
    connection?: string,
    @Option({ flags: "--text <text>", description: "Top-level fallback text for notifications/accessibility" })
    text?: string,
    @Option({ flags: "--thread-ts <ts>", description: "Send inside a Slack thread" }) threadTs?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const message = normalizeSlackNativeWorkObjectMessagePayload(
      readJsonObjectFile(file, "Slack Work Object message payload"),
      text,
    );
    const request = {
      channel,
      file,
      text: message.text,
      metadata: message.metadata,
      ...(threadTs ? { threadTs } : {}),
    };
    const op = "slack work-objects-send";
    const { client, config } = await createSlackOpsContext(connection || raviChannel, "chat.postMessage", {
      op,
      asJson,
    });
    if (!execute) this.brakeDryRun(op, config, "chat.postMessage", request, asJson, message.metadata);
    const raw = await client.postMessage({
      channel,
      text: message.text,
      metadata: message.metadata,
      ...(threadTs ? { threadTs } : {}),
    });
    const payload = this.mutationPayload(config, false, "chat.postMessage", request, raw, raw.raw);
    if (asJson) printJson(payload);
    else console.log(`${raw.channel} ${raw.ts}`);
    return payload;
  }

  @Command({
    name: "work-objects-unfurl",
    description: "Attach Slack native Work Object metadata with chat.unfurl; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.work-objects",
    action: "unfurl",
    risk: "high",
    redactions: ["channel", "ts", "url", "file", "metadata", "unfurls", "raviChannel", "connection"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async workObjectsUnfurl(
    @Arg("channel", { description: "Slack channel/conversation ID containing the URL message" }) channel: string,
    @Arg("ts", { description: "Slack message timestamp containing the URL" }) ts: string,
    @Arg("url", { description: "URL in the message to unfurl" }) url: string,
    @Arg("file", { description: "Path to Slack native Work Object metadata JSON" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--connection <name>", description: "Ravi channel config; SDK-safe alias for --channel" })
    connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const unfurl = normalizeSlackNativeWorkObjectUnfurlPayload(
      readJsonObjectFile(file, "Slack Work Object unfurl payload"),
      url,
    );
    const op = "slack work-objects-unfurl";
    const request = { channel, ts, url, file, ...unfurl };
    const { client, config } = await createSlackOpsContext(connection || raviChannel, "chat.unfurl", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "chat.unfurl", request, asJson, unfurl.metadata);
    let raw;
    try {
      raw = await client.unfurl({
        channel,
        ts,
        metadata: unfurl.metadata,
        unfurls: unfurl.unfurls,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("cannot_unfurl_url")) {
        fail(
          "Slack chat.unfurl failed: cannot_unfurl_url. Work Object unfurls must be applied to a URL from a real Slack link_shared event for a domain registered on the Slack app; arbitrary or bot-posted URL messages may not be unfurlable.",
        );
      }
      throw error;
    }
    const payload = this.mutationPayload(config, false, "chat.unfurl", request, raw, raw);
    if (asJson) printJson(payload);
    else console.log(raw.ok === true ? "unfurled" : JSON.stringify(raw, null, 2));
    return payload;
  }

  @Command({
    name: "work-objects-present-details",
    description: "Present Slack native Work Object flexpane details; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.work-objects",
    action: "present-details",
    risk: "high",
    redactions: ["triggerId", "file", "metadata", "raviChannel", "connection"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async workObjectsPresentDetails(
    @Arg("triggerId", { description: "Slack entity_details_requested trigger_id" }) triggerId: string,
    @Arg("file", { description: "Path to Slack native Work Object detail metadata JSON" }) file: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--connection <name>", description: "Ravi channel config; SDK-safe alias for --channel" })
    connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const metadata = normalizeSlackNativeWorkObjectDetailMetadata(
      readJsonObjectFile(file, "Slack Work Object detail metadata"),
    );
    const op = "slack work-objects-present-details";
    const request = { triggerId, file, metadata };
    const { client, config } = await createSlackOpsContext(connection || raviChannel, "entity.presentDetails", {
      op,
      asJson,
    });
    if (!execute) this.brakeDryRun(op, config, "entity.presentDetails", request, asJson, metadata);
    const raw = await client.entityPresentDetails({ triggerId, metadata });
    const payload = this.mutationPayload(config, false, "entity.presentDetails", request, raw, raw);
    if (asJson) printJson(payload);
    else console.log(raw.ok === true ? "presented" : JSON.stringify(raw, null, 2));
    return payload;
  }

  @Command({ name: "channels-info", description: "Show Slack conversation metadata" })
  @CommandAccess({
    kind: "read",
    resource: "slack.channels",
    action: "info",
    risk: "low",
    redactions: ["channel", "raviChannel"],
  })
  @Returns(slackObjectReturnSchema)
  async channelsInfo(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { client, config } = await createSlackOpsContext(raviChannel, "conversations.info", {
      op: "slack channels-info",
      asJson,
    });
    const raw = await client.conversationsInfo({ channel });
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      item: raw.channel,
      raw,
    };
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(raw.channel, null, 2));
    return payload;
  }

  @Command({ name: "channels-history", description: "Read Slack conversation history" })
  @CommandAccess({
    kind: "read",
    resource: "slack.channels",
    action: "history",
    risk: "medium",
    redactions: ["channel", "raviChannel", "cursor", "latest", "oldest"],
  })
  @Returns(slackListReturnSchema)
  async channelsHistory(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "20" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--latest <ts>", description: "Latest Slack timestamp" }) latest?: string,
    @Option({ flags: "--oldest <ts>", description: "Oldest Slack timestamp" }) oldest?: string,
    @Option({ flags: "--inclusive", description: "Include boundary timestamps" }) inclusive?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 20);
    const { client, config } = await createSlackOpsContext(raviChannel, "conversations.history", {
      op: "slack channels-history",
      asJson,
    });
    const raw = await client.conversationsHistory({ channel, limit, cursor, latest, oldest, inclusive });
    const items = raw.messages ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      // Compact mode (Manual v2 7.9): narrows the JSON items only.
      items: pickFields(items, fields),
      pagination: pagination(limit, cursor, raw.response_metadata?.next_cursor, raw.has_more),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const item of items) console.log(JSON.stringify(item));
    }
    return payload;
  }

  @Command({ name: "messages-inspect", description: "Inspect whether a Slack message exists in Slack and Ravi" })
  @CommandAccess({
    kind: "read",
    resource: "slack.messages",
    action: "inspect",
    risk: "medium",
    redactions: ["channel", "ts", "raviChannel"],
  })
  @Returns(slackObjectReturnSchema)
  async messagesInspect(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("ts", { description: "Slack message timestamp" }) ts: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { client, config } = await createSlackOpsContext(raviChannel, "conversations.history", {
      op: "slack messages-inspect",
      asJson,
    });
    const message = await fetchSlackMessageByTs(client, channel, ts);
    const local = message ? findLocalSlackMessage(config, channel, message) : { chat: null, message: null };
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      item: {
        channel,
        ts,
        foundInSlack: Boolean(message),
        foundInRavi: Boolean(local.message),
        slackMessage: message ? summarizeSlackMessage(message) : null,
        local,
      },
    };
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload.item, null, 2));
    return payload;
  }

  @Command({ name: "messages-replay", description: "Replay a Slack message through the native Ravi channel pipeline" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.messages",
    action: "replay",
    risk: "high",
    redactions: ["channel", "ts", "raviChannel"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async messagesReplay(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("ts", { description: "Slack message timestamp" }) ts: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--force", description: "Replay even when the message is already in Ravi" }) force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the replay; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack messages-replay";
    const request = { channel, ts, force: Boolean(force) };
    const { client, config } = await createSlackOpsContext(raviChannel, "slack.messages.replay", { op, asJson });
    if (!execute) {
      // Write brake (Manual v2 7.8): the brake fires BEFORE the
      // conversations.history fetch — a dry-run performs no Slack Web API call.
      this.brakeDryRun(op, config, "slack.messages.replay", request, asJson, {
        note: "Inspect the message first with: ravi slack messages-inspect <channel> <ts> --json",
      });
    }
    const message = await fetchSlackMessageByTs(client, channel, ts);
    if (!message) {
      contractFail(op, "MESSAGE_NOT_FOUND", `Slack message not found: ${channel} ${ts}`, {
        asJson,
        details: {
          suggestedAction: `Check the timestamp with: ravi slack channels-history ${channel} --json`,
        },
      });
    }

    const localBefore = findLocalSlackMessage(config, channel, message);

    if (localBefore.message && !force) {
      const payload = this.mutationPayload(config, false, "slack.messages.replay", request, {
        status: "skipped",
        reason: "already_ingested",
        slackMessage: summarizeSlackMessage(message),
        localBefore,
      });
      if (asJson) printJson(payload);
      else console.log(JSON.stringify(payload.item, null, 2));
      return payload;
    }

    const envelope = buildSlackReplayEnvelope({
      connection: connectionLabel(config),
      channel,
      message,
    });
    const service = new SlackSocketModeService({
      appToken: config.appToken,
      botToken: config.botToken,
      accountId: config.accountId,
      routeAccountId: config.routeAccountId ?? config.accountId,
      instanceId: config.instanceId,
      webClient: client,
    });
    const replayStatus = await service.handleEnvelope(envelope);
    const localAfter = findLocalSlackMessage(config, channel, message);
    const payload = this.mutationPayload(config, false, "slack.messages.replay", request, {
      status: replayStatus,
      slackMessage: summarizeSlackMessage(message),
      localBefore,
      localAfter,
    });
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload.item, null, 2));
    return payload;
  }

  @Command({ name: "members-list", description: "List Slack conversation members" })
  @CommandAccess({
    kind: "read",
    resource: "slack.members",
    action: "list",
    risk: "medium",
    redactions: ["channel", "raviChannel", "cursor"],
  })
  @Returns(slackListReturnSchema)
  async membersList(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "100" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 100);
    const { client, config } = await createSlackOpsContext(raviChannel, "conversations.members", {
      op: "slack members-list",
      asJson,
    });
    const raw = await client.conversationsMembers({ channel, limit, cursor });
    const items = raw.members ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      items,
      pagination: pagination(limit, cursor, raw.response_metadata?.next_cursor),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const member of items) console.log(member);
    }
    return payload;
  }

  @Command({ name: "files-list", description: "List Slack files visible to the configured bot" })
  @CommandAccess({
    kind: "read",
    resource: "slack.files",
    action: "list",
    risk: "medium",
    redactions: ["raviChannel", "channel", "user", "cursor"],
  })
  @Returns(slackListReturnSchema)
  async filesList(
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--slack-channel <id>", description: "Restrict to a Slack channel/conversation ID" })
    channel?: string,
    @Option({ flags: "--user <id>", description: "Restrict to a Slack user ID" }) user?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "20" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 20);
    const { client, config } = await createSlackOpsContext(raviChannel, "files.list", {
      op: "slack files-list",
      asJson,
    });
    const raw = await client.filesList({ channel, user, limit, cursor });
    const items = raw.files ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      // Compact mode (Manual v2 7.9): narrows the JSON items only.
      items: pickFields(items, fields),
      pagination: pagination(limit, cursor, raw.response_metadata?.next_cursor),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const item of items) console.log(JSON.stringify(item));
    }
    return payload;
  }

  @Command({ name: "topology", description: "Show Slack channels and Ravi route/session ownership" })
  @CommandAccess({
    kind: "read",
    resource: "slack.topology",
    action: "read",
    risk: "medium",
    redactions: ["raviChannel", "cursor"],
  })
  @Returns(slackTopologyReturnSchema)
  async topology(
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({
      flags: "--types <types>",
      description: "Slack conversation types",
      defaultValue: "public_channel,private_channel",
    })
    types?: string,
    @Option({ flags: "--limit <n>", description: "Conversation page size", defaultValue: "200" }) limitValue?: string,
    @Option({ flags: "--cursor <cursor>", description: "Slack pagination cursor" }) cursor?: string,
    @Option({ flags: "--include-archived", description: "Include archived conversations" }) includeArchived?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = parsePositiveInt(limitValue, 200);
    const { client, config } = await createSlackOpsContext(raviChannel, "slack.topology", {
      op: "slack topology",
      asJson,
    });
    const accountId = connectionLabel(config);
    const conversations = await client.conversationsList({
      types,
      limit,
      cursor,
      excludeArchived: !includeArchived,
    });

    const topology = buildSlackTopology({
      accountId,
      channels: conversations.channels ?? [],
      routerConfig: configStore.getConfig(),
      getContactStatus: ({ peerId }) => getContact(peerId)?.status,
    });
    const payload = {
      ...topology,
      connection: accountId,
      source: config.source,
      pagination: pagination(limit, cursor, conversations.response_metadata?.next_cursor),
    };
    if (asJson) printJson(payload);
    else this.printTopologySummary(payload);
    return payload;
  }

  @Command({ name: "channels-create", description: "Create a Slack channel; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.channels",
    action: "create",
    risk: "high",
    redactions: ["name", "raviChannel"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async channelsCreate(
    @Arg("name", { description: "New Slack channel name" }) name: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--private", description: "Create a private channel" }) isPrivate?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack channels-create";
    const request = { name, isPrivate: Boolean(isPrivate) };
    const { client, config } = await createSlackOpsContext(raviChannel, "conversations.create", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "conversations.create", request, asJson);
    const raw = await client.conversationsCreate(request);
    const payload = this.mutationPayload(config, false, "conversations.create", request, raw.channel, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(raw.channel, null, 2));
    return payload;
  }

  @Command({ name: "channels-rename", description: "Rename a Slack channel; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.channels",
    action: "rename",
    risk: "high",
    redactions: ["channel", "name", "raviChannel"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async channelsRename(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("name", { description: "New Slack channel name" }) name: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack channels-rename";
    const request = { channel, name };
    const { client, config } = await createSlackOpsContext(raviChannel, "conversations.rename", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "conversations.rename", request, asJson);
    const raw = await client.conversationsRename(request);
    const payload = this.mutationPayload(config, false, "conversations.rename", request, raw.channel, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(raw.channel, null, 2));
    return payload;
  }

  @Command({ name: "channels-invite", description: "Invite Slack users to a channel; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.channels",
    action: "invite",
    risk: "high",
    redactions: ["channel", "users", "raviChannel", "connection"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async channelsInvite(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Arg("users", { description: "Comma-separated Slack user IDs" }) usersValue: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--connection <name>", description: "Ravi channel config; SDK-safe alias for --channel" })
    connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack channels-invite";
    const request = { channel, userIds: parseRequiredCsvOption(usersValue, "Slack user ids") };
    const { client, config } = await createSlackOpsContext(connection || raviChannel, "conversations.invite", {
      op,
      asJson,
    });
    if (!execute) this.brakeDryRun(op, config, "conversations.invite", request, asJson);
    const raw = await client.conversationsInvite(request);
    const payload = this.mutationPayload(config, false, "conversations.invite", request, raw.channel, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(raw.channel, null, 2));
    return payload;
  }

  @Command({ name: "canvas-create", description: "Create a Slack standalone canvas; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "create",
    risk: "high",
    redactions: ["raviChannel", "title", "markdown", "markdownFile", "artifact", "channelId"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasCreate(
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--title <title>", description: "Canvas title" }) title?: string,
    @Option({ flags: "--markdown <text>", description: "Initial canvas markdown" }) markdownValue?: string,
    @Option({ flags: "--markdown-file <path>", description: "Read initial canvas markdown from a file" })
    markdownFile?: string,
    @Option({ flags: "--artifact <id>", description: "Read initial canvas markdown from a Ravi artifact" })
    artifactId?: string,
    @Option({ flags: "--slack-channel <id>", description: "Optional Slack channel tab target" }) channelId?: string,
    @Option({
      flags: "--skip-refresh",
      description: "Do not refresh the artifact from its source file before publishing",
    })
    skipRefresh?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-create";
    const source = resolveSlackCanvasMarkdownSource({
      markdown: markdownValue,
      markdownFile,
      artifactId,
      execute: Boolean(execute),
      refreshSource: !skipRefresh,
      contract: { op, asJson },
    });
    const markdown = source.markdown;
    const request = {
      ...(title ? { title } : {}),
      ...(markdown?.trim() ? { markdown } : {}),
      ...(channelId ? { channelId } : {}),
      ...slackCanvasMarkdownSourceRequest(source),
    };
    const { client, config } = await createSlackOpsContext(raviChannel, "canvases.create", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "canvases.create", request, asJson);
    const raw = await client.canvasesCreate(request);
    const canvasId = raw.canvas_id ?? null;
    const artifactRecord =
      canvasId && canRecordSlackCanvasArtifactPublish(source)
        ? recordSlackCanvasArtifactPublish({
            artifact: source.artifact,
            canvasId,
            ...(channelId ? { channelId } : {}),
            config,
            title: title?.trim() || source.artifact.title || canvasId,
            markdownSha256: source.markdownSha256,
            markdownChars: source.markdownChars,
          })
        : undefined;
    const item = {
      canvasId,
      canvas: raw.canvas ?? null,
      ...(artifactRecord
        ? {
            artifactId: artifactRecord.artifact.id,
            artifactVersionNumber: artifactRecord.version.versionNumber,
            syncDirection: "artifact_to_slack",
          }
        : {}),
    };
    const payload = this.mutationPayload(
      config,
      false,
      "canvases.create",
      request,
      item,
      artifactRecord ? { ...raw, artifactEvent: artifactRecord.state } : raw,
    );
    if (asJson) printJson(payload);
    else console.log(raw.canvas_id ?? JSON.stringify(item, null, 2));
    return payload;
  }

  @Command({
    name: "canvas-channel-create",
    description: "Create a Slack channel canvas; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "create",
    risk: "high",
    redactions: ["channel", "raviChannel", "title", "markdown", "markdownFile", "artifact"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasChannelCreate(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--title <title>", description: "Canvas title" }) title?: string,
    @Option({ flags: "--markdown <text>", description: "Initial canvas markdown" }) markdownValue?: string,
    @Option({ flags: "--markdown-file <path>", description: "Read initial canvas markdown from a file" })
    markdownFile?: string,
    @Option({ flags: "--artifact <id>", description: "Read initial canvas markdown from a Ravi artifact" })
    artifactId?: string,
    @Option({ flags: "--ensure", description: "Return existing channel canvas when it already exists" })
    ensure?: boolean,
    @Option({
      flags: "--skip-refresh",
      description: "Do not refresh the artifact from its source file before publishing",
    })
    skipRefresh?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-channel-create";
    const source = resolveSlackCanvasMarkdownSource({
      markdown: markdownValue,
      markdownFile,
      artifactId,
      execute: Boolean(execute),
      refreshSource: !skipRefresh,
      contract: { op, asJson },
    });
    const markdown = source.markdown;
    const request = {
      channelId: channel,
      ...(title ? { title } : {}),
      ...(markdown?.trim() ? { markdown } : {}),
      ensure: Boolean(ensure),
      ...slackCanvasMarkdownSourceRequest(source),
    };
    const { client, config } = await createSlackOpsContext(raviChannel, "conversations.canvases.create", {
      op,
      asJson,
    });
    if (!execute) this.brakeDryRun(op, config, "conversations.canvases.create", request, asJson);

    const raw = await client.conversationsCanvasesCreate(request, {
      okErrors: ensure ? ["channel_canvas_already_exists"] : [],
    });
    if (raw.ok === false && raw.error === "channel_canvas_already_exists") {
      const info = await client.conversationsInfo({ channel });
      const canvasId = extractSlackCanvasIdFromConversationInfo(info.channel);
      const item = { status: "exists", channel, canvasId: canvasId ?? null };
      const payload = this.mutationPayload(config, false, "conversations.canvases.create", request, item, {
        create: raw,
        info,
      });
      if (asJson) printJson(payload);
      else console.log(JSON.stringify(item, null, 2));
      return payload;
    }

    const canvasId = raw.canvas_id ?? null;
    const artifactRecord =
      canvasId && canRecordSlackCanvasArtifactPublish(source)
        ? recordSlackCanvasArtifactPublish({
            artifact: source.artifact,
            canvasId,
            channelId: channel,
            config,
            title: title?.trim() || source.artifact.title || canvasId,
            markdownSha256: source.markdownSha256,
            markdownChars: source.markdownChars,
          })
        : undefined;
    const item = {
      status: "created",
      channel,
      canvasId,
      canvas: raw.canvas ?? null,
      ...(artifactRecord
        ? {
            artifactId: artifactRecord.artifact.id,
            artifactVersionNumber: artifactRecord.version.versionNumber,
            syncDirection: "artifact_to_slack",
          }
        : {}),
    };
    const payload = this.mutationPayload(
      config,
      false,
      "conversations.canvases.create",
      request,
      item,
      artifactRecord ? { ...raw, artifactEvent: artifactRecord.state } : raw,
    );
    if (asJson) printJson(payload);
    else console.log(raw.canvas_id ?? JSON.stringify(item, null, 2));
    return payload;
  }

  @Command({
    name: "canvas-showcase",
    description: "Publish the Ravi Slack Canvas showcase into an existing canvas; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "showcase",
    risk: "high",
    redactions: ["canvas", "raviChannel", "channelId", "title"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasShowcase(
    @Arg("canvas", { description: "Slack canvas ID" }) canvasId: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--slack-channel <id>", description: "Slack channel/conversation ID for the showcase context" })
    channelId?: string,
    @Option({ flags: "--title <title>", description: "Canvas title" }) titleValue?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-showcase";
    const title = titleValue?.trim() || SLACK_CANVAS_SHOWCASE_TITLE;
    const markdown = buildSlackCanvasShowcaseMarkdown({ canvasId, channelId, title });
    const request = { canvasId, ...(channelId ? { channelId } : {}), title, markdown };
    const { client, config } = await createSlackOpsContext(raviChannel, "slack.canvas.showcase", { op, asJson });
    if (!execute) {
      this.brakeDryRun(op, config, "slack.canvas.showcase", request, asJson, {
        title,
        markdownChars: markdown.length,
      });
    }

    const published = await this.publishCanvasShowcase(client, { canvasId, channelId, title });
    const item = { status: "published", canvasId, channelId: channelId ?? null, title };
    const payload = this.mutationPayload(config, false, "slack.canvas.showcase", request, item, published.raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(item, null, 2));
    return payload;
  }

  @Command({
    name: "canvas-channel-showcase",
    description: "Create or reuse a channel canvas and publish the Ravi showcase; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "showcase",
    risk: "high",
    redactions: ["channel", "raviChannel", "title"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasChannelShowcase(
    @Arg("channel", { description: "Slack channel/conversation ID" }) channel: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--title <title>", description: "Canvas title" }) titleValue?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-channel-showcase";
    const title = titleValue?.trim() || SLACK_CANVAS_SHOWCASE_TITLE;
    const dryRunMarkdown = buildSlackCanvasShowcaseMarkdown({ channelId: channel, title });
    const request = { channelId: channel, title, markdown: dryRunMarkdown };
    const { client, config } = await createSlackOpsContext(raviChannel, "slack.canvas.channelShowcase", {
      op,
      asJson,
    });
    if (!execute) {
      this.brakeDryRun(op, config, "slack.canvas.channelShowcase", request, asJson, {
        title,
        markdownChars: dryRunMarkdown.length,
      });
    }

    let info = await client.conversationsInfo({ channel });
    let canvasId = extractSlackCanvasIdFromConversationInfo(info.channel, title);
    let createStatus: "created" | "exists" = canvasId ? "exists" : "created";
    let create: Record<string, unknown> | undefined;
    if (!canvasId) {
      create = await client.conversationsCanvasesCreate(
        { channelId: channel, title },
        { okErrors: ["channel_canvas_already_exists"] },
      );
      canvasId = stringField(create, "canvas_id");
      if (create.ok === false && create.error === "channel_canvas_already_exists") {
        createStatus = "exists";
        info = await client.conversationsInfo({ channel });
        canvasId = extractSlackCanvasIdFromConversationInfo(info.channel, title);
      }
    }
    if (!canvasId) {
      contractFail(op, "CANVAS_NOT_FOUND", `Could not resolve Slack channel canvas id for ${channel}`, {
        asJson,
        details: {
          suggestedAction: `Inspect the channel canvas tabs with: ravi slack channels-info ${channel} --json`,
        },
      });
    }

    const published = await this.publishCanvasShowcase(client, { canvasId, channelId: channel, title });
    const item = { status: "published", createStatus, canvasId, channelId: channel, title };
    const publishRequest = {
      channelId: channel,
      canvasId,
      title,
      markdown: buildSlackCanvasShowcaseMarkdown({ canvasId, channelId: channel, title }),
    };
    const payload = this.mutationPayload(config, false, "slack.canvas.channelShowcase", publishRequest, item, {
      ...(create ? { create } : {}),
      info,
      ...published.raw,
    });
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(item, null, 2));
    return payload;
  }

  @Command({
    name: "canvas-artifact-publish",
    description:
      "Compatibility helper for publishing Markdown to Slack Canvas; prefer native canvas-create/channel-create/edit --artifact",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "publish-artifact",
    risk: "high",
    redactions: [
      "artifactOrFile",
      "raviChannel",
      "canvasId",
      "channelId",
      "title",
    ],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasArtifactPublish(
    @Arg("artifactOrFile", { description: "Ravi artifact id or local Markdown file path" }) artifactOrFile: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--canvas <id>", description: "Publish into an existing Slack canvas ID" }) canvasIdValue?: string,
    @Option({ flags: "--slack-channel <id>", description: "Create/reuse a channel canvas for this Slack channel" })
    channelId?: string,
    @Option({ flags: "--title <title>", description: "Canvas title" }) titleValue?: string,
    @Option({
      flags: "--skip-refresh",
      description: "Do not refresh the artifact from its source file before publishing",
    })
    skipRefresh?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-artifact-publish";
    if (canvasIdValue?.trim() && channelId?.trim()) fail("Pass only one of --canvas or --slack-channel.");
    if (!canvasIdValue?.trim() && !channelId?.trim()) fail("Pass one of --canvas or --slack-channel.");

    const { client, config } = await createSlackOpsContext(raviChannel, "slack.canvas.artifact.publish", {
      op,
      asJson,
    });
    const source = resolveSlackCanvasArtifactSource({
      artifactOrFile,
      title: titleValue,
      execute: Boolean(execute),
      refreshSource: !skipRefresh,
      contract: { op, asJson },
    });
    const title =
      titleValue?.trim() || source.artifact?.title || (source.sourcePath ? basename(source.sourcePath) : "Ravi Canvas");
    const request = {
      artifactId: source.artifact?.id ?? null,
      sourceKind: source.sourceKind,
      sourcePath: source.sourcePath ?? null,
      canvasId: canvasIdValue?.trim() || null,
      channelId: channelId?.trim() || null,
      title,
      publishMode: "replace",
      markdownSha256: source.markdownSha256,
      markdownChars: source.markdownChars,
      refreshSource: !skipRefresh,
      refreshed: source.refreshed,
      sourceFileChanged: source.sourceFileChanged,
    };
    if (!execute) {
      this.brakeDryRun(op, config, "slack.canvas.artifact.publish", request, asJson, {
        ...request,
        limitation: SLACK_CANVAS_REMOTE_EXPORT_LIMITATION,
      });
    }
    if (!source.artifact) fail("Could not create or resolve Ravi artifact for Slack Canvas publish.");

    const target = await this.resolveCanvasPublishTarget(
      client,
      {
        canvasId: canvasIdValue?.trim(),
        channelId: channelId?.trim(),
        title,
      },
      { op, asJson },
    );
    const published = await this.publishCanvasMarkdown(client, {
      canvasId: target.canvasId,
      title,
      markdown: source.markdown,
    });
    const recorded = recordSlackCanvasArtifactPublish({
      artifact: source.artifact,
      canvasId: target.canvasId,
      ...(target.channelId ? { channelId: target.channelId } : {}),
      config,
      title,
      markdownSha256: source.markdownSha256,
      markdownChars: source.markdownChars,
    });
    const item = {
      status: "published",
      artifactId: recorded.artifact.id,
      artifactVersionNumber: recorded.version.versionNumber,
      canvasId: target.canvasId,
      channelId: target.channelId ?? null,
      createStatus: target.createStatus,
      title,
      markdownSha256: source.markdownSha256,
      markdownChars: source.markdownChars,
      syncDirection: "artifact_to_slack",
      remoteContentReadable: false,
      limitation: SLACK_CANVAS_REMOTE_EXPORT_LIMITATION,
    };
    const payload = this.mutationPayload(config, false, "slack.canvas.artifact.publish", request, item, {
      ...target.raw,
      ...published.raw,
      artifactEvent: recorded.state,
    });
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(item, null, 2));
    return payload;
  }

  @Command({
    name: "canvas-artifact-status",
    description: "Show local Slack Canvas publish status for a Ravi artifact",
  })
  @CommandAccess({
    kind: "read",
    resource: "slack.canvas",
    action: "artifact-status",
    risk: "low",
    redactions: ["artifact"],
  })
  @Returns(slackCanvasArtifactStatusReturnSchema)
  canvasArtifactStatus(
    @Arg("artifact", { description: "Ravi artifact id" }) artifactId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const item = buildSlackCanvasArtifactStatus(artifactId, { op: "slack canvas-artifact-status", asJson });
    const payload = {
      ok: true as const,
      provider: "slack" as const,
      item,
    };
    if (asJson) printJson(payload);
    else {
      console.log(`artifact=${item.artifactId}`);
      console.log(`canvas=${recordValue(item.published)?.canvasId ?? "not-published"}`);
      console.log(`localDiffersFromPublished=${item.localDiffersFromPublished}`);
      console.log(`sourceFileChanged=${item.sourceFileChanged}`);
    }
    return payload;
  }

  @Command({
    name: "canvas-edit",
    description: "Edit a Slack canvas section or title; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "edit",
    risk: "high",
    redactions: ["canvas", "operation", "raviChannel", "sectionId", "markdown", "markdownFile", "artifact", "title"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasEdit(
    @Arg("canvas", { description: "Slack canvas ID" }) canvasId: string,
    @Arg("operation", { description: "insert_after|insert_before|insert_at_start|insert_at_end|replace|delete|rename" })
    operation: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--section-id <id>", description: "Slack canvas section ID" }) sectionId?: string,
    @Option({ flags: "--markdown <text>", description: "Markdown content for insert/replace operations" })
    markdownValue?: string,
    @Option({ flags: "--markdown-file <path>", description: "Read markdown content from a file" })
    markdownFile?: string,
    @Option({ flags: "--artifact <id>", description: "Read markdown content from a Ravi artifact" })
    artifactId?: string,
    @Option({ flags: "--title <title>", description: "New title for rename operation" }) title?: string,
    @Option({
      flags: "--skip-refresh",
      description: "Do not refresh the artifact from its source file before publishing",
    })
    skipRefresh?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-edit";
    const source = resolveSlackCanvasMarkdownSource({
      markdown: markdownValue,
      markdownFile,
      artifactId,
      execute: Boolean(execute),
      refreshSource: !skipRefresh,
      contract: { op, asJson },
    });
    const markdown = source.markdown;
    const change = buildSlackCanvasEditChange({ operation, sectionId, markdown, title });
    const request = { canvasId, changes: [change], ...slackCanvasMarkdownSourceRequest(source) };
    const { client, config } = await createSlackOpsContext(raviChannel, "canvases.edit", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "canvases.edit", request, asJson, change);
    const raw = await client.canvasesEdit(request);
    const artifactRecord =
      isWholeCanvasReplace(change) && canRecordSlackCanvasArtifactPublish(source)
        ? recordSlackCanvasArtifactPublish({
            artifact: source.artifact,
            canvasId,
            config,
            title: source.artifact.title || canvasId,
            markdownSha256: source.markdownSha256,
            markdownChars: source.markdownChars,
          })
        : undefined;
    const item = {
      ...(recordValue(raw.canvas) ?? { ok: raw.ok }),
      ...(artifactRecord
        ? {
            artifactId: artifactRecord.artifact.id,
            artifactVersionNumber: artifactRecord.version.versionNumber,
            syncDirection: "artifact_to_slack",
          }
        : {}),
    };
    const payload = this.mutationPayload(
      config,
      false,
      "canvases.edit",
      request,
      item,
      artifactRecord ? { ...raw, artifactEvent: artifactRecord.state } : raw,
    );
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload.item, null, 2));
    return payload;
  }

  @Command({ name: "canvas-sections-lookup", description: "Lookup Slack canvas section IDs" })
  @CommandAccess({
    kind: "read",
    resource: "slack.canvas",
    action: "lookup",
    risk: "medium",
    redactions: ["canvas", "raviChannel", "cursor"],
  })
  @Returns(slackListReturnSchema)
  async canvasSectionsLookup(
    @Arg("canvas", { description: "Slack canvas ID" }) canvasId: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({
      flags: "--section-types <types>",
      description: "Comma-separated section types, e.g. h1,h2,h3,any_header",
      defaultValue: "any_header",
    })
    sectionTypesValue?: string,
    @Option({ flags: "--contains-text <text>", description: "Text that matching sections must contain" })
    containsText?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sectionTypes = parseCsvOption(sectionTypesValue);
    const request = {
      canvasId,
      ...(sectionTypes ? { sectionTypes } : {}),
      ...(containsText ? { containsText } : {}),
    };
    const { client, config } = await createSlackOpsContext(raviChannel, "canvases.sections.lookup", {
      op: "slack canvas-sections-lookup",
      asJson,
    });
    const raw = await client.canvasesSectionsLookup(request);
    const items = raw.sections ?? [];
    const payload = {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      // Compact mode (Manual v2 7.9): narrows the JSON items only.
      items: pickFields(items, fields),
      pagination: pagination(items.length, undefined, undefined),
      raw,
    };
    if (asJson) printJson(payload);
    else {
      for (const item of items) console.log(JSON.stringify(item));
    }
    return payload;
  }

  @Command({
    name: "canvas-access-set",
    description: "Set Slack standalone canvas access; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "share",
    risk: "high",
    redactions: ["canvas", "access", "raviChannel", "users", "channels"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasAccessSet(
    @Arg("canvas", { description: "Slack canvas ID" }) canvasId: string,
    @Arg("access", { description: "read|write|owner" }) access: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--users <ids>", description: "Comma-separated Slack user IDs" }) usersValue?: string,
    @Option({ flags: "--channels <ids>", description: "Comma-separated Slack channel IDs" }) channelsValue?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-access-set";
    const accessLevel = parseSlackCanvasAccessLevel(access);
    const targets = parseSlackCanvasAccessTargets(usersValue, channelsValue);
    validateSlackCanvasAccessLevelTargets(accessLevel, targets);
    const request = {
      canvasId,
      accessLevel,
      ...targets,
    };
    const { client, config } = await createSlackOpsContext(raviChannel, "canvases.access.set", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "canvases.access.set", request, asJson);
    const raw = await client.canvasesAccessSet(request);
    const payload = this.mutationPayload(config, false, "canvases.access.set", request, { ok: raw.ok }, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload.item, null, 2));
    return payload;
  }

  @Command({
    name: "canvas-access-delete",
    description: "Delete Slack standalone canvas access; dry-run unless --execute is set",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "unshare",
    risk: "high",
    redactions: ["canvas", "raviChannel", "users", "channels"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasAccessDelete(
    @Arg("canvas", { description: "Slack canvas ID" }) canvasId: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--users <ids>", description: "Comma-separated Slack user IDs" }) usersValue?: string,
    @Option({ flags: "--channels <ids>", description: "Comma-separated Slack channel IDs" }) channelsValue?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-access-delete";
    const request = {
      canvasId,
      ...parseSlackCanvasAccessTargets(usersValue, channelsValue),
    };
    const { client, config } = await createSlackOpsContext(raviChannel, "canvases.access.delete", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "canvases.access.delete", request, asJson);
    const raw = await client.canvasesAccessDelete(request);
    const payload = this.mutationPayload(config, false, "canvases.access.delete", request, { ok: raw.ok }, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload.item, null, 2));
    return payload;
  }

  @Command({ name: "canvas-delete", description: "Delete a Slack standalone canvas; dry-run unless --execute is set" })
  @CommandAccess({
    kind: "mutate",
    resource: "slack.canvas",
    action: "delete",
    risk: "high",
    redactions: ["canvas", "raviChannel"],
    requiresConfirmation: true,
  })
  @Returns(slackMutationReturnSchema)
  async canvasDelete(
    @Arg("canvas", { description: "Slack canvas ID" }) canvasId: string,
    @Option({ flags: "--channel <name>", description: "Ravi channel config" }) raviChannel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Perform the mutation; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "slack canvas-delete";
    const request = { canvasId };
    const { client, config } = await createSlackOpsContext(raviChannel, "canvases.delete", { op, asJson });
    if (!execute) this.brakeDryRun(op, config, "canvases.delete", request, asJson);
    const raw = await client.canvasesDelete(request);
    const payload = this.mutationPayload(config, false, "canvases.delete", request, { ok: raw.ok }, raw);
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload.item, null, 2));
    return payload;
  }

  private async publishCanvasShowcase(
    client: SlackWebApiClient,
    input: { readonly canvasId: string; readonly channelId?: string; readonly title: string },
  ): Promise<{ raw: Record<string, unknown> }> {
    const markdown = buildSlackCanvasShowcaseMarkdown(input);
    return this.publishCanvasMarkdown(client, { canvasId: input.canvasId, title: input.title, markdown });
  }

  private async publishCanvasMarkdown(
    client: SlackWebApiClient,
    input: { readonly canvasId: string; readonly title: string; readonly markdown: string },
  ): Promise<{ raw: Record<string, unknown> }> {
    const rename = await client.canvasesEdit({
      canvasId: input.canvasId,
      changes: [{ operation: "rename", title: input.title }],
    });
    const replace = await client.canvasesEdit({
      canvasId: input.canvasId,
      changes: [{ operation: "replace", markdown: input.markdown }],
    });
    return { raw: { rename, replace } };
  }

  private async resolveCanvasPublishTarget(
    client: SlackWebApiClient,
    input: { readonly canvasId?: string; readonly channelId?: string; readonly title: string },
    contract: SlackContractContext,
  ): Promise<{
    canvasId: string;
    channelId?: string;
    createStatus: "created" | "exists" | "provided";
    raw: Record<string, unknown>;
  }> {
    if (input.canvasId) return { canvasId: input.canvasId, createStatus: "provided", raw: {} };
    if (!input.channelId) fail("Pass one of --canvas or --channel.");

    let info = await client.conversationsInfo({ channel: input.channelId });
    let canvasId = extractSlackCanvasIdFromConversationInfo(info.channel, input.title);
    let createStatus: "created" | "exists" = canvasId ? "exists" : "created";
    let create: Record<string, unknown> | undefined;

    if (!canvasId) {
      create = await client.conversationsCanvasesCreate(
        { channelId: input.channelId, title: input.title },
        { okErrors: ["channel_canvas_already_exists"] },
      );
      canvasId = stringField(create, "canvas_id");
      if (create.ok === false && create.error === "channel_canvas_already_exists") {
        createStatus = "exists";
        info = await client.conversationsInfo({ channel: input.channelId });
        canvasId = extractSlackCanvasIdFromConversationInfo(info.channel, input.title);
      }
    }

    if (!canvasId) {
      contractFail(
        contract.op,
        "CANVAS_NOT_FOUND",
        `Could not resolve Slack channel canvas id for ${input.channelId}`,
        {
          asJson: contract.asJson,
          details: {
            suggestedAction: `Inspect the channel canvas tabs with: ravi slack channels-info ${input.channelId} --json`,
          },
        },
      );
    }
    return {
      canvasId,
      channelId: input.channelId,
      createStatus,
      raw: {
        info,
        ...(create ? { create } : {}),
      },
    };
  }

  /**
   * Write brake (Manual v2 7.8): every externally visible Slack mutation is a
   * dry-run by default and exits 3 (WRITE_REQUIRES_EXECUTE) BEFORE any Slack
   * Web API call. The plan carries safe request metadata only; message text,
   * Block Kit payloads and other request bodies are never serialized.
   */
  private brakeDryRun(
    op: string,
    config: SlackCredentialConfig,
    method: string,
    request: Record<string, unknown>,
    asJson?: boolean,
    item?: unknown,
  ): never {
    contractDryRun(
      op,
      {
        connection: connectionLabel(config),
        source: config.source,
        method,
        request: summarizeSlackDryRunRequest(request),
        ...(item !== undefined ? { item: summarizeSlackDryRunItem(item) } : {}),
      },
      { asJson },
    );
  }

  private mutationPayload(
    config: SlackCredentialConfig,
    dryRun: boolean,
    method: string,
    request: Record<string, unknown>,
    item?: unknown,
    raw?: Record<string, unknown>,
  ) {
    return {
      ok: true,
      provider: "slack" as const,
      connection: connectionLabel(config),
      source: config.source,
      dryRun,
      method,
      request,
      ...(item !== undefined ? { item } : {}),
      ...(raw ? { raw } : {}),
    };
  }

  private printTopologySummary(payload: {
    channels: Array<{
      id: string;
      name: string;
      ravi: {
        matched: boolean;
        agentId?: string;
        routeSession?: string;
        sessionKey?: string;
        policyGate?: { inboundAllowed: boolean; reason: string };
      };
    }>;
  }): void {
    console.log(`channels: ${payload.channels.length}`);
    for (const channel of payload.channels) {
      const routeLabel = channel.ravi.matched
        ? `${channel.ravi.agentId ?? "?"}${channel.ravi.routeSession ? ` session=${channel.ravi.routeSession}` : ""}`
        : "unrouted";
      const gate = channel.ravi.policyGate;
      const gateLabel = gate && !gate.inboundAllowed ? ` blocked=${gate.reason}` : "";
      console.log(`  ${channel.id} ${channel.name} route=${routeLabel}${gateLabel}`);
    }
  }
}
