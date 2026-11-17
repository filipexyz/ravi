import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSshAliases,
  getDestination,
  listDestinations,
  registerDestination,
  validateDestinationInput,
  type DestinationInput,
} from "./destinations.js";

let root: string;
let options: { env: NodeJS.ProcessEnv };
const blob = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]);
const hostKey = `ssh-ed25519 ${blob.toString("base64")}`;
function input(): DestinationInput {
  return {
    id: "billing-prod",
    label: "Billing production",
    sshAlias: "billing",
    host: "192.0.2.10",
    port: 2222,
    user: "credential_writer",
    identityFile: join(root, "writer-key"),
    hostKey,
    envPath: "/srv/billing/.env",
    remoteTarget: "billing",
    keys: ["BILLING_TOKEN"],
    profile: "dotenv-single-line-v1",
  };
}
const registryFile = () => join(root, "state", "credential-destinations", "billing-prod.json");
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ravi-destination-test-")));
  options = { env: { RAVI_STATE_DIR: join(root, "state") } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("private registered credential destinations", () => {
  it("reads an absent registry without creating it", () => {
    expect(getDestination("billing-prod", options)).toBeNull();
    expect(listDestinations(options)).toEqual([]);
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("registers a versioned private record and rejects a second registration", () => {
    const first = registerDestination(input(), options);
    expect(first.version).toMatch(/^[a-f0-9-]{36}$/);
    expect(getDestination(first.id, options)).toEqual(first);
    expect(listDestinations(options)).toEqual([first]);
    expect(statSync(registryFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "state", "credential-destinations")).mode & 0o777).toBe(0o700);
    expect(statSync(registryFile()).nlink).toBe(1);
    expect(() => registerDestination({ ...input(), label: "replacement" }, options)).toThrow("DESTINATION_EXISTS");
    expect(getDestination(first.id, options)).toEqual(first);
    expect(readdirSync(join(root, "state", "credential-destinations"))).toEqual(["billing-prod.json"]);
  });
  it("rejects a FIFO registry record without blocking the process", () => {
    registerDestination(input(), options);
    rmSync(registryFile());
    expect(spawnSync("/usr/bin/mkfifo", ["-m", "600", registryFile()], { timeout: 1000 }).status).toBe(0);
    const code = `import {getDestination} from ${JSON.stringify(new URL("./destinations.ts", import.meta.url).href)}; try { getDestination("billing-prod", ${JSON.stringify(options)}); process.exit(2); } catch (error) { process.exit(error.code === "DESTINATION_UNAVAILABLE" ? 0 : 3); }`;
    const child = spawnSync(process.execPath, ["--no-env-file", "--eval", code], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
      encoding: "utf8",
    });
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
  });
  it("returns independent copies rather than mutable registry authority", () => {
    registerDestination(input(), options);
    const copy = getDestination("billing-prod", options)!;
    copy.keys.push("UNAUTHORIZED_TOKEN");
    expect(getDestination("billing-prod", options)!.keys).toEqual(["BILLING_TOKEN"]);
  });
  it("refuses unknown fields, dynamic coordinates, invalid keys and malformed host keys before IO", () => {
    for (const patch of [
      { secret: "TEST_ONLY_CANARY_SECRET" },
      { id: "../other" },
      { id: "Billing-Prod" },
      { user: "root" },
      { host: "-oProxyCommand=whoami" },
      { user: "root;id" },
      { port: 0 },
      { port: 65536 },
      { envPath: "/srv/../other/.env" },
      { envPath: "~/project/.env" },
      { identityFile: "/tmp/%h" },
      { keys: ["BILLING_TOKEN", "BILLING_TOKEN"] },
      { keys: ["BAD=KEY"] },
      { hostKey: "ssh-ed25519 not-base64" },
      { hostKey: `${hostKey} extra` },
      { hostKey: `ssh-ed25519 ${Buffer.alloc(51).toString("base64")}` },
      { profile: "arbitrary-shell" },
    ])
      expect(() => validateDestinationInput({ ...input(), ...patch })).toThrow("DESTINATION_INVALID");
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("refuses symlink state directories before creating anything in their target", () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(root, "state"));
    expect(() => registerDestination(input(), options)).toThrow("DESTINATION_UNAVAILABLE");
    expect(readdirSync(outside)).toEqual([]);
  });
  it("refuses symlink ancestors before creating the state directory", () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(root, "alias"));
    expect(() => registerDestination(input(), { env: { RAVI_STATE_DIR: join(root, "alias", "state") } })).toThrow(
      "DESTINATION_UNAVAILABLE",
    );
    expect(readdirSync(outside)).toEqual([]);
  });
  it("rejects loose directory permissions without changing them", () => {
    registerDestination(input(), options);
    chmodSync(join(root, "state", "credential-destinations"), 0o755);
    expect(() => listDestinations(options)).toThrow("DESTINATION_UNAVAILABLE");
    expect(statSync(join(root, "state", "credential-destinations")).mode & 0o777).toBe(0o755);
  });
  it("rejects loose, linked, inconsistent and malformed records without leaking JSON", () => {
    registerDestination(input(), options);
    chmodSync(registryFile(), 0o644);
    expect(() => getDestination("billing-prod", options)).toThrow("DESTINATION_UNAVAILABLE");
    chmodSync(registryFile(), 0o600);
    linkSync(registryFile(), join(root, "copy"));
    expect(() => getDestination("billing-prod", options)).toThrow("DESTINATION_UNAVAILABLE");
    rmSync(join(root, "copy"));
    const content = JSON.parse(readFileSync(registryFile(), "utf8"));
    writeFileSync(registryFile(), JSON.stringify({ ...content, id: "another-id" }));
    expect(() => getDestination("billing-prod", options)).toThrow("DESTINATION_UNAVAILABLE");
    writeFileSync(registryFile(), "TEST_ONLY_CANARY_SECRET_INVALID_JSON");
    try {
      getDestination("billing-prod", options);
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain("CANARY");
      expect((error as Error).cause).toBeUndefined();
    }
    rmSync(registryFile());
    symlinkSync(join(root, "copy"), registryFile());
    expect(() => getDestination("billing-prod", options)).toThrow("DESTINATION_UNAVAILABLE");
  });
});

describe("static SSH alias discovery", () => {
  it("resolves literal hosts and first-value wildcard inheritance without exposing identities", () => {
    expect(
      discoverSshAliases(
        `Host billing backup\n HostName=192.0.2.10\n User admin\n Port 2222\n IdentityFile ~/.ssh/private_key\n IdentityAgent /tmp/private-agent\n AddKeysToAgent yes\n UseKeychain yes\n ForwardAgent yes\n StrictHostKeyChecking no\nHost *\n User fallback\n Port 22\n`,
      ),
    ).toEqual([
      { alias: "backup", host: "192.0.2.10", user: "admin", port: 2222 },
      { alias: "billing", host: "192.0.2.10", user: "admin", port: 2222 },
    ]);
  });
  it("applies a preceding wildcard first and defaults no implicit privileged user", () => {
    expect(discoverSshAliases("Host *\n Port 2200\nHost billing\n Port 2222\n")).toEqual([
      { alias: "billing", host: "billing", user: null, port: 2200 },
    ]);
  });
  it("rejects all executable/indirect directives, wildcards and dynamic routing values", () => {
    for (const line of [
      "Match exec touch /tmp/marker",
      "Include anything",
      "ProxyCommand anything",
      "ProxyJump anything",
      "KnownHostsCommand anything",
      "LocalCommand anything",
      "RemoteCommand anything",
      "Host prod-*",
      "Host !prod",
      "HostName %h.example",
      "HostName $" + "{HOST}",
      "HostName $(touch /tmp/marker)",
      "User root;id",
      "ControlMaster auto",
      "SendEnv SECRET",
    ])
      expect(() => discoverSshAliases(`Host billing\n ${line}\n`)).toThrow("SSH_CONFIG_UNSUPPORTED");
  });
  it("rejects oversized and malformed text with stable errors", () => {
    for (const text of [
      "x".repeat(65537),
      "Host billing\n Port unknown",
      "Host billing\n Port 99999",
      "Host billing\n User\n",
      "Host billing\n\u0000",
    ])
      expect(() => discoverSshAliases(text)).toThrow("SSH_CONFIG_UNSUPPORTED");
  });
});
