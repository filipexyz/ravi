import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
  validateDestinationInput,
  type Destination,
} from "../../credentials/remote/destinations.js";
import { REMOTE_CREDENTIAL_WRITER_PYTHON } from "../../credentials/remote/writer-source.js";
import { buildRouteTable } from "../../sdk/gateway/route-table.js";
import { buildRegistry } from "../registry-snapshot.js";
import {
  CredentialDestinationsCommands,
  readDestinationSshConfig,
  type CredentialDestinationsCommandDeps,
} from "./credential-destinations.js";

const hostBlob = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]).toString("base64");
const hostKey = `ssh-ed25519 ${hostBlob}`;
const record: Destination = {
  id: "api-prod",
  version: "b3ed528a-cd6c-4a9e-b5b2-10101d7ae1b2",
  label: "API production",
  sshAlias: "prod",
  host: "api.example.test",
  port: 2222,
  user: "raviwriter",
  identityFile: "/private/dedicated-transport-key",
  hostKey,
  envPath: "/srv/api/.env",
  remoteTarget: "api",
  keys: ["PAYMENTS_API_TOKEN"],
  profile: "dotenv-single-line-v1",
};

function fixture() {
  const writes: unknown[] = [];
  const reads: string[] = [];
  const deps: CredentialDestinationsCommandDeps = {
    readConfig: (path) => {
      reads.push(path);
      return "Host prod\n  HostName api.example.test\n  Port 2222\n  User root\n  IdentityFile /personal/admin-key\n";
    },
    discover: discoverSshAliases,
    validate: validateDestinationInput,
    get: () => null,
    list: () => [record],
    register: (input) => {
      writes.push(input);
      return { ...input, version: record.version };
    },
    exportHelper: (path) => {
      writes.push(path);
    },
  };
  return { deps, writes, reads, command: new CredentialDestinationsCommands(deps) };
}

function register(command: CredentialDestinationsCommands, execute?: boolean) {
  return command.register(
    record.id,
    "prod",
    "/config",
    hostKey,
    record.identityFile,
    record.user,
    record.envPath,
    record.remoteTarget,
    record.keys.join(","),
    record.label,
    execute,
    true,
  );
}

let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
let root: string;
beforeEach(() => {
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  root = realpathSync(mkdtempSync(join(tmpdir(), "credential-destinations-cli-")));
});
afterEach(() => {
  output.mockRestore();
  errors.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("credential destination administration", () => {
  it("validates and previews without writes, importing only host and port from the alias", () => {
    const f = fixture();
    let failure: any;
    try {
      register(f.command);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(f.writes).toEqual([]);
    expect(f.reads).toEqual(["/config"]);
    const encoded = JSON.stringify(failure.envelope());
    expect(encoded).toContain("raviwriter");
    expect(encoded).toContain("api.example.test");
    expect(encoded).not.toContain("/personal/admin-key");
    expect(encoded).not.toContain(record.identityFile);
    expect(encoded).not.toContain(hostBlob);
  });

  it("refuses missing dedicated identities and root before reading config or writing", () => {
    const f = fixture();
    expect(() =>
      f.command.register(
        "api-prod",
        "prod",
        "/config",
        hostKey,
        undefined,
        record.user,
        record.envPath,
        "api",
        "TOKEN",
        "Production",
        true,
        true,
      ),
    ).toThrow();
    expect(() =>
      f.command.register(
        "api-prod",
        "prod",
        "/config",
        hostKey,
        record.identityFile,
        "root",
        record.envPath,
        "api",
        "TOKEN",
        "Production",
        true,
        true,
      ),
    ).toThrow();
    expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it("checks invalid metadata and existing IDs before the confirmation brake", () => {
    const f = fixture();
    let invalid: any;
    try {
      f.command.register(
        "api-prod",
        "prod",
        "/config",
        hostKey,
        record.identityFile,
        record.user,
        record.envPath,
        "api",
        "TOKEN,*",
        "Production",
        false,
        true,
      );
    } catch (error) {
      invalid = error;
    }
    expect(invalid.code).not.toBe("WRITE_REQUIRES_EXECUTE");
    expect(invalid.exitCode).toBe(2);
    f.deps.get = () => record;
    let duplicate: any;
    try {
      register(f.command);
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toMatchObject({ code: "DESTINATION_ALREADY_EXISTS", exitCode: 1 });
    expect(f.writes).toEqual([]);
  });

  it("registers the explicit service identity and returns only safe metadata", () => {
    const f = fixture();
    const result = register(f.command, true);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      user: record.user,
      identityFile: record.identityFile,
      host: record.host,
      port: record.port,
    });
    expect(result.destination).toMatchObject({ id: record.id, envPath: record.envPath, keys: record.keys });
    expect(result.destination.hostKeyFingerprint).toStartWith("SHA256:");
    expect(JSON.stringify(result)).not.toContain(record.identityFile);
    expect(JSON.stringify(result)).not.toContain(hostBlob);
  });

  it("list and show omit private transport coordinates", () => {
    const f = fixture();
    f.deps.get = () => record;
    for (const result of [f.command.list(true), f.command.show(record.id, true)]) {
      expect(JSON.stringify(result)).toContain(record.envPath);
      expect(JSON.stringify(result)).not.toContain("identityFile");
      expect(JSON.stringify(result)).not.toContain(record.identityFile);
    }
  });

  it("discovery and unknown failures cannot echo private config text", () => {
    const f = fixture();
    expect(f.command.discover("/config", true).aliases).toEqual([
      { alias: "prod", host: record.host, port: record.port, user: "root" },
    ]);
    f.deps.readConfig = () => {
      throw new Error("PRIVATE_CONFIG_SENTINEL");
    };
    let failure: any;
    try {
      f.command.discover("/config", true);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "DESTINATION_OPERATION_FAILED" });
    expect(JSON.stringify(failure.envelope())).not.toContain("PRIVATE_CONFIG_SENTINEL");
  });

  it("is CLI-only with access and return contracts, and has no secret input flags", () => {
    const registry = buildRegistry([CredentialDestinationsCommands]);
    expect(registry.commands).toHaveLength(5);
    for (const command of registry.commands) {
      expect(command.cliOnly).toBe(true);
      expect(command.access).toBeDefined();
      expect(command.returns).toBeDefined();
      expect(JSON.stringify(command.options)).not.toMatch(/--(?:value|secret|stdin)/);
    }
    const routes = buildRouteTable(registry);
    expect(routes.byPath.size).toBe(0);
    const command = registry.commands.find((item) => item.command === "register")!;
    expect(command.access).toMatchObject({
      requiresConfirmation: true,
      requireConcreteResource: true,
      resourceId: "id",
    });
  });
});

describe("bounded local files", () => {
  it("reads only regular bounded config files and rejects symlink files or parents", () => {
    const file = join(root, "config");
    writeFileSync(file, "Host sample\n  HostName sample.example.test\n");
    expect(readDestinationSshConfig(file)).toContain("sample.example.test");
    symlinkSync(file, join(root, "linked-config"));
    expect(() => readDestinationSshConfig(join(root, "linked-config"))).toThrow();
    const directory = join(root, "real");
    mkdirSync(directory);
    writeFileSync(join(directory, "config"), "Host sample\n");
    symlinkSync(directory, join(root, "linked-dir"));
    expect(() => readDestinationSshConfig(join(root, "linked-dir", "config"))).toThrow();
    writeFileSync(file, "x".repeat(256 * 1024 + 1));
    expect(() => readDestinationSshConfig(file)).toThrow();
  });

  it("exports the bundled helper once, without deployment or overwriting existing files", () => {
    const command = new CredentialDestinationsCommands();
    const file = join(root, "writer");
    expect(command.exportHelper(file, true)).toEqual({ exported: true, path: file, installed: false });
    expect(readFileSync(file, "utf8")).toBe(REMOTE_CREDENTIAL_WRITER_PYTHON);
    expect(statSync(file).mode & 0o777).toBe(0o700);
    writeFileSync(file, "operator-owned-content");
    expect(() => command.exportHelper(file, true)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("operator-owned-content");
    const link = join(root, "symlink");
    symlinkSync(file, link);
    expect(() => command.exportHelper(link, true)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("operator-owned-content");
  });
});
