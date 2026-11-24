import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOmniClient, OmniApiError } from "./client.js";

// A server that accepts requests and never answers, like a stalled omni-api.
let hangingServer: Server;
let bodyStallServer: Server;
let port = 0;
let bodyStallPort = 0;

beforeAll(async () => {
  hangingServer = createServer(() => {});
  // Sends headers and part of the JSON body, then never finishes it.
  bodyStallServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"data":');
  });
  await Promise.all([
    new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => bodyStallServer.listen(0, "127.0.0.1", resolve)),
  ]);
  port = (hangingServer.address() as AddressInfo).port;
  bodyStallPort = (bodyStallServer.address() as AddressInfo).port;
});

afterAll(() => {
  hangingServer.closeAllConnections();
  hangingServer.close();
  bodyStallServer.closeAllConnections();
  bodyStallServer.close();
});

describe("createOmniClient", () => {
  it("fails a request that never gets a response instead of hanging", async () => {
    const client = createOmniClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test",
      timeoutMs: 50,
    });

    const error = await client.messages
      .sendPresence({ instanceId: "discord", to: "channel", type: "typing" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OmniApiError);
    expect((error as OmniApiError).code).toBe("TIMEOUT");
    expect((error as OmniApiError).message).toContain("POST /messages/send/presence");
  });

  it("fails when the response body never completes", async () => {
    const client = createOmniClient({
      baseUrl: `http://127.0.0.1:${bodyStallPort}`,
      apiKey: "test",
      timeoutMs: 50,
    });

    const error = await client.messages
      .sendPresence({ instanceId: "discord", to: "channel", type: "typing" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OmniApiError);
    expect((error as OmniApiError).code).toBe("TIMEOUT");
  });
});

describe("createOmniClient group members", () => {
  async function withServer<T>(
    reply: (url: string) => { status: number; body: unknown },
    run: (baseUrl: string, seen: string[]) => Promise<T>,
  ): Promise<T> {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const { status, body } = reply(req.url ?? "");
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  it("reads the live members of a group from /instances/:id/groups/:jid/members", async () => {
    await withServer(
      () => ({
        status: 200,
        body: {
          members: [
            { id: "100000000000001@lid", role: "superadmin" },
            { id: "100000000000002@lid", role: "member" },
          ],
        },
      }),
      async (baseUrl, seen) => {
        const client = createOmniClient({ baseUrl, apiKey: "test" });

        const members = await client.instances.listGroupMembers("inst-1", "120363000000000001@g.us");

        expect(seen).toEqual(["GET /api/v2/instances/inst-1/groups/120363000000000001%40g.us/members"]);
        expect(members).toEqual([
          { id: "100000000000001@lid", role: "superadmin" },
          { id: "100000000000002@lid", role: "member" },
        ]);
      },
    );
  });

  it("accepts the members under data and drops entries without an id", async () => {
    await withServer(
      () => ({
        status: 200,
        body: { data: [{ id: "100000000000001@lid" }, { role: "member" }, null, { id: "  " }, "text"] },
      }),
      async (baseUrl) => {
        const client = createOmniClient({ baseUrl, apiKey: "test" });

        const members = await client.instances.listGroupMembers("inst-1", "120363000000000001@g.us");

        expect(members).toEqual([{ id: "100000000000001@lid", role: null }]);
      },
    );
  });

  it("returns an empty list when the response has no member array", async () => {
    await withServer(
      () => ({ status: 200, body: { members: "nope" } }),
      async (baseUrl) => {
        const client = createOmniClient({ baseUrl, apiKey: "test" });

        expect(await client.instances.listGroupMembers("inst-1", "120363000000000001@g.us")).toEqual([]);
      },
    );
  });

  it("surfaces an API error instead of an empty list", async () => {
    await withServer(
      () => ({ status: 404, body: { error: "Group not found" } }),
      async (baseUrl) => {
        const client = createOmniClient({ baseUrl, apiKey: "test" });

        const error = await client.instances
          .listGroupMembers("inst-1", "120363000000000001@g.us")
          .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(OmniApiError);
        expect((error as OmniApiError).status).toBe(404);
      },
    );
  });
});
