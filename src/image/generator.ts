/**
 * Image Generation via Gemini Nano Banana 2 (generateContent with IMAGE modality)
 *
 * Generates images from text prompts, optionally with a source image for editing.
 * Uses gemini-3.1-flash-image-preview (fast) or gemini-3-pro-image-preview (quality).
 */

import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../utils/logger.js";

const log = logger.child("image");

const MODELS = {
  fast: "gemini-3.1-flash-image-preview",
  quality: "gemini-3-pro-image-preview",
} as const;

const SOURCE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function getClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY not configured. Add it to ~/.ravi/.env");
  }
  return new GoogleGenAI({ apiKey: key });
}

export interface GeneratedImage {
  filePath: string;
  mimeType: string;
  prompt: string;
}

export interface GenerateImageOptions {
  /** Model type: "fast" (3.1 Flash) or "quality" (3 Pro). Default: "fast" */
  mode?: "fast" | "quality";
  /** Aspect ratio: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" */
  aspect?: string;
  /** Image size: "1K" | "2K" | "4K". Default: "1K" */
  size?: string;
  /** Source image path for editing/reference */
  source?: string;
  /** Custom output directory */
  outputDir?: string;
}

export async function generateImage(prompt: string, opts: GenerateImageOptions = {}): Promise<GeneratedImage[]> {
  const client = getClient();
  const mode = opts.mode ?? "fast";
  const model = process.env.GEMINI_IMAGE_MODEL || MODELS[mode];
  const outDir = opts.outputDir ?? tmpdir();

  log.info("Generating image", { model, mode, prompt: prompt.slice(0, 100), aspect: opts.aspect, size: opts.size });

  // Build content parts
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  // If source image provided, include it first
  if (opts.source) {
    const ext = extname(opts.source).toLowerCase();
    const mime = SOURCE_MIME[ext];
    if (!mime) {
      throw new Error(`Unsupported image format: ${ext}. Supported: ${Object.keys(SOURCE_MIME).join(", ")}`);
    }
    const data = readFileSync(opts.source).toString("base64");
    parts.push({ inlineData: { mimeType: mime, data } });
    log.info("Source image attached", { path: opts.source, mime });
  }

  parts.push({ text: prompt });

  const response = await client.models.generateContent({
    model,
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
      const ext = mime.includes("jpeg") ? "jpg" : "png";
      const filename = `ravi-image-${timestamp}${idx > 0 ? `-${idx + 1}` : ""}.${ext}`;
      const filePath = join(outDir, filename);

      writeFileSync(filePath, Buffer.from(part.inlineData.data, "base64"));
      results.push({ filePath, mimeType: mime, prompt });
      log.info("Image saved", { filePath });
      idx++;
    }
  }

  if (!results.length) {
    // Check if there's text-only response (model refused to generate image)
    const text = candidate.content.parts.find((p) => p.text)?.text;
    throw new Error(text || "Gemini returned no images.");
  }

  return results;
}
