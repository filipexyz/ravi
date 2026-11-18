import { describe, expect, it } from "bun:test";

import { gatewayLogLevel } from "./server.js";

// The throttle is module state keyed by method, path and status, and the gateway tests that run in the same Bun
// process log real requests through it. These paths belong to this file alone, so what other files logged cannot
// turn an expected "warn" into "debug".
const THROTTLED_PATH = "/api/v1/server-log-test/throttled";
const ECHO_PATH = "/api/v1/server-log-test/echo";

describe("gateway request logging", () => {
  it("throttles repeated 401s for the same route", () => {
    const path = THROTTLED_PATH;
    expect(gatewayLogLevel("POST", path, 401, 10_000)).toBe("warn");
    expect(gatewayLogLevel("POST", path, 401, 10_001)).toBe("debug");
    expect(gatewayLogLevel("POST", path, 401, 70_000)).toBe("warn");
    expect(gatewayLogLevel("POST", path, 401, 70_001)).toBe("debug");
  });

  it("keeps 4xx prominent and leaves 5xx diagnostics to the throttled error logger", () => {
    expect(gatewayLogLevel("POST", ECHO_PATH, 400, 1)).toBe("warn");
    expect(gatewayLogLevel("POST", ECHO_PATH, 500, 1)).toBe("debug");
    expect(gatewayLogLevel("POST", ECHO_PATH, 200, 1)).toBe("debug");
  });
});
