import { CloudAuthError, classifyConsoleNetworkError } from "../cloud-auth/errors.js";
import { inspectExecutionPlane } from "../isolation/execution-plane.js";
import { createAuthenticatedPagesContext, type PagesClientDeps, type PagesClientOptions } from "./client.js";

/**
 * Page Chat: the voice agent inside a Ravi Page. Console owns the feature,
 * metering and the Pages Worker. This module only reads and changes one
 * site's settings through the Console CLI API:
 *
 *   GET   /api/cli/projects/:projectRef/pages/:siteRef/chat
 *   PATCH /api/cli/projects/:projectRef/pages/:siteRef/chat
 *
 * `siteRef` accepts a host slug, site id or hostname. PATCH carries only the
 * fields the caller set; `null` clears `assistantName` or `instructions`.
 */
export const PAGE_CHAT_COLLECTION = "chat";

/** Org-level Console feature that must also be on for any site to show Page Chat. */
export const PAGE_CHAT_FEATURE = "console.pages.chat";

export const PAGE_CHAT_VOICES = [
  "bossa",
  "tempo",
  "marin",
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "beacon",
  "delta",
  "cinder",
] as const;

export type PageChatVoice = (typeof PAGE_CHAT_VOICES)[number];

export const PAGE_CHAT_DEFAULT_VOICE: PageChatVoice = "bossa";
export const PAGE_CHAT_DEFAULT_LANGUAGE = "pt-BR";
export const PAGE_CHAT_ASSISTANT_NAME_MAX = 60;
export const PAGE_CHAT_INSTRUCTIONS_MAX = 2000;
const PAGE_CHAT_LANGUAGE_MAX = 35;

export type PageChatField = "enabled" | "assistantName" | "voice" | "language" | "instructions";

export interface PageChatSettings {
  enabled: boolean;
  assistantName: string | null;
  voice: string;
  language: string;
  instructions: string | null;
}

export interface PageChatPatchBody {
  enabled?: boolean;
  assistantName?: string | null;
  voice?: string;
  language?: string;
  instructions?: string | null;
}

/** Raw CLI flags for `ravi pages chat set`, before validation. */
export interface PageChatSetInput {
  enabled?: string | boolean;
  voice?: string;
  name?: string;
  clearName?: boolean;
  language?: string;
  instructions?: string;
  clearInstructions?: boolean;
}

export interface PageChatShowOptions extends PagesClientOptions {
  project: string;
  site: string;
}

export interface PageChatUpdateOptions extends PageChatShowOptions {
  body: PageChatPatchBody;
}

export interface PageChatResult {
  success: true;
  consoleUrl: string;
  projectRef: string;
  siteRef: string;
  siteId: string | null;
  host: string | null;
  featureEnabled: boolean;
  settings: PageChatSettings;
  voices: string[];
}

export interface PageChatUpdateResult extends PageChatResult {
  changed: PageChatField[];
}

export function pageChatPath(project: string, site: string): string {
  return `/api/cli/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(site)}/${PAGE_CHAT_COLLECTION}`;
}

export function normalizePageChatEnabled(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new CloudAuthError("PAYLOAD_INVALID", `--enabled must be true or false. Received "${value}".`);
}

export function normalizePageChatVoice(value: string | undefined): PageChatVoice | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const voice = PAGE_CHAT_VOICES.find((candidate) => candidate === normalized);
  if (!voice) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--voice must be one of: ${PAGE_CHAT_VOICES.join(", ")}. Received "${value.trim()}".`,
    );
  }
  return voice;
}

export function normalizePageChatLanguage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new CloudAuthError("PAYLOAD_INVALID", "--language must be a BCP 47 tag such as pt-BR or en-US.");
  let canonical: string | undefined;
  if (trimmed.length <= PAGE_CHAT_LANGUAGE_MAX && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(trimmed)) {
    try {
      canonical = Intl.getCanonicalLocales(trimmed)[0];
    } catch {
      canonical = undefined;
    }
  }
  if (!canonical) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--language must be a BCP 47 tag such as pt-BR or en-US. Received "${trimmed.slice(0, PAGE_CHAT_LANGUAGE_MAX)}".`,
    );
  }
  return canonical;
}

export function normalizePageChatAssistantName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--name is empty. Use --clear-name to remove the assistant name.");
  }
  if (hasControlCharacters(trimmed)) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--name must be a single line of text.");
  }
  if ([...trimmed].length > PAGE_CHAT_ASSISTANT_NAME_MAX) {
    throw new CloudAuthError("PAYLOAD_INVALID", `--name must be at most ${PAGE_CHAT_ASSISTANT_NAME_MAX} characters.`);
  }
  return trimmed;
}

export function normalizePageChatInstructions(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "--instructions is empty. Use --clear-instructions to remove the extra instructions.",
    );
  }
  if ([...trimmed].length > PAGE_CHAT_INSTRUCTIONS_MAX) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--instructions must be at most ${PAGE_CHAT_INSTRUCTIONS_MAX} characters.`,
    );
  }
  return trimmed;
}

/**
 * Validate `pages chat set` flags and build the PATCH body. Only flags the
 * caller set reach the body. Every failure is a usage error (exit 2) that
 * fires before credentials, project resolution or any Console call.
 */
export function buildPageChatPatchBody(input: PageChatSetInput): PageChatPatchBody {
  if (input.name !== undefined && input.clearName === true) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Conflicting flags: pass either --name or --clear-name, not both.");
  }
  if (input.instructions !== undefined && input.clearInstructions === true) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Conflicting flags: pass either --instructions or --clear-instructions, not both.",
    );
  }
  const body: PageChatPatchBody = {};
  const enabled = normalizePageChatEnabled(input.enabled);
  if (enabled !== undefined) body.enabled = enabled;
  const assistantName = input.clearName === true ? null : normalizePageChatAssistantName(input.name);
  if (assistantName !== undefined) body.assistantName = assistantName;
  const voice = normalizePageChatVoice(input.voice);
  if (voice !== undefined) body.voice = voice;
  const language = normalizePageChatLanguage(input.language);
  if (language !== undefined) body.language = language;
  const instructions = input.clearInstructions === true ? null : normalizePageChatInstructions(input.instructions);
  if (instructions !== undefined) body.instructions = instructions;
  if (Object.keys(body).length === 0) {
    const message =
      "Missing a setting to change. Pass at least one of --enabled, --voice, --name, --clear-name, --language, --instructions or --clear-instructions.";
    throw new CloudAuthError("PAYLOAD_INVALID", message, { issues: [{ path: [], code: "invalid", message }] });
  }
  return body;
}

export function pageChatChangedFields(body: PageChatPatchBody): PageChatField[] {
  const order: PageChatField[] = ["enabled", "assistantName", "voice", "language", "instructions"];
  return order.filter((field) => field in body);
}

/**
 * Secret-free, bounded description of a PATCH body for a dry-run plan.
 * Instructions are reported by length only.
 */
export function describePageChatPatch(body: PageChatPatchBody): Record<string, string | number | boolean | null> {
  const plan: Record<string, string | number | boolean | null> = {};
  if (body.enabled !== undefined) plan.enabled = body.enabled;
  if (body.assistantName !== undefined) plan.assistantName = body.assistantName;
  if (body.voice !== undefined) plan.voice = body.voice;
  if (body.language !== undefined) plan.language = body.language;
  if (body.instructions === null) plan.instructions = null;
  else if (body.instructions !== undefined) plan.instructionsLength = [...body.instructions].length;
  return plan;
}

export async function getPageChatSettings(
  options: PageChatShowOptions,
  deps: PagesClientDeps = {},
): Promise<PageChatResult> {
  const project = requireText(options.project, "project");
  const site = requireText(options.site, "site");
  const auth = await createAuthenticatedPagesContext(options, deps);
  const payload = await requestPageChat(auth, "GET", pageChatPath(project, site), undefined);
  return { ...readPageChatPayload(payload, { project, site }), consoleUrl: auth.consoleUrl };
}

export async function updatePageChatSettings(
  options: PageChatUpdateOptions,
  deps: PagesClientDeps = {},
): Promise<PageChatUpdateResult> {
  const project = requireText(options.project, "project");
  const site = requireText(options.site, "site");
  const changed = pageChatChangedFields(options.body);
  if (changed.length === 0) throw new CloudAuthError("PAYLOAD_INVALID", "Missing a setting to change.");
  const auth = await createAuthenticatedPagesContext(options, deps);
  const payload = await requestPageChat(auth, "PATCH", pageChatPath(project, site), options.body);
  return { ...readPageChatPayload(payload, { project, site }), changed, consoleUrl: auth.consoleUrl };
}

async function requestPageChat(
  auth: Awaited<ReturnType<typeof createAuthenticatedPagesContext>>,
  method: "GET" | "PATCH",
  path: string,
  body: PageChatPatchBody | undefined,
): Promise<unknown> {
  try {
    return await auth.client.requestJson<unknown>(method, path, body, auth.accessToken);
  } catch (error) {
    if (error instanceof CloudAuthError) throw error;
    throw classifyConsoleNetworkError(error, inspectExecutionPlane());
  }
}

/**
 * Parse the Console response. The CLI success envelope is flat; a nested
 * `data` object is accepted too. Only allowlisted fields leave this function.
 */
export function readPageChatPayload(
  payload: unknown,
  fallback: { project: string; site: string },
): Omit<PageChatResult, "consoleUrl"> {
  const outer = objectValue(payload);
  const record = objectValue(outer?.data) ?? outer;
  if (!record) throw invalidConsoleResponse("Page Chat response");
  const settingsRecord = objectValue(record.settings);
  if (!settingsRecord) throw invalidConsoleResponse("Page Chat settings");
  if (typeof settingsRecord.enabled !== "boolean") throw invalidConsoleResponse("settings.enabled");
  if (typeof record.featureEnabled !== "boolean") throw invalidConsoleResponse("featureEnabled");
  const voices = Array.isArray(record.voices)
    ? [...new Set(record.voices.filter((voice): voice is string => typeof voice === "string" && voice.trim() !== ""))]
    : [];
  return {
    success: true,
    projectRef: stringValue(record.projectRef) ?? fallback.project,
    siteRef: stringValue(record.siteRef) ?? fallback.site,
    siteId: stringValue(record.siteId),
    host: stringValue(record.host),
    featureEnabled: record.featureEnabled,
    settings: {
      enabled: settingsRecord.enabled,
      assistantName: stringValue(settingsRecord.assistantName),
      voice: stringValue(settingsRecord.voice) ?? PAGE_CHAT_DEFAULT_VOICE,
      language: stringValue(settingsRecord.language) ?? PAGE_CHAT_DEFAULT_LANGUAGE,
      instructions: stringValue(settingsRecord.instructions),
    },
    voices: voices.length > 0 ? voices : [...PAGE_CHAT_VOICES],
  };
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function invalidConsoleResponse(label: string): CloudAuthError {
  return new CloudAuthError("SERVER_UNAVAILABLE", `Console returned an invalid ${label}.`);
}
