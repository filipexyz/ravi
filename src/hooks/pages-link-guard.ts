import type { HookCallbackMatcher } from "../bash/hook.js";
import { isRaviPagesUrl } from "../pages/read.js";

/**
 * Sends Ravi Page links to `ravi pages read` instead of a browser or fetch.
 *
 * A browser cannot open a private Page without a Console login, and a fetch of
 * a public one returns HTML with the Pages bar around it. `ravi pages read`
 * reads the published file through Console with the right access rule, so a
 * fetch, a browser navigation or a curl/wget of a *.ravi.page URL is denied
 * with the command to use instead.
 */

const URL_PATTERN = /https?:\/\/[^\s"'<>`)]+/gi;
const BROWSER_TOOL_PATTERN = /(navigate|browser|open_?url|goto|web_?fetch|fetch_?url)/i;
// A fetch tool in command position: line start or after ; & | ( or $( and an
// optional sudo/env, so `echo 'curl ...'` or a comment does not match.
const SHELL_FETCH_PATTERN =
  /(?:^|[;&|(\n]|\$\()\s*(?:(?:sudo|env|command)\s+)*(?:curl|wget|https?|xh|lynx|w3m)(?:\s|$)/m;

export function pagesLinkGuardReason(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== "string") return null;
  const input = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};

  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (!SHELL_FETCH_PATTERN.test(command)) return null;
    const url = firstPagesUrl(command);
    return url ? denyReason(url) : null;
  }

  if (toolName !== "WebFetch" && !BROWSER_TOOL_PATTERN.test(toolName)) return null;
  for (const key of ["url", "uri", "href", "link"]) {
    const value = input[key];
    if (typeof value === "string" && isRaviPagesUrl(value.trim())) return denyReason(value.trim());
  }
  return null;
}

export function createPagesLinkGuardHook(): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        const reason = pagesLinkGuardReason(input.tool_name, input.tool_input);
        if (!reason) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      },
    ],
  };
}

function firstPagesUrl(text: string): string | null {
  for (const match of text.matchAll(URL_PATTERN)) {
    if (isRaviPagesUrl(match[0])) return match[0];
  }
  return null;
}

function denyReason(url: string): string {
  return `This is a Ravi Page. Read it with \`ravi pages read ${url}\` (Bash) instead of a browser or fetch: it reads private Pages too and returns the page as Markdown.`;
}
