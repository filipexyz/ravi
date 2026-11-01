import { CloudAuthError, classifyConsoleNetworkError } from "../cloud-auth/errors.js";
import { inspectExecutionPlane } from "../isolation/execution-plane.js";
import { createAuthenticatedPagesContext, type PagesClientDeps, type PagesClientOptions } from "./client.js";

/**
 * Page Chat: the agent inside a Ravi Page, by voice (`enabled`) and by text
 * (`text`: the chat panel in the Pages bar and the `<ravi-chat>` tag). Console
 * owns the feature, the agent, metering and the Pages Worker. This module only
 * reads and changes one site's settings through the Console CLI API:
 *
 *   GET   /api/cli/projects/:projectRef/pages/:siteRef/chat
 *   PATCH /api/cli/projects/:projectRef/pages/:siteRef/chat
 *
 * `siteRef` accepts a host slug, site id or hostname. PATCH carries only the
 * fields the caller set; `null` clears `assistantName`, `instructions`,
 * `textModel` or `raviAgent`.
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

/** When the agent answers in a page's shared room: only when called, or to every message. */
export const PAGE_CHAT_REPLY_POLICIES = ["mention", "always"] as const;
export type PageChatReplyPolicy = (typeof PAGE_CHAT_REPLY_POLICIES)[number];
export const PAGE_CHAT_DEFAULT_REPLY_POLICY: PageChatReplyPolicy = "mention";

/** An AI Gateway model id, `<provider>/<model>` (the Console's pattern). */
export const PAGE_CHAT_TEXT_MODEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}\/[a-z0-9][a-z0-9.:-]{0,80}$/;
export const PAGE_CHAT_RAVI_AGENT_ID_MAX = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PageChatField =
  | "enabled"
  | "assistantName"
  | "voice"
  | "language"
  | "instructions"
  | "text"
  | "replyPolicy"
  | "textModel"
  | "raviAgent";

/** The agent of a linked Ravi machine that the text chat may ask (a Library request). */
export interface PageChatRaviAgent {
  installationId: string;
  agentId: string;
}

export interface PageChatSettings {
  enabled: boolean;
  assistantName: string | null;
  voice: string;
  language: string;
  instructions: string | null;
  text: boolean;
  replyPolicy: PageChatReplyPolicy;
  textModel: string | null;
  raviAgent: PageChatRaviAgent | null;
}

export interface PageChatPatchBody {
  enabled?: boolean;
  assistantName?: string | null;
  voice?: string;
  language?: string;
  instructions?: string | null;
  text?: boolean;
  replyPolicy?: PageChatReplyPolicy;
  textModel?: string | null;
  raviAgent?: PageChatRaviAgent | null;
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
  text?: string | boolean;
  replyPolicy?: string;
  textModel?: string;
  clearTextModel?: boolean;
  raviAgent?: string;
  clearRaviAgent?: boolean;
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

export function normalizePageChatEnabled(value: string | boolean | undefined, flag = "--enabled"): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new CloudAuthError("PAYLOAD_INVALID", `${flag} must be true or false. Received "${value}".`);
}

export function normalizePageChatReplyPolicy(value: string | undefined): PageChatReplyPolicy | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const policy = PAGE_CHAT_REPLY_POLICIES.find((candidate) => candidate === normalized);
  if (!policy) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--reply-policy must be one of: ${PAGE_CHAT_REPLY_POLICIES.join(", ")}. Received "${value.trim().slice(0, 40)}".`,
    );
  }
  return policy;
}

export function normalizePageChatTextModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "--text-model is empty. Use --clear-text-model to go back to the platform default.",
    );
  }
  if (!PAGE_CHAT_TEXT_MODEL_PATTERN.test(normalized)) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--text-model must be an AI Gateway model id such as <provider>/<model>. Received "${value.trim().slice(0, 130)}".`,
    );
  }
  return normalized;
}

/**
 * `<installationId>/<agentId>`: the installation id (a UUID, as
 * `ravi agents directory --json` prints it) and the agent id there.
 */
export function normalizePageChatRaviAgent(value: string | undefined): PageChatRaviAgent | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  const installationId = slash > 0 ? trimmed.slice(0, slash).trim().toLowerCase() : "";
  const agentId = slash > 0 ? trimmed.slice(slash + 1).trim() : "";
  if (
    !UUID_PATTERN.test(installationId) ||
    !agentId ||
    agentId.length > PAGE_CHAT_RAVI_AGENT_ID_MAX ||
    /[\s/]/.test(agentId) ||
    hasControlCharacters(agentId)
  ) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--ravi-agent must be <installationId>/<agentId>, with the installation id from ravi agents directory --json. Received "${trimmed.slice(0, 160)}".`,
    );
  }
  return { installationId, agentId };
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
  if (input.textModel !== undefined && input.clearTextModel === true) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Conflicting flags: pass either --text-model or --clear-text-model, not both.",
    );
  }
  if (input.raviAgent !== undefined && input.clearRaviAgent === true) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Conflicting flags: pass either --ravi-agent or --clear-ravi-agent, not both.",
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
  const text = normalizePageChatEnabled(input.text, "--text");
  if (text !== undefined) body.text = text;
  const replyPolicy = normalizePageChatReplyPolicy(input.replyPolicy);
  if (replyPolicy !== undefined) body.replyPolicy = replyPolicy;
  const textModel = input.clearTextModel === true ? null : normalizePageChatTextModel(input.textModel);
  if (textModel !== undefined) body.textModel = textModel;
  const raviAgent = input.clearRaviAgent === true ? null : normalizePageChatRaviAgent(input.raviAgent);
  if (raviAgent !== undefined) body.raviAgent = raviAgent;
  if (Object.keys(body).length === 0) {
    const message =
      "Missing a setting to change. Pass at least one of --enabled, --voice, --name, --clear-name, --language, --instructions, --clear-instructions, --text, --reply-policy, --text-model, --clear-text-model, --ravi-agent or --clear-ravi-agent.";
    throw new CloudAuthError("PAYLOAD_INVALID", message, { issues: [{ path: [], code: "invalid", message }] });
  }
  return body;
}

export function pageChatChangedFields(body: PageChatPatchBody): PageChatField[] {
  const order: PageChatField[] = [
    "enabled",
    "assistantName",
    "voice",
    "language",
    "instructions",
    "text",
    "replyPolicy",
    "textModel",
    "raviAgent",
  ];
  return order.filter((field) => field in body);
}

/**
 * What in a PATCH body widens what the Page agent does, in words for the
 * dry-run plan: turning the voice or the text chat on (a metered agent for
 * every viewer the site lets in), answering every message of a shared room,
 * and letting the agent ask an agent of a Ravi machine. Empty when the body
 * only reduces or reshapes what is there; those changes apply at once.
 */
export function pageChatExpandingEffects(body: PageChatPatchBody): string[] {
  const effects: string[] = [];
  if (body.enabled === true) {
    effects.push("enable the Page Chat voice agent for signed-in viewers of this site (metered voice usage)");
  }
  if (body.text === true) {
    effects.push("turn on the text chat for the members and guests who can open this site (metered agent turns)");
  }
  if (body.replyPolicy === "always") {
    effects.push("the agent answers every message in the page's shared rooms, not only when called");
  }
  if (body.raviAgent) {
    effects.push(
      `let the Page agent ask ${body.raviAgent.installationId}/${body.raviAgent.agentId} on a Ravi machine for the people chatting`,
    );
  }
  return effects;
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
  // `text` is a content key the plan redaction hides; the plan names it `textChat`.
  if (body.text !== undefined) plan.textChat = body.text;
  if (body.replyPolicy !== undefined) plan.replyPolicy = body.replyPolicy;
  if (body.textModel !== undefined) plan.textModel = body.textModel;
  if (body.raviAgent === null) plan.raviAgent = null;
  else if (body.raviAgent !== undefined) plan.raviAgent = `${body.raviAgent.installationId}/${body.raviAgent.agentId}`;
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
      // Fields a Console without the text chat does not send read as their defaults.
      text: typeof settingsRecord.text === "boolean" ? settingsRecord.text : true,
      replyPolicy:
        PAGE_CHAT_REPLY_POLICIES.find((policy) => policy === settingsRecord.replyPolicy) ??
        PAGE_CHAT_DEFAULT_REPLY_POLICY,
      textModel: stringValue(settingsRecord.textModel),
      raviAgent: readRaviAgent(settingsRecord.raviAgent),
    },
    voices: voices.length > 0 ? voices : [...PAGE_CHAT_VOICES],
  };
}

function readRaviAgent(value: unknown): PageChatRaviAgent | null {
  const record = objectValue(value);
  const installationId = stringValue(record?.installationId);
  const agentId = stringValue(record?.agentId);
  return installationId && agentId ? { installationId, agentId } : null;
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
