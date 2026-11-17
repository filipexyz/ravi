import { describe, expect, it } from "bun:test";
import {
  decideNatsExposureBootAction,
  natsExposureLogData,
  probeNatsExposure,
  redactNatsUrl,
} from "./nats-exposure.js";

async function expectWithheldWithoutNetwork(input: string) {
  const calls: string[] = [];
  const report = await probeNatsExposure(input, {
    listAddresses: () => ["192.0.2.10"],
    readFirewallState: async () => "unknown",
    resolveHost: async (host) => {
      calls.push(`dns:${host}`);
      return [];
    },
    probe: async (host, port) => {
      calls.push(`tcp:${host}:${port}`);
      return { reachable: false, authRequired: null, tlsRequired: null };
    },
  });
  const log = natsExposureLogData(report);
  expect(redactNatsUrl(input)).toBe("[redacted]");
  expect(report.natsUrl).toBe("[redacted]");
  expect(log.natsUrl).toBe("[redacted]");
  expect(JSON.stringify([report, log])).not.toContain("SYNTHETIC");
  expect(report.status).toBe("unknown");
  expect(decideNatsExposureBootAction(report, { requirePrivate: true })).toBe("refuse");
  expect(calls).toEqual([]);
}

describe("NATS URL control characters (PR 785 re-review)", () => {
  it.each(["na\tts", "na\nts", "na\rts", "nats:\n//"])(
    "withholds controls normalized by WHATWG in scheme %j",
    async (scheme) => {
      const input = `${scheme.endsWith("//") ? scheme : `${scheme}://`}test:SYNTHETIC_SECRET@127.0.0.1:4222`;
      expect(new URL(input).password).toBe("SYNTHETIC_SECRET");
      await expectWithheldWithoutNetwork(input);
    },
  );

  it.each([
    "\tnats://test:SYNTHETIC_SECRET@127.0.0.1:4222",
    "nats://test:SYNTHETIC_\tSECRET@127.0.0.1:4222",
    "nats://test:SYNTHETIC_\rSECRET@127.0.0.1:4222",
    "nats://test:SYNTHETIC_\u0000SECRET@127.0.0.1:4222",
    "nats://test:SYNTHETIC_\u007fSECRET@127.0.0.1:4222",
    "nats://127.0.0.1:4333,\nnats://test:SYNTHETIC_SECRET@127.0.0.1:4222",
  ])("withholds controls in userinfo or server-list boundaries %j", expectWithheldWithoutNetwork);

  it.each([
    "nats://test:SYNTHETIC_SECRET#tail@127.0.0.1:4222",
    "nats://test:SYNTHETIC_SECRET?tail@127.0.0.1:4222",
    "nats://SYNTHETIC_SECRET#tail@127.0.0.1:4222",
    "nats://SYNTHETIC_SECRET/path@127.0.0.1:4222",
    "nats://test:SYNTHETIC_SECRET@127.0.0.1:4222#tail",
    "nats://test:SYNTHETIC_SECRET@127.0.0.1:4222?tail",
  ])("withholds ambiguous userinfo demoted to URL path/query/fragment %j", expectWithheldWithoutNetwork);

  it("accepts percent-encoded delimiters and controls in actual userinfo", async () => {
    const input = "nats://test:SYNTHETIC%23a%3Fb%2Fc%09d%0Ae%40f@127.0.0.1:4222";
    const report = await probeNatsExposure(input, {
      listAddresses: () => [],
      readFirewallState: async () => "unknown",
    });
    expect(redactNatsUrl(input)).toBe("nats://[redacted]@127.0.0.1:4222");
    expect(report.status).toBe("loopback_only");
    expect(JSON.stringify([report, natsExposureLogData(report)])).not.toContain("SYNTHETIC");
  });

  it("preserves non-credential URL path and query text", () => {
    for (const input of ["nats://127.0.0.1:4222/?x=1", "nats://127.0.0.1:4222?x=1"]) {
      expect(redactNatsUrl(input)).toBe(input);
    }
  });
});
