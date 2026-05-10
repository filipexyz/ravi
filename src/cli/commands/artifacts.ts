/**
 * Artifacts Commands - generic Ravi artifact ledger.
 */

import "reflect-metadata";
import { file as bunFile } from "bun";
import { Arg, Command, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import {
  archiveArtifact,
  appendArtifactEvent,
  attachArtifact,
  createArtifact,
  createArtifactVersion,
  getArtifactVersion,
  getArtifactDetails,
  listArtifactEvents,
  listArtifactVersions,
  listArtifactsPage,
  restoreArtifactVersion,
  updateArtifact,
  type ArtifactEvent,
  type ArtifactRecord,
  type ArtifactVersion,
} from "../../artifacts/store.js";
import {
  buildOverlayArtifactsPayload,
  normalizeLifecycle,
  resolveArtifactBlob,
} from "../../whatsapp-overlay/artifacts.js";
import { CloudAuthError, formatCloudAuthError } from "../../cloud-auth/errors.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseJsonObject(value: string | undefined, label: string): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${label} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must be a JSON object.")) throw error;
    fail(`${label} must be valid JSON.`);
  }
}

function parseJsonValue(value: string | undefined, label: string): unknown {
  if (!value?.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail(`${label} must be valid JSON.`);
  }
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value: string | undefined, label: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${label} must be a non-negative number.`);
  return parsed;
}

function parseInteger(value: string | undefined, label: string): number | undefined {
  const parsed = parseNumber(value, label);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) fail(`${label} must be an integer.`);
  return parsed;
}

function contextDefaults() {
  const ctx = getContext();
  return {
    sessionKey: ctx?.sessionKey,
    sessionName: ctx?.sessionName,
    agentId: ctx?.agentId,
    channel: ctx?.source?.channel,
    accountId: ctx?.source?.accountId,
    chatId: ctx?.source?.chatId,
  };
}

function summarizeArtifact(artifact: ArtifactRecord): Record<string, unknown> {
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title ?? null,
    status: artifact.status,
    filePath: artifact.filePath ?? null,
    blobPath: artifact.blobPath ?? null,
    sha256: artifact.sha256 ?? null,
    provider: artifact.provider ?? null,
    model: artifact.model ?? null,
    sessionName: artifact.sessionName ?? null,
    taskId: artifact.taskId ?? null,
    durationMs: artifact.durationMs ?? null,
    costUsd: artifact.costUsd ?? null,
    totalTokens: artifact.totalTokens ?? null,
    tags: artifact.tags,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    deletedAt: artifact.deletedAt ?? null,
  };
}

function summarizeEvent(event: ArtifactEvent): Record<string, unknown> {
  return {
    id: event.id,
    artifactId: event.artifactId,
    eventType: event.eventType,
    status: event.status ?? null,
    message: event.message ?? null,
    source: event.source ?? null,
    actor: event.actor ?? null,
    payload: event.payload ?? null,
    createdAt: event.createdAt,
  };
}

function summarizeVersion(version: ArtifactVersion): Record<string, unknown> {
  return {
    id: version.id,
    artifactId: version.artifactId,
    versionNumber: version.versionNumber,
    status: version.status,
    label: version.label ?? null,
    source: version.source,
    createdBy: version.createdBy ?? null,
    createdAt: version.createdAt,
    assetCount: version.assets.length,
    assets: version.assets.map((asset) => ({
      id: asset.id,
      path: asset.path,
      role: asset.role,
      visibility: asset.visibility,
      uri: asset.uri ?? null,
      filePath: asset.filePath ?? null,
      blobPath: asset.blobPath ?? null,
      mimeType: asset.mimeType ?? null,
      sizeBytes: asset.sizeBytes ?? null,
      sha256: asset.sha256 ?? null,
      metadata: asset.metadata ?? null,
    })),
    manifest: version.manifest,
    metadata: version.metadata ?? null,
  };
}

@Group({
  name: "artifacts",
  description: "Generic artifact ledger and lineage tools",
  scope: "open",
})
export class ArtifactsCommands {
  @Command({ name: "create", description: "Create a generic Ravi artifact record" })
  create(
    @Arg("kind", { description: "Artifact kind, e.g. image, audio, report, trace" }) kind: string,
    @Option({ flags: "--title <text>", description: "Human title" }) title?: string,
    @Option({ flags: "--summary <text>", description: "Human summary" }) summary?: string,
    @Option({ flags: "--path <path>", description: "Local file to ingest into artifact blob storage" })
    filePath?: string,
    @Option({ flags: "--uri <uri>", description: "External URI/reference" }) uri?: string,
    @Option({ flags: "--mime <type>", description: "MIME type override" }) mimeType?: string,
    @Option({ flags: "--provider <provider>", description: "Provider that produced the artifact" }) provider?: string,
    @Option({ flags: "--model <model>", description: "Model that produced the artifact" }) model?: string,
    @Option({ flags: "--prompt <text>", description: "Prompt or user instruction that generated the artifact" })
    prompt?: string,
    @Option({ flags: "--command <text>", description: "Command that produced the artifact" }) command?: string,
    @Option({ flags: "--duration-ms <n>", description: "Generation duration in milliseconds" }) durationMs?: string,
    @Option({ flags: "--cost-usd <n>", description: "Known cost in USD" }) costUsd?: string,
    @Option({ flags: "--input-tokens <n>", description: "Input token count" }) inputTokens?: string,
    @Option({ flags: "--output-tokens <n>", description: "Output token count" }) outputTokens?: string,
    @Option({ flags: "--total-tokens <n>", description: "Total token count" }) totalTokens?: string,
    @Option({ flags: "--metadata <json>", description: "Metadata JSON object" }) metadata?: string,
    @Option({ flags: "--metrics <json>", description: "Metrics JSON object" }) metrics?: string,
    @Option({ flags: "--lineage <json>", description: "Lineage JSON object" }) lineage?: string,
    @Option({ flags: "--input <json>", description: "Raw/structured input JSON" }) input?: string,
    @Option({ flags: "--output <json>", description: "Raw/structured output JSON" }) output?: string,
    @Option({ flags: "--tags <csv>", description: "Comma-separated tags" }) tags?: string,
    @Option({ flags: "--session <nameOrKey>", description: "Override session key/name" }) session?: string,
    @Option({ flags: "--task <id>", description: "Task id" }) taskId?: string,
    @Option({ flags: "--message <id>", description: "Channel message id" }) messageId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ctx = contextDefaults();
    const artifact = createArtifact({
      kind,
      ...(title?.trim() ? { title } : {}),
      ...(summary?.trim() ? { summary } : {}),
      ...(filePath?.trim() ? { filePath } : {}),
      ...(uri?.trim() ? { uri } : {}),
      ...(mimeType?.trim() ? { mimeType } : {}),
      ...(provider?.trim() ? { provider } : {}),
      ...(model?.trim() ? { model } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(command?.trim() ? { command } : {}),
      ...(session?.trim() ? { sessionName: session } : {}),
      ...(ctx.sessionKey && !session ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx.sessionName && !session ? { sessionName: ctx.sessionName } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(taskId?.trim() ? { taskId } : {}),
      ...(messageId?.trim() ? { messageId } : {}),
      ...(ctx.channel ? { channel: ctx.channel } : {}),
      ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
      ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
      ...(durationMs ? { durationMs: parseInteger(durationMs, "--duration-ms") } : {}),
      ...(costUsd ? { costUsd: parseNumber(costUsd, "--cost-usd") } : {}),
      ...(inputTokens ? { inputTokens: parseInteger(inputTokens, "--input-tokens") } : {}),
      ...(outputTokens ? { outputTokens: parseInteger(outputTokens, "--output-tokens") } : {}),
      ...(totalTokens ? { totalTokens: parseInteger(totalTokens, "--total-tokens") } : {}),
      ...(metadata ? { metadata: parseJsonObject(metadata, "--metadata") } : {}),
      ...(metrics ? { metrics: parseJsonObject(metrics, "--metrics") } : {}),
      ...(lineage ? { lineage: parseJsonObject(lineage, "--lineage") } : {}),
      ...(input ? { input: parseJsonValue(input, "--input") } : {}),
      ...(output ? { output: parseJsonValue(output, "--output") } : {}),
      tags: parseCsv(tags) ?? [],
    });

    const payload = { success: true, artifact };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Artifact created: ${artifact.id}`);
      if (artifact.blobPath) console.log(`  Blob: ${artifact.blobPath}`);
    }
    return payload;
  }

  @Command({ name: "list", description: "List artifacts" })
  list(
    @Option({ flags: "--kind <kind>", description: "Filter by artifact kind" }) kind?: string,
    @Option({ flags: "--session <nameOrKey>", description: "Filter by session key or name" }) session?: string,
    @Option({ flags: "--task <id>", description: "Filter by task id" }) taskId?: string,
    @Option({ flags: "--tag <tag>", description: "Filter by tag" }) tag?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500; rich max: 200)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching artifacts to skip (default: 0)" })
    offset?: string,
    @Option({ flags: "--include-deleted", description: "Include archived/deleted artifacts" }) includeDeleted?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--rich",
      description:
        "Return rich projection with stats and per-item lineage (task/session/agent refs). Honors --kind/--session/--task/--limit/--lifecycle/--agent; ignores --tag/--include-deleted.",
    })
    rich?: boolean,
    @Option({
      flags: "--lifecycle <type>",
      description: "Filter rich projection by lifecycle: pending|running|completed|failed|archived",
    })
    lifecycle?: string,
    @Option({ flags: "--agent <id>", description: "Filter rich projection by agent id" })
    agentId?: string,
  ) {
    if (rich) {
      const normalizedLifecycle = lifecycle?.trim() ? normalizeLifecycle(lifecycle.trim()) : null;
      if (lifecycle?.trim() && !normalizedLifecycle) {
        fail(`Invalid --lifecycle: ${lifecycle}. Use pending|running|completed|failed|archived.`);
      }
      const payload = buildOverlayArtifactsPayload({
        ...(limit ? { limit: parseInteger(limit, "--limit") } : {}),
        ...(offset ? { offset: parseCliListOffset(offset) } : {}),
        ...(normalizedLifecycle ? { lifecycle: normalizedLifecycle } : {}),
        ...(kind?.trim() ? { kind: kind.trim() } : {}),
        ...(taskId?.trim() ? { taskId: taskId.trim() } : {}),
        ...(session?.trim() ? { sessionId: session.trim() } : {}),
        ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
      });
      printJson(payload);
      return payload;
    }

    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const filterOptions = {
      ...(kind?.trim() ? { kind: kind.trim() } : {}),
      ...(session?.trim() ? { session: session.trim() } : {}),
      ...(taskId?.trim() ? { taskId: taskId.trim() } : {}),
      ...(tag?.trim() ? { tag: tag.trim() } : {}),
      includeDeleted: includeDeleted === true,
    };
    const page = listArtifactsPage({
      ...filterOptions,
      limit: pageLimit,
      offset: pageOffset,
    });
    const artifacts = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "artifacts", "list"],
      limit: pageLimit,
      offset: pageOffset,
      returned: artifacts.length,
      total: page.total,
      options: [
        "--kind",
        kind?.trim() || null,
        "--session",
        session?.trim() || null,
        "--task",
        taskId?.trim() || null,
        "--tag",
        tag?.trim() || null,
        includeDeleted ? "--include-deleted" : null,
      ],
    });
    const payload = {
      total: page.total,
      pagination,
      items: artifacts.map(summarizeArtifact),
      artifacts: artifacts.map(summarizeArtifact),
    };
    if (asJson) {
      printJson(payload);
    } else if (artifacts.length === 0) {
      console.log("No artifacts found.");
    } else {
      console.log(
        `Artifacts (${artifacts.length} returned of ${page.total}, limit ${pageLimit}, offset ${pageOffset}):`,
      );
      for (const artifact of artifacts) {
        const label = artifact.title ?? artifact.summary ?? artifact.filePath ?? artifact.uri ?? artifact.kind;
        console.log(`${artifact.id} — ${artifact.kind} — ${label}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show artifact details, links and events" })
  show(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getArtifactDetails(id);
    if (!details) fail(`Artifact not found: ${id}`);
    const payload = { ...details };
    if (asJson) {
      printJson(payload);
    } else {
      const artifact = details.artifact;
      console.log(`${artifact.id} — ${artifact.kind}`);
      if (artifact.title) console.log(artifact.title);
      if (artifact.summary) console.log(artifact.summary);
      if (artifact.filePath) console.log(`File: ${artifact.filePath}`);
      if (artifact.blobPath) console.log(`Blob: ${artifact.blobPath}`);
      console.log(`Status: ${artifact.status}`);
      console.log(
        `Links: ${details.links.length} | Events: ${details.events.length} | Versions: ${details.versions.length}`,
      );
    }
    return payload;
  }

  @Command({ name: "snapshot", description: "Create an immutable version snapshot for an artifact" })
  snapshot(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Option({ flags: "--label <text>", description: "Human label for this version" }) label?: string,
    @Option({ flags: "--status <status>", description: "Version status (default: active)" }) status?: string,
    @Option({ flags: "--source <source>", description: "Snapshot source" }) source?: string,
    @Option({ flags: "--message <text>", description: "Event message for the snapshot" }) message?: string,
    @Option({ flags: "--manifest <json>", description: "Extra manifest JSON object" }) manifest?: string,
    @Option({ flags: "--metadata <json>", description: "Version metadata JSON object" }) metadata?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ctx = contextDefaults();
    const version = createArtifactVersion(id, {
      ...(label?.trim() ? { label } : {}),
      ...(status?.trim() ? { status } : {}),
      ...(source?.trim() ? { source } : {}),
      ...(message?.trim() ? { message } : {}),
      ...(manifest ? { manifest: parseJsonObject(manifest, "--manifest") } : {}),
      ...(metadata ? { metadata: parseJsonObject(metadata, "--metadata") } : {}),
      ...(ctx.agentId ? { createdBy: ctx.agentId } : {}),
    });
    const payload = { success: true, version: summarizeVersion(version) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Artifact version created: ${version.artifactId} v${version.versionNumber}`);
    }
    return payload;
  }

  @Command({ name: "versions", description: "List immutable versions for an artifact" })
  versions(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const versions = listArtifactVersions(id);
    const payload = {
      artifactId: id,
      total: versions.length,
      versions: versions.map(summarizeVersion),
    };
    if (asJson) {
      printJson(payload);
    } else if (versions.length === 0) {
      console.log("No artifact versions found.");
    } else {
      for (const version of versions) {
        console.log(`v${version.versionNumber} ${version.id} — ${version.status} — ${version.assets.length} asset(s)`);
      }
    }
    return payload;
  }

  @Command({ name: "version", description: "Show one immutable artifact version" })
  version(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Option({ flags: "--version <n>", description: "Version number (default: latest)" }) versionNumber?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsedVersion = versionNumber ? parseInteger(versionNumber, "--version") : undefined;
    const version = getArtifactVersion(id, parsedVersion);
    if (!version) fail(`Artifact version not found: ${id}${parsedVersion ? ` v${parsedVersion}` : ""}`);
    const payload = { artifactId: id, version: summarizeVersion(version) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`${version.artifactId} v${version.versionNumber} — ${version.status}`);
      for (const asset of version.assets) {
        console.log(`  ${asset.role}: ${asset.path}${asset.sha256 ? ` (${asset.sha256.slice(0, 12)})` : ""}`);
      }
    }
    return payload;
  }

  @Command({ name: "restore", description: "Restore current artifact content from an immutable version" })
  restore(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Option({ flags: "--version <n>", description: "Version number to restore" }) versionNumber?: string,
    @Option({ flags: "--message <text>", description: "Event message for the restore" }) message?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!versionNumber?.trim()) fail("--version is required.");
    const parsedVersion = parseInteger(versionNumber, "--version");
    if (parsedVersion === undefined) fail("--version is required.");
    const ctx = contextDefaults();
    const result = restoreArtifactVersion(id, parsedVersion, {
      ...(ctx.agentId ? { actor: ctx.agentId } : {}),
      ...(message?.trim() ? { message } : {}),
    });
    const payload = {
      success: true,
      artifact: summarizeArtifact(result.artifact),
      restoredFrom: summarizeVersion(result.restoredFrom),
      restoreVersion: summarizeVersion(result.restoreVersion),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(
        `✓ Artifact restored: ${id} v${result.restoredFrom.versionNumber} -> v${result.restoreVersion.versionNumber}`,
      );
    }
    return payload;
  }

  @Command({ name: "update", description: "Edit artifact metadata and high-level fields" })
  update(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Option({ flags: "--title <text>", description: "Replace title" }) title?: string,
    @Option({ flags: "--summary <text>", description: "Replace summary" }) summary?: string,
    @Option({ flags: "--status <status>", description: "Replace status" }) status?: string,
    @Option({ flags: "--path <path>", description: "Replace/ingest file path" }) filePath?: string,
    @Option({ flags: "--uri <uri>", description: "Replace external URI/reference" }) uri?: string,
    @Option({ flags: "--mime <type>", description: "Replace MIME type" }) mimeType?: string,
    @Option({ flags: "--provider <provider>", description: "Replace provider" }) provider?: string,
    @Option({ flags: "--model <model>", description: "Replace model" }) model?: string,
    @Option({ flags: "--prompt <text>", description: "Replace prompt" }) prompt?: string,
    @Option({ flags: "--command <text>", description: "Replace command" }) command?: string,
    @Option({ flags: "--duration-ms <n>", description: "Replace duration in milliseconds" }) durationMs?: string,
    @Option({ flags: "--cost-usd <n>", description: "Replace known cost in USD" }) costUsd?: string,
    @Option({ flags: "--input-tokens <n>", description: "Replace input token count" }) inputTokens?: string,
    @Option({ flags: "--output-tokens <n>", description: "Replace output token count" }) outputTokens?: string,
    @Option({ flags: "--total-tokens <n>", description: "Replace total token count" }) totalTokens?: string,
    @Option({ flags: "--session <nameOrKey>", description: "Replace session name/key reference" }) session?: string,
    @Option({ flags: "--task <id>", description: "Replace task id" }) taskId?: string,
    @Option({ flags: "--message <id>", description: "Replace channel message id" }) messageId?: string,
    @Option({ flags: "--metadata <json>", description: "Merge metadata JSON object" }) metadata?: string,
    @Option({ flags: "--metrics <json>", description: "Merge metrics JSON object" }) metrics?: string,
    @Option({ flags: "--lineage <json>", description: "Merge lineage JSON object" }) lineage?: string,
    @Option({ flags: "--input <json>", description: "Replace raw/structured input JSON" }) input?: string,
    @Option({ flags: "--output <json>", description: "Replace raw/structured output JSON" }) output?: string,
    @Option({ flags: "--tags <csv>", description: "Replace tags" }) tags?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const artifact = updateArtifact(
      id,
      {
        ...(title?.trim() ? { title } : {}),
        ...(summary?.trim() ? { summary } : {}),
        ...(status?.trim() ? { status } : {}),
        ...(filePath?.trim() ? { filePath } : {}),
        ...(uri?.trim() ? { uri } : {}),
        ...(mimeType?.trim() ? { mimeType } : {}),
        ...(provider?.trim() ? { provider } : {}),
        ...(model?.trim() ? { model } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(command?.trim() ? { command } : {}),
        ...(durationMs ? { durationMs: parseInteger(durationMs, "--duration-ms") } : {}),
        ...(costUsd ? { costUsd: parseNumber(costUsd, "--cost-usd") } : {}),
        ...(inputTokens ? { inputTokens: parseInteger(inputTokens, "--input-tokens") } : {}),
        ...(outputTokens ? { outputTokens: parseInteger(outputTokens, "--output-tokens") } : {}),
        ...(totalTokens ? { totalTokens: parseInteger(totalTokens, "--total-tokens") } : {}),
        ...(session?.trim() ? { sessionName: session } : {}),
        ...(taskId?.trim() ? { taskId } : {}),
        ...(messageId?.trim() ? { messageId } : {}),
        ...(metadata ? { metadata: parseJsonObject(metadata, "--metadata") } : {}),
        ...(metrics ? { metrics: parseJsonObject(metrics, "--metrics") } : {}),
        ...(lineage ? { lineage: parseJsonObject(lineage, "--lineage") } : {}),
        ...(input ? { input: parseJsonValue(input, "--input") } : {}),
        ...(output ? { output: parseJsonValue(output, "--output") } : {}),
        ...(tags ? { tags: parseCsv(tags) ?? [] } : {}),
      },
      { actor: contextDefaults().agentId, mergeMetadata: true, mergeMetrics: true, mergeLineage: true },
    );
    const payload = { success: true, artifact };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Artifact updated: ${artifact.id}`);
    }
    return payload;
  }

  @Command({ name: "attach", description: "Attach an artifact to a task, session, message or any target" })
  attach(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Arg("targetType", { description: "Target type, e.g. task, session, message, project" }) targetType: string,
    @Arg("targetId", { description: "Target id" }) targetId: string,
    @Option({ flags: "--relation <name>", description: "Relation name (default: related)" }) relation?: string,
    @Option({ flags: "--metadata <json>", description: "Link metadata JSON object" }) metadata?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const link = attachArtifact(
      id,
      targetType,
      targetId,
      relation?.trim() || "related",
      parseJsonObject(metadata, "--metadata"),
    );
    const payload = { success: true, link };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Artifact attached: ${id} -> ${targetType}:${targetId}`);
    }
    return payload;
  }

  @Command({ name: "archive", description: "Soft-archive an artifact" })
  archive(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const artifact = archiveArtifact(id, contextDefaults().agentId);
    const payload = { success: true, artifact };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Artifact archived: ${artifact.id}`);
    }
    return payload;
  }

  @Command({ name: "event", description: "Append an artifact lifecycle event" })
  event(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Arg("eventType", { description: "Event type, e.g. started, completed, failed" }) eventType: string,
    @Option({ flags: "--status <status>", description: "Lifecycle status for this event" }) status?: string,
    @Option({ flags: "--message <text>", description: "Human-readable event message" }) message?: string,
    @Option({ flags: "--source <source>", description: "Event source" }) source?: string,
    @Option({ flags: "--payload <json>", description: "Structured event payload JSON object" }) payload?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ctx = contextDefaults();
    const artifact = status?.trim() ? updateArtifact(id, { status }, { actor: ctx.agentId }) : undefined;
    const event = appendArtifactEvent(id, {
      eventType,
      ...(status?.trim() ? { status } : {}),
      ...(message?.trim() ? { message } : {}),
      ...(source?.trim() ? { source } : {}),
      ...(payload ? { payload: parseJsonObject(payload, "--payload") } : {}),
      ...(ctx.agentId ? { actor: ctx.agentId } : {}),
    });
    const result = { success: true, event, ...(artifact ? { artifact } : {}) };
    if (asJson) {
      printJson(result);
    } else {
      console.log(`✓ Artifact event appended: ${event.eventType}`);
    }
    return result;
  }

  @Command({ name: "events", description: "List artifact lifecycle events" })
  events(
    @Arg("id", { description: "Artifact id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const events = listArtifactEvents(id);
      const payload = { artifactId: id, total: events.length, events: events.map(summarizeEvent) };
      if (asJson) {
        printJson(payload);
      } else if (events.length === 0) {
        console.log("No artifact events found.");
      } else {
        for (const event of events) {
          console.log(
            `${new Date(event.createdAt).toISOString()} ${event.eventType}${event.status ? ` [${event.status}]` : ""}${
              event.message ? ` — ${event.message}` : ""
            }`,
          );
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "publish", description: "Publish an artifact to a Console-compatible cloud endpoint" })
  publish(
    @Arg("target", { description: "Local artifact id or local path" }) target: string,
    @Option({ flags: "--project <project>", description: "Console project id or slug" }) project?: string,
    @Option({ flags: "--visibility <visibility>", description: "Requested visibility: private|unlisted|public" })
    visibility?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    void target;
    void project;
    void visibility;
    void consoleUrl;
    const error = new CloudAuthError(
      "CLOUD_PUBLISH_NOT_IMPLEMENTED",
      "Cloud artifact publish is not implemented in ravi.bot yet. The local auth client is available, but publish/upload waits for the Console publish contract.",
    );
    if (asJson) {
      printJson(formatCloudAuthError(error));
    } else {
      console.error(`${error.code}: ${error.message}`);
    }
    process.exit(error.exitCode);
  }

  @Command({ name: "blob", description: "Stream raw artifact bytes" })
  @Returns.binary()
  async blob(@Arg("id", { description: "Artifact id" }) id: string): Promise<Response> {
    const result = await resolveArtifactBlob({ artifactId: id });
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error, code: result.code }, { status: result.status });
    }
    const headers = {
      "Content-Type": result.mimeType,
      "Content-Length": String(result.sizeBytes),
      "Cache-Control": "private, max-age=60",
    };
    return new Response(bunFile(result.path), { headers });
  }
}
