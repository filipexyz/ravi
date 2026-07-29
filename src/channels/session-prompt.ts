import { publishSessionPrompt, type PublishSessionPromptOptions } from "../omni/session-stream.js";
import type { ChannelTurnAction, RuntimeTurnOriginPrincipal } from "../runtime/message-types.js";
import { buildChannelTurnOrigin } from "../runtime/turn-origin.js";

export type ChannelPromptTransport = (
  sessionName: string,
  payload: Record<string, unknown>,
  options?: PublishSessionPromptOptions,
) => Promise<void>;

export interface PublishChannelSessionPromptInput {
  sessionName: string;
  action: ChannelTurnAction;
  principal: RuntimeTurnOriginPrincipal;
  payload: Record<string, unknown>;
  options?: PublishSessionPromptOptions;
}

/**
 * Canonical publisher for channel-generated internal turns. Channel-specific
 * data stays in source/context; authority provenance stays provider-neutral.
 */
export async function publishChannelSessionPrompt(
  input: PublishChannelSessionPromptInput,
  transport: ChannelPromptTransport = publishSessionPrompt,
): Promise<void> {
  await transport(
    input.sessionName,
    {
      ...input.payload,
      _turnOrigin: buildChannelTurnOrigin(input.action, input.principal),
    },
    input.options,
  );
}
