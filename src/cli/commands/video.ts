/**
 * Video Commands — Analyze videos via Gemini API
 */

import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { analyzeVideo } from "../../video/gemini.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

@Group({
  name: "video",
  description: "Video analysis tools",
  scope: "open",
})
export class VideoCommands {
  @Command({ name: "analyze", description: "Analyze a video (YouTube URL or local file) and save to markdown" })
  async analyze(
    @Arg("url", { description: "YouTube URL or local file path" }) url: string,
    @Option({ flags: "-o, --output <path>", description: "Output file path (default: auto-generated in cwd)" }) output?: string,
    @Option({ flags: "-p, --prompt <text>", description: "Custom analysis prompt" }) prompt?: string,
  ) {
    console.log("Analyzing video...");

    const result = await analyzeVideo(url, prompt);

    // Determine output path
    const slug = slugify(result.title);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = output || join(process.cwd(), `${slug}-${timestamp}.md`);

    writeFileSync(filename, result.markdown);

    // Print path + short summary for agent consumption
    const summaryPreview = result.summary.slice(0, 500);
    console.log(`\n✓ Video analysis saved: ${filename}`);
    console.log(`\nTitle: ${result.title}`);
    console.log(`Duration: ${result.duration}`);
    console.log(`Topics: ${result.topics.join(", ")}`);
    console.log(`\nSummary:\n${summaryPreview}${result.summary.length > 500 ? "..." : ""}`);
  }
}
