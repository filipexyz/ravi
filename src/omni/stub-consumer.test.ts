import { describe, expect, it } from "bun:test";
import { createStubOmniConsumer } from "./stub-consumer.js";

describe("createStubOmniConsumer", () => {
  it("implements the gateway presence surface as safe no-ops", async () => {
    const stub = createStubOmniConsumer();

    expect(typeof stub.start).toBe("function");
    expect(typeof stub.stop).toBe("function");
    expect(typeof stub.getActiveTarget).toBe("function");
    expect(typeof stub.clearActiveTarget).toBe("function");
    expect(typeof stub.renewActiveTarget).toBe("function");

    await expect(stub.start()).resolves.toBeUndefined();
    await expect(stub.stop()).resolves.toBeUndefined();
    expect(stub.getActiveTarget("agent:main:main")).toBeUndefined();
    await expect(stub.clearActiveTarget("agent:main:main")).resolves.toBeUndefined();
    await expect(stub.renewActiveTarget("agent:main:main")).resolves.toBe(false);
  });
});
