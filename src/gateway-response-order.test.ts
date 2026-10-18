import { describe, expect, it } from "bun:test";
import { SessionResponseQueue } from "./gateway-response-order.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionResponseQueue", () => {
  it("delivers one session's responses in emit order even when the first is slowest", async () => {
    const queue = new SessionResponseQueue();
    const delivered: string[] = [];
    const send = (text: string, ms: number) =>
      queue.run("grupo", async () => {
        await delay(ms);
        delivered.push(text);
      });

    await Promise.all([send("primeira", 30), send("segunda", 10), send("terceira", 0)]);

    expect(delivered).toEqual(["primeira", "segunda", "terceira"]);
  });

  it("does not hold one session behind another", async () => {
    const queue = new SessionResponseQueue();
    const delivered: string[] = [];

    await Promise.all([
      queue.run("lenta", async () => {
        await delay(30);
        delivered.push("lenta");
      }),
      queue.run("rapida", async () => {
        delivered.push("rapida");
      }),
    ]);

    expect(delivered).toEqual(["rapida", "lenta"]);
  });

  it("keeps going after a failed response and forgets idle sessions", async () => {
    const queue = new SessionResponseQueue();
    const delivered: string[] = [];

    const failed = queue.run("grupo", async () => {
      throw new Error("omni down");
    });
    const next = queue.run("grupo", async () => {
      delivered.push("depois da falha");
    });

    await expect(failed).rejects.toThrow("omni down");
    await next;
    await delay(0);

    expect(delivered).toEqual(["depois da falha"]);
    expect(queue.pendingSessions).toBe(0);
  });
});
