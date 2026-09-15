import type { HookCallbackMatcher } from "../bash/hook.js";

export const SANITIZED_ENV_VARS = [
  "RAVI_IDENTITYD_CAPABILITY_FD",
  "RAVI_IDENTITYD_RUNTIME_SOCKET",
  "RAVI_INTELLIGENCE_REQUIRE_CAPABILITY_FD",
  "RAVI_MODEL_BROKER_REQUIRED",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_ACCESS_TOKEN",
  "OPENROUTER_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "DATABASE_URL",
];

export function createSanitizeBashHook(): HookCallbackMatcher {
  return {
    matcher: "Bash",
    hooks: [
      async (input, _toolUseId, _context) => {
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
      },
    ],
  };
}
