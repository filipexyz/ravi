// The per-turn Knowledge preamble (spec knowledge, contract §12.3): one
// audience line, and for a contact the packet, prepended to the model-facing
// `_runtimePrompt` only. `prompt.prompt` (what chat.db stores) never changes,
// and `_knowledgePreamble` keeps durable replay from adding it twice.

import { dbGetAgent } from "../../router/router-db.js";
import { snapshotAgentCapabilities } from "../../runtime/context-registry.js";
import type { RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import { resolveRuntimePromptText } from "../../runtime/session-surface-hint.js";
import { buildContactPacket, type ContactPacket } from "../packet/packet.js";
import { canRunKnowledgeSearch } from "../prompt-section.js";
import { knowledgeAudienceForPrompt, type KnowledgePromptAudience, resolveKnowledgeAudience } from "./audience.js";
import { contactAudienceLine, KNOWLEDGE_AUDIENCE_LINES, stripFenceTokens } from "./preamble-text.js";

export {
  combineKnowledgePreambles,
  contactAudienceLine,
  KNOWLEDGE_AUDIENCE_LINES,
  type StrippedKnowledgePreamble,
  stripKnowledgePreamble,
} from "./preamble-text.js";

const SESSION_SURFACE_LINE = /^\[session surfaces?\][^\n]*\n/i;

export function withKnowledgePreamble(
  prompt: RuntimeLaunchPrompt,
  ctx: { agentId: string; sessionName: string },
  deps: {
    audience?: typeof knowledgeAudienceForPrompt;
    packet?: typeof buildContactPacket;
    /** The system prompt section's check: may this agent run `ravi knowledge`? */
    canUseKnowledge?: (agentId: string) => boolean;
  } = {},
): RuntimeLaunchPrompt {
  if (prompt._knowledgePreamble || prompt._resumeStashedMessages) return prompt;

  let audience: KnowledgePromptAudience = "none";
  let packet: ContactPacket | null = null;
  try {
    if (deps.audience) {
      audience = deps.audience(prompt, ctx);
      if (audience === "contact") {
        packet = (deps.packet ?? buildContactPacket)({
          agentId: ctx.agentId,
          sessionName: ctx.sessionName,
          source: prompt.source,
          messageText: prompt.prompt,
        });
      }
    } else {
      ({ audience, packet } = resolveKnowledgeAudience(prompt, ctx, deps.packet ? { packet: deps.packet } : {}));
    }
  } catch {
    audience = "none";
    packet = null;
  }
  // The contact line only stands on a packet.
  if (audience === "contact" && !packet) audience = "none";
  // Same gate as the `knowledge.tools` section: no invitation the agent cannot use.
  if (audience === "operator" && !agentCanUseKnowledge(ctx.agentId, deps.canUseKnowledge)) audience = "none";

  const preamble = packet ? `${contactAudienceLine(packet.nonce)}\n${packet.text}` : KNOWLEDGE_AUDIENCE_LINES[audience];
  // On a packet turn the contact's text cannot open or close a fence.
  const text = packet ? stripFenceTokens(resolveRuntimePromptText(prompt)) : resolveRuntimePromptText(prompt);
  return {
    ...prompt,
    _runtimePrompt: prependAfterSurfaceLine(text, preamble),
    _knowledgePreamble: true,
  };
}

function agentCanUseKnowledge(agentId: string, check?: (agentId: string) => boolean): boolean {
  try {
    if (check) return check(agentId);
    if (dbGetAgent(agentId)?.mode === "sentinel") return false;
    return canRunKnowledgeSearch(snapshotAgentCapabilities(agentId));
  } catch {
    return false;
  }
}

/**
 * The `[session surface]` hint stays the first line: same-surface batching
 * (`combineSessionSurfacePromptContents`) reads it only from there.
 */
function prependAfterSurfaceLine(text: string, preamble: string): string {
  const surface = text.match(SESSION_SURFACE_LINE)?.[0];
  if (!surface) return `${preamble}\n${text}`;
  return `${surface}${preamble}\n${text.slice(surface.length)}`;
}
