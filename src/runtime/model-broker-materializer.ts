import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import type { RuntimeModelBrokerBinding } from "./model-broker.js";
import { resolveRuntimeModelBrokerProviderModel } from "./model-broker.js";

const LOCAL_DUMMY_KEY_HELPER = "printf ravi-local-forwarder";

export interface RuntimeModelBrokerMaterialization {
  env: Record<string, string>;
  configDir: string;
}

export function materializeRuntimeModelBroker(
  binding: RuntimeModelBrokerBinding,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeModelBrokerMaterialization {
  if (!("uid,cgroup,one-shot-capability".split(",") as string[]).includes(binding.principalIsolation)) {
    throw new Error("Refusing model-broker materialization without an isolated provider principal.");
  }
  const root = ensurePrivateTree(getRaviStateDir(env), ["model-broker", "bindings", materializationDigest(binding)]);
  if (binding.runtimeProvider === "codex") {
    const configDir = ensurePrivateTree(root, ["codex"]);
    atomicPrivateWrite(join(configDir, "config.toml"), codexConfig(binding));
    return { env: { RAVI_MODEL_BROKER_ACTIVE: "1", CODEX_HOME: configDir }, configDir };
  }
  if (binding.runtimeProvider === "claude") {
    const configDir = ensurePrivateTree(root, ["claude"]);
    atomicPrivateWrite(
      join(configDir, "settings.json"),
      `${JSON.stringify(
        {
          apiKeyHelper: LOCAL_DUMMY_KEY_HELPER,
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            network: {
              allowedDomains: [],
              deniedDomains: ["*"],
              allowManagedDomainsOnly: true,
              allowUnixSockets: [],
              allowAllUnixSockets: false,
              allowLocalBinding: false,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    return {
      env: {
        RAVI_MODEL_BROKER_ACTIVE: "1",
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: providerBaseUrl(binding),
        ANTHROPIC_CUSTOM_HEADERS: headerLines(binding),
      },
      configDir,
    };
  }
  if (binding.runtimeProvider === "pi") {
    const configDir = ensurePrivateTree(root, ["pi"]);
    atomicPrivateWrite(join(configDir, "models.json"), `${JSON.stringify(piModelsConfig(binding), null, 2)}\n`);
    return { env: { RAVI_MODEL_BROKER_ACTIVE: "1", PI_CODING_AGENT_DIR: configDir }, configDir };
  }
  throw new Error(`Runtime provider ${binding.runtimeProvider} cannot materialize model-broker configuration.`);
}

function codexConfig(binding: RuntimeModelBrokerBinding): string {
  const providerId = resolveRuntimeModelBrokerLocalProviderId(binding);
  const headerEntries = Object.entries(binding.transport.publicHeaders)
    .map(([name, value]) => `${tomlString(name)} = ${tomlString(value)}`)
    .join(", ");
  return [
    `model_provider = ${tomlString(providerId)}`,
    "",
    `[model_providers.${tomlKey(providerId)}]`,
    `name = ${tomlString(`Model broker ${binding.brokerId}`)}`,
    `base_url = ${tomlString(providerBaseUrl(binding))}`,
    `wire_api = ${tomlString("responses")}`,
    "requires_openai_auth = false",
    `http_headers = { ${headerEntries} }`,
    "",
  ].join("\n");
}

function piModelsConfig(binding: RuntimeModelBrokerBinding): Record<string, unknown> {
  const providerId = resolveRuntimeModelBrokerLocalProviderId(binding);
  const model = resolveRuntimeModelBrokerProviderModel(binding);
  return {
    providers: {
      [providerId]: {
        baseUrl: providerBaseUrl(binding),
        api: "openai-completions",
        apiKey: "ravi-local-forwarder",
        authHeader: true,
        headers: binding.transport.publicHeaders,
        models: [{ id: model, name: model }],
      },
    },
  };
}

function providerBaseUrl(binding: RuntimeModelBrokerBinding): string {
  const suffix =
    binding.transport.protocol === "openai-responses"
      ? "/responses"
      : binding.transport.protocol === "openai-completions"
        ? "/chat/completions"
        : "/v1/messages";
  if (!binding.transport.path.endsWith(suffix)) {
    throw new Error(`Model-broker path ${binding.transport.path} does not match ${binding.transport.protocol}.`);
  }
  const basePath = binding.transport.path.slice(0, -suffix.length);
  return `${binding.transport.origin}${basePath}`;
}

function headerLines(binding: RuntimeModelBrokerBinding): string {
  return Object.entries(binding.transport.publicHeaders)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

export function resolveRuntimeModelBrokerLocalProviderId(binding: RuntimeModelBrokerBinding): string {
  return `ravi-broker-${createHash("sha256")
    .update(`${binding.brokerId}\u0000${binding.profileRef}\u0000${binding.routeRevision}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function materializationDigest(binding: RuntimeModelBrokerBinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        brokerId: binding.brokerId,
        profileRef: binding.profileRef,
        runtimeId: binding.runtimeId,
        routeRevision: binding.routeRevision,
        compatibilityRevision: binding.compatibilityRevision,
        selectionCompatibilityKey: binding.selectionCompatibilityKey,
        runtimeProvider: binding.runtimeProvider,
        model: binding.model,
        transport: binding.transport,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function ensurePrivateTree(rootPath: string, segments: string[]): string {
  const absoluteRoot = resolve(rootPath);
  if (!isAbsolute(absoluteRoot)) throw new Error("Model-broker materialization root must be absolute.");
  try {
    assertPrivateDirectory(absoluteRoot);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 });
  }
  assertPrivateDirectory(absoluteRoot);
  const canonicalRoot = realpathSync(absoluteRoot);
  if (canonicalRoot !== absoluteRoot) throw new Error(`Refusing a non-canonical model-broker root: ${absoluteRoot}`);
  let current = canonicalRoot;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
      throw new Error("Refusing unsafe model-broker materialization path segment.");
    }
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    assertPrivateDirectory(current);
    if (realpathSync(current) !== current) {
      throw new Error(`Refusing non-canonical model-broker materialization directory: ${current}`);
    }
  }
  return current;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function assertPrivateDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing unsafe model-broker materialization directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function atomicPrivateWrite(path: string, contents: string): void {
  assertPrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may not have been created or may already have been renamed.
    }
    throw error;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return JSON.stringify(value);
}
