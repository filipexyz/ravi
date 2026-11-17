/** Reserved identities are accessible only through the owner-verified bridge API. */
export function isBridgeSessionRef(ref: string | null | undefined): boolean {
  return Boolean(ref && /^(?:console-|agent:[^:]+:console:)[0-9a-f-]{36}$/.test(ref));
}

export function isBridgeSession(session: { sessionKey: string; name?: string | null }): boolean {
  return isBridgeSessionRef(session.sessionKey) || isBridgeSessionRef(session.name);
}

export function assertBridgeProvider(providerId: string): void {
  if (providerId !== "codex") throw new Error("Human bridge requires the isolated Codex provider");
}
