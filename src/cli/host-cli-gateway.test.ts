import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("stays disabled when RAVI_HOST_CLI_GATEWAY=0", async () => {
    const handle = await startHostCliGateway({
      socketPath: join(tempDir(), "cli-gateway.sock"),
      env: { RAVI_HOST_CLI_GATEWAY: "0" },
    });
    expect(handle).toBeNull();
  });

  it.each(["EACCES", "ENOENT"])(
    "reports socket cleanup failure to shutdown except an absent socket (%s)",
    async (code) => {
      const cause = Object.assign(new Error("unlink failed"), { code });
      const server = new EventEmitter() as http.Server;
      server.listen = ((...args: unknown[]) => {
        (args.at(-1) as () => void)();
        return server;
      }) as http.Server["listen"];
      server.close = (callback) => {
        callback?.();
        return server;
      };
      const create = spyOn(http, "createServer").mockReturnValue(server);
      const exists = spyOn(fs, "existsSync").mockReturnValue(false);
      const chmod = spyOn(fs, "chmodSync").mockImplementation(() => {});
      const unlink = spyOn(fs, "unlinkSync").mockImplementation(() => {
        throw cause;
      });
      try {
        const handle = await startHostCliGateway({
          socketPath: "/isolated-test/cli-gateway.sock",
          handleRequest: () => Response.json({ ok: true }),
        });
        expect(handle).not.toBeNull();
        exists.mockReturnValue(true);
        if (code === "ENOENT") await expect(handle!.stop()).resolves.toBeUndefined();
        else await expect(handle!.stop()).rejects.toBe(cause);
        expect(unlink).toHaveBeenCalledTimes(1);
      } finally {
        unlink.mockRestore();
        chmod.mockRestore();
        exists.mockRestore();
        create.mockRestore();
      }
    },
  );
});
