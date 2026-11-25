/**
 * The one `input_required` loop of the MCP gateway (spec mcp, Gateway and Raw
 * Dispatch).
 *
 * A 2026-07-28 server that needs something from the person answers a
 * `tools/call` with `resultType: 'input_required'`, a map of embedded requests
 * and an opaque `requestState`. The gateway never lets the SDK fulfil those on
 * its own: it loops here with the call scope in hand. Both call paths use this
 * loop, the SDK client's `callTool` and the hand-written raw dispatch
 * (`raw-dispatch.ts`), so a write confirmation is asked the same way whichever
 * path carries the call.
 *
 * - At most `MCP_MAX_INPUT_ROUNDS` rounds; one more `input_required` stops the call.
 * - Each embedded request must be `elicitation/create` with params; anything
 *   else stops the call (Ravi offers no sampling and no roots).
 * - Every key is answered by the caller's `answer` (the elicitation handler).
 *   The retry carries all answers and the byte-exact `requestState`.
 * - One round gives the person at most `MCP_INPUT_ROUND_ANSWER_MS` in total,
 *   shared by every question of that round (`answerBy`), so a yes reaches a
 *   server whose request state lives a few minutes inside its window.
 * - The loop ends at the first result that is not `input_required`: a plain
 *   result, a `task` or an `upload_required`; the caller reads it.
 *
 * `answerMcpInputRequests` is the step a task's late input uses too (the
 * follower answers a task's `inputRequests` through `tasks/update`).
 */

import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";

export const MCP_MAX_INPUT_ROUNDS = 4;
/**
 * The person's whole time for one `input_required` round, shared by its
 * questions; never more than the call's own deadline. It stays under the five
 * minutes a server such as the Ravi Console keeps a confirmation open.
 */
export const MCP_INPUT_ROUND_ANSWER_MS = 4 * 60 * 1000;

/** The call cannot go on: too many rounds, an unsupported request, no time left. Its text may be shown. */
export class McpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpInputError";
  }
}

/** The round an embedded request belongs to: when the person's time for all of its questions ends (epoch ms). */
export interface McpInputRound {
  answerBy: number;
}

/** One answer to one embedded request, by the server's key. */
export type McpInputAnswer = (
  key: string,
  params: ElicitRequest["params"],
  round: McpInputRound,
) => Promise<ElicitResult>;

export interface McpInputRoundOptions {
  now?: () => number;
  /** The person's time for the whole round (default `MCP_INPUT_ROUND_ANSWER_MS`). */
  roundMs?: number;
}

/** What the retry of an `input_required` round adds to the call's params. */
export interface McpInputRetry {
  inputResponses: Record<string, ElicitResult>;
  /** The server's `requestState`, byte for byte; absent when the server sent none. */
  requestState?: string;
}

export interface McpInputLoopOptions {
  /** The server's name, for error texts. */
  server: string;
  /**
   * Send the call once: `retry` is null on the first send, else the answers
   * of the round before. `remainingMs` is what is left of the call's budget.
   * Returns the result object as the server sent it.
   */
  send: (retry: McpInputRetry | null, remainingMs: number) => Promise<Record<string, unknown>>;
  answer: McpInputAnswer;
  /** When the call's budget ends (epoch ms). */
  deadline: number;
  now?: () => number;
  maxRounds?: number;
  /** Told the number of input rounds so far, after each one starts. */
  onRound?: (rounds: number) => void;
  /** The person's time for one round (default `MCP_INPUT_ROUND_ANSWER_MS`). */
  roundMs?: number;
}

/** Whether a result asks for input. */
export function isMcpInputRequired(result: unknown): boolean {
  return (
    Boolean(result) && typeof result === "object" && (result as Record<string, unknown>).resultType === "input_required"
  );
}

/**
 * Answer a map of embedded requests (`inputRequests` of an `input_required`
 * result or of a task). Keys are answered one at a time, in the server's
 * order, within one round window shared by all of them. A request that is not
 * `elicitation/create` stops everything, before anyone is asked about the
 * rest.
 */
export async function answerMcpInputRequests(
  server: string,
  inputRequests: unknown,
  answer: McpInputAnswer,
  options: McpInputRoundOptions = {},
): Promise<Record<string, ElicitResult>> {
  const requests =
    inputRequests && typeof inputRequests === "object" && !Array.isArray(inputRequests)
      ? (inputRequests as Record<string, unknown>)
      : {};
  const entries = Object.entries(requests);
  for (const [, value] of entries) {
    const request = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    if (
      request.method !== "elicitation/create" ||
      !request.params ||
      typeof request.params !== "object" ||
      Array.isArray(request.params)
    ) {
      throw new McpInputError(
        `MCP server ${server} asked for input Ravi does not provide (${typeof request.method === "string" ? request.method.slice(0, 40) : "unknown"}); the call was stopped.`,
      );
    }
  }
  const round: McpInputRound = {
    answerBy: (options.now ?? Date.now)() + Math.max(0, options.roundMs ?? MCP_INPUT_ROUND_ANSWER_MS),
  };
  const inputResponses: Record<string, ElicitResult> = {};
  for (const [key, value] of entries) {
    const params = (value as Record<string, unknown>).params as ElicitRequest["params"];
    inputResponses[key] = await answer(key, params, round);
  }
  return inputResponses;
}

/**
 * Run one tool call through its `input_required` rounds. Returns the first
 * result that does not ask for input. Throws `McpInputError` when the call
 * must stop, and whatever `send` throws.
 */
export async function runMcpInputRequiredLoop(options: McpInputLoopOptions): Promise<Record<string, unknown>> {
  const now = options.now ?? Date.now;
  const maxRounds = options.maxRounds ?? MCP_MAX_INPUT_ROUNDS;
  let retry: McpInputRetry | null = null;
  for (let round = 0; ; round++) {
    const remaining = options.deadline - now();
    if (remaining <= 0) {
      throw new McpInputError(
        round === 0
          ? "The MCP call ran out of time before it was sent."
          : "The MCP call ran out of time while the server asked for input.",
      );
    }
    const result = await options.send(retry, remaining);
    if (!isMcpInputRequired(result)) return result;
    if (round >= maxRounds) {
      throw new McpInputError(
        `MCP server ${options.server} asked for input more than ${maxRounds} times; the call was stopped.`,
      );
    }
    options.onRound?.(round + 1);
    const inputResponses = await answerMcpInputRequests(options.server, result.inputRequests, options.answer, {
      now,
      ...(options.roundMs !== undefined ? { roundMs: options.roundMs } : {}),
    });
    retry = {
      inputResponses,
      ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}),
    };
  }
}
