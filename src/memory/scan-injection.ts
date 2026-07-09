/**
 * R9 — Injection / exfil / tool-hijack scan with keep-visible policy.
 *
 * Poisoned memory persists in the prompt across sessions. The file MUST stay
 * human-readable so an operator can remove the entry, but the injected snapshot
 * MUST render a `[BLOCKED:injection|<category>]...[/BLOCKED]` placeholder so
 * the model never sees the raw override.
 *
 * Pattern library aligned with `hermes/tools/threat_patterns.py` (subset
 * relevant to memory writes). New patterns anchor on attack-specific
 * vocabulary or unambiguous behavior — not on bossy English — to keep false
 * positives low on legit AGENTS.md / SKILL.md content.
 */

import type { InjectionCategory, InjectionMatch, InjectionScanResult } from "./types.js";

interface InjectionPattern {
  category: InjectionCategory;
  regex: RegExp;
  label: string;
}

const FILLER = String.raw`(?:\w+\s+){0,8}`;

const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  {
    category: "prompt-override",
    label: "ignore-previous-instructions",
    regex: new RegExp(String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions?`, "gi"),
  },
  {
    category: "prompt-override",
    label: "disregard-all-rules",
    regex: new RegExp(
      String.raw`disregard\s+${FILLER}(your|all|any|previous)\s+${FILLER}(instructions|rules|guidelines)`,
      "gi",
    ),
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
    category: "prompt-override",
    label: "system-prompt-override",
    regex: /system\s+prompt\s+override/gi,
  },
  {
    category: "prompt-override",
    label: "role-hijack",
    regex: new RegExp(String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`, "gi"),
  },
  {
    category: "prompt-override",
    label: "role-pretend",
    regex: new RegExp(String.raw`pretend\s+${FILLER}(you\s+are|to\s+be)\s+`, "gi"),
  },
  {
    category: "prompt-override",
    label: "leak-system-prompt",
    regex: new RegExp(String.raw`output\s+${FILLER}(system|initial)\s+prompt`, "gi"),
  },
  {
    category: "prompt-override",
    label: "remove-filters",
    regex: new RegExp(
      String.raw`(respond|answer|reply)\s+without\s+${FILLER}(restrictions|limitations|filters|safety)`,
      "gi",
    ),
  },
  {
    category: "prompt-override",
    label: "fake-update",
    regex: new RegExp(String.raw`you\s+have\s+been\s+${FILLER}(updated|upgraded|patched)\s+to`, "gi"),
  },
  {
    category: "prompt-override",
    label: "bypass-restrictions",
    regex: new RegExp(
      String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don['’]t\s+have)\s+${FILLER}(restrictions|limits|rules)`,
      "gi",
    ),
  },
  {
    category: "prompt-override",
    label: "html-comment-injection",
    regex: /<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/gi,
  },
  {
    category: "prompt-override",
    label: "hidden-div",
    regex: /<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/gi,
  },
  {
    category: "prompt-override",
    label: "deception-hide",
    regex: new RegExp(String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "gi"),
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
    category: "exfil",
    label: "exfil-curl-secrets",
    regex: /curl\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/gi,
  },
  {
    category: "exfil",
    label: "exfil-wget-secrets",
    regex: /wget\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/gi,
  },
  {
    category: "exfil",
    label: "read-secrets",
    regex: /cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/gi,
  },
  {
    category: "exfil",
    label: "context-exfil",
    regex: new RegExp(
      String.raw`(include|output|print|share)\s+${FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`,
      "gi",
    ),
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
    label: "write-to-privileged",
    regex: /write\s+to\s+\/(?:etc|root|sys|proc)/gi,
  },
  {
    category: "tool-hijack",
    label: "agent-config-mod",
    regex:
      /(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)/gi,
  },
  {
    category: "tool-hijack",
    label: "ssh-backdoor",
    regex: /authorized_keys/gi,
  },
  {
    category: "tool-hijack",
    label: "ssh-access",
    regex: /(?:\$HOME|~)\/\.ssh\b/gi,
  },
  {
    category: "tool-hijack",
    label: "env-var-unset-agent",
    regex: /unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|RAVI)\w*/gi,
  },
];

/**
 * Invisible / bidirectional unicode used to smuggle instructions past a
 * human reviewer. Aligned with hermes threat_patterns INVISIBLE_CHARS list.
 * `hasInvisibleChars` returns true whenever any of these codepoints appears —
 * the wrapper marks them so the snapshot never carries a hidden RTL override
 * or zero-width joiner into the model context.
 */
const INVISIBLE_CHAR_REGEX = /[​-‍⁠⁢-⁤﻿‪-‮⁦-⁩]/g;

/**
 * Scan `content` for injection patterns.
 *
 * Returns matches with byte offsets + a `wrapped` string where each match is
 * enclosed in `[BLOCKED:injection|<category>]...[/BLOCKED]`. Invisible /
 * bidirectional unicode codepoints are collapsed to `[BLOCKED:injection|invisible-unicode]`
 * so the snapshot cannot smuggle hidden text. Callers write the WRAPPED copy
 * to disk (R9 keep-visible: the [BLOCKED:...] markers render inline for both
 * operator inspection and prompt safety).
 */
export function scanInjection(content: string): InjectionScanResult {
  if (!content) {
    return { matches: [], hasInjection: false, wrapped: content };
  }

  const matches: InjectionMatch[] = [];

  const invisibleRegex = new RegExp(INVISIBLE_CHAR_REGEX.source, INVISIBLE_CHAR_REGEX.flags);
  let invisibleMatch: RegExpExecArray | null = invisibleRegex.exec(content);
  while (invisibleMatch !== null) {
    matches.push({
      category: "prompt-override",
      pattern: "invisible-unicode",
      startIndex: invisibleMatch.index,
      endIndex: invisibleMatch.index + invisibleMatch[0].length,
      excerpt: invisibleMatch[0],
    });
    if (invisibleRegex.lastIndex === invisibleMatch.index) {
      invisibleRegex.lastIndex += 1;
    }
    invisibleMatch = invisibleRegex.exec(content);
  }

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
