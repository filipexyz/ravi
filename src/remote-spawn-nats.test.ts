import { describe, expect, it } from "bun:test";
import { createNatsRemoteSpawn, NatsSpawnedProcess } from "./remote-spawn-nats.js";

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

  const requests: PublishedMessage[] = [];

  return {
    published,
    requests,
    nc: {
      publish(subject: string, data: Uint8Array) {
        published.push({ subject, data });
      },
      subscribe() {
        return new MockSubscription();
      },
      request(subject: string, data: Uint8Array) {
        requests.push({ subject, data });
        // Never resolves: these tests only inspect the outgoing spawn payload.
        return new Promise<never>(() => {});
      },
    },
  };
}

const SECRET_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret-oauth",
  ANTHROPIC_API_KEY: "sk-ant-secret-api",
  PATH: "/usr/bin",
};

function spawnAndCapturePayload(processEnv: NodeJS.ProcessEnv) {
  const { nc, requests } = createMockNats();
  const spawnFn = createNatsRemoteSpawn("worker-x", {
    getNats: () => nc as any,
    processEnv: () => processEnv,
  });
  const proc = spawnFn({
    command: "bun",
    args: ["/local/cli.js", "--model", "sonnet"],
    cwd: "/srv/work",
    env: SECRET_ENV,
    signal: new AbortController().signal,
  } as any);
  proc.on("error", () => {});
  (proc as NatsSpawnedProcess).failStartup(new Error("test cleanup"));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.subject).toBe("ravi.worker.worker-x.spawn");
  const raw = new TextDecoder().decode(requests[0]?.data);
  return { raw, payload: JSON.parse(raw) as { args: string[]; env: Record<string, string>; cwd: string } };
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

describe("createNatsRemoteSpawn credentials", () => {
  it("sends no credential values in the spawn payload by default", () => {
    const { raw, payload } = spawnAndCapturePayload({});

    expect(payload.args).toEqual(["--model", "sonnet"]);
    expect(payload.env).toEqual({});
    expect(raw).not.toContain(SECRET_ENV.CLAUDE_CODE_OAUTH_TOKEN);
    expect(raw).not.toContain(SECRET_ENV.ANTHROPIC_API_KEY);
  });

  it("ignores opt-in values other than exactly 1", () => {
    const { payload } = spawnAndCapturePayload({ RAVI_REMOTE_WORKER_FORWARD_CREDENTIALS: "true" });
    expect(payload.env).toEqual({});
  });

  it("forwards credentials only when RAVI_REMOTE_WORKER_FORWARD_CREDENTIALS=1", () => {
    const { payload } = spawnAndCapturePayload({ RAVI_REMOTE_WORKER_FORWARD_CREDENTIALS: "1" });
    expect(payload.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: SECRET_ENV.CLAUDE_CODE_OAUTH_TOKEN,
      ANTHROPIC_API_KEY: SECRET_ENV.ANTHROPIC_API_KEY,
    });
  });
});
