import { describe, expect, it } from "bun:test";
import { stopRuntimeComponents } from "../runtime/shutdown.js";
import { closeAllRaviDbs } from "./close-all.js";

describe("close all Ravi databases", () => {
  it("database-close failure reaches shutdown result and blocks the drain latch", async () => {
    const calls: string[] = [];
    const first = new Error("chat close failed");
    const second = { reason: "router close failed" };
    const result = await stopRuntimeComponents(
      [{ name: "component", stop: () => calls.push("component") }],
      [
        {
          name: "sqlite",
          stop: () =>
            closeAllRaviDbs([
              {
                name: "chat",
                close: () => {
                  calls.push("chat");
                  throw first;
                },
              },
              { name: "knowledge", close: () => void calls.push("knowledge") },
              {
                name: "router",
                close: () => {
                  calls.push("router");
                  throw second;
                },
              },
            ]),
        },
        { name: "remaining-resource", stop: () => calls.push("remaining-resource") },
      ],
    );
    expect(calls).toEqual(["component", "chat", "knowledge", "router", "remaining-resource"]);
    expect(result.exitCode).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.name).toBe("sqlite");
    const aggregate = result.failures[0]?.cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "Database chat failed to close",
      "Database router failed to close",
    ]);
    expect((aggregate as AggregateError).errors[0].cause).toBe(first);
    expect((aggregate as AggregateError).errors[1].cause).toBe(second);
    expect(result.drain.phase).toBe("blocked");
    expect(result.drain.failures).toContain("sqlite");
  });

  it("reports success only after every database closes in dependency order", async () => {
    const calls: string[] = [];
    const result = await stopRuntimeComponents(
      [],
      [
        {
          name: "sqlite",
          stop: () =>
            closeAllRaviDbs([
              { name: "dependent", close: () => void calls.push("dependent") },
              { name: "base", close: () => void calls.push("base") },
            ]),
        },
      ],
    );
    expect(calls).toEqual(["dependent", "base"]);
    expect(result.exitCode).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.drain.phase).toBe("drained");
  });
});
