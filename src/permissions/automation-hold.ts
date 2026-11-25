/**
 * Why a turn may not write automation that runs later as the executor agent,
 * and the fixed advice for each cause. Pure, no imports: the daemon's guard
 * (`user-overlay-automation.ts`) sends the cause as the `automationHold` control
 * field, and the remote CLI turns it back into this same copy instead of
 * forwarding server text or the generic "request the permission" advice.
 *
 * - `contact-chat-grants`: the turn is narrowed to a contact's chat grants
 *   (`actorAuthorizationMode: user-overlay`); automation written there would
 *   outlive those grants, so no chat grant lifts it. A contact whose own power
 *   (global permission tags) holds full access is never narrowed there: the
 *   overlay is lifted (`userOverlay: lifted`), so this cause does not name them.
 * - `held-relay`: the turn was relayed (a thread, a thread's return, a session
 *   message) from a turn that does not carry the agent's whole authority: a held
 *   caller, or a relay without the `relayCallerUnrestricted` stamp. It is not
 *   about anyone's grants.
 * - `person-without-chat-grant`: a person's turn in a chat with no grants, held
 *   below the agent's break-glass (`actorBreakGlassWithheld`).
 */
export const AUTOMATION_HOLD_CAUSES = ["contact-chat-grants", "held-relay", "person-without-chat-grant"] as const;

export type AutomationHoldCause = (typeof AUTOMATION_HOLD_CAUSES)[number];

export const AUTOMATION_HOLD_SUGGESTED_ACTION: Readonly<Record<AutomationHoldCause, string>> = {
  "contact-chat-grants":
    "Ask the operator to set it up. More chat permissions do not lift this: what it writes would outlive them.",
  "held-relay":
    "The limit is the relay, not anyone's grant: requesting access for a contact does not lift it. Do it in a turn that starts from the operator's own message, or ask the operator to set it up.",
  "person-without-chat-grant": "Ask the operator to set it up.",
};

export function isAutomationHoldCause(value: unknown): value is AutomationHoldCause {
  return typeof value === "string" && (AUTOMATION_HOLD_CAUSES as readonly string[]).includes(value);
}
