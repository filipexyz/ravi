import { expect, test } from "bun:test";
import { oidcAddressAllowed, constrainedOidcFetch } from "../../src/server/console/fleet/oidc-network";
import { admissionGroupsAllow, ssoConfigSchema, ssoWriteSchema } from "../../src/server/console/fleet/sso-contract";
import { randomUUID } from "node:crypto";
import { pinnedOidcLookup } from "../../src/server/console/fleet/oidc-lookup";
import { node24Binary } from "./binaries";

test("OIDC network defaults deny private, metadata, local, reserved and IPv6", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "169.254.169.254", "100.100.100.200", "::1", "::ffff:127.0.0.1", "224.0.0.1", "192.0.2.1", "255.255.255.255"]) {
    expect(oidcAddressAllowed(address, true)).toBe(false);
  }
  for (const address of ["10.0.0.2", "192.168.2.2", "172.19.0.1", "100.92.130.44"]) {
    expect(oidcAddressAllowed(address, false)).toBe(false); expect(oidcAddressAllowed(address, true)).toBe(true);
  }
  expect(oidcAddressAllowed("8.8.8.8", false)).toBe(true);
});
test("OIDC transport refuses different origin and loopback before HTTP", async () => {
  const fetch = constrainedOidcFetch("https://127.0.0.1:4321", true);
  const options = { body: null, headers: {}, method: "GET", redirect: "manual" as const };
  await expect(fetch("https://evil.example.invalid", options)).rejects.toThrow("oidc_endpoint_not_allowed");
  await expect(fetch("https://127.0.0.1:4321", options)).rejects.toThrow("oidc_target_not_allowed");
});
test("pinned OIDC lookup preserves Node single-address callback contract", () => {
  let callbacks = 0;
  pinnedOidcLookup("10.42.0.8")("fixture.invalid", { all: false }, (error, address, family) => {
    callbacks++;
    expect(error).toBeNull(); expect(address).toBe("10.42.0.8"); expect(family).toBe(4);
  });
  expect(callbacks).toBe(1);
});
test("pinned OIDC lookup preserves Node all-address callback contract", () => {
  let callbacks = 0;
  pinnedOidcLookup("10.42.0.8")("fixture.invalid", { all: true }, (error, addresses, family) => {
    callbacks++;
    expect(error).toBeNull(); expect(addresses).toEqual([{ address: "10.42.0.8", family: 4 }]); expect(family).toBeUndefined();
  });
  expect(callbacks).toBe(1);
});
test("Node 24 real socket consumes pinned lookup with autoSelectFamily", async () => {
  // Test the production primitive, not a reimplementation. Loopback is used only
  // by this transport fixture; constrainedOidcFetch still refuses it above.
  const source = new URL("../../src/server/console/fleet/oidc-lookup.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { createServer, get } from "node:http";
    const { pinnedOidcLookup } = await import(process.argv[1]);
    assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
    const server = createServer((req, res) => res.end("pinned-peer"));
    let lookupCount = 0; let allRequested = false;
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const body = await new Promise((resolve, reject) => {
        const req = get("http://fixture.invalid:" + server.address().port, {
          agent: false, autoSelectFamily: true,
          lookup: (hostname, options, callback) => {
            assert.equal(hostname, "fixture.invalid");
            lookupCount++; allRequested = options.all === true;
            pinnedOidcLookup("127.0.0.1")(hostname, options, callback);
          },
        }, response => {
          assert.equal(response.socket.remoteAddress, "127.0.0.1");
          let body = ""; response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => resolve(body)); response.on("error", reject);
        });
        req.setTimeout(3000, () => req.destroy(new Error("fixture timeout")));
        req.on("error", reject);
      });
      assert.equal(body, "pinned-peer"); assert.equal(lookupCount, 1); assert.equal(allRequested, true);
      console.log(JSON.stringify({ pinnedPeer: true, lookupCount, allRequested }));
    } finally { await new Promise(resolve => server.close(resolve)); }
  `;
  const process = Bun.spawn([await node24Binary(), "--input-type=module", "-e", script, source], {
    env: { PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => process.kill(), 7000);
  try {
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ pinnedPeer: true, lookupCount: 1, allRequested: true });
  } finally { clearTimeout(timer); }
}, 10000);
test("OIDC groups restrict admission independently of policy role names; obsolete/invalid config fails closed", () => {
  expect(admissionGroupsAllow([], [])).toBe(true);
  const policy = ["employees", "contractors"];
  expect(admissionGroupsAllow(policy, ["employees"])).toBe(true);
  expect(admissionGroupsAllow(policy, ["contractors"])).toBe(true);
  expect(admissionGroupsAllow(policy, ["owner", "admin"])).toBe(false);
  expect(admissionGroupsAllow(policy, [])).toBe(false);
  expect(ssoConfigSchema.safeParse({ label:"Old", allowPrivateNetwork:false, roleGroups:{ owner:["employees"] } }).success).toBe(false);
  expect(ssoConfigSchema.safeParse({ label:"Bad", allowPrivateNetwork:false, admissionGroups:[""] }).success).toBe(false);
  expect(ssoWriteSchema.safeParse({ id: randomUUID(), operationId: randomUUID(), expectedRevision: 0, label: "Test", issuer: "http://unsafe.invalid",
    clientId: "test", credentialId: randomUUID(), allowPrivateNetwork: false, admissionGroups: policy }).success).toBe(false);
});
