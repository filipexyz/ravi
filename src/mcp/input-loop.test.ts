import { describe, expect, it } from "bun:test";

import {
  answerMcpInputRequests,
  MCP_MAX_INPUT_ROUNDS,
  McpInputError,
  type McpInputRetry,
  runMcpInputRequiredLoop,
} from "./input-loop.js";

const FORM = {
  method: "elicitation/create",
  params: { mode: "form", message: "OK?", requestedSchema: { type: "object", properties: {} } },
};

function asking(state: string) {
  return { resultType: "input_required", inputRequests: { confirm: FORM }, requestState: state };
}

describe("runMcpInputRequiredLoop", () => {
  it("returns the first result that does not ask for input, carrying answers and the byte-exact state", async () => {
    const retries: (McpInputRetry | null)[] = [];
    const rounds: number[] = [];
    const result = await runMcpInputRequiredLoop({
      server: "s",
      deadline: Date.now() + 5_000,
      onRound: (count) => rounds.push(count),
      answer: async () => ({ action: "accept", content: {} }),
      send: async (retry) => {
        retries.push(retry);
        return retries.length === 1 ? asking("state é 1") : { resultType: "task", taskId: "t" };
      },
    });
    expect(result).toEqual({ resultType: "task", taskId: "t" });
    expect(rounds).toEqual([1]);
    expect(retries).toEqual([
      null,
      { inputResponses: { confirm: { action: "accept", content: {} } }, requestState: "state é 1" },
    ]);
  });

  it("stops after the round limit", async () => {
    let sends = 0;
    const loop = runMcpInputRequiredLoop({
      server: "s",
      deadline: Date.now() + 5_000,
      answer: async () => ({ action: "decline" }),
      send: async () => {
        sends++;
        return asking(`s${sends}`);
      },
    });
    await expect(loop).rejects.toThrow(`asked for input more than ${MCP_MAX_INPUT_ROUNDS} times`);
    expect(sends).toBe(MCP_MAX_INPUT_ROUNDS + 1);
  });

  it("stops when the budget is spent, before sending", async () => {
    let now = 1_000;
    let sends = 0;
    const loop = runMcpInputRequiredLoop({
      server: "s",
      deadline: 2_000,
      now: () => now,
      answer: async () => {
        now = 3_000;
        return { action: "accept", content: {} };
      },
      send: async () => {
        sends++;
        return asking("x");
      },
    });
    await expect(loop).rejects.toBeInstanceOf(McpInputError);
    expect(sends).toBe(1);
  });
});

describe("answerMcpInputRequests", () => {
  it("refuses a request other than elicitation/create before anyone is asked", async () => {
    let asked = 0;
    const answer = async () => {
      asked++;
      return { action: "accept" as const, content: {} };
    };
    await expect(
      answerMcpInputRequests("s", { a: FORM, b: { method: "sampling/createMessage", params: {} } }, answer),
    ).rejects.toThrow("sampling/createMessage");
    await expect(answerMcpInputRequests("s", { a: { method: "elicitation/create" } }, answer)).rejects.toBeInstanceOf(
      McpInputError,
    );
    expect(asked).toBe(0);
  });

  it("answers every key in order", async () => {
    const keys: string[] = [];
    const responses = await answerMcpInputRequests("s", { b: FORM, a: FORM }, async (key) => {
      keys.push(key);
      return { action: key === "a" ? "decline" : "cancel" };
    });
    expect(keys).toEqual(["b", "a"]);
    expect(responses).toEqual({ b: { action: "cancel" }, a: { action: "decline" } });
  });
});
