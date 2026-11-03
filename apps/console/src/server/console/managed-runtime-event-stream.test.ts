import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import {
  createManagedRuntimeEventStream,
  encodeManagedRuntimeStreamEvent,
  managedRuntimeEventCursor,
} from "./managed-runtime-event-stream";

describe("managed runtime event stream", () => {
  test("prefers a valid Last-Event-ID and rejects invalid cursors", () => {
    expect(
      managedRuntimeEventCursor({ after: "4", lastEventId: "8" }),
    ).toBe(8);
    expect(
      managedRuntimeEventCursor({ after: "-1", lastEventId: null }),
    ).toBe(0);
    expect(
      managedRuntimeEventCursor({ after: "wat", lastEventId: null }),
    ).toBe(0);
  });

  test("encodes resumable SSE events without exposing transport metadata", () => {
    const encoded = new TextDecoder().decode(
      encodeManagedRuntimeStreamEvent({
        id: "event-1",
        sequence: 7,
        eventType: "assistant.message",
        payload: { text: "done" },
      }),
    );

    expect(encoded).toContain("id: 7\n");
    expect(encoded).toContain("event: session\n");
    expect(encoded).toContain('"text":"done"');
  });

  test("delivers the initial page, polls from its cursor, and skips duplicates", async () => {
    const calls: number[] = [];
    const stop = new AbortController();
    const stream = createManagedRuntimeEventStream({
      signal: stop.signal,
      authorizeEmission: async () => {},
      initialPage: {
        items: [{ id: "one", sequence: 1 }],
        nextSequence: 1,
      },
      initialSequence: 0,
      loadEvents: async (afterSequence) => {
        calls.push(afterSequence);
        if (afterSequence === 2) stop.abort();
        return {
          items: [
            { id: "duplicate", sequence: 1 },
            { id: "two", sequence: 2 },
          ],
          nextSequence: 2,
        };
      },
      pollIntervalMs: 1,
      streamWindowMs: 1000,
    });
    const output = await new Response(stream).text();

    expect(output.match(/event: session/g)?.length).toBe(2);
    expect(output).toContain("id: 1");
    expect(output).toContain("id: 2");
    expect(calls[0]).toBe(1);
  });

  test("denied initial authorization emits no previously loaded payload or cursor", async () => {
    const stream = createManagedRuntimeEventStream({
      initialPage: { items: [{ id: "private", sequence: 42, text: "private content" }], nextSequence: 42 },
      initialSequence: 41,
      authorizeEmission: async () => { throw new Error("private denial details"); },
      loadEvents: async () => { throw new Error("must not load"); },
    });
    const output = await new Response(stream).text();
    expect(output).toBe('event: stream_error\ndata: {"error":"managed_runtime_stream_unavailable"}\n\n');
    expect(output).not.toContain("42");
    expect(output).not.toContain("private");
  });

  test("checks after an async load and discards a revoked pending batch", async () => {
    let allowed = true, checks = 0, loads = 0;
    const stream = createManagedRuntimeEventStream({
      initialPage: { items: [{ id: "allowed", sequence: 1 }], nextSequence: 1 }, initialSequence: 0,
      authorizeEmission: async () => { checks++; if (!allowed) throw new Error("revoked"); },
      loadEvents: async () => {
        loads++; allowed = false;
        return { items: [{ id: "revoked private", sequence: 2 }], nextSequence: 2 };
      },
      pollIntervalMs: 1,
    });
    const output = await new Response(stream).text();
    expect(checks).toBe(2);
    expect(loads).toBe(1);
    expect(output).toContain("id: 1\n");
    expect(output).not.toContain("id: 2\n");
    expect(output).not.toContain("revoked");
    expect(output).toContain("stream_error");
  });

  test("empty pages also require current authority before their heartbeat cursor", async () => {
    let calls = 0;
    const output = await new Response(createManagedRuntimeEventStream({
      initialPage: { items: [], nextSequence: 0 }, initialSequence: 0,
      authorizeEmission: async () => { if (++calls > 1) throw new Error("unavailable"); },
      loadEvents: async () => ({ items: [], nextSequence: 123 }), pollIntervalMs: 1,
    })).text();
    expect(calls).toBe(2);
    expect(output).not.toContain("heartbeat");
    expect(output).not.toContain("123");
    expect(output).toContain("stream_error");
  });

  test("an already aborted request never checks, loads or emits", async () => {
    const abort = new AbortController(); abort.abort();
    let calls = 0;
    const output = await new Response(createManagedRuntimeEventStream({
      signal: abort.signal, initialPage: { items: [], nextSequence: 0 }, initialSequence: 0,
      authorizeEmission: async () => { calls++; },
      loadEvents: async () => { calls++; return { items: [], nextSequence: 0 }; },
    })).text();
    expect(calls).toBe(0);
    expect(output).toBe("");
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  test("abort while initial authorization is pending discards its eventual result", async () => {
    const pending = Promise.withResolvers<void>();
    const abort = new AbortController();
    const output = new Response(createManagedRuntimeEventStream({
      signal: abort.signal, initialPage: { items: [{ id: "private", sequence: 1 }], nextSequence: 1 }, initialSequence: 0,
      authorizeEmission: () => pending.promise,
      loadEvents: async () => { throw new Error("must not load"); },
    })).text();
    abort.abort(); pending.resolve();
    expect(await output).toBe("");
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  test("reader cancellation discards an in-flight load without authorizing or enqueueing it", async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const signal = new AbortController();
    let checks = 0;
    const reader = createManagedRuntimeEventStream({
      signal: signal.signal, initialPage: { items: [], nextSequence: 0 }, initialSequence: 0,
      authorizeEmission: async () => { checks++; },
      loadEvents: async () => { entered.resolve(); await release.promise; return { items: [{ id: "late", sequence: 1 }], nextSequence: 1 }; },
      pollIntervalMs: 1,
    }).getReader();
    expect((await reader.read()).done).toBe(false);
    await entered.promise;
    const cancelled = reader.cancel(); release.resolve(); await cancelled;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(checks).toBe(1);
    expect((await reader.read()).done).toBe(true);
    expect(getEventListeners(signal.signal, "abort")).toHaveLength(0);
  });

  test("normal completion cleans the abort listener without changing the signal", async () => {
    const signal = new AbortController();
    await new Response(createManagedRuntimeEventStream({
      signal: signal.signal, initialPage: { items: [], nextSequence: 0 }, initialSequence: 0,
      authorizeEmission: async () => {}, loadEvents: async () => ({ items: [], nextSequence: 0 }),
      streamWindowMs: 0,
    })).text();
    expect(signal.signal.aborted).toBe(false);
    expect(getEventListeners(signal.signal, "abort")).toHaveLength(0);
  });
});
