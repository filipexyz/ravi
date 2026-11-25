/**
 * The parts of remote skills (spec mcp, Remote Skills) the CLI needs before it
 * runs a skills command: limits and the error type. Kept apart from
 * `skills.ts`, which loads the MCP client, so a `ravi` process loads that
 * client only when a skills command actually runs.
 */

/** Text a read prints; the rest is cut and `truncated` says so. */
export const MCP_SKILL_READ_TEXT_CAP_BYTES = 256 * 1024;
/** Skills one page of a listing returns at most (`--limit`). */
export const MCP_SKILLS_LIST_MAX = 500;

export class McpSkillsError extends Error {
  readonly code: string;
  readonly exitCode: 1 | 2 | 3;
  readonly suggestedAction?: string;
  /** A fixed code for the trace beside `code` (the stale reason of `MCP_SKILL_STALE`). */
  readonly detail?: string;
  constructor(code: string, message: string, exitCode: 1 | 2 | 3 = 1, suggestedAction?: string, detail?: string) {
    super(message);
    this.name = "McpSkillsError";
    this.code = code;
    this.exitCode = exitCode;
    if (suggestedAction) this.suggestedAction = suggestedAction;
    if (detail) this.detail = detail;
  }
}
