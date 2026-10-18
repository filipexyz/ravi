/**
 * Agent-facing copy for a Console write refused because the person of the
 * turn has no `ravi link` (`ACTOR_NOT_LINKED`). The refusal already started
 * the link (`turn-link.ts`); the copy says what the agent tells the person.
 * Local text only: transports relay the `linkFlow` value, never remote text.
 */

/** What the refusal set in motion. */
export type TurnLinkFlow = "awaiting_dm" | "dm_sent" | "already_linked" | "unavailable";

const TURN_LINK_FLOWS: ReadonlySet<string> = new Set<TurnLinkFlow>([
  "awaiting_dm",
  "dm_sent",
  "already_linked",
  "unavailable",
]);

export function parseTurnLinkFlow(value: unknown): TurnLinkFlow | null {
  return typeof value === "string" && TURN_LINK_FLOWS.has(value) ? (value as TurnLinkFlow) : null;
}

export interface TurnLinkCopy {
  message: string;
  suggestedAction: string;
  /** What to say to the person, in PT-BR, in the chat where they asked. */
  chatLinePt?: string;
}

const NOT_LINKED = "The person asking has not linked their Ravi Console account, so Ravi did not do this.";

export function turnLinkCopy(flow: TurnLinkFlow): TurnLinkCopy {
  switch (flow) {
    case "awaiting_dm":
      return {
        message: `${NOT_LINKED} On WhatsApp Ravi never starts a private chat, so ask them to message you in private: Ravi answers that message with their approval link, and once they approve they can ask again.`,
        suggestedAction:
          "tell the person to message you in private (chatLinePt); do not run ravi link or retry until they ask again",
        chatLinePt:
          "Pra eu fazer isso no seu nome, você precisa vincular sua conta do Ravi. Me chama na DM que eu te mando o link.",
      };
    case "dm_sent":
      return {
        message: `${NOT_LINKED} Ravi sent them a private approval link; once they approve, they can ask again.`,
        suggestedAction: "tell the person to approve the link sent in private (chatLinePt); retry when they ask again",
        chatLinePt:
          "Pra eu fazer isso no seu nome, você precisa vincular sua conta do Ravi. Te mandei um link no privado: depois de aprovar, me pede de novo.",
      };
    case "already_linked":
      return {
        message: "The person asking has just linked their Ravi Console account. Retry the same command once.",
        suggestedAction: "retry the same command once",
      };
    case "unavailable":
      return {
        message: `${NOT_LINKED} Ravi could not start their link from here, so ask them to message you in private to link it.`,
        suggestedAction: "ask the person to message you in private (chatLinePt), then run ravi link in that chat",
        chatLinePt:
          "Pra eu fazer isso no seu nome, você precisa vincular sua conta do Ravi. Me chama na DM pra gente vincular.",
      };
  }
}

/** The refusal's public message and details for a `linkFlow` value, or null when it names none. */
export function turnLinkContract(
  value: unknown,
): { message: string; details: { linkFlow: TurnLinkFlow; suggestedAction: string; chatLinePt?: string } } | null {
  const flow = parseTurnLinkFlow(value);
  if (!flow) return null;
  const copy = turnLinkCopy(flow);
  return {
    message: copy.message,
    details: {
      linkFlow: flow,
      suggestedAction: copy.suggestedAction,
      ...(copy.chatLinePt ? { chatLinePt: copy.chatLinePt } : {}),
    },
  };
}
