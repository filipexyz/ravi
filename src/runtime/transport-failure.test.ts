import { describe, expect, it } from "bun:test";
import { classifyTransportFailureKind, isTransportFailureMessage } from "./transport-failure.js";

describe("transport failure classification", () => {
  it.each([
    "Error: Connection error.",
    "Connection error.",
    "read ECONNRESET",
    "connect ECONNREFUSED 127.0.0.1:443",
    "socket hang up",
    "connect ETIMEDOUT 1.2.3.4:443",
    "fetch failed",
    "The operation was terminated",
    "network error",
  ])("classifies %p as transport", (message) => {
    expect(isTransportFailureMessage(message)).toBe(true);
    expect(classifyTransportFailureKind(message)).toBe("transport");
  });

  it.each([
    "",
    "Pi turn failed",
    "You've hit your session limit - resets 4:20pm",
    "402 Insufficient Balance",
    "Tool output exceeded the size limit.",
    "permission denied",
    "Agent is already processing a prompt",
  ])("does not classify %p as transport", (message) => {
    expect(isTransportFailureMessage(message)).toBe(false);
    expect(classifyTransportFailureKind(message)).toBeUndefined();
  });

  it("ignores non-string values and uses Error messages", () => {
    expect(isTransportFailureMessage(undefined)).toBe(false);
    expect(isTransportFailureMessage(null)).toBe(false);
    expect(isTransportFailureMessage(new Error("socket hang up"))).toBe(true);
  });
});
