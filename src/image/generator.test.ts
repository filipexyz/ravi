import { describe, expect, it } from "bun:test";
import { normalizeImageProvider, resolveImageOptions, resolveOpenAIImageSize } from "./generator.js";

describe("image generator options", () => {
  it("normalizes provider aliases", () => {
    expect(normalizeImageProvider("openai")).toBe("openai");
    expect(normalizeImageProvider("gpt-image")).toBe("openai");
    expect(normalizeImageProvider("google")).toBe("gemini");
  });

  it("requires an explicit or configured provider", () => {
    expect(() => resolveImageOptions({ mode: "quality", aspect: "16:9", size: "2K" })).toThrow(
      "Image provider not configured",
    );
  });

  it("keeps Gemini available when explicitly selected", () => {
    const original = process.env.GEMINI_IMAGE_MODEL;
    delete process.env.GEMINI_IMAGE_MODEL;
    try {
      const resolved = resolveImageOptions({ provider: "gemini", mode: "quality", aspect: "16:9", size: "2K" });
      expect(resolved.provider).toBe("gemini");
      expect(resolved.model).toBe("gemini-3-pro-image-preview");
      expect(resolved.aspect).toBe("16:9");
      expect(resolved.size).toBe("2K");
    } finally {
      if (original === undefined) delete process.env.GEMINI_IMAGE_MODEL;
      else process.env.GEMINI_IMAGE_MODEL = original;
    }
  });

  it("defaults OpenAI to gpt-image-2", () => {
    const original = process.env.OPENAI_IMAGE_MODEL;
    delete process.env.OPENAI_IMAGE_MODEL;
    try {
      const resolved = resolveImageOptions({ provider: "openai", mode: "quality" });
      expect(resolved.provider).toBe("openai");
      expect(resolved.model).toBe("gpt-image-2");
      expect(resolved.quality).toBe("high");
    } finally {
      if (original === undefined) delete process.env.OPENAI_IMAGE_MODEL;
      else process.env.OPENAI_IMAGE_MODEL = original;
    }
  });

  it("maps aspect ratio to OpenAI native sizes", () => {
    expect(resolveOpenAIImageSize({ aspect: "1:1" })).toBe("1024x1024");
    expect(resolveOpenAIImageSize({ aspect: "9:16" })).toBe("1024x1536");
    expect(resolveOpenAIImageSize({ aspect: "16:9" })).toBe("1536x1024");
  });

  it("passes through explicit pixel sizes for OpenAI", () => {
    expect(resolveOpenAIImageSize({ size: "1536x1024" })).toBe("1536x1024");
  });
});
