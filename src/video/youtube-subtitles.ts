import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SUBTITLE_LANGUAGES = ["pt-BR", "pt-br", "pt", "en"];

export interface YouTubeSubtitleChapter {
  title: string;
  startTime: number | null;
  endTime: number | null;
  startLabel: string;
  endLabel: string | null;
}

interface YtDlpChapter {
  title?: string;
  start_time?: number;
  end_time?: number;
}

export interface YtDlpVideoInfo {
  id?: string;
  title?: string;
  duration?: number;
  duration_string?: string;
  chapters?: YtDlpChapter[];
  subtitles?: Record<string, unknown[]>;
  automatic_captions?: Record<string, unknown[]>;
}

export interface YouTubeSubtitleAnalysis {
  title: string;
  duration: string;
  summary: string;
  topics: string[];
  transcript: string;
  visualDescription: string;
  source: string;
  markdown: string;
  strategy: "subtitles";
  subtitleLanguage: string;
  chapters: YouTubeSubtitleChapter[];
}

interface ExtractYouTubeSubtitlesOptions {
  preferredLanguages?: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runYtDlp(args: string[]): CommandResult {
  const result = spawnSync("yt-dlp", ["--ignore-config", "--ignore-no-formats-error", ...args], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("yt-dlp not found. Install yt-dlp to extract YouTube subtitles before Gemini fallback.");
    }
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`yt-dlp failed: ${detail}`);
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function formatDuration(seconds?: number | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "unknown";
  }

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanVttText(line: string): string {
  return decodeHtmlEntities(line)
    .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVttTranscript(vtt: string): string {
  const cues: string[] = [];
  let currentCue: string[] = [];

  const flushCue = () => {
    const text = currentCue.join(" ").replace(/\s+/g, " ").trim();
    currentCue = [];
    if (!text) return;

    const previous = cues.at(-1);
    if (previous === text) return;
    cues.push(text);
  };

  for (const rawLine of vtt.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      flushCue();
      continue;
    }

    if (line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:") || line.startsWith("NOTE")) {
      continue;
    }

    if (/^\d+$/.test(line)) {
      continue;
    }

    if (line.includes("-->")) {
      flushCue();
      continue;
    }

    const cleaned = cleanVttText(line);
    if (cleaned) {
      currentCue.push(cleaned);
    }
  }

  flushCue();
  return cues.join("\n");
}

function availableSubtitleLanguages(info: Pick<YtDlpVideoInfo, "subtitles" | "automatic_captions">): string[] {
  return Array.from(new Set([...Object.keys(info.subtitles ?? {}), ...Object.keys(info.automatic_captions ?? {})]));
}

export function selectSubtitleLanguage(
  info: Pick<YtDlpVideoInfo, "subtitles" | "automatic_captions">,
  preferredLanguages: string[] = DEFAULT_SUBTITLE_LANGUAGES,
): string | null {
  const available = availableSubtitleLanguages(info).filter(Boolean);
  if (available.length === 0) return null;

  const byLowerCase = new Map(available.map((language) => [language.toLowerCase(), language]));

  for (const preferred of preferredLanguages) {
    const normalizedPreferred = preferred.toLowerCase();
    const exact = byLowerCase.get(normalizedPreferred);
    if (exact) return exact;

    if (normalizedPreferred.includes("-")) {
      continue;
    }

    const prefix = normalizedPreferred;
    const match = available.find((language) => {
      const normalized = language.toLowerCase();
      return normalized === prefix || normalized.startsWith(`${prefix}-`) || normalized.startsWith(`${prefix}_`);
    });
    if (match) return match;
  }

  return null;
}

function parseYtDlpInfo(url: string): YtDlpVideoInfo {
  const { stdout } = runYtDlp(["--dump-json", "--skip-download", "--no-warnings", "--no-playlist", url]);
  const json = stdout.trim().split("\n").at(-1);
  if (!json) {
    throw new Error("yt-dlp returned no metadata");
  }

  return JSON.parse(json) as YtDlpVideoInfo;
}

function findVttFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...findVttFiles(path));
    } else if (entry.toLowerCase().endsWith(".vtt")) {
      files.push(path);
    }
  }

  return files;
}

function downloadSubtitle(url: string, language: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-video-subs-"));

  try {
    runYtDlp([
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      language,
      "--sub-format",
      "vtt",
      "--no-warnings",
      "--no-playlist",
      "-o",
      join(dir, "youtube-%(id)s.%(ext)s"),
      url,
    ]);

    const vttFiles = findVttFiles(dir);
    if (vttFiles.length === 0) {
      throw new Error(`yt-dlp did not produce a VTT subtitle file for language ${language}`);
    }

    const normalizedLanguage = language.toLowerCase();
    const selected = vttFiles.find((file) => file.toLowerCase().includes(`.${normalizedLanguage}.`)) ?? vttFiles[0];

    return readFileSync(selected, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function normalizeChapters(chapters?: YtDlpChapter[]): YouTubeSubtitleChapter[] {
  return (chapters ?? []).map((chapter, index) => ({
    title: chapter.title?.trim() || `Chapter ${index + 1}`,
    startTime: typeof chapter.start_time === "number" ? chapter.start_time : null,
    endTime: typeof chapter.end_time === "number" ? chapter.end_time : null,
    startLabel: formatDuration(chapter.start_time),
    endLabel: typeof chapter.end_time === "number" ? formatDuration(chapter.end_time) : null,
  }));
}

function formatChapterMarkdown(chapters: YouTubeSubtitleChapter[]): string {
  if (chapters.length === 0) {
    return "";
  }

  return chapters
    .map((chapter) => {
      const range = chapter.endLabel ? `${chapter.startLabel}-${chapter.endLabel}` : chapter.startLabel;
      return `- [${range}] ${chapter.title}`;
    })
    .join("\n");
}

export function buildSubtitleMarkdown(input: {
  title: string;
  source: string;
  duration: string;
  subtitleLanguage: string;
  transcript: string;
  chapters: YouTubeSubtitleChapter[];
}): string {
  const date = new Date().toISOString().split("T")[0];

  return [
    `# Video: ${input.title}`,
    `**Source:** ${input.source}`,
    `**Duration:** ${input.duration}`,
    `**Analyzed:** ${date}`,
    `**Strategy:** YouTube subtitles`,
    `**Subtitle Language:** ${input.subtitleLanguage}`,
    "",
    "## Summary",
    "Not generated. This run extracted the available YouTube subtitles without calling Gemini.",
    "",
    "## Topics",
    "",
    "## Transcript",
    input.transcript,
    "",
    "## Chapters",
    formatChapterMarkdown(input.chapters),
    "",
    "## Visual Description",
    "Not generated. Use `--strategy gemini` or `--force-analyze` when visual analysis is required.",
  ].join("\n");
}

export async function extractYouTubeSubtitleAnalysis(
  url: string,
  options: ExtractYouTubeSubtitlesOptions = {},
): Promise<YouTubeSubtitleAnalysis> {
  const info = parseYtDlpInfo(url);
  const preferredLanguages = options.preferredLanguages ?? DEFAULT_SUBTITLE_LANGUAGES;
  const subtitleLanguage = selectSubtitleLanguage(info, preferredLanguages);

  if (!subtitleLanguage) {
    throw new Error(`No YouTube subtitles/captions found for preferred languages: ${preferredLanguages.join(", ")}`);
  }

  const vtt = downloadSubtitle(url, subtitleLanguage);
  const transcript = parseVttTranscript(vtt);

  if (!transcript) {
    throw new Error(`YouTube subtitle file for ${subtitleLanguage} was empty after VTT parsing`);
  }

  const title = info.title?.trim() || (info.id ? `YouTube ${info.id}` : "YouTube Video");
  const duration = info.duration_string?.trim() || formatDuration(info.duration);
  const chapters = normalizeChapters(info.chapters);
  const markdown = buildSubtitleMarkdown({
    title,
    source: url,
    duration,
    subtitleLanguage,
    transcript,
    chapters,
  });

  return {
    title,
    duration,
    summary: "",
    topics: [],
    transcript,
    visualDescription: "",
    source: url,
    markdown,
    strategy: "subtitles",
    subtitleLanguage,
    chapters,
  };
}
