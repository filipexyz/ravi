import { describe, expect, it } from "bun:test";
import {
  decideNatsExposureBootAction,
  natsExposureLogData,
  probeNatsExposure,
  redactNatsUrl,
} from "./nats-exposure.js";

const deps = {
  listAddresses: () => ["192.0.2.10"],
  readFirewallState: async () => "unknown" as const,
  resolveHost: async () => [] as string[],
};

describe("NATS userinfo containing comma (PR 785 re-review)", () => {
  it.each(["SYNTHETIC_PART,", "SYNTHETIC_PART,tail", "1234,tail"])(
    "withholds ambiguous password %s from the URL, report and log",
    async (password) => {
      const url = `nats://test:${password}@127.0.0.1:4222`;
      expect(new URL(url).password).toBe(password);
      const calls: string[] = [];
      const report = await probeNatsExposure(url, {
        ...deps,
        resolveHost: async (host) => {
          calls.push(`resolve:${host}`);
          return [];
        },
        probe: async (host, port) => {
          calls.push(`${host}:${port}`);
          return { reachable: false, authRequired: null, tlsRequired: null };
        },
      });
      for (const output of [redactNatsUrl(url), JSON.stringify(report), JSON.stringify(natsExposureLogData(report))]) {
        expect(output).not.toContain(password.split(",")[0]);
        expect(output).not.toContain("tail");
        expect(output).toContain("[redacted]");
      }
      expect(report.status).toBe("unknown");
      expect(decideNatsExposureBootAction(report, { requirePrivate: true })).toBe("refuse");
      expect(calls).toEqual([]);
    },
  );

  it.each([
    "nats://test:SYNTHETIC_PART,tail@127.0.0.1:4222,nats://127.0.0.1:4333",
    "nats://127.0.0.1:4333,nats://test:SYNTHETIC_PART,tail@127.0.0.1:4222",
    "test:SYNTHETIC_PART,tail@127.0.0.1:4222",
  ])("withholds the complete ambiguous input %s", async (url) => {
    const report = await probeNatsExposure(url, {
      ...deps,
      probe: async () => ({ reachable: false, authRequired: null, tlsRequired: null }),
    });
    for (const output of [redactNatsUrl(url), JSON.stringify(report), JSON.stringify(natsExposureLogData(report))]) {
      expect(output).not.toContain("SYNTHETIC_PART");
      expect(output).not.toContain("tail");
    }
    expect(report.status).toBe("unknown");
  });

  it.each([
    [
      "nats://first:ONE@127.0.0.1:4222, nats://second:TWO@127.0.0.1:4333",
      "nats://[redacted]@127.0.0.1:4222, nats://[redacted]@127.0.0.1:4333",
    ],
    [
      "nats://127.0.0.1:4222,nats://second:TWO@127.0.0.1:4333",
      "nats://127.0.0.1:4222,nats://[redacted]@127.0.0.1:4333",
    ],
    ["127.0.0.1:4222,127.0.0.1:4333", "127.0.0.1:4222,127.0.0.1:4333"],
  ])("preserves an unambiguous server list %s", async (url, expected) => {
    const ports: number[] = [];
    const report = await probeNatsExposure(url, {
      ...deps,
      probe: async (_host, port) => {
        ports.push(port);
        return { reachable: port === 4333, authRequired: port === 4333 ? false : null, tlsRequired: null };
      },
    });
    expect(redactNatsUrl(url)).toBe(expected);
    expect(report.natsUrl).toBe(expected);
    expect(natsExposureLogData(report).natsUrl).toBe(expected);
    expect(ports).toEqual([4222, 4333]);
    expect(report.status).toBe("exposed");
  });

  it("accepts a percent-encoded comma in userinfo without exposing either part", async () => {
    const url = "nats://test:SYNTHETIC_PART%2Ctail@127.0.0.1:4222,nats://127.0.0.1:4333";
    const report = await probeNatsExposure(url, {
      ...deps,
      probe: async () => ({ reachable: false, authRequired: null, tlsRequired: null }),
    });
    expect(report.status).toBe("loopback_only");
    for (const output of [redactNatsUrl(url), JSON.stringify(report), JSON.stringify(natsExposureLogData(report))]) {
      expect(output).not.toContain("SYNTHETIC_PART");
      expect(output).not.toContain("tail");
    }
  });
});
