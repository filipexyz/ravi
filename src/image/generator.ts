/**
 * Provider-agnostic image generation.
 *
 * Keeps the Gemini provider available while allowing OpenAI image models to be
 * selected by CLI flags, agent defaults, instance defaults, settings or env.
 * Provider fallback is intentionally not automatic.
 */

import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";
import { extname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { logger } from "../utils/logger.js";

const log = logger.child("image");

export const IMAGE_PROVIDERS = ["gemini", "openai"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];
export type ImageMode = "fast" | "quality";
export type ImageQuality = "standard" | "hd" | "low" | "medium" | "high" | "auto";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageBackground = "transparent" | "opaque" | "auto";

const GEMINI_MODELS: Record<ImageMode, string> = {
  fast: "gemini-3.1-flash-image-preview",
  quality: "gemini-3-pro-image-preview",
};

export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";

const SOURCE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const OPENAI_DIRECT_SIZES = new Set([
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1792x1024",
  "1024x1792",
  "256x256",
  "512x512",
]);

export interface GeneratedImage {
  filePath: string;
  mimeType: string;
  prompt: string;
  provider: ImageProvider;
  model: string;
  quality?: string;
  size?: string;
  outputFormat?: string;
  usage?: unknown;
}

export interface GenerateImageOptions {
  /** Provider: "gemini" or "openai". Must be provided by CLI/default resolution. */
  provider?: string;
  /** Provider-specific model override. */
  model?: string;
  /** Legacy mode: "fast" or "quality". Still maps to provider defaults. */
  mode?: ImageMode;
  /** Aspect ratio: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" */
  aspect?: string;
  /** Image size: legacy "1K" | "2K" | "4K" or provider native sizes such as "1024x1024". */
  size?: string;
  /** OpenAI quality: "low" | "medium" | "high" | "auto" plus DALL-E legacy values. */
  quality?: string;
  /** OpenAI output format. */
  format?: string;
  /** OpenAI output compression, 0-100, for jpeg/webp. */
  compression?: number;
  /** OpenAI background handling. */
  background?: string;
  /** Source image path for editing/reference */
  source?: string;
  /** Custom output directory */
  outputDir?: string;
}

export interface ResolvedImageOptions {
  provider: ImageProvider;
  model: string;
  mode: ImageMode;
  aspect?: string;
  size?: string;
  quality?: ImageQuality;
  format?: ImageOutputFormat;
  compression?: number;
  background?: ImageBackground;
  source?: string;
  outputDir: string;
}

function getGeminiClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY not configured. Add it to ~/.ravi/.env");
  }
  return new GoogleGenAI({ apiKey: key });
}

function getOpenAIClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY not configured. Add it to ~/.ravi/.env");
  }
  return new OpenAI({ apiKey: key });
}

export function normalizeImageProvider(value?: string): ImageProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "openai" || normalized === "gpt" || normalized === "gpt-image") return "openai";
  if (normalized === "gemini" || normalized === "google") return "gemini";
  throw new Error(`Invalid image provider: ${value}. Valid providers: ${IMAGE_PROVIDERS.join(", ")}`);
}

function normalizeMode(value?: ImageMode): ImageMode {
  return value === "quality" ? "quality" : "fast";
}

function normalizeQuality(value?: string, mode?: ImageMode): ImageQuality | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    if (mode === "quality") return "high";
    if (mode === "fast") return "low";
    return undefined;
  }
  if (["standard", "hd", "low", "medium", "high", "auto"].includes(normalized)) {
    return normalized as ImageQuality;
  }
  throw new Error("Invalid image quality. Valid: low, medium, high, auto, standard, hd");
}

function normalizeFormat(value?: string): ImageOutputFormat | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "jpg") return "jpeg";
  if (normalized === "png" || normalized === "jpeg" || normalized === "webp") return normalized;
  throw new Error("Invalid image format. Valid: png, jpeg, webp");
}

function normalizeBackground(value?: string): ImageBackground | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "transparent" || normalized === "opaque" || normalized === "auto") return normalized;
  throw new Error("Invalid image background. Valid: transparent, opaque, auto");
}

function normalizeCompression(value?: number): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Invalid image compression. Must be an integer between 0 and 100.");
  }
  return value;
}

export function resolveOpenAIImageSize(input?: { size?: string; aspect?: string }): string | undefined {
  const rawSize = input?.size?.trim();
  if (rawSize) {
    if (OPENAI_DIRECT_SIZES.has(rawSize) || /^\d+x\d+$/.test(rawSize)) return rawSize;
    if (!["1K", "2K", "4K"].includes(rawSize.toUpperCase())) {
      throw new Error(`Invalid OpenAI image size: ${rawSize}`);
    }
  }

  const aspect = input?.aspect?.trim();
  if (!aspect && !rawSize) return undefined;

  const scale = rawSize?.toUpperCase();
  if (scale === "2K" || scale === "4K") {
    // The Images API accepts provider-native pixel sizes. Keep the legacy size
    // intent visible without fabricating unsupported high-res dimensions.
    return "auto";
  }

  if (aspect === "1:1") return "1024x1024";
  if (["9:16", "2:3", "3:4"].includes(aspect ?? "")) return "1024x1536";
  if (["16:9", "21:9", "3:2", "4:3"].includes(aspect ?? "")) return "1536x1024";
  return rawSize ? "1024x1024" : undefined;
}

export function resolveImageOptions(opts: GenerateImageOptions = {}): ResolvedImageOptions {
  const mode = normalizeMode(opts.mode);
  const provider = normalizeImageProvider(opts.provider);
  if (!provider) {
    throw new Error(
      "Image provider not configured. Pass --provider openai|gemini or configure an image_provider default.",
    );
  }
  const model =
    opts.model?.trim() ||
    (provider === "openai"
      ? process.env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL
      : process.env.GEMINI_IMAGE_MODEL || GEMINI_MODELS[mode]);

  return {
    provider,
    model,
    mode,
    ...(opts.aspect ? { aspect: opts.aspect } : {}),
    ...(provider === "openai" ? { size: resolveOpenAIImageSize({ size: opts.size, aspect: opts.aspect }) } : {}),
    ...(provider === "gemini" && opts.size ? { size: opts.size } : {}),
    ...(provider === "openai" ? { quality: normalizeQuality(opts.quality, mode) } : {}),
    ...(provider === "openai" ? { format: normalizeFormat(opts.format) } : {}),
    ...(provider === "openai" ? { compression: normalizeCompression(opts.compression) } : {}),
    ...(provider === "openai" ? { background: normalizeBackground(opts.background) } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    outputDir: opts.outputDir ?? tmpdir(),
  };
}

function getSourceMime(source: string): string {
  const ext = extname(source).toLowerCase();
  const mime = SOURCE_MIME[ext];
  if (!mime) {
    throw new Error(`Unsupported image format: ${ext}. Supported: ${Object.keys(SOURCE_MIME).join(", ")}`);
  }
  return mime;
}

function outputExtension(mimeType: string, format?: string): string {
  if (format === "jpeg" || mimeType.includes("jpeg")) return "jpg";
  if (format === "webp" || mimeType.includes("webp")) return "webp";
  return "png";
}

function writeImageResult(input: {
  outDir: string;
  timestamp: number;
  index: number;
  data: string;
  mimeType: string;
  prompt: string;
  provider: ImageProvider;
  model: string;
  quality?: string;
  size?: string;
  outputFormat?: string;
  usage?: unknown;
}): GeneratedImage {
  const ext = outputExtension(input.mimeType, input.outputFormat);
  const filename = `ravi-image-${input.timestamp}${input.index > 0 ? `-${input.index + 1}` : ""}.${ext}`;
  const filePath = join(input.outDir, filename);

  writeFileSync(filePath, Buffer.from(input.data, "base64"));
  log.info("Image saved", { filePath, provider: input.provider, model: input.model });

  return {
    filePath,
    mimeType: input.mimeType,
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.size ? { size: input.size } : {}),
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

async function generateGeminiImage(prompt: string, opts: ResolvedImageOptions): Promise<GeneratedImage[]> {
  const client = getGeminiClient();

  log.info("Generating image", {
    provider: "gemini",
    model: opts.model,
    mode: opts.mode,
    prompt: prompt.slice(0, 100),
    aspect: opts.aspect,
    size: opts.size,
  });

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  if (opts.source) {
    const mime = getSourceMime(opts.source);
    parts.push({ inlineData: { mimeType: mime, data: readFileSync(opts.source).toString("base64") } });
    log.info("Source image attached", { path: opts.source, mime });
  }

  parts.push({ text: prompt });

  const response = await client.models.generateContent({
    model: opts.model,
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        ...(opts.aspect ? { aspectRatio: opts.aspect } : {}),
        ...(opts.size ? { imageSize: opts.size } : {}),
      },
    },
  });

  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error("Gemini returned no content. The prompt may have been blocked by safety filters.");
  }

  const results: GeneratedImage[] = [];
  const timestamp = Date.now();
  let idx = 0;
  for (const part of candidate.content.parts) {
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType ?? "image/png";
      results.push(
        writeImageResult({
          outDir: opts.outputDir,
          timestamp,
          index: idx,
          data: part.inlineData.data,
          mimeType: mime,
          prompt,
          provider: "gemini",
          model: opts.model,
          size: opts.size,
        }),
      );
      idx++;
    }
  }

  if (!results.length) {
    const text = candidate.content.parts.find((p) => p.text)?.text;
    throw new Error(text || "Gemini returned no images.");
  }

  return results;
}

async function generateOpenAIImage(prompt: string, opts: ResolvedImageOptions): Promise<GeneratedImage[]> {
  const client = getOpenAIClient();

  log.info("Generating image", {
    provider: "openai",
    model: opts.model,
    prompt: prompt.slice(0, 100),
    quality: opts.quality,
    size: opts.size,
    format: opts.format,
  });

  const common = {
    model: opts.model,
    prompt,
    ...(opts.size ? { size: opts.size as never } : {}),
    ...(opts.quality ? { quality: opts.quality as never } : {}),
    ...(opts.format ? { output_format: opts.format as never } : {}),
    ...(opts.compression !== undefined ? { output_compression: opts.compression } : {}),
    ...(opts.background ? { background: opts.background as never } : {}),
  };

  const response = opts.source
    ? await client.images.edit({
        ...common,
        image: await toFile(readFileSync(opts.source), basename(opts.source), { type: getSourceMime(opts.source) }),
      })
    : await client.images.generate(common);

  const images = response.data ?? [];
  const timestamp = Date.now();
  const mimeType = opts.format === "jpeg" ? "image/jpeg" : opts.format === "webp" ? "image/webp" : "image/png";
  const results = images
    .map((image, idx) => {
      if (!image.b64_json) return null;
      return writeImageResult({
        outDir: opts.outputDir,
        timestamp,
        index: idx,
        data: image.b64_json,
        mimeType,
        prompt,
        provider: "openai",
        model: opts.model,
        quality: opts.quality ?? response.quality,
        size: opts.size ?? response.size,
        outputFormat: opts.format ?? response.output_format,
        usage: response.usage,
      });
    })
    .filter((result): result is GeneratedImage => result !== null);

  if (!results.length) {
    throw new Error("OpenAI returned no image data.");
  }

  return results;
}

export async function generateImage(prompt: string, opts: GenerateImageOptions = {}): Promise<GeneratedImage[]> {
  const resolved = resolveImageOptions(opts);
  if (resolved.provider === "openai") {
    return generateOpenAIImage(prompt, resolved);
  }
  return generateGeminiImage(prompt, resolved);
}
