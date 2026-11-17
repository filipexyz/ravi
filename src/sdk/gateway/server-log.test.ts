import { describe, expect, it } from "bun:test";

import { gatewayLogLevel } from "./server.js";

describe("gateway request logging", () => {
  it("throttles repeated 401s for the same route", () => {
    const path = "/api/v1/agents/list";
    expect(gatewayLogLevel("POST", path, 401, 10_000)).toBe("warn");
    expect(gatewayLogLevel("POST", path, 401, 10_001)).toBe("debug");
    expect(gatewayLogLevel("POST", path, 401, 70_000)).toBe("warn");
    expect(gatewayLogLevel("POST", path, 401, 70_001)).toBe("debug");
  });

  it("keeps 4xx prominent and leaves 5xx diagnostics to the throttled error logger", () => {
    expect(gatewayLogLevel("POST", "/api/v1/demo/echo", 400, 1)).toBe("warn");
    expect(gatewayLogLevel("POST", "/api/v1/demo/echo", 500, 1)).toBe("debug");
    expect(gatewayLogLevel("POST", "/api/v1/demo/echo", 200, 1)).toBe("debug");
  });
});
