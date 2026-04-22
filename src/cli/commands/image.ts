/**
 * Image Commands — provider-agnostic image generation.
 */

import "reflect-metadata";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { getContext, fail } from "../context.js";
import { nats } from "../../nats.js";
import { generateImage, normalizeImageProvider, type ImageMode } from "../../image/generator.js";
import { getAgent } from "../../router/config.js";
import { dbGetInstance, dbGetInstanceByInstanceId, dbGetSetting } from "../../router/router-db.js";
import { createArtifact } from "../../artifacts/store.js";

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

    if (!asJson) {
      console.log(
        `Generating image (${normalizedProvider}${resolvedModel ? `/${resolvedModel}` : ""}, ${resolvedMode})...`,
      );
    }

    const startedAt = Date.now();
    const results = await generateImage(prompt, {
      provider: normalizedProvider,
      model: resolvedModel,
      mode: resolvedMode,
      aspect: resolvedAspect,
      size: resolvedSize,
      quality: resolvedQuality,
      format: resolvedFormat,
      compression: parseCompression(compressionDefault),
      background: resolvedBackground,
      source: source ? resolve(source) : undefined,
      outputDir: output ? resolve(output) : undefined,
    });
    const durationMs = Date.now() - startedAt;

    const artifacts = results.map((img) => {
      const inputTokens = numericUsageField(img.usage, "input_tokens");
      const outputTokens = numericUsageField(img.usage, "output_tokens");
      const totalTokens = numericUsageField(img.usage, "total_tokens");
      return createArtifact({
        kind: "image",
        title: prompt.slice(0, 120),
        summary: `Imagem gerada por ${img.provider}/${img.model}`,
        filePath: img.filePath,
        mimeType: img.mimeType,
        provider: img.provider,
        model: img.model,
        prompt,
        command: "ravi image generate",
        ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        ...(ctx?.sessionName ? { sessionName: ctx.sessionName } : {}),
        ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
        ...(ctx?.source?.channel ? { channel: ctx.source.channel } : {}),
        ...(ctx?.source?.accountId ? { accountId: ctx.source.accountId } : {}),
        ...(ctx?.source?.chatId ? { chatId: ctx.source.chatId } : {}),
        durationMs,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        metadata: {
          quality: img.quality ?? resolvedQuality ?? null,
          size: img.size ?? resolvedSize ?? null,
          outputFormat: img.outputFormat ?? resolvedFormat ?? null,
          sourcePath: source ? resolve(source) : null,
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
          source: source ? resolve(source) : null,
          options: {
            provider: normalizedProvider,
            model: resolvedModel ?? img.model,
            mode: resolvedMode,
            aspect: resolvedAspect ?? null,
            size: resolvedSize ?? null,
            quality: resolvedQuality ?? null,
            format: resolvedFormat ?? null,
            background: resolvedBackground ?? null,
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
      });
    });

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
        topic: "ravi.media.send";
        channel: string;
        accountId: string;
        chatId: string;
        filename: string;
        caption: string;
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
        provider: normalizedProvider,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        mode: resolvedMode,
        ...(resolvedAspect ? { aspect: resolvedAspect } : {}),
        ...(resolvedSize ? { size: resolvedSize } : {}),
        ...(resolvedQuality ? { quality: resolvedQuality } : {}),
        ...(resolvedFormat ? { format: resolvedFormat } : {}),
        ...(compressionDefault ? { compression: parseCompression(compressionDefault) } : {}),
        ...(resolvedBackground ? { background: resolvedBackground } : {}),
        ...(source ? { source: resolve(source) } : {}),
        ...(output ? { outputDir: resolve(output) } : {}),
      },
      sent: [],
    };

    if (!asJson) {
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

    if (send && results.length > 0) {
      const ctx = getContext()?.source;
      const channel = ctx?.channel;
      const accountId = ctx?.accountId;
      const chatId = ctx?.chatId;

      if (!channel || !accountId || !chatId) {
        fail("No chat context available for --send. Use from a chat session or specify target via media send.");
      }

      for (const img of results) {
        await nats.emit("ravi.media.send", {
          channel,
          accountId,
          chatId,
          filePath: img.filePath,
          mimetype: img.mimeType,
          type: "image",
          filename: basename(img.filePath),
          caption: caption ?? prompt,
        });
        payload.sent.push({
          topic: "ravi.media.send",
          channel,
          accountId,
          chatId,
          filename: basename(img.filePath),
          caption: caption ?? prompt,
        });
        if (!asJson) {
          console.log(`✓ Sent to chat: ${basename(img.filePath)}`);
        }
      }
    }

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    }

    return payload;
  }
}
