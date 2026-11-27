/**
 * Environment every Claude Code process Ravi starts must carry, local or remote.
 *
 * Claude Code expands `@path` in prompt text: it reads the file and puts the
 * content in the model's context before any tool call, so no PreToolUse hook
 * sees the read. Ravi prompts carry text other people typed in a chat. With
 * this switch a mention stays text, and a file reaches the model only through
 * a tool call, which the agent's ceiling checks.
 *
 * The Agent SDK's `verbatimPrompts` also stops the expansion, but it drops the
 * context Claude Code attaches at the start of a turn (skill and tool
 * listings), so Ravi uses the narrower switch.
 */
export const CLAUDE_DISABLE_FILE_MENTIONS_ENV = "CLAUDE_CODE_DISABLE_FILE_MENTIONS";

/** Names and values are constants: safe to place on a remote command line. */
export const CLAUDE_REQUIRED_PROMPT_ENV: Readonly<Record<string, string>> = Object.freeze({
  [CLAUDE_DISABLE_FILE_MENTIONS_ENV]: "1",
});

/** Sets the required values on `env`, over anything the caller passed. */
export function applyClaudeRequiredPromptEnv<T extends Record<string, string | undefined>>(env: T): T {
  Object.assign(env, CLAUDE_REQUIRED_PROMPT_ENV);
  return env;
}
