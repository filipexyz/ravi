import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";

import { knowledgeJobFailureCode, nextKnowledgeJobAttemptAt } from "./jobs";

describe("knowledge job queue (pure parts)", () => {
  test("backoff is 5s·2^(n-1), capped at 5 minutes", () => {
    const now = new Date("2026-10-17T00:00:00.000Z");
    const delay = (attempt: number) => nextKnowledgeJobAttemptAt(attempt, now).getTime() - now.getTime();
    expect(delay(1)).toBe(5_000);
    expect(delay(2)).toBe(10_000);
    expect(delay(4)).toBe(40_000);
    expect(delay(10)).toBe(300_000);
  });

  test("failure codes come from the error code, never its message", () => {
    expect(knowledgeJobFailureCode(new ConsoleApiError(409, { error: "knowledge_route_not_captured" }))).toBe(
      "knowledge_route_not_captured",
    );
    expect(knowledgeJobFailureCode(Object.assign(new Error("secret text"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(knowledgeJobFailureCode(new Error("secret text"))).toBe("handler_failed");
    expect(knowledgeJobFailureCode(Object.assign(new Error("x"), { code: "has spaces and text" }))).toBe("handler_failed");
  });
});
