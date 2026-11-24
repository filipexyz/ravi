/**
 * The seed of a cloned session runs with no authority at all.
 *
 * Its only job is to read copied text (other people's messages included) and
 * answer with one short line, so it needs nothing, and it must never hold more
 * than the person who asked, whoever that is (operator, a full-access agent
 * through the CLI, or a limited contact through `/ravi clone`). The turn is
 * produced with a caller context that grants nothing and is marked as a
 * narrowed relay: the runtime caps the turn at that empty ceiling
 * (`resolveRelayCaller`), and every automation sink sees it as held below the
 * agent. A caller context that is gone or expired narrows to nothing as well.
 *
 * Spec: sessions/clone.
 */

import type { RuntimeTurnOriginPrincipal } from "../runtime/message-types.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { buildChannelTurnOrigin } from "../runtime/turn-origin.js";

export const SESSION_CLONE_SEED_CONTEXT_KIND = "clone-seed";
/** Long enough for a queued seed to start; the turn narrows to nothing either way once it is gone. */
const SEED_CONTEXT_TTL_MS = 60 * 60 * 1000;

export interface SessionCloneSeedTurnInput {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly sessionName: string;
  readonly prompt: string;
  readonly source: { readonly channel: string; readonly accountId: string; readonly chatId: string };
  /** Who asked: recorded on the seed's context for the audit trail. It grants nothing. */
  readonly requestedBy: RuntimeTurnOriginPrincipal;
}

/** The prompt payload of the seed turn, ready for the session's prompt queue. */
export function buildSessionCloneSeedTurn(input: SessionCloneSeedTurnInput): Record<string, unknown> {
  const ceiling = createRuntimeContext({
    kind: SESSION_CLONE_SEED_CONTEXT_KIND,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionName: input.sessionName,
    capabilities: [],
    metadata: {
      relayNarrowing: true,
      cloneSeed: true,
      cloneRequestedBy: `${input.requestedBy.type}:${input.requestedBy.id}`,
    },
    ttlMs: SEED_CONTEXT_TTL_MS,
  });
  return {
    prompt: input.prompt,
    source: input.source,
    deliveryBarrier: "after_response",
    _turnOrigin: buildChannelTurnOrigin("session.bootstrap", input.requestedBy, ceiling.contextId),
  };
}
