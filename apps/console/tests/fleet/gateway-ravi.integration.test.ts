import { expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { node24Binary } from "./binaries";
const source = process.env.FLEET_TEST_RAVI_SOURCE;
const integration = source && (source.endsWith("ravi-console-gateway") || source.endsWith("ravi-desktop-contracts")) ? test : test.skip;
integration(
  "real Ravi gateway and private journal through Fleet HTTP/SSE SSH client",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-pair-")),
      out = await mkdtemp(resolve("node_modules/.cache-gateway-pair-"));
    const { runtimeIdentity } = await import(`${source}/src/bridge/auth.ts`);
    const { BridgeStore } = await import(`${source}/src/bridge/store.ts`);
    const { BridgeService } = await import(`${source}/src/bridge/service.ts`);
    const { serveConsoleSocket } = await import(`${source}/src/sdk/gateway/console-socket.ts`);
    const { createGatewayHandlerContext } = await import(`${source}/src/sdk/gateway/server.ts`);
    const { buildRegistry } = await import(`${source}/src/cli/registry-snapshot.ts`);
    const { SessionConversationCommands } = await import(
      `${source}/src/cli/commands/session-conversations.ts`
    );
    await mkdir(join(root, "signer"));
    const signer = runtimeIdentity(join(root, "signer")),
      identity = runtimeIdentity(root);
    const store = new BridgeStore(join(root, "private.db"));
    const enrollment = {
      id: randomUUID(),
      orgId: randomUUID(),
      installationId: randomUUID(),
      runtimeId: identity.runtimeId,
      issuer: "https://fixture.invalid",
      issuerKeyId: "fixture",
      issuerPublicKey: signer.publicKey,
      epoch: 1,
      active: true,
    };
    store.putEnrollment(enrollment);
    const service = new BridgeService(store, identity.runtimeId, "fixture-cursor", {
      agents: () => [{ id: "main", name: "main" }],
      start: async () => {},
      cancel: () => false,
    });
    const socketPath = join(root, "gateway.sock"),
      handle = await serveConsoleSocket(
        service,
        identity,
        socketPath,
        createGatewayHandlerContext({ registry: buildRegistry([SessionConversationCommands]) }),
      );
    try {
      const file = join(root, "fixture.json");
      await writeFile(
        file,
        JSON.stringify({
          socketPath,
          identity: { runtimeId: identity.runtimeId, publicKey: identity.publicKey },
          enrollment,
          signer,
          project: randomUUID(),
          subject: randomUUID(),
        }),
        { mode: 0o600 },
      );
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "gateway-ravi.node-fixture.ts")],
        outdir: out,
        target: "node",
        format: "cjs",
        external: ["ssh2", "jose", "zod", "ipaddr.js"],
      });
      expect(build.success).toBe(true);
      const child = Bun.spawn([await node24Binary(), build.outputs[0]!.path, file], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code) throw new Error(stderr);
      expect(JSON.parse(stdout)).toMatchObject({ result: "PASS", checks: 8 });
      expect(store.db.query("select count(*) n from turns").get()).toEqual({ n: 1 });
      expect(store.db.query("select count(*) n from messages").get()).toEqual({ n: 1 });
    } finally {
      await handle.stop();
      service.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  },
  60000,
);
