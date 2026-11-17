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

/**
 * Upper bound for the teardown wait (`handle.close`) and for a provider stream
 * that ignores the abort. Teardown gets `min(this, timeoutMs)`, so the probe
 * always returns within `timeoutMs` plus this grace.
 */
export const RUNTIME_PROBE_TEARDOWN_GRACE_MS = 5_000;

/** A probe stage did not finish inside the probe deadline. */
class RuntimeProbeDeadlineError extends Error {
  constructor(stage: string) {
    super(`Probe deadline reached while ${stage}.`);
    this.name = "RuntimeProbeDeadlineError";
  }
}

/**
 * Stops WAITING for `work` after `ms`. The refresh hook, provider setup and
 * `close()` contracts accept no abort signal, so the underlying work is not
 * cancelled: it is only no longer allowed to keep the probe pending.
 */
function raceProbeDeadline<T>(work: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RuntimeProbeDeadlineError(stage)), Math.max(0, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  /** Test seam: replaces the scratch working directory creation. */
  createScratchDir?: () => string;
  /** Test seam: replaces the scratch working directory removal. */
  removeScratchDir?: (dir: string) => void;
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
  // One deadline for the whole probe, armed BEFORE credential resolution: a
  // refresh hook that never returns must not keep the caller (and the rollback
  // that depends on this result) pending past --probe-timeout.
  const deadlineAt = startedAt + timeoutMs;
  const remainingMs = (): number => Math.max(0, deadlineAt - Date.now());
  const teardownGraceMs = Math.min(RUNTIME_PROBE_TEARDOWN_GRACE_MS, timeoutMs);
  const timeoutMessage = `Probe timed out after ${timeoutMs}ms without completing a turn.`;

  let credentialResolution: Awaited<ReturnType<typeof resolveRuntimeCredentialAttemptBinding>>;
  const pendingCredential = Promise.resolve().then(() =>
    resolveCredential({
      runtimeProvider: request.provider,
      model: request.model,
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      sessionName: request.sessionName,
      runId: `probe_${randomUUID()}`,
      env: baseEnv,
    }),
  );
  try {
    credentialResolution = await raceProbeDeadline(
      pendingCredential,
      remainingMs(),
      "resolving the runtime credential",
    );
  } catch (error) {
    // no-cause: The deadline branch reports the probe's own timeout sentinel, whose only content is the stage already named in the message; every other error is forwarded by message below.
    if (error instanceof RuntimeProbeDeadlineError) {
      // The resolution keeps running (no abort signal). If it reserves an
      // attempt after the probe gave up, release it instead of leaking it.
      void pendingCredential.then(
        (late) => {
          try {
            completeRuntimeCredentialAttempt(late.attemptBinding?.attemptId, {
              status: "abandoned",
              metadata: { reason: "runtime-probe", error: "credential resolution outlived the probe deadline" },
            });
          } catch (settleError) {
            log.warn("Could not release late probe credential attempt", {
              attemptId: late.attemptBinding?.attemptId,
              error: settleError instanceof Error ? settleError.message : String(settleError),
            });
          }
        },
        () => {
          // no-cause: The probe already reported the credential-resolution timeout; a late rejection of the abandoned resolution has no caller left to inform.
        },
      );
      return fail(`Probe timed out after ${timeoutMs}ms while resolving the runtime credential.`, { timedOut: true });
    }
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

  let cwd: string | null = null;
  const abortController = new AbortController();
  let timedOut = false;
  let settled: RuntimeProbeResult | null = null;

  try {
    // Inside the try: a scratch-dir failure (full or read-only tmp) is a probe
    // failure the caller can roll back on, not a rejection that skips the
    // credential settlement below.
    const scratchDir = (request.createScratchDir ?? (() => mkdtempSync(join(tmpdir(), "ravi-runtime-probe-"))))();
    cwd = scratchDir;
    const bootstrap = await raceProbeDeadline(
      Promise.resolve().then(() =>
        provider.prepareSession?.({
          agentId: request.agentId ?? "runtime-probe",
          cwd: scratchDir,
        }),
      ),
      remainingMs(),
      "preparing the provider session",
    );
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
      cwd: scratchDir,
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
      void handle.interrupt().catch(() => {
        // no-cause: The probe result already reports the timeout; a failed interrupt must not replace it and the abort below still tears the turn down.
      });
      abortController.abort();
    }, remainingMs());

    const consumeTurn = async (): Promise<RuntimeProbeResult | null> => {
      for await (const event of handle.events) {
        if (event.type === "turn.complete") {
          return { ...base, ok: true, durationMs: Date.now() - startedAt };
        }
        if (event.type === "turn.failed") {
          return fail(event.error);
        }
        if (event.type === "turn.interrupted") {
          return fail(timedOut ? timeoutMessage : "Probe turn was interrupted.", { timedOut });
        }
      }
      return null;
    };

    try {
      // The timer above asks the provider to stop at the deadline; the race
      // covers a stream that ignores both the interrupt and the abort.
      settled = await raceProbeDeadline(
        consumeTurn(),
        remainingMs() + teardownGraceMs,
        "waiting for the provider turn",
      );
    } catch (error) {
      if (error instanceof RuntimeProbeDeadlineError) timedOut = true;
      settled = fail(timedOut ? timeoutMessage : error instanceof Error ? error.message : String(error), { timedOut });
    } finally {
      clearTimeout(timer);
      abortController.abort();
      const close = handle.close?.bind(handle);
      if (close) {
        // Bounded teardown: Grok and Pi await their transports on close, and a
        // stalled transport must not hold the settled result back.
        await raceProbeDeadline(
          Promise.resolve().then(() => close()),
          teardownGraceMs,
          "closing the provider session",
        ).catch((error) => {
          // no-cause: Teardown of an already-settled probe; a close failure or a close that outlives its grace must not replace the recorded probe outcome.
          if (error instanceof RuntimeProbeDeadlineError) {
            log.warn("Probe provider session close outlived its grace; continuing without it", {
              provider: request.provider,
              graceMs: teardownGraceMs,
            });
          }
        });
      }
    }
  } catch (error) {
    // no-cause: The deadline branch reports the probe's own timeout sentinel as the timeout result; every other error is forwarded by message below.
    if (error instanceof RuntimeProbeDeadlineError) {
      timedOut = true;
      settled = fail(timeoutMessage, { timedOut });
    } else {
      settled = fail(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (cwd) {
      try {
        (request.removeScratchDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true })))(cwd);
      } catch (error) {
        // Scratch cleanup must never skip the credential settlement below nor
        // turn a settled probe into a rejection.
        log.warn("Could not remove probe scratch directory", {
          cwd,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (!settled) {
    settled = fail(timedOut ? timeoutMessage : "Provider stream ended without a terminal turn event.", { timedOut });
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
