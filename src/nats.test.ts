import { describe, expect, it } from "bun:test";
import { connectNats, isSessionResponseTopic } from "./nats.js";

describe("isSessionResponseTopic", () => {
  it("matches only session chat response topics", () => {
    expect(isSessionResponseTopic("ravi.session.demo-agent.response")).toBe(true);
    expect(isSessionResponseTopic("ravi.session.demo-group.response")).toBe(true);
  });

  it("does not treat approval or other .response topics as ghost chat emits", () => {
    expect(isSessionResponseTopic("ravi.approval.response")).toBe(false);
    expect(isSessionResponseTopic("ravi.session.demo-agent.runtime")).toBe(false);
    expect(isSessionResponseTopic("ravi.outbound.deliver")).toBe(false);
  });
});

describe("connectNats", () => {
  it("does not print an error when a lazy CLI connect finds no server", async () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(connectNats("nats://127.0.0.1:1")).rejects.toThrow();
    } finally {
      process.stderr.write = original;
    }
    expect(writes.join("")).not.toContain("Failed to connect to NATS");
  });
});
