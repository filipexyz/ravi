/**
 * Upstream provider credentials and broker capabilities that must never reach
 * a runtime that runs under the model broker, nor the Pi RPC process (which
 * also executes the agent's tools).
 *
 * This list is not the agent-shell boundary. Every provider process env is
 * built from an allowlist at spawn (runtime/agent-env-policy.ts); this list
 * is applied on top of it where a runtime must not hold even its own provider
 * key. The former PreToolUse `unset` hook built from this list was removed:
 * it never took effect, because the job wrapper rewrote the command from the
 * original input after it.
 */
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
