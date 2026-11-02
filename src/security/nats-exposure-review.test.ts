import { describe, expect, it } from "bun:test";
import { spawn } from "bun";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  decideNatsExposureBootAction,
  defaultNatsProbe,
  isLoopbackHost,
  natsExposureLogData,
  probeNatsExposure,
  redactNatsUrl,
  type NatsExposureStatus,
  type NatsProbeResult,
} from "./nats-exposure.js";

const CLOSED: NatsProbeResult = { reachable: false, authRequired: null, tlsRequired: null };
const OPEN: NatsProbeResult = { reachable: true, authRequired: false, tlsRequired: false };
const deps = {
  listAddresses: () => ["192.0.2.10"],
  readFirewallState: async () => "unknown" as const,
  resolveHost: async () => [] as string[],
};

describe("PR 785 independent review regressions", () => {
  it("refuses strict startup after EMFILE in the real TCP probe", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/nats-probe-emfile.ts", import.meta.url));
    const child = spawn(
      ["/bin/sh", "-c", 'ulimit -n 128 && exec "$1" --no-env-file "$2"', "probe", process.execPath, fixture],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH },
      },
    );
    const timer = setTimeout(() => child.kill(), 3_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ exhaustion: "EMFILE", status: "unknown", strictAction: "refuse" });
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  });

  it("preserves an injected EMFILE failure through safeProbe", async () => {
    const report = await probeNatsExposure("nats://127.0.0.1:4222", {
      ...deps,
      probe: async () => {
        throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
      },
    });
    expect(report.status).toBe("unknown");
    expect(decideNatsExposureBootAction(report, { requirePrivate: true })).toBe("refuse");
  });

  it("still recognizes a real connection refusal when descriptors are available", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (!address || typeof address === "string") throw new Error("missing TCP server address");
    expect(await defaultNatsProbe("127.0.0.1", address.port, 500)).toEqual(CLOSED);
  });

  it("does not certify an authenticated port when another local port is inconclusive", async () => {
    const report = await probeNatsExposure("nats://127.0.0.1:4222,nats://127.0.0.1:4333", {
      ...deps,
      probe: async (_host, port) => {
        if (port === 4333) throw new Error("probe unavailable");
        return { reachable: true, authRequired: true, tlsRequired: true };
      },
    });
    expect(report.status).toBe("unknown");
    expect(report.port).toBe(4333);
    expect(decideNatsExposureBootAction(report, { requirePrivate: true })).toBe("refuse");
  });

  it("preserves known exposure even when another local probe fails", async () => {
    const report = await probeNatsExposure("nats://127.0.0.1:4222,nats://127.0.0.1:4333", {
      ...deps,
      probe: async (_host, port) => {
        if (port === 4222) throw new Error("probe unavailable");
        return OPEN;
      },
    });
    expect(report.status).toBe("exposed");
    expect(report.port).toBe(4333);
    expect(decideNatsExposureBootAction(report, { requirePrivate: true })).toBe("refuse");
  });

  it("removes a space-containing password from the URL, report and log payload", async () => {
    const url = "nats://test:synthetic space@127.0.0.1:4222";
    expect(new URL(url).password).toBe("synthetic%20space");
    const report = await probeNatsExposure(url, { ...deps, probe: async () => CLOSED });
    const outputs = [redactNatsUrl(url), JSON.stringify(report), JSON.stringify(natsExposureLogData(report))];
    for (const output of outputs) {
      expect(output).not.toContain("synthetic");
      expect(output).toContain("[redacted]@127.0.0.1:4222");
    }
  });

  it("redacts malformed and bare userinfo containing spaces", () => {
    for (const url of ["nats://test:synthetic space@", "test:synthetic space@127.0.0.1:4222"]) {
      expect(redactNatsUrl(url)).not.toContain("synthetic");
    }
  });

  it("checks the second local port before declaring the server list private", async () => {
    const calls: string[] = [];
    const report = await probeNatsExposure("nats://127.0.0.1:4222,nats://127.0.0.1:4333", {
      ...deps,
      probe: async (host, port) => {
        calls.push(`${host}:${port}`);
        return port === 4333 ? OPEN : CLOSED;
      },
    });
    expect(calls).toEqual(["192.0.2.10:4222", "192.0.2.10:4333"]);
    expect(report.status).toBe("exposed");
    expect(report.reachableAddresses).toEqual(["192.0.2.10:4333"]);
    expect(decideNatsExposureBootAction(report, { requirePrivate: true })).toBe("refuse");
  });

  it("recognizes a complete IPv4-mapped loopback URL after URL normalization", async () => {
    const url = "nats://[::ffff:127.0.0.1]:4222";
    expect(new URL(url).hostname).toBe("[::ffff:7f00:1]");
    const calls: string[] = [];
    const report = await probeNatsExposure(url, {
      ...deps,
      probe: async (host) => {
        calls.push(host);
        return CLOSED;
      },
    });
    expect(report.status).toBe("loopback_only");
    expect(calls).toEqual(["192.0.2.10"]);
    expect(decideNatsExposureBootAction(report, { requirePrivate: true })).toBe("none");
  });

  it("keeps scoped IPv6 interface addresses probeable during normalization", async () => {
    expect(isLoopbackHost("fe80::1%en0")).toBe(false);
    const calls: string[] = [];
    const report = await probeNatsExposure("nats://[::ffff:127.0.0.1]:4222", {
      ...deps,
      listAddresses: () => ["fe80::1%en0"],
      probe: async (host) => {
        calls.push(host);
        return CLOSED;
      },
    });
    expect(report.status).toBe("loopback_only");
    expect(calls).toEqual(["fe80::1%en0"]);
  });

  it.each([
    ["::ffff:127.255.255.255", "loopback_only"],
    ["0:0:0:0:0:ffff:7f00:1", "loopback_only"],
    ["::ffff:126.255.255.255", "remote_plaintext"],
    ["::ffff:128.0.0.1", "remote_plaintext"],
    ["::ffff:192.0.2.1", "remote_plaintext"],
  ] satisfies Array<[string, NatsExposureStatus]>)(
    "classifies mapped address %s without expanding loopback beyond 127/8",
    async (host, expected) => {
      const report = await probeNatsExposure(`nats://[${host}]:4222`, { ...deps, probe: async () => CLOSED });
      expect(report.status).toBe(expected);
    },
  );
});
