import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { probeInstallation, sshVersionProbe } from "../../src/server/console/fleet/ssh-probe";
import type { Installation } from "../../src/server/console/fleet/contract";

const makeKey = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const hostKey = makeKey(), userKey = makeKey();
const host = utils.parseKey(hostKey), user = utils.parseKey(userKey);
if (host instanceof Error || Array.isArray(host) || user instanceof Error || Array.isArray(user)) throw new Error("Invalid generated fixture key");
const fingerprint = `SHA256:${createHash("sha256").update(host.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
let authentications = 0, commands = 0;
const server = new Server({ hostKeys: [hostKey] }, client => {
  client.on("error", () => {});
  client.on("authentication", context => {
    authentications++;
    if (context.method === "publickey" && context.username === "ravi-fleet" && context.key.data.equals(user.getPublicSSH()) &&
      (!context.signature || user.verify(context.blob!, context.signature, context.hashAlgo) === true)) context.accept();
    else context.reject();
  });
  client.on("ready", () => client.on("session", accept => {
    accept().on("exec", (acceptExec, reject, info) => {
      if (info.command !== "ravi --version") return reject();
      commands++; const stream = acceptExec(); stream.write("ravi 3.261021.9\n"); stream.exit(0); stream.end();
    });
  }));
});
let fixture: Installation;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fixture = { id: "00000000-0000-4000-8000-000000000001", label: "Local protocol fixture", hostname: "127.0.0.1",
    port: (server.address() as AddressInfo).port, username: "ravi-fleet", hostFingerprint: fingerprint,
    credentialId: "00000000-0000-4000-8000-000000000002", revision: 1, status: "draft", testedAt: null,
    testedCredentialRevision: null, cliVersion: null, failureCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

test("real SSH transport pins host before any authentication", async () => {
  const before = authentications;
  expect(await sshVersionProbe({ ...fixture, hostFingerprint: `SHA256:${"a".repeat(43)}` }, userKey, "127.0.0.1"))
    .toEqual({ ok: false, code: "host_key_mismatch" });
  expect(authentications).toBe(before); expect(commands).toBe(0);
});
test("real SSH transport authenticates dedicated key and executes only version probe", async () => {
  expect(await sshVersionProbe(fixture, userKey, "127.0.0.1")).toEqual({ ok: true, cliVersion: "3.261021.9" });
  expect(commands).toBe(1);
});
test("real SSH transport wrong user refused without command execution", async () => {
  expect((await sshVersionProbe({ ...fixture, username: "not-authorized" }, userKey, "127.0.0.1")).ok).toBe(false);
  expect(commands).toBe(1);
});
test("public probe entrypoint still rejects the loopback fixture before transport", async () => {
  const before = authentications;
  expect(await probeInstallation(fixture, userKey)).toEqual({ ok: false, code: "target_not_allowed" });
  expect(authentications).toBe(before);
});
