import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { YouTubeCommands } from "../../cli/commands/youtube.js";
import { runWithContext } from "../../cli/context.js";
import * as backends from "../../credentials/backends.js";
import { closeCredentialsDb, upsertCredentialConnection } from "../../credentials/store.js";
import { dbCreateAgent } from "../../router/router-db.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { YouTubeClient } from "./client.js";

let stateDir: string;
let readSecret: ReturnType<typeof spyOn<typeof backends, "readSecret">>;
let providerFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-youtube-credential-authority-");
  upsertCredentialConnection({
    provider: "youtube",
    connection: "fixture",
    backend: "vault",
    secretRef: "vault:secret/test-only#token",
    status: "active",
  });
  readSecret = spyOn(backends, "readSecret").mockResolvedValue(JSON.stringify({ accessToken: "youtube-fixture-only" }));
  providerFetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ items: [{ id: "UC-fixture", snippet: { title: "Fixture" } }] }),
  );
  spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  mock.restore();
  closeCredentialsDb();
  await cleanupIsolatedRaviState(stateDir);
});

describe("YouTube credential authority", () => {
  it("keeps a context-free helper denied unless its host supplies authority", async () => {
    const client = new YouTubeClient({ connection: "fixture" });
    await expect(client.channelInfo()).rejects.toThrow("YouTube credential unavailable");
    expect(readSecret).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("forwards explicit host authority through the default broker resolver", async () => {
    const client = new YouTubeClient({ connection: "fixture", authority: { kind: "local-operator" } });
    const result = await client.channelInfo();
    expect(result.channelId).toBe("UC-fixture");
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(new Headers(providerFetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer youtube-fixture-only",
    );
    expect(JSON.stringify(result)).not.toContain("youtube-fixture-only");
  });

  it("lets the direct local CLI factory use the configured connection", async () => {
    const result = await new YouTubeCommands().info("fixture", true);
    expect(result.channel.channelId).toBe("UC-fixture");
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("does not let the CLI factory's host intent bypass a denied runtime caller", async () => {
    const agentId = "youtube-restricted";
    dbCreateAgent({ id: agentId, cwd: stateDir });
    const context = createRuntimeContext({ kind: "turn-runtime", agentId, capabilities: [] });
    await expect(
      runWithContext({ transport: "tool", agentId, context }, () => new YouTubeCommands().info("fixture", true)),
    ).rejects.toThrow("YouTube credential unavailable");
    expect(readSecret).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
