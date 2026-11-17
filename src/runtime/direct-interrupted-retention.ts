import { isDeepStrictEqual } from "node:util";
import { getRuntimeMessagesAfterTurn } from "./delivery-queue.js";
import {
  isExplicitLocalRuntimeAbort,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
} from "./host-session.js";
import type { ChannelBackendPromptMetadata } from "./message-types.js";

/** Identity accepted by the interrupted handoff, captured before diagnostic awaits. */
export interface CapturedDirectInterruptedRequest {
  readonly channelBackend: ChannelBackendPromptMetadata | undefined;
  readonly yieldedIds: ReadonlySet<string>;
  readonly atoms: ReadonlyArray<Pick<RuntimeUserMessage, "pendingId" | "message" | "launchPrompt">>;
  readonly explicitlyCancelled: boolean;
}

/**
 * Preserve the accepted request rather than a mutable pointer into the queue.
 * Neither another successor nor a reused pending ID with a changed envelope
 * proves that this logical request survived the physical interruption.
 */
export function captureDirectInterruptedRequest(
  session: RuntimeHostStreamingSession,
): CapturedDirectInterruptedRequest {
  const yieldedIds = new Set(session.currentTurnPendingIds ?? []);
  return {
    channelBackend: session.currentChannelBackend ? structuredClone(session.currentChannelBackend) : undefined,
    yieldedIds,
    atoms: session.pendingMessages
      .filter((message) => Boolean(message.pendingId && yieldedIds.has(message.pendingId)))
      .map((message) => ({
        pendingId: message.pendingId,
        message: structuredClone(message.message),
        launchPrompt: structuredClone(message.launchPrompt),
      })),
    explicitlyCancelled: session.pendingAbort || isExplicitLocalRuntimeAbort(session.internalAbortReason),
  };
}

/**
 * Inspect the generator's actual post-turn selection after the host has applied
 * its existing replay-safety filters. This does not grant replay permission or
 * reset safety. Call only after the last awaited diagnostic and keep the true
 * decision adjacent to synchronous cleanup and generator notification.
 */
export function canRetainDirectInterruptedRequest(
  session: RuntimeHostStreamingSession,
  request: CapturedDirectInterruptedRequest,
  owner: RuntimeHostStreamingSession | undefined,
): boolean {
  if (
    !request.channelBackend ||
    owner !== session ||
    session.done ||
    session.abortController.signal.aborted ||
    request.explicitlyCancelled ||
    session.pendingAbort ||
    isExplicitLocalRuntimeAbort(session.internalAbortReason)
  ) {
    return false;
  }
  return getRuntimeMessagesAfterTurn(session, request.yieldedIds).some(
    (message) =>
      isDeepStrictEqual(message.launchPrompt?._channelBackend, request.channelBackend) &&
      request.atoms.some(
        (accepted) =>
          accepted.pendingId === message.pendingId &&
          isDeepStrictEqual(accepted.message, message.message) &&
          isDeepStrictEqual(accepted.launchPrompt, message.launchPrompt),
      ),
  );
}

/**
 * Recheck logical projection authority at the transaction boundary. A replaced
 * owner never authorizes the old request; an absent slot requires positive
 * explicit cancellation, not merely a physically done or aborted handle.
 */
export function mayProjectDirectInterruptedRequest(
  session: RuntimeHostStreamingSession,
  request: CapturedDirectInterruptedRequest,
  owner: RuntimeHostStreamingSession | undefined,
): boolean {
  return (
    owner === session ||
    (!owner &&
      (request.explicitlyCancelled || session.pendingAbort || isExplicitLocalRuntimeAbort(session.internalAbortReason)))
  );
}
