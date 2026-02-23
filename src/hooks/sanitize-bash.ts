import type { HookCallbackMatcher } from "../bash/hook.js";

export const SANITIZED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "DATABASE_URL",
];

export function createSanitizeBashHook(): HookCallbackMatcher {
  return {
    matcher: "Bash",
    hooks: [async (input, _toolUseId, _context) => {
      const command = (input.tool_input as { command?: string })?.command;
      if (!command) return {};
      const unsetPrefix = `unset ${SANITIZED_ENV_VARS.join(" ")} 2>/dev/null; `;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: {
            ...(input.tool_input as Record<string, unknown>),
            command: unsetPrefix + command,
          },
        },
      };
    }],
  };
}
