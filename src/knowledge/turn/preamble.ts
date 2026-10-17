// The per-turn Knowledge preamble (spec knowledge, contract §12.3): one
// audience line, and for a contact the packet, prepended to the model-facing
// `_runtimePrompt` only. `prompt.prompt` (what chat.db stores) never changes,
// and `_knowledgePreamble` keeps durable replay from adding it twice.

import type { RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import { resolveRuntimePromptText } from "../../runtime/session-surface-hint.js";
import { buildContactPacket, type ContactPacket } from "../packet/packet.js";
import { knowledgeAudienceForPrompt, type KnowledgePromptAudience, resolveKnowledgeAudience } from "./audience.js";

export const KNOWLEDGE_AUDIENCE_LINES: Readonly<Record<KnowledgePromptAudience, string>> = {
  operator: "[knowledge] audience=operator: ravi knowledge search/read may be used for this turn.",
  none: "[knowledge] audience=none: ravi knowledge will refuse on this turn (exit 3).",
  contact: "[knowledge] audience=contact: answer from the memory below and the marked pages only.",
};

const SESSION_SURFACE_LINE = /^\[session surfaces?\][^\n]*\n/i;

export function withKnowledgePreamble(
  prompt: RuntimeLaunchPrompt,
  ctx: { agentId: string; sessionName: string },
  deps: { audience?: typeof knowledgeAudienceForPrompt; packet?: typeof buildContactPacket } = {},
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

  const preamble = packet ? `${KNOWLEDGE_AUDIENCE_LINES.contact}\n${packet.text}` : KNOWLEDGE_AUDIENCE_LINES[audience];
  return {
    ...prompt,
    _runtimePrompt: prependAfterSurfaceLine(resolveRuntimePromptText(prompt), preamble),
    _knowledgePreamble: true,
  };
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
