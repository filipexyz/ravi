/**
 * How long Ravi waits for a person to answer an approval (plan, spec,
 * permission) or a question poll. Kept apart from the service so runtime code
 * can size its own windows without importing the approval transport.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
