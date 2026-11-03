import { afterAll, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, stat, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareConsoleInstallation } from "./prepare-installation";
const root = await mkdtemp(join(tmpdir(), "ravi-console-installer-"));
const secret = join(root, "client-secret");
await writeFile(secret, "synthetic-client-secret", {mode:0o600});
const input = { directory: join(root,"new-console"), image:`ravi/console@sha256:${"a".repeat(64)}`,
  consoleOrigin:"https://console.example.invalid", transportOrigin:"https://fleet.example.invalid:7443",
  oidcIssuer:"https://idp.example.invalid/realms/console", oidcClientId:"test-client", oidcSecretFile:secret,
  ownerEmail:"owner@example.invalid", organizationName:"Synthetic Console",slug:"synthetic" };
afterAll(async()=> {await rm(root,{recursive:true,force:true});});
test("new control plane has isolated credentials, no runtime or host privileges", async()=> {
  const result = await prepareConsoleInstallation(input);
  expect(result.consoleOrigin).toBe(input.consoleOrigin);
  const compose = JSON.parse(await readFile(join(input.directory,"compose.json"),"utf8"));
  expect(Object.keys(compose.services).sort()).toEqual(["console","postgres","transport"]);
  expect(compose.services.console.cap_drop).toEqual(["ALL"]);
  expect(compose.services.console.ports).toEqual(["127.0.0.1:3000:3000"]);
  expect(compose.services.transport.command).toEqual(["node",".fleet-dist/transport.mjs"]);
  expect(JSON.stringify(compose)).not.toContain("docker.sock");
  expect(JSON.stringify(compose)).not.toContain("synthetic-client-secret");
  expect((await stat(join(input.directory,"compose.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(input.directory,"authority/ca-key.pem"))).mode & 0o777).toBe(0o600);
  await expect(prepareConsoleInstallation(input)).rejects.toMatchObject({code:"EEXIST"});
});
test("rejects unsafe credentials and image references before creating an installation", async()=> {
  await expect(prepareConsoleInstallation({...input,directory:join(root,"unsafe"),image:"ravi/console:latest"})).rejects.toBeDefined();
  await chmod(secret,0o644);
  await expect(prepareConsoleInstallation({...input,directory:join(root,"unsafe")})).rejects.toThrow("private regular file");
});
