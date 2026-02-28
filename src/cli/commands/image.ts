/**
 * Image Commands — Generate images via Gemini Nano Banana 2
 */

import "reflect-metadata";
import { resolve, basename } from "node:path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { getContext, fail } from "../context.js";
import { nats } from "../../nats.js";
import { generateImage } from "../../image/generator.js";
import { getAgent } from "../../router/config.js";

@Group({
  name: "image",
  description: "Image generation tools",
  scope: "open",
})
export class ImageCommands {
  @Command({
    name: "generate",
    description: "Generate an image from a text prompt using Gemini Nano Banana 2",
  })
  async generate(
    @Arg("prompt", { description: "Text prompt describing the image to generate" })
    prompt: string,
    @Option({ flags: "--mode <type>", description: "Model: fast (3.1 Flash) or quality (3 Pro). Default: fast" })
    mode?: string,
    @Option({ flags: "--source <path>", description: "Source image path for editing/reference" })
    source?: string,
    @Option({ flags: "-o, --output <path>", description: "Output directory (default: /tmp)" })
    output?: string,
    @Option({ flags: "--aspect <ratio>", description: "Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9" })
    aspect?: string,
    @Option({ flags: "--size <size>", description: "Image size: 1K, 2K, 4K (default: 1K)" })
    size?: string,
    @Option({ flags: "--send", description: "Auto-send generated image to the current chat" })
    send?: boolean,
    @Option({ flags: "--caption <text>", description: "Caption when sending (used with --send)" })
    caption?: string,
  ) {
    // Resolve agent defaults (CLI flags take precedence)
    const agentId = getContext()?.agentId;
    const defaults = agentId ? getAgent(agentId)?.defaults : undefined;

    const modeVal = mode ?? (defaults?.image_mode as string) ?? "fast";
    const resolvedMode = modeVal === "quality" ? "quality" : "fast";
    const resolvedAspect = aspect ?? (defaults?.image_aspect as string);
    const resolvedSize = size ?? (defaults?.image_size as string);

    console.log(`Generating image (${resolvedMode})...`);

    const results = await generateImage(prompt, {
      mode: resolvedMode,
      aspect: resolvedAspect,
      size: resolvedSize,
      source: source ? resolve(source) : undefined,
      outputDir: output ? resolve(output) : undefined,
    });

    for (const img of results) {
      console.log(`\n✓ Image saved: ${img.filePath}`);
      console.log(`  Send to chat: ravi media send "${img.filePath}"`);
    }

    console.log(`\nPrompt: ${prompt}`);
    if (source) console.log(`Source: ${source}`);
    console.log(`Mode: ${resolvedMode} | Aspect: ${resolvedAspect ?? "auto"} | Size: ${resolvedSize ?? "1K"}`);

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
        console.log(`✓ Sent to chat: ${basename(img.filePath)}`);
      }
    }

    return {
      success: true,
      images: results.map((r) => ({
        path: r.filePath,
        sendCommand: `ravi media send "${r.filePath}"`,
      })),
    };
  }
}
