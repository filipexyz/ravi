import { describe, expect, it } from "bun:test";
import {
  decideNatsExposureBootAction,
  isLoopbackHost,
  isPrivateNatsRequired,
  parseFirewallGlobalState,
  parseNatsInfoLine,
  probeNatsExposure,
  readHostFirewallState,
  redactNatsUrl,
  type NatsProbe,
  type NatsProbeResult,
} from "./nats-exposure.js";

const OPEN: NatsProbeResult = { reachable: true, authRequired: false, tlsRequired: false };
const AUTH: NatsProbeResult = { reachable: true, authRequired: true, tlsRequired: false };
const CLOSED: NatsProbeResult = { reachable: false, authRequired: null, tlsRequired: null };

function fakeProbe(byHost: Record<string, NatsProbeResult | Error>) {
  const calls: Array<{ host: string; port: number; timeoutMs: number }> = [];
  const probe: NatsProbe = async (host, port, timeoutMs) => {
    calls.push({ host, port, timeoutMs });
    const result = byHost[host] ?? CLOSED;
    if (result instanceof Error) throw result;
    return result;
  };
  return { probe, calls };
}

const firewallOff = async () => "off" as const;
const noDns = async () => [] as string[];

describe("probeNatsExposure", () => {
  it("reports loopback_only when no non-loopback address accepts a connection", async () => {
    const { probe, calls } = fakeProbe({});
    const report = await probeNatsExposure("nats://127.0.0.1:4222", {
      listAddresses: () => ["192.168.1.10", "fd00::5", "127.0.0.1"],
      probe,
      readFirewallState: firewallOff,
    });

    expect(report.status).toBe("loopback_only");
    expect(report.reachableAddresses).toEqual([]);
    expect(calls.map((call) => call.host).sort()).toEqual(["192.168.1.10", "fd00::5"]);
    expect(calls.every((call) => call.port === 4222 && call.timeoutMs === 500)).toBe(true);
  });

  it("reports exposed when a LAN address accepts an unauthenticated connection", async () => {
    const { probe } = fakeProbe({ "192.168.1.10": OPEN });
    const report = await probeNatsExposure("nats://127.0.0.1:4222", {
      listAddresses: () => ["192.168.1.10", "10.0.0.2"],
      probe,
      readFirewallState: firewallOff,
    });

    expect(report.status).toBe("exposed");
    expect(report.reachableAddresses).toEqual(["192.168.1.10:4222"]);
    expect(report.authRequired).toBe(false);
    expect(report.firewall).toBe("off");
    expect(report.remediation.join(" ")).toContain("-a 127.0.0.1");
    expect(report.remediation.join(" ")).toContain("firewall");
  });

  it("treats a reachable address without a readable INFO line as exposed", async () => {
    const { probe } = fakeProbe({ "192.168.1.10": { reachable: true, authRequired: null, tlsRequired: null } });
    const report = await probeNatsExposure("nats://127.0.0.1:4222", {
      listAddresses: () => ["192.168.1.10"],
      probe,
      readFirewallState: firewallOff,
    });
    expect(report.status).toBe("exposed");
  });

  it("reports exposed_auth_required when every reachable address requires auth", async () => {
    const { probe } = fakeProbe({ "192.168.1.10": AUTH, "fd00::5": AUTH });
    const report = await probeNatsExposure("nats://localhost:4222", {
      listAddresses: () => ["192.168.1.10", "fd00::5"],
      probe,
      readFirewallState: firewallOff,
    });
    expect(report.status).toBe("exposed_auth_required");
    expect(report.authRequired).toBe(true);
  });

  it("never throws when the probe or firewall reader throws", async () => {
    const { probe } = fakeProbe({ "192.168.1.10": new Error("boom") });
    const report = await probeNatsExposure("nats://127.0.0.1:4222", {
      listAddresses: () => {
        return ["192.168.1.10"];
      },
      probe,
      readFirewallState: async () => {
        throw new Error("no firewall");
      },
    });
    expect(report.status).toBe("loopback_only");
    expect(report.firewall).toBe("unknown");
  });

  it("reports remote_plaintext for a non-loopback nats:// URL without tls_required", async () => {
    const { probe, calls } = fakeProbe({ "nats.internal": OPEN });
    const report = await probeNatsExposure("nats://nats.internal:4333", {
      resolveHost: noDns,
      listAddresses: () => ["192.168.1.10"],
      probe,
      readFirewallState: firewallOff,
    });
    expect(report.status).toBe("remote_plaintext");
    expect(calls).toEqual([{ host: "nats.internal", port: 4333, timeoutMs: 500 }]);
    expect(report.reachableAddresses).toEqual(["nats.internal:4333"]);
  });

  it("reports remote when the remote server advertises tls_required", async () => {
    const { probe } = fakeProbe({ "nats.internal": { reachable: true, authRequired: true, tlsRequired: true } });
    const report = await probeNatsExposure("nats://nats.internal:4222", {
      resolveHost: noDns,
      listAddresses: () => [],
      probe,
      readFirewallState: firewallOff,
    });
    expect(report.status).toBe("remote");
  });

  it("reports remote for tls:// URLs without probing", async () => {
    const { probe, calls } = fakeProbe({});
    const report = await probeNatsExposure("tls://nats.example.com:4222", {
      resolveHost: noDns,
      listAddresses: () => [],
      probe,
      readFirewallState: firewallOff,
    });
    expect(report.status).toBe("remote");
    expect(calls).toHaveLength(0);
  });

  it("treats a URL pointing at one of this host's own addresses as local", async () => {
    const { probe } = fakeProbe({ "192.168.1.10": OPEN });
    const report = await probeNatsExposure("nats://192.168.1.10:4222", {
      listAddresses: () => ["192.168.1.10"],
      probe,
      readFirewallState: firewallOff,
    });
    expect(report.status).toBe("exposed");
  });

  it("checks every server in a comma-separated NATS_URL", async () => {
    const { probe, calls } = fakeProbe({ "10.0.0.5": OPEN });
    const report = await probeNatsExposure("nats://127.0.0.1:4222,nats://10.0.0.5:4222", {
      listAddresses: () => ["192.168.1.10"],
      probe,
      readFirewallState: firewallOff,
      resolveHost: noDns,
    });
    expect(report.status).toBe("remote_plaintext");
    expect(report.message).toContain("10.0.0.5:4222");
    expect(calls.map((call) => call.host)).toContain("10.0.0.5");
  });

  it("treats a hostname that resolves only to loopback as local", async () => {
    const { probe } = fakeProbe({});
    const report = await probeNatsExposure("nats://nats.local.test:4222", {
      listAddresses: () => ["192.168.1.10"],
      probe,
      readFirewallState: firewallOff,
      resolveHost: async () => ["127.0.0.1", "::1"],
    });
    expect(report.status).toBe("loopback_only");
  });

  it("keeps a hostname remote when any resolved address is not ours", async () => {
    const { probe } = fakeProbe({ "nats.mixed.test": OPEN });
    const report = await probeNatsExposure("nats://nats.mixed.test:4222", {
      listAddresses: () => [],
      probe,
      readFirewallState: firewallOff,
      resolveHost: async () => ["127.0.0.1", "203.0.113.7"],
    });
    expect(report.status).toBe("remote_plaintext");
  });

  it("reports unknown for an unparsable URL and redacts credentials", async () => {
    const report = await probeNatsExposure("nats://user:hunter2@", {
      listAddresses: () => [],
      probe: fakeProbe({}).probe,
      readFirewallState: firewallOff,
    });
    expect(report.status).toBe("unknown");
    expect(report.message).not.toContain("hunter2");
    expect(report.natsUrl).not.toContain("hunter2");
  });
});

describe("nats exposure helpers", () => {
  it("classifies loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });

  it("parses the NATS INFO line", () => {
    expect(parseNatsInfoLine('INFO {"server_id":"x","auth_required":true,"tls_required":false}')).toEqual({
      authRequired: true,
      tlsRequired: false,
    });
    expect(parseNatsInfoLine('INFO {"server_id":"x"}')).toEqual({ authRequired: false, tlsRequired: false });
    expect(parseNatsInfoLine("-ERR 'nope'")).toBeNull();
    expect(parseNatsInfoLine("INFO {not json")).toBeNull();
  });

  it("redacts userinfo from NATS URLs", () => {
    expect(redactNatsUrl("nats://user:pass@10.0.0.1:4222")).toBe("nats://***@10.0.0.1:4222");
    expect(redactNatsUrl("nats://127.0.0.1:4222")).toBe("nats://127.0.0.1:4222");
    expect(redactNatsUrl("user:secret@10.0.0.5:4222")).toBe("***@10.0.0.5:4222");
    expect(redactNatsUrl("nats://user:p@ss@host:4222")).toBe("nats://***@host:4222");
    expect(redactNatsUrl("nats://a:b@h1:4222, tls://tok@h2:4222")).toBe("nats://***@h1:4222, tls://***@h2:4222");
  });

  it("parses the macOS firewall global state", () => {
    expect(parseFirewallGlobalState("Firewall is enabled. (State = 1)")).toBe("on");
    expect(parseFirewallGlobalState("Firewall is blocking all non-essential connections. (State = 2)")).toBe("on");
    expect(parseFirewallGlobalState("Firewall is disabled. (State = 0)")).toBe("off");
    expect(parseFirewallGlobalState("garbage")).toBe("unknown");
  });

  it("reads the firewall state via execFile on darwin and reports unknown elsewhere", async () => {
    const calls: string[] = [];
    const execFile = (file: string, args: string[], _options: { timeout: number }, callback: any) => {
      calls.push([file, ...args].join(" "));
      callback(null, "Firewall is enabled. (State = 1)\n", "");
    };
    expect(await readHostFirewallState({ platform: "darwin", execFile })).toBe("on");
    expect(calls).toEqual(["/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate"]);
    expect(await readHostFirewallState({ platform: "linux", execFile })).toBe("unknown");
    expect(calls).toHaveLength(1);

    const failing = (_f: string, _a: string[], _o: { timeout: number }, callback: any) =>
      callback(new Error("ENOENT"), "", "");
    expect(await readHostFirewallState({ platform: "darwin", execFile: failing })).toBe("unknown");
  });
});

describe("decideNatsExposureBootAction", () => {
  it("warns on exposed and remote_plaintext, otherwise does nothing", () => {
    for (const status of ["exposed", "remote_plaintext"] as const) {
      expect(decideNatsExposureBootAction({ status }, { requirePrivate: false })).toBe("warn");
    }
    for (const status of ["loopback_only", "exposed_auth_required", "remote", "unknown"] as const) {
      expect(decideNatsExposureBootAction({ status }, { requirePrivate: false })).toBe("none");
    }
  });

  it("refuses risky or unknown exposure when private NATS is required", () => {
    for (const status of ["exposed", "remote_plaintext", "unknown"] as const) {
      expect(decideNatsExposureBootAction({ status }, { requirePrivate: true })).toBe("refuse");
    }
    for (const status of ["loopback_only", "exposed_auth_required", "remote"] as const) {
      expect(decideNatsExposureBootAction({ status }, { requirePrivate: true })).toBe("none");
    }
  });

  it("reads RAVI_REQUIRE_PRIVATE_NATS strictly", () => {
    expect(isPrivateNatsRequired({ RAVI_REQUIRE_PRIVATE_NATS: "1" })).toBe(true);
    expect(isPrivateNatsRequired({ RAVI_REQUIRE_PRIVATE_NATS: "true" })).toBe(false);
    expect(isPrivateNatsRequired({})).toBe(false);
  });
});
