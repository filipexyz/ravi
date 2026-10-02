import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  setupNats,
  setupOmniBridge,
  type SetupCommandResult,
  type SetupPm2Process,
  type SetupSystem,
} from "./setup.js";

const originalLog = console.log;
beforeAll(() => {
  console.log = () => {};
});
afterAll(() => {
  console.log = originalLog;
});

interface FakeSystemOptions {
  reachable?: boolean | boolean[];
  processes?: SetupPm2Process[] | (() => SetupPm2Process[]);
  binaries?: string[];
  interactive?: boolean;
  confirm?: boolean;
  omniHealthy?: boolean;
  omniConfigExists?: boolean;
  natsUrl?: string;
  failCommands?: string[];
  onRun?: (command: string) => void;
}

function fakeSystem(options: FakeSystemOptions = {}) {
  const commands: string[] = [];
  const reachable = Array.isArray(options.reachable) ? [...options.reachable] : null;
  let binaryRequests = 0;
  let confirmQuestions = 0;
  const system: SetupSystem = {
    natsUrl: options.natsUrl ?? "nats://127.0.0.1:4222",
    natsStoreDir: "/home/u/.ravi/jetstream",
    interactive: options.interactive ?? true,
    which: (binary) => (options.binaries ?? ["pm2", "omni"]).includes(binary),
    run: (command, args): SetupCommandResult => {
      const line = [command, ...args].join(" ");
      commands.push(line);
      options.onRun?.(line);
      const failed = (options.failCommands ?? []).some((prefix) => line.startsWith(prefix));
      return { status: failed ? 1 : 0, stdout: "", stderr: failed ? "boom" : "" };
    },
    pm2Processes: () =>
      typeof options.processes === "function" ? options.processes() : [...(options.processes ?? [])],
    isNatsReachable: async () => {
      if (reachable) return reachable.length > 1 ? (reachable.shift() ?? false) : (reachable[0] ?? false);
      return options.reachable === true;
    },
    ensureNatsServerBinary: async () => {
      binaryRequests++;
      return { path: "/home/u/.ravi/bin/nats-server", version: "2.11.8", downloaded: true, url: "https://x" };
    },
    omniHealthy: async () => options.omniHealthy ?? false,
    omniConfigExists: () => options.omniConfigExists ?? false,
    confirm: async () => {
      confirmQuestions++;
      return options.confirm ?? false;
    },
    sleep: async () => {},
  };
  return {
    system,
    commands,
    binaryRequests: () => binaryRequests,
    confirmQuestions: () => confirmQuestions,
  };
}

/** Commands that would stop, restart or remove a NATS process, or stop Omni (which stops omni-nats). */
function touchesNats(commands: string[]): string[] {
  return commands.filter(
    (line) => /^pm2 (stop|restart|delete|reload|kill)\b/.test(line) || /^omni (stop|restart)\b/.test(line),
  );
}

describe("setupNats", () => {
  it("reuses a reachable NATS and reports omni-nats as its owner without touching it", async () => {
    const fake = fakeSystem({
      reachable: true,
      processes: [
        { name: "omni-nats", status: "online", pid: 10 },
        { name: "omni-api", status: "online", pid: 11 },
      ],
    });

    const result = await setupNats(fake.system);

    expect(result).toEqual({ action: "reused", owner: "omni-nats" });
    expect(fake.commands).toEqual([]);
    expect(fake.binaryRequests()).toBe(0);
  });

  it("reuses a reachable NATS that PM2 does not manage", async () => {
    const fake = fakeSystem({ reachable: true, processes: [] });

    expect(await setupNats(fake.system)).toEqual({ action: "reused", owner: null });
    expect(fake.commands).toEqual([]);
  });

  it("downloads nats-server and starts ravi-nats under PM2 when nothing answers", async () => {
    const fake = fakeSystem({ reachable: [false, false, true], processes: [] });

    const result = await setupNats(fake.system);

    expect(result).toEqual({ action: "started", owner: "ravi-nats" });
    expect(fake.binaryRequests()).toBe(1);
    expect(fake.commands).toEqual([
      "pm2 start /home/u/.ravi/bin/nats-server --name ravi-nats --interpreter none -- -js -sd /home/u/.ravi/jetstream -a 127.0.0.1 -p 4222",
    ]);
  });

  it("starts ravi-nats on the port of a loopback NATS_URL", async () => {
    const fake = fakeSystem({ reachable: [false, true], natsUrl: "nats://localhost:4300" });

    await setupNats(fake.system);

    expect(fake.commands[0]).toEndWith("-a 127.0.0.1 -p 4300");
  });

  it("never stops, restarts or deletes an existing NATS process that does not answer", async () => {
    for (const name of ["omni-nats", "ravi-nats"]) {
      const fake = fakeSystem({ reachable: false, processes: [{ name, status: "errored", pid: 0 }] });

      const result = await setupNats(fake.system);

      expect(result).toEqual({ action: "not_reachable", owner: name, detail: "existing_process_not_answering" });
      expect(fake.commands).toEqual([]);
      expect(fake.binaryRequests()).toBe(0);
    }
  });

  it("does not provision anything for an unreachable remote NATS_URL", async () => {
    const fake = fakeSystem({ reachable: false, natsUrl: "nats://nats.internal:4222" });

    expect(await setupNats(fake.system)).toEqual({ action: "not_reachable", owner: null, detail: "remote_nats_url" });
    expect(fake.commands).toEqual([]);
  });

  it("reports a failed PM2 start", async () => {
    const fake = fakeSystem({ reachable: false, failCommands: ["pm2 start"] });

    const result = await setupNats(fake.system);

    expect(result.action).toBe("failed");
    expect(touchesNats(fake.commands)).toEqual([]);
  });
});

describe("setupOmniBridge (opt-in)", () => {
  it("is skipped by default in a non-interactive run, without asking or running anything", async () => {
    const fake = fakeSystem({ interactive: false, reachable: true });

    expect(await setupOmniBridge(fake.system)).toEqual({ action: "declined", commands: [] });
    expect(fake.confirmQuestions()).toBe(0);
    expect(fake.commands).toEqual([]);
  });

  it("does nothing when the operator answers No", async () => {
    const fake = fakeSystem({ confirm: false, reachable: true });

    expect(await setupOmniBridge(fake.system)).toEqual({ action: "declined", commands: [] });
    expect(fake.confirmQuestions()).toBe(1);
    expect(fake.commands).toEqual([]);
  });

  it("does nothing when omni-api is already online", async () => {
    const fake = fakeSystem({
      confirm: true,
      processes: [
        { name: "omni-api", status: "online", pid: 1 },
        { name: "omni-nats", status: "online", pid: 2 },
      ],
    });

    expect(await setupOmniBridge(fake.system)).toEqual({ action: "already_running", commands: [] });
    expect(fake.confirmQuestions()).toBe(0);
  });

  it("installs Omni on top of ravi-nats and removes the crash-looping omni-nats", async () => {
    let installed = false;
    const fake = fakeSystem({
      confirm: true,
      reachable: true,
      processes: () => [
        { name: "ravi-nats", status: "online", pid: 5 },
        ...(installed ? [{ name: "omni-nats", status: "errored", pid: 0 }] : []),
      ],
      onRun: (line) => {
        if (line === "omni install --non-interactive") installed = true;
      },
    });

    const result = await setupOmniBridge(fake.system);

    expect(result).toEqual({
      action: "installed_on_ravi_nats",
      commands: ["omni install --non-interactive", "pm2 delete omni-nats"],
    });
    expect(fake.commands).not.toContain("omni stop");
  });

  it("does not delete anything when the Omni install on ravi-nats created no omni-nats", async () => {
    const fake = fakeSystem({
      confirm: true,
      reachable: true,
      processes: [{ name: "ravi-nats", status: "online", pid: 5 }],
    });

    const result = await setupOmniBridge(fake.system);

    expect(result.commands).toEqual(["omni install --non-interactive"]);
  });

  it("never deletes omni-nats when omni-nats owns :4222 (it is Ravi's NATS)", async () => {
    const fake = fakeSystem({
      confirm: true,
      reachable: true,
      omniConfigExists: true,
      processes: [
        { name: "omni-nats", status: "online", pid: 7 },
        { name: "omni-api", status: "stopped", pid: 0 },
      ],
    });

    const result = await setupOmniBridge(fake.system);

    expect(result).toEqual({ action: "started", commands: ["omni start"] });
    expect(touchesNats(fake.commands)).toEqual([]);
  });

  it("runs the classic omni install when no NATS answers", async () => {
    const fake = fakeSystem({ confirm: true, reachable: false, omniConfigExists: false });

    expect(await setupOmniBridge(fake.system)).toEqual({
      action: "installed",
      commands: ["omni install --non-interactive"],
    });
  });

  it("refuses to install Omni next to a NATS that PM2 does not manage", async () => {
    const fake = fakeSystem({ confirm: true, reachable: true, processes: [] });

    expect(await setupOmniBridge(fake.system)).toEqual({ action: "skipped_external_nats", commands: [] });
  });

  it("does nothing when the Omni API is already healthy", async () => {
    const fake = fakeSystem({ confirm: true, reachable: true, omniHealthy: true });

    expect(await setupOmniBridge(fake.system)).toEqual({ action: "already_running", commands: [] });
  });

  it("installs the omni CLI first when it is missing", async () => {
    const fake = fakeSystem({ confirm: true, reachable: false, binaries: ["pm2"] });

    const result = await setupOmniBridge(fake.system);

    expect(result.commands).toEqual(["bun add -g @automagik/omni", "omni install --non-interactive"]);
  });

  it("never runs omni stop in any flow", async () => {
    const scenarios: FakeSystemOptions[] = [
      { confirm: true, reachable: true, processes: [{ name: "ravi-nats", status: "online" }] },
      { confirm: true, reachable: true, omniConfigExists: true, processes: [{ name: "omni-nats", status: "online" }] },
      { confirm: true, reachable: false, omniConfigExists: true },
      { confirm: true, reachable: false },
    ];
    for (const scenario of scenarios) {
      const fake = fakeSystem(scenario);
      await setupOmniBridge(fake.system);
      expect(fake.commands.filter((line) => line.startsWith("omni stop") || line.startsWith("omni restart"))).toEqual(
        [],
      );
    }
  });
});
