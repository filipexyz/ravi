import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATS_PM2_PROCESS,
  NATS_SERVER_VERSION,
  ensureNatsServerBinary,
  findNatsPm2Owner,
  isNatsReachable,
  natsPm2StartArgs,
  natsServerArgs,
  natsServerBinaryPath,
  natsServerReleaseAsset,
  parseNatsEndpoint,
  type NatsProbeSocket,
} from "./nats-server.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-nats-server-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeSocket extends EventEmitter implements NatsProbeSocket {
  destroyed = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function fakeConnect(script: (socket: FakeSocket) => void) {
  const calls: Array<{ port: number; host: string }> = [];
  const sockets: FakeSocket[] = [];
  const connect = (port: number, host: string) => {
    calls.push({ port, host });
    const socket = new FakeSocket();
    sockets.push(socket);
    queueMicrotask(() => script(socket));
    return socket;
  };
  return { connect, calls, sockets };
}

describe("nats-server constants", () => {
  it("pins the version the E2B template used and names the PM2 process ravi-nats", () => {
    expect(NATS_SERVER_VERSION).toBe("2.11.8");
    expect(NATS_PM2_PROCESS).toBe("ravi-nats");
  });
});

describe("natsServerArgs / natsPm2StartArgs", () => {
  it("builds JetStream args bound to loopback", () => {
    expect(natsServerArgs({ storeDir: "/s/jetstream" })).toEqual([
      "-js",
      "-sd",
      "/s/jetstream",
      "-a",
      "127.0.0.1",
      "-p",
      "4222",
    ]);
    expect(natsServerArgs({ storeDir: "/s", port: 4333, host: "0.0.0.0" })).toEqual([
      "-js",
      "-sd",
      "/s",
      "-a",
      "0.0.0.0",
      "-p",
      "4333",
    ]);
  });

  it("defaults the store dir to <RAVI_STATE_DIR>/jetstream", () => {
    const previous = process.env.RAVI_STATE_DIR;
    process.env.RAVI_STATE_DIR = "/tmp/ravi-state-x";
    try {
      expect(natsServerArgs()[2]).toBe("/tmp/ravi-state-x/jetstream");
    } finally {
      if (previous === undefined) delete process.env.RAVI_STATE_DIR;
      else process.env.RAVI_STATE_DIR = previous;
    }
  });

  it("starts the binary under PM2 as ravi-nats with no interpreter", () => {
    expect(natsPm2StartArgs("/h/.ravi/bin/nats-server", { storeDir: "/h/.ravi/jetstream" })).toEqual([
      "start",
      "/h/.ravi/bin/nats-server",
      "--name",
      "ravi-nats",
      "--interpreter",
      "none",
      "--",
      "-js",
      "-sd",
      "/h/.ravi/jetstream",
      "-a",
      "127.0.0.1",
      "-p",
      "4222",
    ]);
  });
});

describe("parseNatsEndpoint", () => {
  it("parses host, port and loopback", () => {
    expect(parseNatsEndpoint("nats://127.0.0.1:4222")).toEqual({ host: "127.0.0.1", port: 4222, loopback: true });
    expect(parseNatsEndpoint("localhost:4300")).toEqual({ host: "localhost", port: 4300, loopback: true });
    expect(parseNatsEndpoint("nats://nats.internal")).toEqual({ host: "nats.internal", port: 4222, loopback: false });
    expect(parseNatsEndpoint("nats://10.0.0.5:4222, nats://10.0.0.6:4222").host).toBe("10.0.0.5");
  });
});

describe("isNatsReachable", () => {
  it("is true when the server greets with INFO", async () => {
    const fake = fakeConnect((socket) => {
      socket.emit("connect");
      socket.emit("data", Buffer.from('INFO {"server_id":"x"}\r\n'));
    });
    await expect(isNatsReachable("nats://127.0.0.1:4222", { connect: fake.connect })).resolves.toBe(true);
    expect(fake.calls).toEqual([{ port: 4222, host: "127.0.0.1" }]);
    expect(fake.sockets[0]?.destroyed).toBe(true);
  });

  it("is false when the connection is refused", async () => {
    const fake = fakeConnect((socket) => socket.emit("error", new Error("ECONNREFUSED")));
    await expect(isNatsReachable("nats://127.0.0.1:4222", { connect: fake.connect })).resolves.toBe(false);
  });

  it("is false for a listener that is not NATS", async () => {
    const fake = fakeConnect((socket) => {
      socket.emit("connect");
      socket.emit("data", "HTTP/1.1 400 Bad Request\r\n");
    });
    await expect(isNatsReachable("nats://127.0.0.1:4222", { connect: fake.connect })).resolves.toBe(false);
  });

  it("is false on timeout and closes the socket", async () => {
    const fake = fakeConnect((socket) => socket.emit("connect"));
    await expect(isNatsReachable("nats://127.0.0.1:4222", { connect: fake.connect, timeoutMs: 20 })).resolves.toBe(
      false,
    );
    expect(fake.sockets[0]?.destroyed).toBe(true);
  });

  it("is false for an unparseable URL without connecting", async () => {
    const fake = fakeConnect(() => {});
    await expect(isNatsReachable("nats://host:notaport", { connect: fake.connect })).resolves.toBe(false);
    expect(fake.calls).toEqual([]);
  });
});

describe("findNatsPm2Owner", () => {
  it("prefers an online ravi-nats, then an online omni-nats", () => {
    const ravi = { name: "ravi-nats", status: "online" };
    const omni = { name: "omni-nats", status: "online" };
    expect(findNatsPm2Owner([omni, ravi])).toBe(ravi);
    expect(findNatsPm2Owner([omni, { name: "ravi-nats", status: "errored" }])).toBe(omni);
    expect(findNatsPm2Owner([{ name: "omni-api", status: "online" }])).toBeNull();
    expect(findNatsPm2Owner([{ name: "omni-nats", status: "stopped" }])).toBeNull();
  });
});

describe("natsServerReleaseAsset / natsServerBinaryPath", () => {
  it("maps linux/darwin x amd64/arm64 to the GitHub release asset", () => {
    expect(natsServerReleaseAsset("linux", "x64")).toEqual({
      name: "nats-server-v2.11.8-linux-amd64",
      url: "https://github.com/nats-io/nats-server/releases/download/v2.11.8/nats-server-v2.11.8-linux-amd64.tar.gz",
    });
    expect(natsServerReleaseAsset("linux", "arm64").name).toBe("nats-server-v2.11.8-linux-arm64");
    expect(natsServerReleaseAsset("darwin", "arm64").name).toBe("nats-server-v2.11.8-darwin-arm64");
    expect(natsServerReleaseAsset("darwin", "x64").name).toBe("nats-server-v2.11.8-darwin-amd64");
  });

  it("refuses unsupported platforms", () => {
    expect(() => natsServerReleaseAsset("win32", "x64")).toThrow("not supported");
    expect(() => natsServerReleaseAsset("linux", "ia32")).toThrow("not supported");
  });

  it("downloads into <stateDir>/bin/nats-server", () => {
    expect(natsServerBinaryPath("/home/u/.ravi")).toBe("/home/u/.ravi/bin/nats-server");
  });
});

describe("ensureNatsServerBinary", () => {
  it("reuses an existing binary without running anything", async () => {
    const stateDir = makeTempDir();
    mkdirSync(join(stateDir, "bin"), { recursive: true });
    writeFileSync(join(stateDir, "bin", "nats-server"), "bin");
    const commands: string[][] = [];

    const result = await ensureNatsServerBinary({ stateDir, run: (cmd, args) => commands.push([cmd, ...args]) });

    expect(result).toEqual({
      path: join(stateDir, "bin", "nats-server"),
      version: "2.11.8",
      downloaded: false,
      url: null,
    });
    expect(commands).toEqual([]);
  });

  it("downloads and extracts the pinned release when missing", async () => {
    const stateDir = makeTempDir();
    const commands: string[][] = [];
    const asset = natsServerReleaseAsset("linux", "arm64");

    const result = await ensureNatsServerBinary({
      stateDir,
      platform: "linux",
      arch: "arm64",
      run: (cmd, args) => {
        commands.push([cmd, ...args]);
        if (cmd === "tar") {
          const target = args[args.indexOf("-C") + 1] ?? "";
          mkdirSync(join(target, asset.name), { recursive: true });
          writeFileSync(join(target, asset.name, "nats-server"), "nats-binary");
        }
      },
    });

    const binary = join(stateDir, "bin", "nats-server");
    expect(result).toEqual({ path: binary, version: "2.11.8", downloaded: true, url: asset.url });
    expect(commands[0]?.[0]).toBe("curl");
    expect(commands[0]).toContain(asset.url);
    expect(commands[1]?.slice(0, 2)).toEqual(["tar", "-xzf"]);
    expect(readFileSync(binary, "utf8")).toBe("nats-binary");
    expect(statSync(binary).mode & 0o111).not.toBe(0);
    // The temp download dir is removed.
    expect(readdirSync(join(stateDir, "bin"))).toEqual(["nats-server"]);
  });

  it("throws and leaves no binary when the archive has no nats-server", async () => {
    const stateDir = makeTempDir();
    await expect(ensureNatsServerBinary({ stateDir, platform: "linux", arch: "x64", run: () => {} })).rejects.toThrow(
      "nats-server not found",
    );
    expect(existsSync(join(stateDir, "bin", "nats-server"))).toBe(false);
  });

  it("propagates a failed download", async () => {
    const stateDir = makeTempDir();
    await expect(
      ensureNatsServerBinary({
        stateDir,
        platform: "linux",
        arch: "x64",
        run: () => {
          throw new Error("curl exited with 22");
        },
      }),
    ).rejects.toThrow("curl exited with 22");
  });
});
