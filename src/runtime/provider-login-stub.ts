import type { RuntimeProviderId } from "./types.js";

/**
 * Providers emit an auth/logged-out *stub* as if it were assistant text when the
 * subprocess is not authenticated: Claude Code, for example, prints a single
 * notice line instead of an answer, with zero output tokens.
 *
 * Those stubs must not be projected as transcript, counted as an answer, or
 * treated as a materialized turn.
 *
 * Matching is intentionally strict. A substring test false-positives on any
 * assistant message that *quotes* or *explains* an auth error -- for example an
 * agent reporting what a CLI printed on screen -- and that silently discarded
 * the entire response and failed the turn. Real stubs are short, single-line and
 * emitted with zero output tokens, so long, multi-line or token-producing text
 * is never treated as a stub.
 */

/** A real stub is one short line; anything larger is a real message. */
const MAX_STUB_CHARS = 240;
const MAX_STUB_LINES = 3;

export interface ProviderLoginStubPhrase {
  /** Stable identifier, used in tests and diagnostics. */
  id: string;
  /** Anchored against the whole normalized stub text unless `match` says otherwise. */
  pattern: RegExp;
  /**
   * `whole` (default) requires the pattern to describe the entire text.
   * `contains` is an explicit escape hatch for providers whose stub is embedded
   * in a larger payload; use it only when `whole` provably does not work, since
   * it reintroduces the false-positive class this module exists to prevent.
   */
  match?: "whole" | "contains";
  /** Restricts the phrase to specific providers. Omitted means any provider. */
  providers?: readonly RuntimeProviderId[];
}

/**
 * Phrase map for provider auth stubs.
 *
 * Add new stubs here. Prefer a new provider-scoped entry over widening a shared
 * one, and keep the pattern anchored so it can only match the stub itself.
 */
export const PROVIDER_LOGIN_STUB_PHRASES: readonly ProviderLoginStubPhrase[] = [
  {
    id: "shared.not-authenticated",
    pattern: /^not logged in\.?$/i,
  },
  {
    id: "shared.not-authenticated-with-instruction",
    pattern: /^not logged in\s*[·:\-|]\s*please run \/login\.?$/i,
  },
  {
    id: "shared.please-run-login",
    pattern: /^please run \/login\.?$/i,
  },
];

export interface ProviderLoginStubMatchOptions {
  /** Provider that produced the text, when known. Enables provider-scoped phrases. */
  provider?: RuntimeProviderId | null;
  /**
   * Output tokens reported for the turn. A real stub is emitted with zero
   * tokens, so any token spend disqualifies the match.
   */
  outputTokens?: number | null;
  /** Override the phrase map. Defaults to {@link PROVIDER_LOGIN_STUB_PHRASES}. */
  phrases?: readonly ProviderLoginStubPhrase[];
}

export function isRuntimeProviderLoginStub(
  text: string | undefined | null,
  options: ProviderLoginStubMatchOptions = {},
): boolean {
  const normalized = normalizeStubText(text);
  if (!normalized) return false;

  if (options.outputTokens != null && options.outputTokens > 0) return false;
  if (normalized.length > MAX_STUB_CHARS) return false;
  if (normalized.split("\n").length > MAX_STUB_LINES) return false;

  return (options.phrases ?? PROVIDER_LOGIN_STUB_PHRASES).some((phrase) =>
    phraseMatches(phrase, normalized, options.provider),
  );
}

function phraseMatches(
  phrase: ProviderLoginStubPhrase,
  normalizedText: string,
  provider: RuntimeProviderId | null | undefined,
): boolean {
  if (phrase.providers && (!provider || !phrase.providers.includes(provider))) return false;
  return phrase.pattern.test(normalizedText);
}

function normalizeStubText(text: string | undefined | null): string {
  if (typeof text !== "string") return "";
  return text
    .trim()
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n");
}
