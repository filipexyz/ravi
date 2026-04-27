/**
 * prox.city Calls — Provider Adapter
 *
 * Defines the provider boundary and provides:
 * - StubCallProvider for dry-run / no-credentials mode
 * - ElevenLabsTwilioCallProvider for real outbound calls via ElevenLabs + Twilio
 */

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallProviderAdapter, ProviderDialInput, ProviderDialResult } from "./types.js";
import type { CallProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Stub adapter (dry-run / no-credentials mode)
// ---------------------------------------------------------------------------

/**
 * A safe stub adapter that simulates a successful dial without making
 * any real provider API calls. Used when ElevenLabs/Twilio credentials
 * are not available or when running in dry-run mode.
 */
export class StubCallProvider implements CallProviderAdapter {
  readonly name = "stub";

  async dial(_input: ProviderDialInput): Promise<ProviderDialResult> {
    const simulatedId = `stub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      provider_call_id: simulatedId,
      twilio_call_sid: null,
      status: "completed",
      failure_reason: null,
    };
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs + Twilio adapter
// ---------------------------------------------------------------------------

export interface ElevenLabsTwilioConfig {
  apiKey: string;
}

function readRaviEnvApiKey(): string | undefined {
  if (process.env.RAVI_CALLS_DISABLE_ENV_FILE === "1") return undefined;
  const envPath = join(process.env.HOME ?? "", ".ravi/.env");
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith("ELEVENLABS_API_KEY="));
  if (!line) return undefined;
  const value = line.split("=").slice(1).join("=").trim();
  return value.replace(/^['"]|['"]$/g, "") || undefined;
}

function resolveElevenLabsApiKey(): string {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || readRaviEnvApiKey();
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured.");
  return apiKey;
}

/**
 * Validates that all required fields are present before attempting a live dial.
 * Returns a failure reason string or null if valid.
 */
function validateDialInput(input: ProviderDialInput): string | null {
  if (!input.profile.provider_agent_id) {
    return "Missing provider_agent_id on call profile. Configure with: ravi prox calls profiles configure <id> --agent-id <elevenlabs_agent_id>";
  }
  if (!input.profile.twilio_number_id) {
    return "Missing twilio_number_id on call profile. Configure with: ravi prox calls profiles configure <id> --twilio-number-id <id>";
  }
  if (!input.target_phone) {
    return "Missing target phone number. Use --phone <e164> on the request command.";
  }
  return null;
}

function extractDynamicVariables(metadata: Record<string, unknown> | null): Record<string, string> {
  const raw = metadata?.dynamic_variables ?? metadata?.dynamicVariables;
  if (!isJsonRecord(raw)) return {};

  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim()) continue;
    if (typeof value === "string") {
      variables[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      variables[key] = String(value);
    }
  }
  return variables;
}

export class ElevenLabsTwilioCallProvider implements CallProviderAdapter {
  readonly name = "elevenlabs_twilio";
  private readonly config: ElevenLabsTwilioConfig;

  constructor(config: ElevenLabsTwilioConfig) {
    this.config = config;
  }

  async dial(input: ProviderDialInput): Promise<ProviderDialResult> {
    const validationError = validateDialInput(input);
    if (validationError) {
      return {
        provider_call_id: null,
        twilio_call_sid: null,
        status: "failed",
        failure_reason: validationError,
      };
    }

    const client = new ElevenLabsClient({ apiKey: this.config.apiKey });

    const result = await client.conversationalAi.twilio.outboundCall({
      agentId: input.profile.provider_agent_id,
      agentPhoneNumberId: input.profile.twilio_number_id,
      toNumber: input.target_phone,
      conversationInitiationClientData: {
        dynamicVariables: {
          person_name: input.request.target_person_id,
          reason: input.request.reason,
          ...extractDynamicVariables(input.request.metadata_json),
        },
      },
    });

    if (!result.success) {
      return {
        provider_call_id: result.conversationId ?? null,
        twilio_call_sid: result.callSid ?? null,
        status: "failed",
        failure_reason: result.message || "ElevenLabs API returned success=false",
      };
    }

    // The API confirms initiation only. Keep run as dialing — terminal
    // state arrives via webhook or polling.
    return {
      provider_call_id: result.conversationId ?? null,
      twilio_call_sid: result.callSid ?? null,
      status: "dialing",
      failure_reason: null,
    };
  }
}

export interface SyncElevenLabsAgentProfileResult {
  agentId: string;
  firstMessageSynced: boolean;
  systemPromptSynced: boolean;
  dynamicVariablesSynced: boolean;
}

const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1";

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getJsonRecord(value: unknown): JsonRecord {
  return isJsonRecord(value) ? value : {};
}

function describeElevenLabsError(status: number, body: unknown): string {
  if (isJsonRecord(body)) {
    const detail = body.detail ?? body.message ?? body.error;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (isJsonRecord(detail)) {
      const detailMessage = detail.message ?? detail.reason;
      if (typeof detailMessage === "string" && detailMessage.trim()) return detailMessage;
    }
  }
  return `HTTP ${status}`;
}

async function requestElevenLabsJson(
  apiKey: string,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<JsonRecord> {
  const response = await fetch(`${ELEVENLABS_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "xi-api-key": apiKey,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new Error(describeElevenLabsError(response.status, body));
  }

  return getJsonRecord(body);
}

async function fetchElevenLabsAgentRaw(apiKey: string, agentId: string): Promise<JsonRecord> {
  return requestElevenLabsJson(apiKey, `/convai/agents/${encodeURIComponent(agentId)}`, {
    method: "GET",
  });
}

async function patchElevenLabsAgentRaw(apiKey: string, agentId: string, body: JsonRecord): Promise<void> {
  await requestElevenLabsJson(apiKey, `/convai/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function syncElevenLabsAgentProfile(
  profile: CallProfile,
  options: {
    firstMessage?: string | null;
    systemPrompt?: string | null;
    dynamicVariablePlaceholders?: Record<string, string> | null;
  },
): Promise<SyncElevenLabsAgentProfileResult | null> {
  if (profile.provider !== "elevenlabs_twilio" && profile.provider !== "elevenlabs") return null;
  if (!profile.provider_agent_id) return null;

  const firstMessageSynced = options.firstMessage !== undefined;
  const systemPromptSynced = options.systemPrompt !== undefined;
  const dynamicVariablesSynced = options.dynamicVariablePlaceholders !== undefined;
  if (!firstMessageSynced && !systemPromptSynced && !dynamicVariablesSynced) return null;

  const apiKey = resolveElevenLabsApiKey();
  const agent = await fetchElevenLabsAgentRaw(apiKey, profile.provider_agent_id);
  const conversationConfig = {
    ...getJsonRecord(agent.conversation_config),
  };
  const agentConfig = {
    ...getJsonRecord(conversationConfig.agent),
  };

  if (firstMessageSynced) {
    agentConfig.first_message = options.firstMessage ?? "";
  }

  if (systemPromptSynced) {
    agentConfig.prompt = {
      ...getJsonRecord(agentConfig.prompt),
      prompt: options.systemPrompt ?? "",
    };
  }

  if (dynamicVariablesSynced) {
    const dynamicVariables = {
      ...getJsonRecord(agentConfig.dynamic_variables),
    };
    dynamicVariables.dynamic_variable_placeholders = {
      ...getJsonRecord(dynamicVariables.dynamic_variable_placeholders),
      ...(options.dynamicVariablePlaceholders ?? {}),
    };
    agentConfig.dynamic_variables = dynamicVariables;
  }

  conversationConfig.agent = agentConfig;

  await patchElevenLabsAgentRaw(apiKey, profile.provider_agent_id, {
    conversation_config: conversationConfig,
  });

  return {
    agentId: profile.provider_agent_id,
    firstMessageSynced,
    systemPromptSynced,
    dynamicVariablesSynced,
  };
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const adapters = new Map<string, CallProviderAdapter>();

/** Register a provider adapter by name. */
export function registerCallProvider(adapter: CallProviderAdapter): void {
  adapters.set(adapter.name, adapter);
}

/**
 * Auto-register the ElevenLabs/Twilio adapter if ELEVENLABS_API_KEY is set
 * and the adapter is not already registered.
 */
function ensureElevenLabsAdapter(): void {
  if (adapters.has("elevenlabs_twilio")) return;
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || readRaviEnvApiKey();
  if (!apiKey) return;
  const adapter = new ElevenLabsTwilioCallProvider({ apiKey });
  adapters.set(adapter.name, adapter);
}

/**
 * Get a provider adapter by name.
 *
 * - If `name` matches a registered adapter, return it.
 * - If `name` is "stub" or omitted and no real adapter is registered,
 *   returns the stub adapter.
 * - If `name` is a real provider name but not registered, throws
 *   instead of silently falling back to stub.
 */
export function getCallProvider(name?: string): CallProviderAdapter {
  ensureElevenLabsAdapter();

  if (name && adapters.has(name)) {
    return adapters.get(name)!;
  }

  // Explicit stub request or no name given
  if (!name || name === "stub") {
    if (adapters.size > 0) {
      // Prefer a real adapter if one exists
      for (const [adapterName, adapter] of adapters) {
        if (adapterName !== "stub") return adapter;
      }
    }
    // Fall back to stub only when no real adapter or explicitly stub
    if (!adapters.has("stub")) {
      const stub = new StubCallProvider();
      adapters.set(stub.name, stub);
    }
    return adapters.get("stub")!;
  }

  // Treat "elevenlabs" as an alias for "elevenlabs_twilio"
  if ((name === "elevenlabs" || name === "elevenlabs-twilio") && adapters.has("elevenlabs_twilio")) {
    return adapters.get("elevenlabs_twilio")!;
  }

  // Named a real provider that is not registered — fail explicitly
  throw new Error(
    `Call provider "${name}" is not registered. Set ELEVENLABS_API_KEY in ~/.ravi/.env or use provider "stub" for dry-run.`,
  );
}

/** Check if a real (non-stub) provider is configured. */
export function hasRealProvider(): boolean {
  ensureElevenLabsAdapter();
  for (const [name] of adapters) {
    if (name !== "stub") return true;
  }
  return false;
}

/** Reset provider registry (for testing). */
export function resetProviders(): void {
  adapters.clear();
}
