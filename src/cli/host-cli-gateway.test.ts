import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRemote } from "./remote-gateway.js";
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
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      path: "/api/v1/pages/published",
      authorization: "Bearer rctx_test",
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
});
