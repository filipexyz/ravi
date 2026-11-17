import { describe, expect, it } from "bun:test";
import { TrackedWorkDrain } from "./work-drain.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("tracked work drain", () => {
  it("fences new work synchronously and waits for concurrent reply and receipt", async () => {
    const drain = new TrackedWorkDrain("test-handlers");
    const reply = deferred();
    const receipt = deferred();
    const first = drain.run("reply", () => reply.promise);
    const second = drain.run("receipt", () => receipt.promise);
    const proof = drain.waitForDrain();
    await expect(drain.run("late", () => {})).rejects.toThrow("WORK_DRAIN_ADMISSION_CLOSED");
    reply.resolve();
    await first;
    expect(drain.status()).toMatchObject({ phase: "draining", pending: 1 });
    receipt.resolve();
    await second;
    expect(await proof).toMatchObject({ scope: "test-handlers", accepted: 2, completed: 2 });
  });

  it("keeps a caught handler failure as missing proof after promises settle", async () => {
    const drain = new TrackedWorkDrain("failed-callback");
    await drain
      .run("receipt-persistence", () => {
        throw new Error("persistence failed");
      })
      .catch(() => {});
    expect(drain.status().pending).toBe(0);
    await expect(drain.waitForDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
  });

  it("never promotes a timed-out drain to success when work completes later", async () => {
    const drain = new TrackedWorkDrain("timeout");
    const handler = deferred();
    const task = drain.run("handler", () => handler.promise);
    await expect(drain.waitForDrain(5)).rejects.toThrow("WORK_DRAIN_TIMEOUT");
    handler.resolve();
    await task;
    await expect(drain.waitForDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
  });

  it("accounts for work before invoking it and runs admission fences immediately", async () => {
    const drain = new TrackedWorkDrain("synchronous");
    const task = drain.run("stop", () => {
      expect(drain.status().pending).toBe(1);
      drain.beginDrain();
    });
    expect(drain.status().phase).toBe("draining");
    await task;
    expect((await drain.waitForDrain()).completed).toBe(1);
  });

  it("awaits a detached continuation registered by an admitted handler after drain starts", async () => {
    const drain = new TrackedWorkDrain("continuations");
    const startChild = deferred();
    const finishChild = deferred();
    const handler = drain.run("handler", async () => {
      await startChild.promise;
      void drain.runContinuation("publication", () => finishChild.promise);
    });
    const proof = drain.waitForDrain();
    startChild.resolve();
    await handler;
    expect(drain.status()).toMatchObject({ phase: "draining", accepted: 2, completed: 1, pending: 1 });
    finishChild.resolve();
    expect(await proof).toMatchObject({ accepted: 2, completed: 2 });
  });

  it("preserves a late callback from an ended admission but refuses drain proof", async () => {
    const drain = new TrackedWorkDrain("expired-continuation");
    const startChild = deferred();
    let late!: Promise<unknown>;
    let called = false;
    await drain.run("handler", () => {
      late = startChild.promise.then(() =>
        drain.runContinuation("late", () => {
          called = true;
        }),
      );
    });
    drain.beginDrain();
    startChild.resolve();
    await late;
    expect(called).toBe(true);
    await expect(drain.waitForDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
    expect(drain.status().failures).toEqual(["unowned-continuation:late"]);
  });

  it("retains a caught detached continuation failure after its parent finishes", async () => {
    const drain = new TrackedWorkDrain("failed-continuation");
    const finishChild = deferred();
    let child!: Promise<void>;
    await drain.run("handler", () => {
      child = drain.runContinuation("publication", async () => {
        await finishChild.promise;
        throw new Error("publication failed");
      });
    });
    finishChild.resolve();
    await expect(child).rejects.toThrow("publication failed");
    await expect(drain.waitForDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
    expect(drain.status().failures).toEqual(["publication"]);
  });
});
