/**
 * prox.city Calls — Provider Adapter
 *
 * Defines the provider boundary and provides a safe stub adapter
 * for MVP use when real ElevenLabs/Twilio credentials are not configured.
 */

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
// Provider registry
// ---------------------------------------------------------------------------

const adapters = new Map<string, CallProviderAdapter>();

/** Register a provider adapter by name. */
export function registerCallProvider(adapter: CallProviderAdapter): void {
  adapters.set(adapter.name, adapter);
}

/** Get the active provider adapter. Falls back to stub if none registered. */
export function getCallProvider(name?: string): CallProviderAdapter {
  if (name && adapters.has(name)) {
    return adapters.get(name)!;
  }
  if (adapters.size > 0) {
    return adapters.values().next().value!;
  }
  // Default: stub adapter
  const stub = new StubCallProvider();
  adapters.set(stub.name, stub);
  return stub;
}

/** Check if a real (non-stub) provider is configured. */
export function hasRealProvider(): boolean {
  for (const [name] of adapters) {
    if (name !== "stub") return true;
  }
  return false;
}

/** Reset provider registry (for testing). */
export function resetProviders(): void {
  adapters.clear();
}
