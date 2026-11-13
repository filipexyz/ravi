/**
 * Runtime liveness probe — proves a (provider, model, effort, thinking)
 * selection can complete one real provider turn on this installation.
 *
 * `ravi sessions update` applies a runtime change, runs this probe, and rolls
 * the change back when the probe fails, so a bad selection never survives as
 * session state that only dies, masked, on the session's next real turn.
 *
 * The probe runs out-of-band: a scratch working directory, no tools, no chat
 * delivery, and no writes to the target session's provider continuity. It
 * resolves managed credentials through the same pool the daemon uses, so what
 * it proves is what the next real turn will run.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRuntimeCredentialAttemptBinding } from "./credential-resolver.js";
import { isolateSelectedClaudeAuthEnv } from "./credential-secret-shape.js";
import { completeRuntimeCredentialAttempt, markRuntimeCredentialAttemptStarted } from "./credential-store.js";
import { createRuntimeProvider } from "./provider-registry.js";
import {
  buildRuntimeCredentialProfileEnv,
  formatRuntimeCredentialResolutionFailure,
} from "./credential-profile-env.js";
import type {
  RuntimeEffort,
  RuntimePromptMessage,
  RuntimeProviderId,
  RuntimeThinking,
  SessionRuntimeProvider,
} from "./types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("runtime-probe");

export const DEFAULT_RUNTIME_PROBE_TIMEOUT_MS = 120_000;

const PROBE_PROMPT = "Reply with the single word OK.";
const PROBE_SYSTEM_PROMPT =
  "This is an automated runtime liveness probe. Reply with the single word OK and nothing else.";

export interface RuntimeProbeRequest {
  provider: RuntimeProviderId;
  model: string;
  effort?: RuntimeEffort;
  thinking?: RuntimeThinking;
  /** Attribution only; the probe never touches this agent's session state. */
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the provider registry. */
  createProvider?: (providerId: RuntimeProviderId) => SessionRuntimeProvider;
  /** Test seam: replaces managed credential resolution. */
  resolveCredential?: typeof resolveRuntimeCredentialAttemptBinding;
}

export interface RuntimeProbeResult {
  ok: boolean;
  provider: RuntimeProviderId;
  model: string;
  effort?: RuntimeEffort;
  thinking?: RuntimeThinking;
  durationMs: number;
  credentialId?: string;
  credentialLabel?: string;
  /** Terminal failure cause when ok is false. */
  error?: string;
  timedOut?: boolean;
}

function createProbePrompt(text: string): AsyncGenerator<RuntimePromptMessage> {
  return (async function* () {
    yield {
      type: "user",
      message: { role: "user", content: text },
      session_id: "",
      parent_tool_use_id: null,
    } as RuntimePromptMessage;
  })();
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function probeRuntimeTurn(request: RuntimeProbeRequest): Promise<RuntimeProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = request.timeoutMs ?? DEFAULT_RUNTIME_PROBE_TIMEOUT_MS;
  const base: Omit<RuntimeProbeResult, "ok" | "durationMs"> = {
    provider: request.provider,
    model: request.model,
    ...(request.effort ? { effort: request.effort } : {}),
    ...(request.thinking ? { thinking: request.thinking } : {}),
  };
  const fail = (error: string, extra: Partial<RuntimeProbeResult> = {}): RuntimeProbeResult => ({
    ...base,
    ok: false,
    durationMs: Date.now() - startedAt,
    error,
    ...extra,
  });

  let provider: SessionRuntimeProvider;
  try {
    provider = (request.createProvider ?? createRuntimeProvider)(request.provider);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const baseEnv = request.env ?? process.env;
  const resolveCredential = request.resolveCredential ?? resolveRuntimeCredentialAttemptBinding;
  let credentialResolution: Awaited<ReturnType<typeof resolveRuntimeCredentialAttemptBinding>>;
  try {
    credentialResolution = await resolveCredential({
      runtimeProvider: request.provider,
      model: request.model,
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      sessionName: request.sessionName,
      runId: `probe_${randomUUID()}`,
      env: baseEnv,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const binding = credentialResolution.attemptBinding;
  if (!binding && credentialResolution.managedPoolConfigured) {
    return fail(
      formatRuntimeCredentialResolutionFailure(request.provider, request.model, credentialResolution.rejected),
    );
  }
  if (binding) {
    base.credentialId = binding.credentialId;
    base.credentialLabel = binding.label;
  }

  const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-probe-"));
  const abortController = new AbortController();
  let timedOut = false;
  let settled: RuntimeProbeResult | null = null;

  try {
    const bootstrap = await provider.prepareSession?.({
      agentId: request.agentId ?? "runtime-probe",
      cwd,
    });
    const runtimeEnv: Record<string, string> = {
      ...stringEnv(baseEnv),
      ...(bootstrap?.env ?? {}),
      ...(buildRuntimeCredentialProfileEnv(request.provider, binding ?? undefined, baseEnv) ?? {}),
      ...(binding?.resolvedEnv ?? {}),
    };
    isolateSelectedClaudeAuthEnv({
      runtimeProviderId: request.provider,
      binding: binding ?? null,
      runtimeEnv,
    });

    markRuntimeCredentialAttemptStarted(binding?.attemptId);
    const handle = provider.startSession({
      prompt: createProbePrompt(PROBE_PROMPT),
      model: request.model,
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
      cwd,
      abortController,
      systemPromptAppend: PROBE_SYSTEM_PROMPT,
      env: runtimeEnv,
      settingSources: [],
      allowedTools: [],
      omitAdvertisedSkillCatalog: true,
      ...(request.agentId ? { agentId: request.agentId } : {}),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void handle.interrupt().catch(() => {});
      abortController.abort();
    }, timeoutMs);

    try {
      for await (const event of handle.events) {
        if (event.type === "turn.complete") {
          settled = { ...base, ok: true, durationMs: Date.now() - startedAt };
          break;
        }
        if (event.type === "turn.failed") {
          settled = fail(event.error);
          break;
        }
        if (event.type === "turn.interrupted") {
          settled = fail(
            timedOut
              ? `Probe timed out after ${timeoutMs}ms without completing a turn.`
              : "Probe turn was interrupted.",
            { timedOut },
          );
          break;
        }
      }
    } catch (error) {
      settled = fail(
        timedOut
          ? `Probe timed out after ${timeoutMs}ms without completing a turn.`
          : error instanceof Error
            ? error.message
            : String(error),
        { timedOut },
      );
    } finally {
      clearTimeout(timer);
      abortController.abort();
      await handle.close?.().catch(() => {});
    }
  } catch (error) {
    settled = fail(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  if (!settled) {
    settled = fail(
      timedOut
        ? `Probe timed out after ${timeoutMs}ms without completing a turn.`
        : "Provider stream ended without a terminal turn event.",
      { timedOut },
    );
  }

  try {
    completeRuntimeCredentialAttempt(binding?.attemptId, {
      status: settled.ok ? "succeeded" : "failed",
      metadata: { reason: "runtime-probe", ...(settled.error ? { error: settled.error } : {}) },
    });
  } catch (error) {
    log.warn("Could not settle probe credential attempt", {
      attemptId: binding?.attemptId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  log.info("Runtime probe finished", {
    provider: request.provider,
    model: request.model,
    ok: settled.ok,
    durationMs: settled.durationMs,
    ...(settled.error ? { error: settled.error } : {}),
  });
  return settled;
}
