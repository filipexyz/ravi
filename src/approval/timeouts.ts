/**
 * How long Ravi waits for a person to answer an approval (plan, spec,
 * permission) or a question poll. Kept apart from the service so runtime code
 * can size its own windows without importing the approval transport.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long Ravi waits for the approval card itself to be delivered. Delivery is
 * one chat API call per person; it must not hold the tool call for the whole
 * approval window when the channel is down.
 */
export const DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS = 30 * 1000;
