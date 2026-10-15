import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CALLER_CWD_HEADER, dispatchRemote } from "./remote-gateway.js";
import { startHostCliGateway, type HostCliGatewayHandle } from "./host-cli-gateway.js";

const tempDirs: string[] = [];
const handles: HostCliGatewayHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-host-cli-gateway-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) await handle.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("host CLI gateway", () => {
  it("listens on a 0600 unix socket and serves authenticated CLI posts", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");
    const handle = await startHostCliGateway({
      socketPath,
      handleRequest: async (request) => {
        const url = new URL(request.url);
        const body = (await request.json()) as { project?: string };
        return Response.json({
          ok: true,
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          cwd: request.headers.get(CALLER_CWD_HEADER),
          project: body.project,
        });
      },
    });
    expect(handle).not.toBeNull();
    handles.push(handle!);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const result = await dispatchRemote({
      groupSegments: ["pages"],
      command: "published",
      body: { project: "rbbt-lab", json: true },
      config: { url: `unix://${socketPath}`, source: "host-socket", socketPath },
      contextKey: "rctx_test",
      cwd: "/tmp/agent-workspace",
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      path: "/api/v1/pages/published",
      authorization: "Bearer rctx_test",
      cwd: "/tmp/agent-workspace",
      project: "rbbt-lab",
    });
  });

  it("never unlinks a live socket: a second gateway returns null and the first keeps serving", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");
    const first = await startNamedGateway(socketPath, "first");
    expect(first).not.toBeNull();
    handles.push(first!);
    const inode = lstatSync(socketPath).ino;

    const second = await startNamedGateway(socketPath, "second");

    expect(second).toBeNull();
    expect(lstatSync(socketPath).ino).toBe(inode);
    expect(await whoServes(socketPath)).toBe("first");
  });

  it("replaces a stale socket nobody is listening on", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");
    await leaveStaleSocket(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    const handle = await startNamedGateway(socketPath, "fresh");

    expect(handle).not.toBeNull();
    handles.push(handle!);
    expect(await whoServes(socketPath)).toBe("fresh");
  });

  it("refuses a path that holds a regular file and leaves the file intact", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");
    writeFileSync(socketPath, "not a socket");

    const handle = await startNamedGateway(socketPath, "never");

    expect(handle).toBeNull();
    expect(readFileSync(socketPath, "utf8")).toBe("not a socket");
  });

  it("stop() leaves a successor's socket in place", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");
    const old = await startNamedGateway(socketPath, "old");
    expect(old).not.toBeNull();
    // The old daemon's socket file disappears and a successor binds the path.
    unlinkSync(socketPath);
    const successor = await startNamedGateway(socketPath, "successor");
    expect(successor).not.toBeNull();
    handles.push(successor!);
    const successorInode = lstatSync(socketPath).ino;

    await old!.stop();

    expect(lstatSync(socketPath).ino).toBe(successorInode);
    expect(await whoServes(socketPath)).toBe("successor");
    expect(readdirSync(dirname(socketPath))).toEqual(["cli-gateway.sock"]);
  });

  it("of gateways starting at once on a free path, exactly one starts", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");

    const started = await Promise.all(["a", "b", "c", "d"].map((name) => startNamedGateway(socketPath, name)));

    const winners = started.flatMap((handle, index) => (handle ? [{ handle, name: "abcd"[index] }] : []));
    for (const winner of winners) handles.push(winner.handle);
    expect(winners).toHaveLength(1);
    expect(await whoServes(socketPath)).toBe(winners[0]!.name);
    expect(readdirSync(dirname(socketPath))).toEqual(["cli-gateway.sock"]);
  });

  it("of gateways starting at once over a stale socket, exactly one starts", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");
    await leaveStaleSocket(socketPath);

    const started = await Promise.all(["a", "b", "c"].map((name) => startNamedGateway(socketPath, name)));

    const winners = started.flatMap((handle, index) => (handle ? [{ handle, name: "abc"[index] }] : []));
    for (const winner of winners) handles.push(winner.handle);
    expect(winners).toHaveLength(1);
    expect(await whoServes(socketPath)).toBe(winners[0]!.name);
    expect(readdirSync(dirname(socketPath))).toEqual(["cli-gateway.sock"]);
  });

  it("a refused start leaves no temporary socket behind", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");
    const first = await startNamedGateway(socketPath, "first");
    handles.push(first!);
    expect(await startNamedGateway(socketPath, "second")).toBeNull();
    expect(readdirSync(dirname(socketPath))).toEqual(["cli-gateway.sock"]);
  });

  it("stop() removes its own socket", async () => {
    const socketPath = join(tempDir(), "cli-gateway.sock");
    const handle = await startNamedGateway(socketPath, "only");
    await handle!.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("stays disabled when RAVI_HOST_CLI_GATEWAY=0", async () => {
    const handle = await startHostCliGateway({
      socketPath: join(tempDir(), "cli-gateway.sock"),
      env: { RAVI_HOST_CLI_GATEWAY: "0" },
    });
    expect(handle).toBeNull();
  });
});

function startNamedGateway(socketPath: string, name: string): Promise<HostCliGatewayHandle | null> {
  return startHostCliGateway({ socketPath, handleRequest: () => Response.json({ name }) });
}

async function whoServes(socketPath: string): Promise<string> {
  const result = await dispatchRemote({
    groupSegments: ["daemon"],
    command: "status",
    body: {},
    config: { url: `unix://${socketPath}`, source: "host-socket", socketPath },
    contextKey: "rctx_test",
  });
  return (JSON.parse(result.body) as { name: string }).name;
}

/** A socket file with no listener, as a crashed daemon leaves behind. */
async function leaveStaleSocket(socketPath: string): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  // Closing unlinks the path by name; a hard link keeps the socket file.
  const kept = `${socketPath}.stale`;
  linkSync(socketPath, kept);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // rename() between two links to the same file is a no-op that keeps both.
  renameSync(kept, socketPath);
  if (existsSync(kept)) unlinkSync(kept);
}
