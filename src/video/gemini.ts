/**
 * Video Analysis via Gemini API
 *
 * Analyzes videos (YouTube URLs or local files) using Google's Gemini model.
 * Returns structured analysis saved as markdown.
 */

import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { logger } from "../utils/logger.js";

const log = logger.child("video");

const MIME_MAP: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mov": "video/mov",
  ".avi": "video/avi",
  ".flv": "video/x-flv",
  ".mpg": "video/mpg",
  ".webm": "video/webm",
  ".wmv": "video/wmv",
  ".3gpp": "video/3gpp",
};

function getClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY not configured. Add it to ~/.ravi/.env"
    );
  }
  return new GoogleGenAI({ apiKey: key });
}

function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

const DEFAULT_PROMPT = `Analyze this video thoroughly and return the following sections in this exact format:

## Title
The video title or a descriptive title if not available.

## Duration
Estimated duration in MM:SS format.

## Summary
A comprehensive summary of the video content in 2-3 paragraphs.

## Topics
A bullet list of the main topics covered.

## Transcript
The complete transcription of all spoken content in the video. Include speaker labels if there are multiple speakers.

## Visual Description
A timestamped description of what's visually happening in the video. Format each entry as [MM:SS-MM:SS] followed by the description.

Respond in the same language as the video's spoken content.`;

export interface VideoAnalysis {
  title: string;
  duration: string;
  summary: string;
  topics: string[];
  transcript: string;
  visualDescription: string;
  source: string;
  markdown: string;
}

function parseResponse(text: string, source: string): VideoAnalysis {
  const getSection = (name: string): string => {
    const regex = new RegExp(`## ${name}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "i");
    const match = text.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const title = getSection("Title") || "Untitled Video";
  const duration = getSection("Duration") || "unknown";
  const summary = getSection("Summary");
  const topicsRaw = getSection("Topics");
  const transcript = getSection("Transcript");
  const visualDescription = getSection("Visual Description");

  const topics = topicsRaw
    .split("\n")
    .map(l => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);

  const date = new Date().toISOString().split("T")[0];
  const markdown = [
    `# Video: ${title}`,
    `**Source:** ${source}`,
    `**Duration:** ${duration}`,
    `**Analyzed:** ${date}`,
    "",
    `## Summary`,
    summary,
    "",
    `## Topics`,
    topics.map(t => `- ${t}`).join("\n"),
    "",
    `## Transcript`,
    transcript,
    "",
    `## Visual Description`,
    visualDescription,
  ].join("\n");

  return { title, duration, summary, topics, transcript, visualDescription, source, markdown };
}

export async function analyzeVideo(
  urlOrPath: string,
  customPrompt?: string,
): Promise<VideoAnalysis> {
  const client = getClient();
  const model = process.env.GEMINI_VIDEO_MODEL || "gemini-2.5-flash";
  const prompt = customPrompt
    ? `${customPrompt}\n\nAlso provide the following sections: Title, Duration, Summary, Topics, Transcript, Visual Description. Use ## headers for each section.`
    : DEFAULT_PROMPT;

  let response;

  if (isYouTubeUrl(urlOrPath)) {
    log.info("Analyzing YouTube video", { url: urlOrPath, model });
    response = await client.models.generateContent({
      model,
      contents: [
        { fileData: { fileUri: urlOrPath } },
        { text: prompt },
      ],
    });
  } else if (existsSync(urlOrPath)) {
    const ext = extname(urlOrPath).toLowerCase();
    const mimeType = MIME_MAP[ext];
    if (!mimeType) {
      throw new Error(`Unsupported video format: ${ext}. Supported: ${Object.keys(MIME_MAP).join(", ")}`);
    }

    log.info("Uploading and analyzing local video", { path: urlOrPath, mimeType, model });
    const uploaded = await client.files.upload({
      file: urlOrPath,
      config: { mimeType },
    });

    if (!uploaded.uri || !uploaded.mimeType) {
      throw new Error("File upload failed — no URI returned");
    }

    response = await client.models.generateContent({
      model,
      contents: createUserContent([
        createPartFromUri(uploaded.uri, uploaded.mimeType),
        prompt,
      ]),
    });
  } else {
    throw new Error(`Not a valid YouTube URL or local file: ${urlOrPath}`);
  }

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  log.info("Video analysis complete", { responseLength: text.length });
  return parseResponse(text, urlOrPath);
}
