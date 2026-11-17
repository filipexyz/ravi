import { expect, it } from "bun:test";
import { stopRuntimeComponents } from "./shutdown.js";

it("continues independent stops after failed gateway drain, retains shared handles and exits nonzero", async () => {
  const calls: string[] = [];
  const cause = new Error("gateway drain unproven");
  const result = await stopRuntimeComponents(
    [
      { name: "bot", stop: () => calls.push("bot") },
      {
        name: "gateway",
        stop: async () => {
          calls.push("gateway");
          throw cause;
        },
      },
      { name: "remaining-consumer", stop: () => calls.push("remaining-consumer") },
    ],
    [
      { name: "nats", stop: () => calls.push("nats") },
      { name: "sqlite", stop: () => calls.push("sqlite") },
    ],
  );
  expect(calls).toEqual(["bot", "gateway", "remaining-consumer"]);
  expect(result.exitCode).toBe(1);
  expect(result.failures).toEqual([{ name: "gateway", cause }]);
  expect(result.drain).toMatchObject({ phase: "blocked", pending: 0, failures: ["gateway"] });
});

it("waits for accepted component work before releasing shared resources", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stopped = stopRuntimeComponents(
    [{ name: "gateway", stop: () => pending.then(() => void calls.push("gateway")) }],
    [{ name: "nats", stop: () => calls.push("nats") }],
  );
  await Promise.resolve();
  expect(calls).toEqual([]);
  finish();
  expect(await stopped).toMatchObject({ exitCode: 0, failures: [], drain: { phase: "drained", failures: [] } });
  expect(calls).toEqual(["gateway", "nats"]);
});

it("preserves every failure and an existing fatal exit code", async () => {
  const first = new Error("component failed");
  const second = new Error("other component failed");
  const result = await stopRuntimeComponents(
    [
      {
        name: "first",
        stop: () => {
          throw first;
        },
      },
      {
        name: "second",
        stop: () => {
          throw second;
        },
      },
    ],
    [],
    2,
  );
  expect(result).toMatchObject({
    exitCode: 2,
    failures: [
      { name: "first", cause: first },
      { name: "second", cause: second },
    ],
    drain: { phase: "blocked", failures: ["first", "second"] },
  });
});

it("records resource-close failure after successful component drains and continues closing", async () => {
  const calls: string[] = [];
  const cause = new Error("broker close failed");
  const result = await stopRuntimeComponents(
    [],
    [
      {
        name: "nats",
        stop: () => {
          throw cause;
        },
      },
      { name: "sqlite", stop: () => calls.push("sqlite") },
    ],
  );
  expect(calls).toEqual(["sqlite"]);
  expect(result).toMatchObject({
    exitCode: 1,
    failures: [{ name: "nats", cause }],
    drain: { phase: "blocked", failures: ["nats"] },
  });
});

it("reports a failure before a later pending stop can reach the process watchdog", async () => {
  const cause = new Error("gateway drain failed");
  const reported: unknown[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = stopRuntimeComponents(
    [
      {
        name: "gateway",
        stop: () => {
          throw cause;
        },
      },
      { name: "pending-consumer", stop: () => pending },
    ],
    [],
    0,
    (failure) => reported.push(failure.cause),
  );
  await Promise.resolve();
  expect(reported).toEqual([cause]);
  finish();
  expect((await result).exitCode).toBe(1);
});

it("latches a failed shutdown diagnostic without skipping remaining stops or losing the original cause", async () => {
  const cause = new Error("stop failed");
  const reportCause = new Error("diagnostic failed");
  const calls: string[] = [];
  const result = await stopRuntimeComponents(
    [
      {
        name: "broken",
        stop: () => {
          throw cause;
        },
      },
      { name: "remaining", stop: () => calls.push("remaining") },
    ],
    [{ name: "sqlite", stop: () => calls.push("sqlite") }],
    0,
    () => {
      throw reportCause;
    },
  );
  expect(calls).toEqual(["remaining"]);
  expect(result).toMatchObject({
    exitCode: 1,
    failures: [
      { name: "broken", cause },
      { name: "broken.diagnostic", cause: reportCause },
    ],
    drain: { phase: "blocked", pending: 0, failures: ["broken", "broken.diagnostic"] },
  });
});
