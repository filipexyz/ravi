import {
  TRIAGE_ENGINE_NOT_CONFIGURED,
  readBugTriageEngineConfig,
} from "@/server/console/bug-triage-config";
import {
  BUG_TRIAGE_SCHEMA_VERSION,
  parseBugTriageV1,
  type BugTriageV1,
} from "@/server/console/bug-reports";

export {
  BUG_TRIAGE_API_BASE_ENV,
  BUG_TRIAGE_API_KEY_ENV,
  BUG_TRIAGE_MODEL_ENV,
  DEFAULT_BUG_TRIAGE_MODEL,
  TRIAGE_ENGINE_NOT_CONFIGURED,
  isBugTriageEngineConfigured,
  readBugTriageEngineConfig,
  type BugTriageEngineConfig,
} from "@/server/console/bug-triage-config";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROMPT_PAYLOAD_CHARS = 12_000;

export type BugTriagePromptReport = {
  title: string;
  summary: string;
  severity: string;
  surface: string | null;
  payload: Record<string, unknown>;
};

export class BugTriageEngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BugTriageEngineError";
    this.code = code;
  }
}

export function requireBugTriageEngineConfig(env: Record<string, string | undefined> = process.env) {
  const config = readBugTriageEngineConfig(env);
  if (!config) {
    throw new BugTriageEngineError(
      TRIAGE_ENGINE_NOT_CONFIGURED,
      "Bug triage engine is not configured. Set RAVI_BUG_TRIAGE_API_BASE and RAVI_BUG_TRIAGE_API_KEY.",
    );
  }
  return config;
}

export function bugTriageChatCompletionsUrl(apiBase: string) {
  const base = apiBase.replace(/\/$/, "");
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function buildBugTriageMessages(report: BugTriagePromptReport) {
  const dossier = truncateJson(report.payload, MAX_PROMPT_PAYLOAD_CHARS);
  return [
    {
      role: "system",
      content: [
        "You are Ravi Console internal bug triage.",
        "Return ONLY a JSON object matching ravi.bug_triage/v1.",
        "Required keys: schemaVersion, model, summary, suggestedPriority, similarBugIds, missingEvidence, clarifyingQuestions, confidence.",
        'schemaVersion must be "ravi.bug_triage/v1".',
        "suggestedPriority must be one of p0, p1, p2, p3.",
        "similarBugIds must be an empty array. Duplicate detection is out of scope; do not invent UUIDs.",
        "confidence is a number from 0 to 1.",
        "You only suggest. Do not claim priority or status were applied.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        title: report.title,
        summary: report.summary,
        severity: report.severity,
        surface: report.surface,
        payload: dossier,
      }),
    },
  ];
}

export function parseModelTriageOutput(input: { text: string; model: string }): BugTriageV1 {
  const json = extractJsonObject(input.text);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new BugTriageEngineError("triage_model_output_invalid", "Model output was not a JSON object.");
  }
  const record = json as Record<string, unknown>;
  const similar = Array.isArray(record.similarBugIds)
    ? record.similarBugIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
    : [];
  return parseBugTriageV1({
    ...record,
    schemaVersion: BUG_TRIAGE_SCHEMA_VERSION,
    model: typeof record.model === "string" && record.model.trim() ? record.model : input.model,
    similarBugIds: similar,
  });
}

export function extractChatCompletionText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BugTriageEngineError("triage_model_http_invalid", "Model response was not a JSON object.");
  }
  const record = payload as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const message = (first as Record<string, unknown>).message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string" && content.trim()) return content;
    }
    const text = (first as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return text;
  }
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text;
  if (typeof record.content === "string" && record.content.trim()) return record.content;
  throw new BugTriageEngineError("triage_model_http_invalid", "Model response had no text content.");
}

export async function completeBugTriageSuggestion(input: {
  report: BugTriagePromptReport;
  env?: Record<string, string | undefined>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<BugTriageV1> {
  const config = requireBugTriageEngineConfig(input.env);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(bugTriageChatCompletionsUrl(config.apiBase), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: buildBugTriageMessages(input.report),
    }),
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new BugTriageEngineError("triage_model_http_failed", `Model host returned ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawText) as unknown;
  } catch {
    throw new BugTriageEngineError("triage_model_http_invalid", "Model host returned non-JSON.");
  }
  return parseModelTriageOutput({
    text: extractChatCompletionText(payload),
    model: config.model,
  });
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    }
    throw new BugTriageEngineError("triage_model_output_invalid", "Model output was not valid JSON.");
  }
}

function truncateJson(value: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (encoded.length <= maxChars) return value;
  return { truncated: true, excerpt: encoded.slice(0, maxChars) };
}
