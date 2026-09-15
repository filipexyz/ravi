/**
 * Provider login / not-logged-in stubs must not be treated as assistant
 * transcript. Claude Code emits `Not logged in · Please run /login` as a
 * normal assistant message with zero tokens when the subprocess is
 * unauthenticated.
 */

const LOGIN_STUB_PATTERNS = [/\bnot logged in\b/i, /\bplease run\s+\/login\b/i, /\brun\s+\/login\b/i];

export function isRuntimeProviderLoginStub(text: string | undefined | null): boolean {
  const normalized = text?.trim();
  if (!normalized) return false;
  return LOGIN_STUB_PATTERNS.some((pattern) => pattern.test(normalized));
}
