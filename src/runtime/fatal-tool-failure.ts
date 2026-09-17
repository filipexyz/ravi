export const FATAL_TOOL_FAILURE_REASON = "fatal_tool_failure" as const;

export type FatalToolSignal = "sigkill" | "sigsegv" | "sigabrt" | "sigbus" | "oom_killed";

export interface FatalToolFailure {
  fatal: boolean;
  reason?: FatalToolSignal;
  exitCode?: number;
  summary: string;
}

const FATAL_EXIT_CODES: Readonly<Record<number, FatalToolSignal>> = {
  134: "sigabrt",
  135: "sigbus",
  137: "sigkill",
  139: "sigsegv",
};

const EXIT_CODE_PATTERN = /(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|status|return(?:ed)?(?:\s+code)?)\s*[:=]?\s*(\d+)/i;
const SIGNAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: FatalToolSignal; exitCode?: number }> = [
  { pattern: /\bSIGKILL\b|\bsignal\s*9\b|\bSIGKILLED\b/i, reason: "sigkill", exitCode: 137 },
  { pattern: /\bSIGSEGV\b|\bsignal\s*11\b|\bsegmentation fault\b/i, reason: "sigsegv", exitCode: 139 },
  { pattern: /\bSIGABRT\b|\bsignal\s*6\b/i, reason: "sigabrt", exitCode: 134 },
  { pattern: /\bSIGBUS\b|\bsignal\s*7\b/i, reason: "sigbus", exitCode: 135 },
  { pattern: /\boomed\b|\bout of memory\b|\bcannot allocate memory\b/i, reason: "oom_killed" },
];

export function classifyFatalToolFailure(input: {
  isError?: boolean;
  content?: unknown;
  metadata?: unknown;
  toolName?: string;
}): FatalToolFailure {
  if (input.isError !== true) {
    return { fatal: false, summary: "" };
  }

  const text = stringifyToolFailureContent(input.content);
  const metadataText = stringifyToolFailureContent(input.metadata);
  const combined = `${text}\n${metadataText}`.trim();
  const exitCode = readExitCode(combined, input.metadata);

  if (exitCode !== undefined && FATAL_EXIT_CODES[exitCode]) {
    const reason = FATAL_EXIT_CODES[exitCode];
    return {
      fatal: true,
      reason,
      exitCode,
      summary: summarizeFatalToolFailure(input.toolName, reason, exitCode, combined),
    };
  }

  for (const candidate of SIGNAL_PATTERNS) {
    if (!candidate.pattern.test(combined)) continue;
    return {
      fatal: true,
      reason: candidate.reason,
      ...(candidate.exitCode !== undefined ? { exitCode: candidate.exitCode } : {}),
      summary: summarizeFatalToolFailure(input.toolName, candidate.reason, candidate.exitCode, combined),
    };
  }

  if (/(?:^|\n)\s*killed\s*$/im.test(combined) || /\bprocess killed\b/i.test(combined)) {
    return {
      fatal: true,
      reason: "oom_killed",
      summary: summarizeFatalToolFailure(input.toolName, "oom_killed", undefined, combined),
    };
  }

  return { fatal: false, summary: combined };
}

function summarizeFatalToolFailure(
  toolName: string | undefined,
  reason: FatalToolSignal,
  exitCode: number | undefined,
  detail: string,
): string {
  const tool = toolName?.trim() || "tool";
  const code = exitCode !== undefined ? ` exit ${exitCode}` : "";
  const preview = detail.replace(/\s+/g, " ").trim().slice(0, 180);
  return preview.length > 0 ? `${tool} fatal ${reason}${code}: ${preview}` : `${tool} fatal ${reason}${code}`;
}

function readExitCode(text: string, metadata: unknown): number | undefined {
  const fromText = text.match(EXIT_CODE_PATTERN);
  if (fromText?.[1]) {
    const parsed = Number.parseInt(fromText[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (metadata && typeof metadata === "object") {
    const record = metadata as Record<string, unknown>;
    for (const key of ["exitCode", "exit_code", "status"]) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
    }
  }
  return undefined;
}

export function stringifyToolFailureContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }
        if (item && typeof item === "object" && "content" in item) {
          return stringifyToolFailureContent(item.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (record.content !== undefined) return stringifyToolFailureContent(record.content);
  }
  return "";
}
