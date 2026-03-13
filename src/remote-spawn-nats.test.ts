import { describe, expect, it } from "bun:test";
import { NatsSpawnedProcess } from "./remote-spawn-nats.js";

type PublishedMessage = {
  subject: string;
  data: Uint8Array;
};

function createMockNats() {
  const published: PublishedMessage[] = [];

  class MockSubscription {
    private closed = false;
    private wake: (() => void) | null = null;

    unsubscribe() {
      this.closed = true;
      this.wake?.();
    }

    async *[Symbol.asyncIterator]() {
      while (!this.closed) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    }
  }

  return {
    published,
    nc: {
      publish(subject: string, data: Uint8Array) {
        published.push({ subject, data });
      },
      subscribe() {
        return new MockSubscription();
      },
    },
  };
}

function writeToStdin(proc: NatsSpawnedProcess, chunk: string): Promise<Error | null | undefined> {
  return new Promise((resolve) => {
    proc.stdin.write(Buffer.from(chunk), (err) => resolve(err));
  });
}

describe("NatsSpawnedProcess", () => {
  it("buffers stdin and EOF until ready, but drops them when killed before startup finishes", async () => {
    const { nc, published } = createMockNats();
    const proc = new NatsSpawnedProcess("worker-1", "spawn-1", nc as any);
    proc.stdin.on("error", () => {});

    const writeResult = writeToStdin(proc, "hello");
    proc.stdin.end();

    expect(published).toHaveLength(0);
    expect(proc.kill("SIGTERM")).toBe(true);

    proc.ready();

    const writeError = await writeResult;
    expect(writeError).toBeInstanceOf(Error);
    expect(published.map((entry) => entry.subject)).toEqual(["ravi.worker.worker-1.spawn-1.kill"]);
  });

  it("emits error and exit immediately when startup fails", async () => {
    const { nc } = createMockNats();
    const proc = new NatsSpawnedProcess("worker-2", "spawn-2", nc as any);
    const errors: Error[] = [];

    proc.stdin.on("error", () => {});
    proc.on("error", (error) => {
      errors.push(error as Error);
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const writeResult = writeToStdin(proc, "hello");

    proc.failStartup(new Error("spawn rejected"));

    const writeError = await writeResult;
    const exit = await exitPromise;

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("spawn rejected");
    expect(writeError).toBeInstanceOf(Error);
    expect((writeError as Error).message).toContain("spawn rejected");
    expect(exit).toEqual({ code: 1, signal: null });
  });
});
