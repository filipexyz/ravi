import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
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
import { ContractError } from "../agent-contract.js";
import { decodeListCursor, encodeListCursor } from "../listing.js";
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

let output: Mock<typeof console.log>;
let errors: Mock<typeof console.error>;
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

describe("credential destination list pagination", () => {
  function destinations(count: number): Destination[] {
    return Array.from({ length: count }, (_, index) => ({
      ...record,
      id: `destination-${String(index).padStart(3, "0")}`,
      label: `Destination ${index}`,
    }));
  }

  function usageError(run: () => unknown): ContractError {
    let failure: unknown;
    try {
      run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ exitCode: 2, op: "credentials destinations list" });
    return failure as ContractError;
  }

  it("defaults to thirty ID-ordered items and exposes safe continuation metadata", () => {
    const f = fixture();
    const all = destinations(35);
    f.deps.list = () => [...all].reverse();
    const page = f.command.list(true);
    expect(page.total).toBe(30);
    expect(page.items.map((item) => item.id)).toEqual(all.slice(0, 30).map((item) => item.id));
    expect(page.page).toMatchObject({ limit: 30, count: 30, hasMore: true, sort: "id", order: "asc" });
    expect(page.filters).toEqual({});
    expect(page.page.nextCommand).toContain("ravi credentials destinations list --json --limit 30 --cursor ");
    expect(decodeListCursor(page.page.nextCursor ?? undefined)).toEqual({
      sort: "id",
      order: "asc",
      value: 0,
      id: all[29]!.id,
      filters: "credentials.destinations:list:v1",
    });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("identityFile");
    expect(serialized).not.toContain(record.identityFile);
    expect(serialized).not.toContain(hostBlob);
    const command = buildRegistry([CredentialDestinationsCommands]).commands.find((item) => item.command === "list")!;
    expect(command.returns!.parse(page)).toEqual(page);
    expect(command.options.map((option) => option.name)).toContain("limit");
    expect(command.options.map((option) => option.name)).toContain("cursor");
    expect(command.cliOnly).toBe(true);
  });

  it("walks multiple pages without duplicates and ends without a continuation", () => {
    const f = fixture();
    const all = destinations(5);
    f.deps.list = () => [all[3]!, all[0]!, all[4]!, all[2]!, all[1]!];
    const first = f.command.list(true, "2");
    const second = f.command.list(true, "2", first.page.nextCursor ?? undefined);
    const third = f.command.list(true, "2", second.page.nextCursor ?? undefined);
    expect([first.total, second.total, third.total]).toEqual([2, 2, 1]);
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(ids).toEqual(all.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(third.page).toMatchObject({ count: 1, hasMore: false, nextCursor: null, nextCommand: null });
  });

  it("continues by last ID when earlier rows are added or the cursor row disappears", () => {
    const f = fixture();
    const all = destinations(5);
    f.deps.list = () => [...all];
    const first = f.command.list(true, "2");
    f.deps.list = () => [{ ...record, id: "aaa-added-before-cursor" }, all[4]!, all[0]!, all[3]!, all[2]!];
    const second = f.command.list(true, "3", first.page.nextCursor ?? undefined);
    expect(second.items.map((item) => item.id)).toEqual(all.slice(2).map((item) => item.id));
    expect(second.page.hasMore).toBe(false);
  });

  it("supports the bounded maximum and reports an empty final page consistently", () => {
    const f = fixture();
    f.deps.list = () => destinations(501);
    const page = f.command.list(true, "500");
    expect(page.items).toHaveLength(500);
    expect(page.page).toMatchObject({ limit: 500, count: 500, hasMore: true });
    f.deps.list = () => [];
    expect(f.command.list(true, "500", page.page.nextCursor ?? undefined)).toEqual({
      total: 0,
      items: [],
      page: { limit: 500, count: 0, hasMore: false, nextCursor: null, nextCommand: null, sort: "id", order: "asc" },
      filters: {},
    });
  });

  it("rejects invalid limits before reading the registry without echoing input", () => {
    const f = fixture();
    let reads = 0;
    f.deps.list = () => {
      reads++;
      return [record];
    };
    for (const limit of ["0", "-1", "1.5", "1x", "1e2", "501", "Infinity", "DO_NOT_ECHO_LIMIT_INPUT"]) {
      const failure = usageError(() => f.command.list(true, limit));
      expect(failure.code).toBe("DESTINATION_LIST_LIMIT_INVALID");
      expect(JSON.stringify(failure.envelope())).not.toContain("DO_NOT_ECHO_LIMIT_INPUT");
    }
    expect(reads).toBe(0);
  });

  it("rejects malformed or foreign cursors before reading the registry without echoing private data", () => {
    const f = fixture();
    let reads = 0;
    f.deps.list = () => {
      reads++;
      return [record];
    };
    const valid = {
      sort: "id",
      order: "asc" as const,
      value: 0,
      id: "api-prod",
      filters: "credentials.destinations:list:v1",
    };
    const invalid = [
      "not-a-json-cursor",
      "!DO_NOT_ECHO_CURSOR_INPUT!",
      "a".repeat(513),
      encodeListCursor({ ...valid, sort: "updated" }),
      encodeListCursor({ ...valid, order: "desc" }),
      encodeListCursor({ ...valid, value: 1 }),
      encodeListCursor({ ...valid, id: "API-PROD" }),
      encodeListCursor({ ...valid, filters: "other-command" }),
      encodeListCursor({ sort: "id", order: "asc", value: 0, id: "api-prod" }),
      Buffer.from(JSON.stringify({ ...valid, identityFile: "DO_NOT_ECHO_CURSOR_INPUT" })).toString("base64url"),
    ];
    for (const cursor of invalid) {
      const failure = usageError(() => f.command.list(true, "2", cursor));
      expect(failure.code).toBe("DESTINATION_LIST_CURSOR_INVALID");
      expect(JSON.stringify(failure.envelope())).not.toContain("DO_NOT_ECHO_CURSOR_INPUT");
    }
    expect(reads).toBe(0);
  });

  it("human output identifies the order, returned count and next command without private key metadata", () => {
    const f = fixture();
    f.deps.list = () => destinations(2);
    const result = f.command.list(false, "1");
    const rendered = output.mock.calls.map((call) => String(call[0])).join("\n");
    expect(rendered).toContain("1 returned, limit 1, sort id asc");
    expect(rendered).toContain(`Next page: ${result.page.nextCommand}`);
    expect(rendered).not.toContain(record.identityFile);
    expect(rendered).not.toContain(hostBlob);
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
