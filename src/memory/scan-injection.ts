/**
 * R9 — Injection / exfil / tool-hijack scan with keep-visible policy.
 *
 * Poisoned memory persists in the prompt across sessions. The file MUST stay
 * human-readable so an operator can remove the entry, but the injected snapshot
 * MUST render a `[BLOCKED:injection|<category>]...[/BLOCKED]` placeholder so
 * the model never sees the raw override.
 */

import type { InjectionCategory, InjectionMatch, InjectionScanResult } from "./types.js";

interface InjectionPattern {
  category: InjectionCategory;
  regex: RegExp;
  label: string;
}

const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  {
    category: "prompt-override",
    label: "ignore-previous-instructions",
    regex: /ignore\s+(?:all\s+)?previous\s+instructions?/gi,
  },
  {
    category: "prompt-override",
    label: "disregard-all-rules",
    regex: /disregard\s+(?:all\s+)?(?:previous\s+)?rules?/gi,
  },
  {
    category: "prompt-override",
    label: "you-are-now",
    regex: /you\s+are\s+now\s+(?:a|an|the)\b/gi,
  },
  {
    category: "prompt-override",
    label: "new-system-prompt",
    regex: /new\s+system\s+prompt\s*[:=]/gi,
  },
  {
    category: "prompt-override",
    label: "sudo-override",
    regex: /sudo\s+override/gi,
  },
  {
    category: "exfil",
    label: "email-me-the",
    regex: /email\s+me\s+the\s+(?:api\s+key|token|password|secret|credential)/gi,
  },
  {
    category: "exfil",
    label: "post-to-external",
    regex: /(?:POST|send)\s+(?:to\s+)?https?:\/\/[^\s]+/gi,
  },
  {
    category: "exfil",
    label: "send-api-key",
    regex: /send\s+the\s+api\s+key/gi,
  },
  {
    category: "tool-hijack",
    label: "run-bash-to",
    regex: /run\s+bash\s+to\s+/gi,
  },
  {
    category: "tool-hijack",
    label: "execute-the-following",
    regex: /execute\s+the\s+following\s+command/gi,
  },
  {
    category: "tool-hijack",
    label: "write-to-etc",
    regex: /write\s+to\s+\/(?:etc|root|sys|proc)/gi,
  },
];

/**
 * Scan `content` for injection patterns.
 *
 * Returns matches with byte offsets + a `wrapped` string where each match is
 * enclosed in `[BLOCKED:injection|<category>]...[/BLOCKED]`. Callers should
 * write the ORIGINAL to disk (keep-visible for HITL) and inject the WRAPPED
 * copy into the system prompt (model-facing).
 */
export function scanInjection(content: string): InjectionScanResult {
  if (!content) {
    return { matches: [], hasInjection: false, wrapped: content };
  }

  const matches: InjectionMatch[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null = regex.exec(content);
    while (match !== null) {
      matches.push({
        category: pattern.category,
        pattern: pattern.label,
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

  const nonOverlapping: InjectionMatch[] = [];
  let cursor = -1;
  for (const m of matches) {
    if (m.startIndex >= cursor) {
      nonOverlapping.push(m);
      cursor = m.endIndex;
    }
  }

  if (nonOverlapping.length === 0) {
    return { matches: [], hasInjection: false, wrapped: content };
  }

  let wrapped = "";
  let lastIndex = 0;
  for (const m of nonOverlapping) {
    wrapped += content.slice(lastIndex, m.startIndex);
    wrapped += `[BLOCKED:injection|${m.category}]${m.excerpt}[/BLOCKED]`;
    lastIndex = m.endIndex;
  }
  wrapped += content.slice(lastIndex);

  return { matches: nonOverlapping, hasInjection: true, wrapped };
}
