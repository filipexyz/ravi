/**
 * prox.city Calls — Provider Adapter
 *
 * Defines the provider boundary and provides:
 * - StubCallProvider for dry-run / no-credentials mode
 * - ElevenLabsTwilioCallProvider for real outbound calls via ElevenLabs + Twilio
 */

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { CallProviderAdapter, ProviderDialInput, ProviderDialResult } from "./types.js";

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
  const apiKey = process.env.ELEVENLABS_API_KEY;
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
