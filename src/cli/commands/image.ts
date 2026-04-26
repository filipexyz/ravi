/**
 * Image Commands — provider-agnostic image generation.
 */

import "reflect-metadata";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { getContext, fail, type ToolContext } from "../context.js";
import { generateImage, normalizeImageProvider, type ImageMode } from "../../image/generator.js";
import { getAgent } from "../../router/config.js";
import { dbGetInstance, dbGetInstanceByInstanceId, dbGetSetting } from "../../router/router-db.js";
import {
  appendArtifactEvent,
  createArtifact,
  getArtifact,
  updateArtifact,
  type ArtifactRecord,
} from "../../artifacts/store.js";
import { sendMediaWithOmniCli } from "../media-send.js";

function stringDefault(defaults: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = defaults?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseCompression(value?: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim() || parsed < 0 || parsed > 100) {
    fail("Invalid compression. Must be an integer between 0 and 100.");
  }
  return parsed;
}

function numericUsageField(usage: unknown, key: string): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function serializeCliValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function pushOption(args: string[], flag: string, value?: unknown): void {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, serializeCliValue(value));
}

function spawnDetachedCli(args: string[]): number | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Cannot resolve Ravi CLI entrypoint for async worker.");
  }
  const child = spawn(process.execPath, [entrypoint, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child.pid;
}

function notifyOwnerSession(artifact: ArtifactRecord, status: "completed" | "failed", message: string): void {
  const target = artifact.sessionName ?? artifact.sessionKey;
  if (!target) return;
  try {
    const pid = spawnDetachedCli([
      "sessions",
      "inform",
      target,
      `Artifact ${artifact.id} ${status}: ${message}`,
      "--barrier",
      "after_response",
    ]);
    appendArtifactEvent(artifact.id, {
      eventType: "notified",
      status,
      message: `Owner session notification queued${pid ? ` (pid ${pid})` : ""}`,
      source: "ravi.image",
      ...(artifact.agentId ? { actor: artifact.agentId } : {}),
    });
  } catch (error) {
    appendArtifactEvent(artifact.id, {
      eventType: "notification_failed",
      status,
      message: error instanceof Error ? error.message : String(error),
      source: "ravi.image",
      ...(artifact.agentId ? { actor: artifact.agentId } : {}),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contextArtifactFields(ctx: ToolContext | undefined): {
  sessionKey?: string;
  sessionName?: string;
  agentId?: string;
  channel?: string;
  accountId?: string;
  chatId?: string;
  threadId?: string;
} {
  return {
    ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx?.sessionName ? { sessionName: ctx.sessionName } : {}),
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.source?.channel ? { channel: ctx.source.channel } : {}),
    ...(ctx?.source?.accountId ? { accountId: ctx.source.accountId } : {}),
    ...(ctx?.source?.chatId ? { chatId: ctx.source.chatId } : {}),
    ...(ctx?.source?.threadId ? { threadId: ctx.source.threadId } : {}),
  };
}

@Group({
  name: "image",
  description: "Image generation tools",
  scope: "open",
})
export class ImageCommands {
  @Command({
    name: "generate",
    description: "Generate an image from a text prompt",
  })
  async generate(
    @Arg("prompt", { description: "Text prompt describing the image to generate" })
    prompt: string,
    @Option({ flags: "--provider <provider>", description: "Image provider: gemini or openai" })
    provider?: string,
    @Option({ flags: "--model <model>", description: "Provider image model override" })
    model?: string,
    @Option({ flags: "--mode <type>", description: "Legacy quality mode: fast or quality. Default: fast" })
    mode?: string,
    @Option({ flags: "--source <path>", description: "Source image path for editing/reference" })
    source?: string,
    @Option({ flags: "-o, --output <path>", description: "Output directory (default: /tmp)" })
    output?: string,
    @Option({ flags: "--aspect <ratio>", description: "Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9" })
    aspect?: string,
    @Option({ flags: "--size <size>", description: "Image size: 1K, 2K, 4K (default: 1K)" })
    size?: string,
    @Option({ flags: "--quality <quality>", description: "OpenAI quality: low, medium, high, auto" })
    quality?: string,
    @Option({ flags: "--format <format>", description: "OpenAI output format: png, jpeg, webp" })
    format?: string,
    @Option({ flags: "--compression <0-100>", description: "OpenAI jpeg/webp output compression" })
    compression?: string,
    @Option({ flags: "--background <mode>", description: "OpenAI background: transparent, opaque, auto" })
    background?: string,
    @Option({ flags: "--send", description: "Auto-send generated image to the current chat" })
    send?: boolean,
    @Option({ flags: "--caption <text>", description: "Caption when sending (used with --send)" })
    caption?: string,
    @Option({ flags: "--async", description: "Compatibility no-op: image generation is async by default" })
    asyncMode?: boolean,
    @Option({ flags: "--sync", description: "Wait for provider completion before returning" })
    syncMode?: boolean,
    @Option({ flags: "--artifact-id <id>", description: "Internal artifact id for async worker continuation" })
    artifactId?: string,
    @Option({ flags: "--async-worker", description: "Internal background worker mode" })
    asyncWorker?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    // Resolve defaults: explicit flag > agent > instance > global setting > env.
    // There is intentionally no implicit provider fallback: if the selected
    // provider fails, the command fails. Operators can retry with --provider.
    const ctx = getContext();
    const agentId = ctx?.agentId;
    const defaults = agentId ? getAgent(agentId)?.defaults : undefined;
    const accountId = ctx?.source?.accountId;
    const instance = accountId ? (dbGetInstance(accountId) ?? dbGetInstanceByInstanceId(accountId)) : undefined;
    const instanceDefaults = instance?.defaults;

    const resolvedProvider =
      provider ??
      stringDefault(defaults, "image_provider") ??
      stringDefault(instanceDefaults, "image_provider") ??
      dbGetSetting("image.provider") ??
      process.env.RAVI_IMAGE_PROVIDER;
    const normalizedProvider = normalizeImageProvider(resolvedProvider);
    if (!normalizedProvider) {
      fail(
        "No image provider configured. Pass --provider openai|gemini or set image_provider on the agent/instance/default settings.",
      );
    }

    const resolvedModel =
      model ??
      stringDefault(defaults, "image_model") ??
      stringDefault(instanceDefaults, "image_model") ??
      dbGetSetting("image.model") ??
      process.env.RAVI_IMAGE_MODEL;

    const modeVal =
      mode ??
      stringDefault(defaults, "image_mode") ??
      stringDefault(instanceDefaults, "image_mode") ??
      dbGetSetting("image.mode") ??
      "fast";
    const resolvedMode: ImageMode = modeVal === "quality" ? "quality" : "fast";
    const resolvedAspect =
      aspect ??
      stringDefault(defaults, "image_aspect") ??
      stringDefault(instanceDefaults, "image_aspect") ??
      dbGetSetting("image.aspect") ??
      undefined;
    const resolvedSize =
      size ??
      stringDefault(defaults, "image_size") ??
      stringDefault(instanceDefaults, "image_size") ??
      dbGetSetting("image.size") ??
      undefined;
    const resolvedQuality =
      quality ??
      stringDefault(defaults, "image_quality") ??
      stringDefault(instanceDefaults, "image_quality") ??
      dbGetSetting("image.quality") ??
      undefined;
    const resolvedFormat =
      format ??
      stringDefault(defaults, "image_format") ??
      stringDefault(instanceDefaults, "image_format") ??
      dbGetSetting("image.format") ??
      undefined;
    const compressionDefault =
      compression ??
      stringDefault(defaults, "image_compression") ??
      stringDefault(instanceDefaults, "image_compression") ??
      dbGetSetting("image.compression") ??
      undefined;
    const resolvedBackground =
      background ??
      stringDefault(defaults, "image_background") ??
      stringDefault(instanceDefaults, "image_background") ??
      dbGetSetting("image.background") ??
      undefined;

    const sourcePath = source ? resolve(source) : undefined;
    const outputDir = output ? resolve(output) : undefined;
    const compressionValue = parseCompression(compressionDefault);
    const artifactContext = contextArtifactFields(ctx);
    if (asyncMode && syncMode) {
      fail("--async and --sync cannot be used together. Async is already the default; use --sync only when needed.");
    }
    const shouldRunAsync = syncMode !== true && asyncWorker !== true;
    const hasOriginChat = Boolean(ctx?.source?.accountId && ctx.source.chatId);
    const shouldSend = send === true || hasOriginChat;
    const asyncHint = shouldSend
      ? "No polling needed: this artifact emits lifecycle events and will be sent to the origin chat when completed. Use watch/events only for manual inspection or debugging."
      : ctx?.sessionName || ctx?.sessionKey
        ? "No polling needed: this artifact emits lifecycle events and the owner session is notified on completed/failed. Use watch/events only for manual inspection or debugging."
        : "No polling needed: this artifact emits lifecycle events. Use watch/events only for manual inspection or debugging.";
    const optionsPayload = {
      provider: normalizedProvider,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      mode: resolvedMode,
      ...(resolvedAspect ? { aspect: resolvedAspect } : {}),
      ...(resolvedSize ? { size: resolvedSize } : {}),
      ...(resolvedQuality ? { quality: resolvedQuality } : {}),
      ...(resolvedFormat ? { format: resolvedFormat } : {}),
      ...(compressionValue !== undefined ? { compression: compressionValue } : {}),
      ...(resolvedBackground ? { background: resolvedBackground } : {}),
      ...(sourcePath ? { source: sourcePath } : {}),
      ...(outputDir ? { outputDir } : {}),
    };
    const baseArtifactInput = {
      kind: "image",
      status: "pending",
      title: prompt.slice(0, 120),
      summary: `Image generation queued for ${normalizedProvider}${resolvedModel ? `/${resolvedModel}` : ""}`,
      provider: normalizedProvider,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      prompt,
      command: "ravi image generate",
      ...artifactContext,
      metadata: {
        mode: resolvedMode,
        aspect: resolvedAspect ?? null,
        size: resolvedSize ?? null,
        quality: resolvedQuality ?? null,
        outputFormat: resolvedFormat ?? null,
        background: resolvedBackground ?? null,
        sourcePath: sourcePath ?? null,
        async: shouldRunAsync || asyncWorker === true,
        send: shouldSend,
      },
      lineage: {
        source: "ravi image generate",
        provider: normalizedProvider,
        model: resolvedModel ?? null,
        promptSha256: sha256Text(prompt),
      },
      input: {
        prompt,
        source: sourcePath ?? null,
        options: optionsPayload,
      },
      tags: ["generated", "image", normalizedProvider],
    };

    if (artifactId && !asyncWorker) {
      fail("--artifact-id is reserved for internal image async workers.");
    }

    if (shouldRunAsync) {
      const artifact = createArtifact(baseArtifactInput);
      appendArtifactEvent(artifact.id, {
        eventType: "queued",
        status: "pending",
        message: "Image generation queued",
        payload: { options: optionsPayload, send: shouldSend, delivery: shouldSend ? artifactContext : null },
        source: "ravi.image",
        ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
      });

      const workerArgs = ["image", "generate", prompt, "--provider", normalizedProvider, "--mode", resolvedMode];
      pushOption(workerArgs, "--model", resolvedModel);
      pushOption(workerArgs, "--source", sourcePath);
      pushOption(workerArgs, "--output", outputDir);
      pushOption(workerArgs, "--aspect", resolvedAspect);
      pushOption(workerArgs, "--size", resolvedSize);
      pushOption(workerArgs, "--quality", resolvedQuality);
      pushOption(workerArgs, "--format", resolvedFormat);
      pushOption(workerArgs, "--compression", compressionValue);
      pushOption(workerArgs, "--background", resolvedBackground);
      if (shouldSend) workerArgs.push("--send");
      pushOption(workerArgs, "--caption", caption);
      workerArgs.push("--artifact-id", artifact.id, "--async-worker", "--json");

      const pid = spawnDetachedCli(workerArgs);
      appendArtifactEvent(artifact.id, {
        eventType: "worker_started",
        status: "pending",
        message: `Background image worker started${pid ? ` (pid ${pid})` : ""}`,
        payload: { pid: pid ?? null },
        source: "ravi.image",
        ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
      });

      const queuedPayload = {
        success: true,
        artifact_id: artifact.id,
        artifactId: artifact.id,
        status: artifact.status,
        hint: asyncHint,
        autoSend: shouldSend,
        ...(shouldSend
          ? {
              delivery: {
                channel: ctx?.source?.channel ?? null,
                accountId: ctx?.source?.accountId ?? null,
                chatId: ctx?.source?.chatId ?? null,
                threadId: ctx?.source?.threadId ?? null,
              },
            }
          : {}),
        watch: `ravi artifacts watch ${artifact.id}`,
        events: `ravi artifacts events ${artifact.id}`,
        ...(pid ? { workerPid: pid } : {}),
      };
      if (asJson) {
        console.log(JSON.stringify(queuedPayload, null, 2));
      } else {
        console.log(`✓ Image generation queued: ${artifact.id}`);
        console.log(`  Hint: ${asyncHint}`);
        console.log(`  Debug: ravi artifacts watch ${artifact.id}`);
      }
      return queuedPayload;
    }

    const primaryArtifact = artifactId
      ? getArtifact(artifactId)
      : createArtifact({
          ...baseArtifactInput,
          summary: `Image generation pending for ${normalizedProvider}${resolvedModel ? `/${resolvedModel}` : ""}`,
        });
    if (!primaryArtifact) fail(`Artifact not found: ${artifactId}`);

    const runningArtifact = updateArtifact(
      primaryArtifact.id,
      {
        status: "running",
        summary: `Image generation running for ${normalizedProvider}${resolvedModel ? `/${resolvedModel}` : ""}`,
        provider: normalizedProvider,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        metadata: baseArtifactInput.metadata,
        lineage: baseArtifactInput.lineage,
        input: baseArtifactInput.input,
      },
      { actor: ctx?.agentId, mergeMetadata: true, mergeLineage: true },
    );
    appendArtifactEvent(runningArtifact.id, {
      eventType: "started",
      status: "running",
      message: "Image generation started",
      payload: { options: optionsPayload },
      source: "ravi.image",
      ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
    });
    appendArtifactEvent(runningArtifact.id, {
      eventType: "provider_requested",
      status: "running",
      message: `Requested ${normalizedProvider}${resolvedModel ? `/${resolvedModel}` : ""}`,
      payload: { provider: normalizedProvider, model: resolvedModel ?? null },
      source: "ravi.image",
      ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
    });

    if (!asJson && !asyncWorker) {
      console.log(
        `Generating image (${normalizedProvider}${resolvedModel ? `/${resolvedModel}` : ""}, ${resolvedMode})...`,
      );
    }

    const startedAt = Date.now();
    let results: Awaited<ReturnType<typeof generateImage>>;
    let artifacts: ArtifactRecord[];
    try {
      results = await generateImage(prompt, {
        provider: normalizedProvider,
        model: resolvedModel,
        mode: resolvedMode,
        aspect: resolvedAspect,
        size: resolvedSize,
        quality: resolvedQuality,
        format: resolvedFormat,
        compression: compressionValue,
        background: resolvedBackground,
        source: sourcePath,
        outputDir,
      });
      const durationMs = Date.now() - startedAt;

      artifacts = results.map((img, index) => {
        const inputTokens = numericUsageField(img.usage, "input_tokens");
        const outputTokens = numericUsageField(img.usage, "output_tokens");
        const totalTokens = numericUsageField(img.usage, "total_tokens");
        const completedInput = {
          status: "completed",
          summary: `Imagem gerada por ${img.provider}/${img.model}`,
          filePath: img.filePath,
          mimeType: img.mimeType,
          provider: img.provider,
          model: img.model,
          prompt,
          command: "ravi image generate",
          ...artifactContext,
          durationMs,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          metadata: {
            quality: img.quality ?? resolvedQuality ?? null,
            size: img.size ?? resolvedSize ?? null,
            outputFormat: img.outputFormat ?? resolvedFormat ?? null,
            sourcePath: sourcePath ?? null,
            usage: img.usage ?? null,
          },
          metrics: {
            durationMs,
            inputTokens: inputTokens ?? null,
            outputTokens: outputTokens ?? null,
            totalTokens: totalTokens ?? null,
          },
          lineage: {
            source: "ravi image generate",
            provider: img.provider,
            model: img.model,
            promptSha256: sha256Text(prompt),
          },
          input: {
            prompt,
            source: sourcePath ?? null,
            options: {
              ...optionsPayload,
              model: resolvedModel ?? img.model,
            },
          },
          output: {
            filePath: img.filePath,
            mimeType: img.mimeType,
            provider: img.provider,
            model: img.model,
            usage: img.usage ?? null,
          },
          tags: ["generated", "image", img.provider],
        };
        const artifact =
          index === 0
            ? updateArtifact(runningArtifact.id, completedInput, {
                actor: ctx?.agentId,
                mergeMetadata: true,
                mergeMetrics: true,
                mergeLineage: true,
              })
            : createArtifact({
                kind: "image",
                title: prompt.slice(0, 120),
                ...completedInput,
              });
        appendArtifactEvent(artifact.id, {
          eventType: "file_saved",
          status: "completed",
          message: `Image file saved: ${img.filePath}`,
          payload: { filePath: img.filePath, mimeType: img.mimeType },
          source: "ravi.image",
          ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
        });
        if (artifact.blobPath) {
          appendArtifactEvent(artifact.id, {
            eventType: "blob_ingested",
            status: "completed",
            message: `Artifact blob ingested: ${artifact.blobPath}`,
            payload: { blobPath: artifact.blobPath, sha256: artifact.sha256 ?? null },
            source: "ravi.image",
            ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
          });
        }
        appendArtifactEvent(artifact.id, {
          eventType: "completed",
          status: "completed",
          message: `Image generation completed by ${img.provider}/${img.model}`,
          payload: { filePath: img.filePath, provider: img.provider, model: img.model },
          source: "ravi.image",
          ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
        });
        return artifact;
      });
    } catch (error) {
      const message = errorMessage(error);
      const failedArtifact = updateArtifact(
        runningArtifact.id,
        {
          status: "failed",
          summary: `Image generation failed: ${message}`,
          durationMs: Date.now() - startedAt,
          metadata: { error: message },
          metrics: { durationMs: Date.now() - startedAt },
          output: { error: message },
        },
        { actor: ctx?.agentId, mergeMetadata: true, mergeMetrics: true },
      );
      appendArtifactEvent(failedArtifact.id, {
        eventType: "failed",
        status: "failed",
        message,
        payload: { error: message },
        source: "ravi.image",
        ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
      });
      if (asyncWorker) {
        notifyOwnerSession(failedArtifact, "failed", message);
      }
      throw error;
    }

    const payload: {
      success: true;
      images: Array<{
        filePath: string;
        mimeType: string;
        prompt: string;
        provider: string;
        model: string;
        quality?: string;
        size?: string;
        outputFormat?: string;
        usage?: unknown;
        artifactId: string;
        sendCommand: string;
      }>;
      options: {
        provider: string;
        model?: string;
        mode: "fast" | "quality";
        aspect?: string;
        size?: string;
        quality?: string;
        format?: string;
        compression?: number;
        background?: string;
        source?: string;
        outputDir?: string;
      };
      sent: Array<{
        transport: "omni-send";
        channel?: string;
        accountId: string;
        instanceId: string;
        chatId: string;
        threadId?: string;
        filename: string;
        caption: string;
        messageId?: string;
        status?: string;
      }>;
    } = {
      success: true,
      images: results.map((img, index) => ({
        filePath: img.filePath,
        mimeType: img.mimeType,
        prompt: img.prompt,
        provider: img.provider,
        model: img.model,
        ...(img.quality ? { quality: img.quality } : {}),
        ...(img.size ? { size: img.size } : {}),
        ...(img.outputFormat ? { outputFormat: img.outputFormat } : {}),
        ...(img.usage ? { usage: img.usage } : {}),
        artifactId: artifacts[index]?.id ?? "",
        sendCommand: `ravi media send "${img.filePath}"`,
      })),
      options: {
        ...optionsPayload,
      },
      sent: [],
    };

    if (!asJson && !asyncWorker) {
      for (const img of results) {
        console.log(`\n✓ Image saved: ${img.filePath}`);
        const artifact = artifacts.find((item) => item.filePath === img.filePath);
        if (artifact) console.log(`  Artifact: ${artifact.id}`);
        console.log(`  Send to chat: ravi media send "${img.filePath}"`);
      }

      console.log(`\nPrompt: ${prompt}`);
      if (source) console.log(`Source: ${source}`);
      console.log(
        `Provider: ${normalizedProvider} | Model: ${results[0]?.model ?? resolvedModel ?? "(default)"} | Mode: ${resolvedMode} | Aspect: ${resolvedAspect ?? "auto"} | Size: ${resolvedSize ?? "auto"}`,
      );
    }

    if (shouldSend && results.length > 0) {
      try {
        for (const img of results) {
          const delivered = await sendMediaWithOmniCli({
            filePath: img.filePath,
            caption: caption ?? prompt,
            type: "image",
            filename: basename(img.filePath),
          });
          const delivery = {
            transport: delivered.delivery.transport,
            ...(delivered.target.channel ? { channel: delivered.target.channel } : {}),
            accountId: delivered.target.accountId,
            instanceId: delivered.target.instanceId,
            chatId: delivered.target.chatId,
            ...(delivered.target.threadId ? { threadId: delivered.target.threadId } : {}),
            filename: delivered.filename,
            caption: caption ?? prompt,
            ...(delivered.delivery.messageId ? { messageId: delivered.delivery.messageId } : {}),
            ...(delivered.delivery.status ? { status: delivered.delivery.status } : {}),
          };
          payload.sent.push(delivery);
          const artifact = artifacts.find((item) => item.filePath === img.filePath);
          if (artifact) {
            appendArtifactEvent(artifact.id, {
              eventType: "sent",
              status: "completed",
              message: `Image sent to ${delivered.target.chatId}`,
              payload: delivery,
              source: "ravi.image",
              ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
            });
          }
          if (!asJson && !asyncWorker) {
            console.log(`✓ Sent to chat: ${delivered.filename}`);
          }
        }
      } catch (error) {
        const message = errorMessage(error);
        for (const artifact of artifacts) {
          appendArtifactEvent(artifact.id, {
            eventType: "send_failed",
            status: "completed",
            message,
            payload: { error: message },
            source: "ravi.image",
            ...(ctx?.agentId ? { actor: ctx.agentId } : {}),
          });
        }
        if (asyncWorker) {
          notifyOwnerSession(artifacts[0] ?? runningArtifact, "completed", `generated; send failed: ${message}`);
        } else {
          throw error;
        }
      }
    }

    if (asyncWorker) {
      notifyOwnerSession(artifacts[0] ?? runningArtifact, "completed", "image generation completed");
    }

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    }

    return payload;
  }
}
