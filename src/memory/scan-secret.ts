/**
 * R9b — Secret / PII scan with redact-at-source policy.
 *
 * Political opposite of R9: a live credential in memory is a leak, so the file
 * itself MUST be redacted (never kept visible). A candidate whose entire VALUE
 * is a credential is rejected outright — callers MUST NOT persist it.
 */

import type { SecretKind, SecretMatch, SecretScanResult } from "./types.js";

interface SecretPattern {
  kind: SecretKind;
  regex: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "github-token", regex: /ghp_[A-Za-z0-9]{36}/g },
  { kind: "openai-key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", regex: /xox[baprs]-[A-Za-z0-9-]+/g },
  { kind: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { kind: "bearer-token", regex: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  {
    kind: "private-key",
    regex: /-----BEGIN\s+(?:RSA|OPENSSH|PGP|EC|DSA)?\s*PRIVATE KEY-----/g,
  },
  { kind: "oauth-token", regex: /(?:access_token|refresh_token)=[A-Za-z0-9._-]{16,}/g },
  { kind: "cpf", regex: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g },
  { kind: "cnpj", regex: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g },
  // Generic hardcoded credential — aligned with hermes threat_patterns
  // `hardcoded_secret`. Anchors on the key-name vocabulary rather than the
  // value shape, so it catches configs like `api_key = "abc123..."` that the
  // prefix-based patterns above would miss. The credential run is redacted
  // as a whole and the leading assignment (`api_key = "`) intentionally lands
  // in the match so the surrounding key label goes away too.
  {
    kind: "hardcoded-secret",
    regex: /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}["']?/gi,
  },
];

const REDACTION = "[REDACTED:secret]";

/**
 * Scan `content` for secret/PII patterns.
 *
 * The returned `redacted` string ALREADY has each match replaced by the
 * `[REDACTED:secret]` placeholder — callers should persist THIS instead of the
 * original.
 *
 * `isCredentialOnly = true` means the ENTIRE trimmed content is one credential
 * (excerpt covers ≥90% of trimmed length). In that case, callers MUST reject
 * the candidate — there is no useful context to preserve.
 */
export function scanSecret(content: string): SecretScanResult {
  if (!content) {
    return { matches: [], hasSecret: false, isCredentialOnly: false, redacted: content };
  }

  const matches: SecretMatch[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null = regex.exec(content);
    while (match !== null) {
      matches.push({
        kind: pattern.kind,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        excerpt: match[0],
      });
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
      match = regex.exec(content);
    }
  }

  matches.sort((a, b) => a.startIndex - b.startIndex);

  const nonOverlapping: SecretMatch[] = [];
  let cursor = -1;
  for (const m of matches) {
    if (m.startIndex >= cursor) {
      nonOverlapping.push(m);
      cursor = m.endIndex;
    }
  }

  if (nonOverlapping.length === 0) {
    return { matches: [], hasSecret: false, isCredentialOnly: false, redacted: content };
  }

  let redacted = "";
  let lastIndex = 0;
  for (const m of nonOverlapping) {
    redacted += content.slice(lastIndex, m.startIndex);
    redacted += REDACTION;
    lastIndex = m.endIndex;
  }
  redacted += content.slice(lastIndex);

  const trimmed = content.trim();
  const totalMatchChars = nonOverlapping.reduce((sum, m) => sum + (m.endIndex - m.startIndex), 0);
  const isCredentialOnly = trimmed.length > 0 && totalMatchChars / trimmed.length >= 0.9;

  return { matches: nonOverlapping, hasSecret: true, isCredentialOnly, redacted };
}
