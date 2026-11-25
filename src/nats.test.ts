import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "bun:test";
import { isSessionResponseTopic } from "./nats.js";

describe("isSessionResponseTopic", () => {
  it("matches only session chat response topics", () => {
    expect(isSessionResponseTopic("ravi.session.demo-agent.response")).toBe(true);
    expect(isSessionResponseTopic("ravi.session.demo-group.response")).toBe(true);
  });

  it("does not treat approval or other .response topics as ghost chat emits", () => {
    expect(isSessionResponseTopic("ravi.approval.response")).toBe(false);
    expect(isSessionResponseTopic("ravi.session.demo-agent.runtime")).toBe(false);
    expect(isSessionResponseTopic("ravi.outbound.deliver")).toBe(false);
  });
});

describe("lazy NATS connect failure logging", () => {
  // Each case runs in a fresh process so the module-level connection state and
  // NATS_URL (read at import time) point at a port nothing listens on.
  const natsModule = new URL("./nats.ts", import.meta.url).pathname;

  function failureLinesFor(script: string): number {
    const result = spawnSync(process.execPath, ["-e", `import * as n from ${JSON.stringify(natsModule)};\n${script}`], {
      env: { ...process.env, NATS_URL: "nats://127.0.0.1:1", RAVI_LOG_LEVEL: "info" },
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;
    return output.split("\n").filter((line) => line.includes("Failed to connect to NATS")).length;
  }

  it("stays silent for a best-effort emit such as the CLI audit event", () => {
    expect(failureLinesFor(`await n.publish("ravi._cli.cli.x.y", {}, { quietConnect: true }).catch(() => {});`)).toBe(
      0,
    );
  });

  it("still prints one error for callers that need NATS", () => {
    expect(
      failureLinesFor(`await Promise.all([n.ensureConnected().catch(() => {}), n.ensureConnected().catch(() => {})]);`),
    ).toBe(1);
  });

  it("prints the error once when a caller that needs NATS joins a quiet attempt", () => {
    expect(
      failureLinesFor(
        `await Promise.all([
          n.ensureConnected({ quiet: true }).catch(() => {}),
          n.ensureConnected().catch(() => {}),
          n.ensureConnected().catch(() => {}),
        ]);`,
      ),
    ).toBe(1);
  });
});

describe("redactNatsUrl", () => {
  it("drops credentials and tokens but keeps the server", async () => {
    const { redactNatsUrl } = await import("./nats.js");
    expect(redactNatsUrl("nats://user:secret@127.0.0.1:4222")).toBe("nats://[redacted]@127.0.0.1:4222");
    expect(redactNatsUrl("nats://token@a:4222,nats://b:4222")).toBe("nats://[redacted]@a:4222,nats://b:4222");
    expect(redactNatsUrl("nats://127.0.0.1:4222")).toBe("nats://127.0.0.1:4222");
  });
});

describe("closeNats while the lazy connection is still opening", () => {
  // A CLI command that fires `nats.emit(...)` without awaiting it (settings, agents) reaches its cleanup while the
  // lazy handshake is in flight. The close used to be a no-op there, the handshake finished afterwards, and the
  // open socket kept the process alive. The child runs in its own process and must exit on its own.
  const natsModule = new URL("./nats.ts", import.meta.url).pathname;

  function runChild(natsUrl: string): Promise<{ code: number | null; timedOut: boolean }> {
    const script = `import * as n from ${JSON.stringify(natsModule)};
      n.nats.emit("ravi.config.changed", {}).catch(() => {});
      await n.closeNats();`;
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script], {
        env: { ...process.env, NATS_URL: natsUrl, RAVI_LOG_LEVEL: "error" },
        stdio: "ignore",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 15_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut });
      });
    });
  }

  it("closes the connection the pending attempt opens, so the process exits", async () => {
    const server = createServer((socket) => {
      socket.write(
        'INFO {"server_id":"fake","server_name":"fake","version":"2.10.0","proto":1,"headers":true,"max_payload":1048576}\r\n',
      );
      socket.on("data", (data) => {
        if (data.toString().includes("PING")) socket.write("PONG\r\n");
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await runChild(`nats://127.0.0.1:${port}`);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
    } finally {
      server.close();
    }
  }, 30_000);

  it("returns when the pending attempt fails, with nothing to close", async () => {
    const result = await runChild("nats://127.0.0.1:1");
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  }, 30_000);
});
