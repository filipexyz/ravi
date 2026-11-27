import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sleep, spawn, which } from "bun";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AckPolicy, connect, type NatsConnection, StringCodec } from "nats";
import {
  ensureNatsCredentials,
  loadNatsCredential,
  NATS_ROLES,
  NatsCredentialError,
  natsConnectAuth,
  natsCredentialPath,
  natsRolePermissions,
  renderNatsServerConfig,
} from "./nats-auth.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravi-nats-auth-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("NATS role credentials", () => {
  it("has no credential on a host that was never configured, and connects as before", () => {
    expect(loadNatsCredential("cli", dir)).toBeNull();
    expect(natsConnectAuth("daemon", dir)).toEqual({ role: "daemon" });
  });

  it("creates one 0600 credential per role and keeps existing ones on a rewrite", () => {
    const first = ensureNatsCredentials(dir);
    for (const role of NATS_ROLES) {
      expect(statSync(natsCredentialPath(role, dir)).mode & 0o777).toBe(0o600);
      expect(first[role].pass.length).toBeGreaterThanOrEqual(32);
    }
    expect(new Set(NATS_ROLES.map((role) => first[role].pass)).size).toBe(NATS_ROLES.length);

    const second = ensureNatsCredentials(dir);
    expect(second).toEqual(first);
    expect(natsConnectAuth("channels", dir)).toEqual({ role: "channels", ...first.channels });
  });

  it("refuses a credential file others can read, and a malformed one, instead of skipping it", () => {
    ensureNatsCredentials(dir);
    chmodSync(natsCredentialPath("daemon", dir), 0o644);
    expect(() => loadNatsCredential("daemon", dir)).toThrow(NatsCredentialError);

    writeFileSync(natsCredentialPath("cli", dir), "{not json", { mode: 0o600 });
    expect(() => loadNatsCredential("cli", dir)).toThrow(NatsCredentialError);

    writeFileSync(natsCredentialPath("omni", dir), JSON.stringify({ user: "ravi-omni" }), { mode: 0o600 });
    expect(() => loadNatsCredential("omni", dir)).toThrow(NatsCredentialError);
  });

  it("denies channel input to cli and omni only once locked", () => {
    for (const role of NATS_ROLES) {
      expect(natsRolePermissions(role, "open").publish.deny).toBeUndefined();
    }
    for (const role of ["cli", "omni"] as const) {
      const locked = natsRolePermissions(role, "locked");
      expect(locked.publish.deny).toContain("ravi.inbound.>");
      expect(locked.publish.deny).toContain("$JS.API.STREAM.CREATE.>");
      expect(locked.publish.deny).toContain("$JS.API.STREAM.UPDATE.>");
      expect(locked.subscribe.deny).toEqual(["ravi.inbound.>"]);
    }
    expect(natsRolePermissions("channels", "locked").publish.deny).toBeUndefined();
    expect(natsRolePermissions("daemon", "locked").publish.deny).toBeUndefined();
  });

  it("keeps unauthenticated clients entering only in the open phase", () => {
    const credentials = ensureNatsCredentials(dir);
    const open = renderNatsServerConfig({ phase: "open", credentials, jetstreamDir: join(dir, "js") });
    const locked = renderNatsServerConfig({ phase: "locked", credentials, jetstreamDir: join(dir, "js") });
    expect(open).toContain('no_auth_user: "legacy"');
    expect(locked).not.toContain("no_auth_user");
    expect(locked).not.toContain('"legacy"');
    expect(locked).toContain('deny: ["ravi.inbound.>"]');
  });
});

function findNatsServer(): string | null {
  const explicit = process.env.NATS_SERVER_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const onPath = which("nats-server");
  if (onPath) return onPath;
  const local = join(homedir(), ".ravi", "bin", "nats-server");
  return existsSync(local) ? local : null;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function startServer(config: string): Promise<{ stop: () => void; url: string }> {
  const bin = findNatsServer()!;
  const port = Number(/port: (\d+)/.exec(config)![1]);
  const confPath = join(dir, "server.conf");
  writeFileSync(confPath, config, { mode: 0o600 });
  const child = spawn([bin, "-c", confPath], { stdout: "ignore", stderr: "ignore" });
  const url = `nats://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const probe = await connect({ servers: url, reconnect: false, timeout: 200, user: "ravi-daemon", pass: "x" });
      await probe.close();
      break;
    } catch (error) {
      // An authorization error means the server is up; anything else, wait.
      if (String(error).toLowerCase().includes("authorization")) break;
      await sleep(100);
    }
  }
  return { url, stop: () => child.kill() };
}

async function delivered(subscriber: NatsConnection, publisher: NatsConnection, subject: string): Promise<boolean> {
  const sc = StringCodec();
  const sub = subscriber.subscribe(subject, { max: 1 });
  await subscriber.flush();
  publisher.publish(subject, sc.encode("forged"));
  await publisher.flush().catch(() => {});
  const timer = setTimeout(() => sub.unsubscribe(), 500);
  for await (const _message of sub) {
    clearTimeout(timer);
    return true;
  }
  return false;
}

const natsServer = findNatsServer();
const describeWithServer = natsServer ? describe : describe.skip;
if (!natsServer) console.warn("nats-auth: nats-server not found; skipping the real-server checks");

describeWithServer("NATS role credentials against a real nats-server", () => {
  async function lockedServer() {
    const credentials = ensureNatsCredentials(dir);
    const server = await startServer(
      renderNatsServerConfig({ phase: "locked", credentials, port: await freePort(), jetstreamDir: join(dir, "js") }),
    );
    const as = (role: keyof typeof credentials) =>
      connect({ servers: server.url, reconnect: false, user: credentials[role].user, pass: credentials[role].pass });
    return { server, as };
  }

  it("once locked: cli cannot forge channel input through a stream that republishes it", async () => {
    const { server, as } = await lockedServer();
    const daemon = await as("daemon");
    const cli = await as("cli");
    try {
      const forged: string[] = [];
      const sub = daemon.subscribe("ravi.inbound.>");
      (async () => {
        for await (const message of sub) forged.push(message.subject);
      })();
      await daemon.flush();
      const cliStreams = await cli.jetstreamManager();
      // A new stream that republishes into channel input.
      await expect(
        cliStreams.streams.add({
          name: "FORGE_NEW",
          subjects: ["forge.new"],
          republish: { src: "forge.new", dest: "ravi.inbound.interaction" },
        }),
      ).rejects.toThrow();
      // An existing stream (created by the daemon) changed to republish into channel input.
      const daemonStreams = await daemon.jetstreamManager();
      await daemonStreams.streams.add({ name: "FORGE_OLD", subjects: ["forge.old"] });
      await expect(
        cliStreams.streams.update("FORGE_OLD", {
          subjects: ["forge.old"],
          republish: { src: "forge.old", dest: "ravi.inbound.command" },
        }),
      ).rejects.toThrow();
      await expect(cliStreams.streams.delete("FORGE_OLD")).rejects.toThrow();
      cli.publish("forge.new", StringCodec().encode("forged"));
      cli.publish("forge.old", StringCodec().encode("forged"));
      await cli.flush();
      await sleep(300);
      expect(forged).toEqual([]);
      // What the CLI does use keeps working: read stream info, manage its own consumer.
      expect((await cliStreams.streams.info("FORGE_OLD")).config.name).toBe("FORGE_OLD");
      await cliStreams.consumers.add("FORGE_OLD", { durable_name: "cli-own", ack_policy: AckPolicy.Explicit });
      await cliStreams.consumers.delete("FORGE_OLD", "cli-own");
      sub.unsubscribe();
    } finally {
      await Promise.allSettled([daemon.close(), cli.close()]);
      server.stop();
    }
  }, 20_000);

  it("once locked: cli does not read channel input, even through a wildcard", async () => {
    const { server, as } = await lockedServer();
    const channels = await as("channels");
    const cli = await as("cli");
    try {
      const seen: string[] = [];
      const refused: string[] = [];
      for (const subject of ["ravi.inbound.>", ">"]) {
        const sub = cli.subscribe(subject);
        (async () => {
          for await (const message of sub) seen.push(`${subject} ${message.subject}`);
        })().catch((error) => refused.push(`${subject} ${String(error)}`));
      }
      await cli.flush().catch(() => {});
      channels.publish("ravi.inbound.reply", StringCodec().encode("a message of some chat"));
      channels.publish("ravi.events.visible", StringCodec().encode("an event"));
      await channels.flush();
      await sleep(300);
      expect(seen.filter((entry) => entry.includes("ravi.inbound"))).toEqual([]);
      expect(seen).toContain("> ravi.events.visible");
      // The explicit subscription is refused by the server, not just left empty.
      expect(refused.some((entry) => entry.startsWith("ravi.inbound.> ") && /permissions violation/i.test(entry))).toBe(
        true,
      );
    } finally {
      await Promise.allSettled([channels.close(), cli.close()]);
      server.stop();
    }
  }, 20_000);

  it("once locked: cli cannot publish channel input, channels can, and no password means no connection", async () => {
    const credentials = ensureNatsCredentials(dir);
    const server = await startServer(
      renderNatsServerConfig({ phase: "locked", credentials, port: await freePort(), jetstreamDir: join(dir, "js") }),
    );
    const daemon = await connect({
      servers: server.url,
      reconnect: false,
      user: credentials.daemon.user,
      pass: credentials.daemon.pass,
    });
    const cli = await connect({
      servers: server.url,
      reconnect: false,
      user: credentials.cli.user,
      pass: credentials.cli.pass,
    });
    const channels = await connect({
      servers: server.url,
      reconnect: false,
      user: credentials.channels.user,
      pass: credentials.channels.pass,
    });
    try {
      expect(await delivered(daemon, cli, "ravi.inbound.interaction")).toBe(false);
      expect(await delivered(daemon, cli, "ravi.inbound.command")).toBe(false);
      expect(await delivered(daemon, channels, "ravi.inbound.interaction")).toBe(true);
      expect(await delivered(daemon, cli, "ravi.events.test")).toBe(true);
      await expect(connect({ servers: server.url, reconnect: false, timeout: 1_000 })).rejects.toThrow();
      await expect(
        connect({ servers: server.url, reconnect: false, timeout: 1_000, user: credentials.cli.user, pass: "wrong" }),
      ).rejects.toThrow();
    } finally {
      await Promise.allSettled([daemon.close(), cli.close(), channels.close()]);
      server.stop();
    }
  }, 20_000);

  it("while open: an old client without a password still connects and works", async () => {
    const credentials = ensureNatsCredentials(dir);
    const server = await startServer(
      renderNatsServerConfig({ phase: "open", credentials, port: await freePort(), jetstreamDir: join(dir, "js") }),
    );
    const daemon = await connect({
      servers: server.url,
      reconnect: false,
      user: credentials.daemon.user,
      pass: credentials.daemon.pass,
    });
    const legacy = await connect({ servers: server.url, reconnect: false });
    try {
      expect(await delivered(daemon, legacy, "ravi.inbound.interaction")).toBe(true);
    } finally {
      await Promise.allSettled([daemon.close(), legacy.close()]);
      server.stop();
    }
  }, 20_000);

  it("connectNats enters a locked server with the credential of the role the process declares", async () => {
    const credentials = ensureNatsCredentials(dir);
    const server = await startServer(
      renderNatsServerConfig({ phase: "locked", credentials, port: await freePort(), jetstreamDir: join(dir, "js") }),
    );
    const previous = process.env.RAVI_STATE_DIR;
    process.env.RAVI_STATE_DIR = dir;
    const { closeNats, connectNats, getNats } = await import("./nats.js");
    try {
      await connectNats(server.url, { retry: false, quiet: true, role: "channels" });
      expect(getNats().info?.client_id).toBeDefined();
      await closeNats();
      // Without a credential on disk the locked server refuses the same call.
      rmSync(natsCredentialPath("cli", dir));
      await expect(connectNats(server.url, { retry: false, quiet: true })).rejects.toThrow();
    } finally {
      await closeNats().catch(() => {});
      if (previous === undefined) delete process.env.RAVI_STATE_DIR;
      else process.env.RAVI_STATE_DIR = previous;
      server.stop();
    }
  }, 20_000);
});
