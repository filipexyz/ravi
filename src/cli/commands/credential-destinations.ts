import "reflect-metadata";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { z } from "zod";
import {
  discoverSshAliases,
  getDestination,
  listDestinations,
  registerDestination,
  RemoteDestinationError,
  validateDestinationInput,
  type Destination,
} from "../../credentials/remote/destinations.js";
import { REMOTE_CREDENTIAL_WRITER_PYTHON } from "../../credentials/remote/writer-source.js";
import { errorDiagnostic } from "../../utils/error-diagnostic.js";
import { ContractError, contractDryRun, contractFail } from "../agent-contract.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const CONFIG_LIMIT_BYTES = 64 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const publicDestinationSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    label: z.string(),
    sshAlias: z.string(),
    host: z.string(),
    port: z.number().int(),
    user: z.string(),
    hostKeyFingerprint: z.string(),
    envPath: z.string(),
    remoteTarget: z.string(),
    keys: z.array(z.string()),
    profile: z.literal("dotenv-single-line-v1"),
  })
  .strict();

function publicDestination(destination: Destination) {
  const blob = destination.hostKey.split(/\s+/)[1] ?? "";
  return {
    id: destination.id,
    version: destination.version,
    label: destination.label,
    sshAlias: destination.sshAlias,
    host: destination.host,
    port: destination.port,
    user: destination.user,
    hostKeyFingerprint: `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`,
    envPath: destination.envPath,
    remoteTarget: destination.remoteTarget,
    keys: destination.keys,
    profile: destination.profile,
  };
}

class DestinationCliInputError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: 1 | 2 = 2,
  ) {
    super(code);
  }
}

function checkLocalPath(path: string, includeLeaf: boolean): void {
  if (!isAbsolute(path) || normalize(path) !== path || /[\r\n\0]/.test(path)) {
    throw new DestinationCliInputError("DESTINATION_LOCAL_PATH_INVALID");
  }
  let current = includeLeaf ? path : dirname(path);
  const root = parse(current).root;
  while (true) {
    const stat = lstatSync(current);
    if (includeLeaf && current === path && !stat.isFile()) {
      throw new DestinationCliInputError("DESTINATION_CONFIG_INVALID");
    }
    if (stat.isSymbolicLink() || (current !== path && !stat.isDirectory())) {
      throw new DestinationCliInputError("DESTINATION_LOCAL_PATH_UNSAFE");
    }
    if (current === root) break;
    current = dirname(current);
  }
}

/** Only reads the declared config file; no Include, Match exec, ssh -G or child process. */
export function readDestinationSshConfig(path: string): string {
  checkLocalPath(path, true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > CONFIG_LIMIT_BYTES) {
      throw new DestinationCliInputError("DESTINATION_CONFIG_INVALID");
    }
    const buffer = Buffer.alloc(CONFIG_LIMIT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > CONFIG_LIMIT_BYTES) throw new DestinationCliInputError("DESTINATION_CONFIG_INVALID");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function exportHelperFile(path: string): void {
  checkLocalPath(path, false);
  writeFileSync(path, REMOTE_CREDENTIAL_WRITER_PYTHON, { flag: "wx", mode: 0o700 });
}

export interface CredentialDestinationsCommandDeps {
  readConfig: typeof readDestinationSshConfig;
  discover: typeof discoverSshAliases;
  validate: typeof validateDestinationInput;
  get: typeof getDestination;
  list: typeof listDestinations;
  register: typeof registerDestination;
  exportHelper(path: string): void;
}

const defaults: CredentialDestinationsCommandDeps = {
  readConfig: readDestinationSshConfig,
  discover: discoverSshAliases,
  validate: validateDestinationInput,
  get: getDestination,
  list: listDestinations,
  register: registerDestination,
  exportHelper: exportHelperFile,
};

function render<T>(payload: T, asJson: boolean | undefined, text: string): T {
  console.log(asJson ? JSON.stringify(payload) : text);
  return payload;
}

function failDestination(op: string, error: unknown, asJson?: boolean): never {
  if (error instanceof ContractError) throw error;
  // no-cause: config and filesystem diagnostics can contain untrusted config text or private key coordinates; expose only typed codes.
  const code =
    error instanceof DestinationCliInputError || error instanceof RemoteDestinationError
      ? error.code
      : "DESTINATION_OPERATION_FAILED";
  const exitCode =
    error instanceof DestinationCliInputError
      ? error.exitCode
      : code === "DESTINATION_INVALID" || code === "SSH_CONFIG_UNSUPPORTED"
        ? 2
        : 1;
  const message = "Destination operation refused. Check the metadata, local paths and dedicated SSH identity.";
  contractFail(op, code, message, {
    asJson,
    exitCode,
    diagnostic: errorDiagnostic(code, { operation: op, code }),
  });
}

@Group({
  name: "credentials.destinations",
  description: "Administer explicit remote credential destinations",
  scope: "admin",
})
export class CredentialDestinationsCommands {
  constructor(private readonly deps: CredentialDestinationsCommandDeps = defaults) {}

  @Command({
    name: "discover",
    description: "Read literal SSH aliases as metadata without connecting or executing config",
  })
  @CommandAccess({ kind: "read", resource: "credentials.destinations", action: "discover", risk: "low" })
  @CliOnly()
  @Returns(
    z
      .object({
        aliases: z.array(
          z
            .object({ alias: z.string(), host: z.string(), user: z.string().nullable(), port: z.number().int() })
            .strict(),
        ),
      })
      .strict(),
  )
  discover(
    @Option({ flags: "--config <path>", description: "Absolute local SSH config; defaults to ~/.ssh/config" })
    config?: string,
    @Option({ flags: "--json", description: "Print discovered alias metadata" }) asJson?: boolean,
  ) {
    const op = "credentials destinations discover";
    try {
      const aliases = this.deps.discover(this.deps.readConfig(config ?? join(homedir(), ".ssh", "config")));
      return render(
        { aliases },
        asJson,
        aliases.map((alias) => `${alias.alias}: ${alias.host}:${alias.port} (discovery only)`).join("\n") ||
          "No supported literal SSH aliases found.",
      );
    } catch (error) {
      return failDestination(op, error, asJson);
    }
  }

  @Command({
    name: "register",
    description: "Register one allowlisted destination; requires a dedicated service user and SSH identity",
    helpAfter:
      "Reads host/port from a literal SSH alias. Never imports its User or IdentityFile. Host-key pinning and the dedicated identity are explicit. Registration installs no remote helper, permissions or credentials. Existing destination IDs cannot be replaced.",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "credentials.destinations",
    action: "register",
    risk: "high",
    resourceId: "id",
    requireConcreteResource: true,
    input: ["id"],
    requiresConfirmation: true,
  })
  @CliOnly()
  @Returns(z.object({ destination: publicDestinationSchema }).strict())
  register(
    @Arg("id", { description: "New destination identifier" }) id: string,
    @Option({ flags: "--ssh-alias <alias>", description: "Literal alias in the local SSH config" }) sshAlias?: string,
    @Option({ flags: "--config <path>", description: "Absolute local SSH config; defaults to ~/.ssh/config" })
    config?: string,
    @Option({
      flags: "--host-key <public-key-line>",
      description: "Pinned server public host key verified outside this connection",
    })
    hostKey?: string,
    @Option({
      flags: "--identity-file <path>",
      description: "Absolute path to a dedicated, restricted SSH private key; never read by this command",
    })
    identityFile?: string,
    @Option({ flags: "--user <service-user>", description: "Dedicated remote service account; root is refused" })
    user?: string,
    @Option({
      flags: "--path <absolute-env>",
      description: "Exact absolute remote env file approved by the receiver policy",
    })
    envPath?: string,
    @Option({ flags: "--remote-target <id>", description: "Target ID in the receiver policy" }) remoteTarget?: string,
    @Option({ flags: "--keys <csv>", description: "Explicit comma-separated allowlist of credential variable names" })
    keys?: string,
    @Option({ flags: "--label <text>", description: "Human-readable environment label" }) label?: string,
    @Option({ flags: "--execute", description: "Register the authority boundary; otherwise dry-run (exit 3)" })
    execute?: boolean,
    @Option({ flags: "--json", description: "Print safe destination metadata or the dry-run plan" }) asJson?: boolean,
  ) {
    const op = "credentials destinations register";
    try {
      if (
        !sshAlias ||
        !hostKey ||
        !identityFile ||
        !user ||
        user === "root" ||
        !envPath ||
        !remoteTarget ||
        !keys ||
        !label?.trim()
      ) {
        throw new DestinationCliInputError("DESTINATION_METADATA_REQUIRED");
      }
      const candidate = this.deps
        .discover(this.deps.readConfig(config ?? join(homedir(), ".ssh", "config")))
        .find((item) => item.alias === sshAlias);
      if (!candidate) throw new DestinationCliInputError("DESTINATION_ALIAS_NOT_FOUND", 1);
      const input = this.deps.validate({
        id,
        label: label.trim(),
        sshAlias,
        host: candidate.host,
        port: candidate.port,
        user,
        identityFile,
        hostKey,
        envPath,
        remoteTarget,
        keys: keys.split(",").map((key) => key.trim()),
        profile: "dotenv-single-line-v1",
      });
      if (this.deps.get(input.id)) throw new DestinationCliInputError("DESTINATION_ALREADY_EXISTS", 1);
      if (execute !== true) {
        const preview = publicDestination({ ...input, version: "unregistered" });
        contractDryRun(op, { destination: preview, installsRemoteHelper: false, grantsPermissions: false }, { asJson });
      }
      const destination = publicDestination(this.deps.register(input));
      return render(
        { destination },
        asJson,
        `Registered ${destination.label}: ${destination.user}@${destination.host}:${destination.port} ${destination.envPath}. Remote installation and permissions remain separate.`,
      );
    } catch (error) {
      return failDestination(op, error, asJson);
    }
  }

  @Command({ name: "list", description: "List registered destinations without SSH private-key coordinates" })
  @CommandAccess({ kind: "read", resource: "credentials.destinations", action: "list", risk: "low" })
  @CliOnly()
  @Returns(z.object({ destinations: z.array(publicDestinationSchema) }).strict())
  list(@Option({ flags: "--json", description: "Print safe destination metadata" }) asJson?: boolean) {
    const op = "credentials destinations list";
    try {
      const destinations = this.deps.list().map(publicDestination);
      return render(
        { destinations },
        asJson,
        destinations
          .map(
            (destination) =>
              `${destination.id}: ${destination.label} — ${destination.host}:${destination.port} ${destination.envPath}`,
          )
          .join("\n") || "No credential destinations registered.",
      );
    } catch (error) {
      return failDestination(op, error, asJson);
    }
  }

  @Command({ name: "show", description: "Show the exact host, env path and allowed keys of one destination" })
  @CommandAccess({
    kind: "read",
    resource: "credentials.destinations",
    action: "show",
    risk: "low",
    resourceId: "id",
    requireConcreteResource: true,
    input: ["id"],
  })
  @CliOnly()
  @Returns(z.object({ destination: publicDestinationSchema }).strict())
  show(
    @Arg("id", { description: "Destination identifier" }) id: string,
    @Option({ flags: "--json", description: "Print safe destination metadata" }) asJson?: boolean,
  ) {
    const op = "credentials destinations show";
    try {
      if (!ID_PATTERN.test(id)) throw new DestinationCliInputError("DESTINATION_ID_INVALID");
      const record = this.deps.get(id);
      if (!record) throw new DestinationCliInputError("DESTINATION_NOT_FOUND", 1);
      const destination = publicDestination(record);
      return render(
        { destination },
        asJson,
        `${destination.label}: ${destination.user}@${destination.host}:${destination.port}\nFile: ${destination.envPath}\nKeys: ${destination.keys.join(", ")}\nHost key: ${destination.hostKeyFingerprint}`,
      );
    } catch (error) {
      return failDestination(op, error, asJson);
    }
  }

  @Command({
    name: "export-helper",
    description: "Write the bundled receiver helper to a new local file; does not install it",
  })
  @CommandAccess({ kind: "mutate", resource: "credentials.destinations", action: "export-helper", risk: "medium" })
  @CliOnly()
  @Returns(z.object({ exported: z.literal(true), path: z.string(), installed: z.literal(false) }).strict())
  exportHelper(
    @Option({
      flags: "--out <path>",
      description: "New absolute local output path; overwrite and symlink paths are refused",
    })
    out?: string,
    @Option({ flags: "--json", description: "Print export metadata" }) asJson?: boolean,
  ) {
    const op = "credentials destinations export-helper";
    try {
      if (!out || !isAbsolute(out) || normalize(out) !== out || /[\r\n\0]/.test(out))
        throw new DestinationCliInputError("DESTINATION_OUTPUT_INVALID");
      this.deps.exportHelper(out);
      return render(
        { exported: true as const, path: out, installed: false as const },
        asJson,
        "Receiver helper exported locally. Review and install it through the operator's deployment process.",
      );
    } catch (error) {
      return failDestination(op, error, asJson);
    }
  }
}
