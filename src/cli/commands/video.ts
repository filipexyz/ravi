/**
 * Video Commands — Analyze videos via subtitles or Gemini
 */

import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Group, Command, Arg, Option, Returns } from "../decorators.js";
import { analyzeVideo, type VideoAnalyzeStrategy } from "../../video/gemini.js";
import { videoAnalyzeReturnSchema } from "./operational-return-schemas.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function parseStrategy(value?: string): VideoAnalyzeStrategy {
  if (!value) return "auto";
  if (value === "auto" || value === "subtitles" || value === "gemini") return value;
  throw new Error(`Invalid video analysis strategy: ${value}. Use auto, subtitles, or gemini.`);
}

@Group({
  name: "video",
  description: "Video analysis tools",
  scope: "open",
})
export class VideoCommands {
  @Command({ name: "analyze", description: "Analyze a video (YouTube URL or local file) and save to markdown" })
  @Returns(videoAnalyzeReturnSchema)
  async analyze(
    @Arg("url", { description: "YouTube URL or local file path" }) url: string,
    @Option({ flags: "-o, --output <path>", description: "Output file path (default: auto-generated in cwd)" })
    output?: string,
    @Option({ flags: "-p, --prompt <text>", description: "Custom Gemini prompt used by Gemini strategy/fallback" })
    prompt?: string,
    @Option({
      flags: "--strategy <strategy>",
      description: "Analysis strategy: auto, subtitles, or gemini (default: auto)",
    })
    strategy?: string,
    @Option({ flags: "--force-analyze", description: "Force Gemini analysis even when YouTube subtitles exist" })
    forceAnalyze?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!asJson) {
      console.log("Analyzing video...");
    }

    const requestedStrategy = forceAnalyze ? "gemini" : parseStrategy(strategy);
    const result = await analyzeVideo(url, prompt, { strategy: requestedStrategy });

    // Determine output path
    const slug = slugify(result.title);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = output || join(process.cwd(), `${slug}-${timestamp}.md`);

    writeFileSync(filename, result.markdown);

    const payload = {
      success: true,
      artifact: {
        filePath: filename,
        mimeType: "text/markdown",
      },
      video: {
        source: result.source,
        strategy: result.strategy,
        title: result.title,
        duration: result.duration,
        summary: result.summary,
        topics: result.topics,
        transcript: result.transcript,
        visualDescription: result.visualDescription,
        subtitleLanguage: result.subtitleLanguage ?? null,
        chapters: result.chapters ?? [],
      },
      options: {
        strategy: requestedStrategy,
        forceAnalyze: Boolean(forceAnalyze),
        ...(prompt ? { prompt } : {}),
      },
    };

    // Print path + short summary for agent consumption
    const summaryPreview = result.summary.slice(0, 500);
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n✓ Video analysis saved: ${filename}`);
      console.log(`Strategy: ${result.strategy}${result.subtitleLanguage ? ` (${result.subtitleLanguage})` : ""}`);
      console.log(`\nTitle: ${result.title}`);
      console.log(`Duration: ${result.duration}`);
      if (result.topics.length > 0) {
        console.log(`Topics: ${result.topics.join(", ")}`);
      }
      if (result.summary) {
        console.log(`\nSummary:\n${summaryPreview}${result.summary.length > 500 ? "..." : ""}`);
      } else {
        console.log(`Transcript: ${result.transcript.length} chars`);
      }
    }

    return payload;
  }
}
