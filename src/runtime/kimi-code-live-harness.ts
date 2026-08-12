import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import type { RuntimeCredentialFailureKind } from "./credential-types.js";
import type { RuntimeEvent } from "./types.js";

export interface KimiCodeLiveEvidence {
  eventCount: number;
  threadStartedCount: number;
  turnStartedCount: number;
  textDeltaCount: number;
  reasoningObserved: boolean;
  toolStartedCount: number;
  toolCompletedCount: number;
  toolResultDeliveredCount: number;
  toolCompletionAfterStart: boolean;
  toolResultAfterStart: boolean;
  turnCompleteCount: number;
  turnFailedCount: number;
  turnInterruptedCount: number;
  usageObserved: boolean;
  failureClassifications: RuntimeCredentialFailureKind[];
}

export interface KimiCodeLiveState {
  root: string;
  cwd: string;
  stateDir: string;
}

export function isKimiCodeLiveOptedIn(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    env.RAVI_LIVE_TESTS === "1" &&
    env.RAVI_KIMI_CODE_ENABLED === "1" &&
    typeof env.KIMI_API_KEY === "string" &&
    env.KIMI_API_KEY.trim().length > 0
  );
}

export function buildKimiCodeLiveRequestEnv(
  env: Readonly<Record<string, string | undefined>>,
  stateDir: string,
): Record<string, string> {
  const apiKey = env.KIMI_API_KEY?.trim();
  if (!apiKey) throw new Error("A fresh private Kimi Code credential is required");
  return {
    KIMI_API_KEY: apiKey,
    RAVI_KIMI_CODE_ENABLED: "1",
    RAVI_STATE_DIR: stateDir,
  };
}

export async function runKimiCodeLiveGate<T>(
  env: Readonly<Record<string, string | undefined>>,
  execute: () => Promise<T>,
): Promise<{ status: "skipped" } | { status: "ran"; evidence: T }> {
  if (!isKimiCodeLiveOptedIn(env)) return { status: "skipped" };
  return { status: "ran", evidence: await execute() };
}

export async function withIsolatedKimiCodeLiveState<T>(
  execute: (state: KimiCodeLiveState) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "ravi-live-kimi-code-"));
  const state = {
    root,
    cwd: join(root, "workspace"),
    stateDir: join(root, "state"),
  };
  mkdirSync(state.cwd);
  try {
    return await execute(state);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function reduceKimiCodeLiveEvidence(events: AsyncIterable<RuntimeEvent>): Promise<KimiCodeLiveEvidence> {
  const evidence: KimiCodeLiveEvidence = {
    eventCount: 0,
    threadStartedCount: 0,
    turnStartedCount: 0,
    textDeltaCount: 0,
    reasoningObserved: false,
    toolStartedCount: 0,
    toolCompletedCount: 0,
    toolResultDeliveredCount: 0,
    toolCompletionAfterStart: false,
    toolResultAfterStart: false,
    turnCompleteCount: 0,
    turnFailedCount: 0,
    turnInterruptedCount: 0,
    usageObserved: false,
    failureClassifications: [],
  };
  for await (const event of events) {
    evidence.eventCount += 1;
    switch (event.type) {
      case "thread.started":
        evidence.threadStartedCount += 1;
        break;
      case "turn.started":
        evidence.turnStartedCount += 1;
        break;
      case "text.delta":
        evidence.textDeltaCount += 1;
        break;
      case "status":
        evidence.reasoningObserved ||= event.status === "thinking";
        break;
      case "tool.started":
        evidence.toolStartedCount += 1;
        break;
      case "tool.completed":
        evidence.toolCompletedCount += 1;
        evidence.toolCompletionAfterStart ||= evidence.toolStartedCount > 0;
        break;
      case "tool.result_delivered":
        evidence.toolResultDeliveredCount += 1;
        evidence.toolResultAfterStart ||= evidence.toolStartedCount > 0;
        break;
      case "turn.complete":
        evidence.turnCompleteCount += 1;
        evidence.usageObserved ||= event.usage !== undefined;
        break;
      case "turn.failed": {
        evidence.turnFailedCount += 1;
        const rawEvent = event.rawEvent;
        evidence.failureClassifications.push(
          classifyRuntimeCredentialFailure({
            runtimeProvider: "kimi-code",
            upstreamProvider: "kimi",
            model: "k3",
            httpStatus: typeof rawEvent?.status === "number" ? rawEvent.status : undefined,
            providerCode: typeof rawEvent?.code === "string" ? rawEvent.code : undefined,
            providerType: typeof rawEvent?.type === "string" ? rawEvent.type : undefined,
            message: event.error,
            source: "sdk-error",
          }).kind,
        );
        break;
      }
      case "turn.interrupted":
        evidence.turnInterruptedCount += 1;
        break;
      default:
        break;
    }
  }

  return evidence;
}
