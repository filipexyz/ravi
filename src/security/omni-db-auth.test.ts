import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
import {
  buildStartupMessage,
  classifyStartupReply,
  loopbackAddressesFor,
  omniDatabaseUrlFromConfig,
  probeOmniDatabaseAuth,
  redactDatabaseUrl,
  type PgStartupReply,
} from "./omni-db-auth.js";

function authReply(method: number): Buffer {
  const reply = Buffer.alloc(9);
  reply.write("R", 0, "ascii");
  reply.writeInt32BE(8, 1);
  reply.writeInt32BE(method, 5);
  return reply;
}

function errorReply(): Buffer {
  const body = Buffer.from("SFATAL\0C28000\0Mno pg_hba.conf entry\0\0", "utf8");
  const reply = Buffer.alloc(5 + body.length);
  reply.write("E", 0, "ascii");
  reply.writeInt32BE(4 + body.length, 1);
  body.copy(reply, 5);
  return reply;
}

type FakeServer = { port: number; startups: Buffer[]; afterReply: Buffer[]; stop: () => void };
const servers: FakeServer[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A loopback TCP server that answers the first StartupMessage with `reply`, possibly split in two writes. */
async function fakePostgres(reply: Buffer, split = false): Promise<FakeServer> {
  const startups: Buffer[] = [];
  const afterReply: Buffer[] = [];
  const server = createServer((socket) => {
    let answered = false;
    socket.on("data", (data: Buffer) => {
      if (answered) {
        afterReply.push(Buffer.from(data));
        return;
      }
      startups.push(Buffer.from(data));
      answered = true;
      if (split) {
        socket.write(reply.subarray(0, 3));
        setTimeout(() => socket.write(reply.subarray(3)), 20);
      } else {
        socket.write(reply);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fake = { port, startups, afterReply, stop: () => server.close() };
  servers.push(fake);
  return fake;
}

afterEach(() => {
  while (servers.length) servers.pop()?.stop();
});

describe("omni database URL", () => {
  it("reads server.databaseUrl from Omni's config", () => {
    expect(omniDatabaseUrlFromConfig({ server: { databaseUrl: " postgresql://root@localhost/omni " } })).toBe(
      "postgresql://root@localhost/omni",
    );
    expect(omniDatabaseUrlFromConfig({ server: {} })).toBeNull();
    expect(omniDatabaseUrlFromConfig(null)).toBeNull();
  });

  it("redacts the password", () => {
    const redacted = redactDatabaseUrl("postgresql://omni:s3cret@127.0.0.1:5432/omni");
    expect(redacted).not.toContain("s3cret");
    expect(redacted).toContain("omni:***@");
  });

  it("probes only loopback hosts", () => {
    expect(loopbackAddressesFor("localhost")).toEqual(["127.0.0.1", "::1"]);
    expect(loopbackAddressesFor("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(loopbackAddressesFor("[::1]")).toEqual(["::1"]);
    expect(loopbackAddressesFor("db.example.com")).toBeNull();
    expect(loopbackAddressesFor("10.0.0.5")).toBeNull();
  });
});

describe("startup message and reply", () => {
  it("builds a v3 StartupMessage with user and database, and no password", () => {
    const message = buildStartupMessage("root", "omni");
    expect(message.readInt32BE(0)).toBe(message.length);
    expect(message.readInt32BE(4)).toBe(196_608);
    expect(message.subarray(8).toString("utf8")).toBe("user\0root\0database\0omni\0\0");
  });

  it("classifies AuthenticationOk, a password request, an error and an incomplete reply", () => {
    expect(classifyStartupReply(authReply(0))).toEqual({ kind: "auth_ok" });
    expect(classifyStartupReply(authReply(10))).toEqual({ kind: "auth_required", method: 10 });
    expect(classifyStartupReply(errorReply())).toEqual({ kind: "error" });
    expect(classifyStartupReply(authReply(0).subarray(0, 4))).toBeNull();
  });
});

describe("probeOmniDatabaseAuth against a fake server", () => {
  it("flags a trust login, sends no password and terminates the session", async () => {
    const server = await fakePostgres(authReply(0));
    const report = await probeOmniDatabaseAuth(`postgresql://root@127.0.0.1:${server.port}/omni`);
    expect(report.status).toBe("no_password_login");
    expect(report.passwordlessAddresses).toEqual(["127.0.0.1"]);
    expect(report.remediation.join(" ")).toContain("scram-sha-256");
    expect(server.startups[0]?.subarray(8).toString("utf8")).toBe("user\0root\0database\0omni\0\0");
    await sleep(30);
    const after = Buffer.concat(server.afterReply);
    expect(after.equals(Buffer.from([0x58, 0, 0, 0, 4]))).toBe(true);
  });

  it("accepts a reply split across packets", async () => {
    const server = await fakePostgres(authReply(0), true);
    const report = await probeOmniDatabaseAuth(`postgresql://root@127.0.0.1:${server.port}/omni`);
    expect(report.status).toBe("no_password_login");
  });

  it("passes when the server asks for SCRAM and never sends it anything else", async () => {
    const server = await fakePostgres(authReply(10));
    const report = await probeOmniDatabaseAuth(`postgresql://omni:pw@127.0.0.1:${server.port}/omni`);
    expect(report.status).toBe("password_required");
    expect(report.databaseUrl).not.toContain("pw@");
    await sleep(30);
    expect(server.afterReply).toEqual([]);
  });

  it("reports a refusal before authentication as rejected", async () => {
    const server = await fakePostgres(errorReply());
    const report = await probeOmniDatabaseAuth(`postgresql://root@127.0.0.1:${server.port}/omni`);
    expect(report.status).toBe("rejected");
  });

  it("reports nothing listening as unknown, not as safe", async () => {
    const server = await fakePostgres(authReply(0));
    const port = server.port;
    server.stop();
    servers.length = 0;
    const report = await probeOmniDatabaseAuth(`postgresql://root@127.0.0.1:${port}/omni`, { timeoutMs: 300 });
    expect(report.status).toBe("unknown");
  });
});

describe("probeOmniDatabaseAuth decisions", () => {
  const replying =
    (byAddress: Record<string, PgStartupReply>) =>
    async (host: string): Promise<PgStartupReply> =>
      byAddress[host] ?? { kind: "unreachable" };

  it("flags localhost when either loopback family logs in without a password", async () => {
    const report = await probeOmniDatabaseAuth("postgresql://root@localhost/omni", {
      probe: replying({ "127.0.0.1": { kind: "auth_required", method: 10 }, "::1": { kind: "auth_ok" } }),
    });
    expect(report.status).toBe("no_password_login");
    expect(report.passwordlessAddresses).toEqual(["::1"]);
    expect(report.port).toBe(5432);
  });

  it("does not probe a remote host", async () => {
    let probed = false;
    const report = await probeOmniDatabaseAuth("postgresql://omni:pw@db.example.com/omni", {
      probe: async () => {
        probed = true;
        return { kind: "auth_ok" };
      },
    });
    expect(report.status).toBe("remote");
    expect(probed).toBe(false);
  });

  it("reports a missing or unparseable URL without throwing", async () => {
    expect((await probeOmniDatabaseAuth(null)).status).toBe("not_configured");
    expect((await probeOmniDatabaseAuth("not a url")).status).toBe("unknown");
    expect((await probeOmniDatabaseAuth("mysql://root@127.0.0.1/omni")).status).toBe("unknown");
  });

  it("falls back to the system user and to the user as database, like libpq", async () => {
    const seen: string[] = [];
    const report = await probeOmniDatabaseAuth("postgresql://127.0.0.1", {
      defaultUser: () => "ravi",
      probe: async (_host, _port, user, database) => {
        seen.push(user, database);
        return { kind: "auth_required", method: 10 };
      },
    });
    expect(seen).toEqual(["ravi", "ravi"]);
    expect(report.status).toBe("password_required");
  });

  it("treats a throwing probe as unreachable", async () => {
    const report = await probeOmniDatabaseAuth("postgresql://root@127.0.0.1/omni", {
      probe: async () => {
        throw new Error("boom");
      },
    });
    expect(report.status).toBe("unknown");
  });
});
