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
import { resolveRuntimeIntelligenceProviderModel, type RuntimeIntelligenceProxyBinding } from "./intelligence-proxy.js";

const BINDING_HEADER = "x-ravi-binding";
const LOCAL_DUMMY_KEY_HELPER = "printf ravi-local-forwarder";

export interface RuntimeIntelligenceMaterialization {
  env: Record<string, string>;
  configDir: string;
}

export function materializeRuntimeIntelligenceProxy(
  binding: RuntimeIntelligenceProxyBinding,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeIntelligenceMaterialization {
  const isolation = (binding as { providerPrincipalIsolation?: string }).providerPrincipalIsolation;
  if (!isolation || isolation === "none") {
    throw new Error("Refusing intelligence proxy materialization without an isolated provider principal.");
  }
  const root = ensurePrivateTree(getRaviStateDir(env), ["intelligence", "bindings", materializationDigest(binding)]);
  const sharedEnv = publicBindingEnv(binding);
  if (binding.runtimeProvider === "codex") {
    const configDir = ensurePrivateTree(root, ["codex"]);
    atomicPrivateWrite(join(configDir, "config.toml"), codexConfig(binding));
    return { env: { ...sharedEnv, CODEX_HOME: configDir }, configDir };
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
        ...sharedEnv,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: binding.localSigningForwarderBaseUrl,
        ANTHROPIC_CUSTOM_HEADERS: `${BINDING_HEADER}: ${binding.bindingHandle}`,
      },
      configDir,
    };
  }
  if (binding.runtimeProvider === "pi") {
    const configDir = ensurePrivateTree(root, ["pi"]);
    atomicPrivateWrite(join(configDir, "models.json"), `${JSON.stringify(piModelsConfig(binding), null, 2)}\n`);
    return {
      env: { ...sharedEnv, PI_CODING_AGENT_DIR: configDir },
      configDir,
    };
  }
  throw new Error(`Runtime provider ${binding.runtimeProvider} cannot materialize Hub proxy configuration.`);
}

function publicBindingEnv(binding: RuntimeIntelligenceProxyBinding): Record<string, string> {
  return {
    RAVI_INTELLIGENCE_BINDING_HANDLE: binding.bindingHandle,
  };
}

function codexConfig(binding: RuntimeIntelligenceProxyBinding): string {
  return [
    `model_provider = ${tomlString(binding.providerRuntimeId)}`,
    "",
    `[model_providers.${tomlKey(binding.providerRuntimeId)}]`,
    `name = ${tomlString("Ravi Hub")}`,
    `base_url = ${tomlString(binding.localSigningForwarderBaseUrl)}`,
    `wire_api = ${tomlString("responses")}`,
    "requires_openai_auth = false",
    `http_headers = { ${tomlString(BINDING_HEADER)} = ${tomlString(binding.bindingHandle)} }`,
    "",
  ].join("\n");
}

function piModelsConfig(binding: RuntimeIntelligenceProxyBinding): Record<string, unknown> {
  return {
    providers: {
      [binding.providerRuntimeId]: {
        baseUrl: binding.localSigningForwarderBaseUrl,
        api: "openai-completions",
        apiKey: "ravi-local-forwarder",
        authHeader: true,
        headers: { [BINDING_HEADER]: binding.bindingHandle },
        models: [
          {
            id: resolveRuntimeIntelligenceProviderModel(binding),
            name: resolveRuntimeIntelligenceProviderModel(binding),
          },
        ],
      },
    },
  };
}

function materializationDigest(binding: RuntimeIntelligenceProxyBinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        runtimeId: binding.runtimeId,
        connectionId: binding.connectionId,
        connectionRevision: binding.connectionRevision,
        sessionCompatibilityKey: binding.sessionCompatibilityKey,
        policyCompatibilityKey: binding.policyCompatibilityKey,
        runtimeProvider: binding.runtimeProvider,
        model: binding.model,
        forwarderIdentity: binding.bindingHandle,
        audience: binding.audience,
        protocol: binding.protocol,
        requestPath: binding.localSigningForwarderRequestPath,
        bindingHandle: binding.bindingHandle,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function ensurePrivateTree(rootPath: string, segments: string[]): string {
  const absoluteRoot = resolve(rootPath);
  if (!isAbsolute(absoluteRoot)) throw new Error("Intelligence materialization root must be absolute.");
  try {
    assertPrivateDirectory(absoluteRoot);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 });
  }
  assertPrivateDirectory(absoluteRoot);
  const canonicalRoot = realpathSync(absoluteRoot);
  if (canonicalRoot !== absoluteRoot) {
    throw new Error(`Refusing a non-canonical intelligence materialization root: ${absoluteRoot}`);
  }
  let current = canonicalRoot;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
      throw new Error("Refusing unsafe intelligence materialization path segment.");
    }
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    assertPrivateDirectory(current);
    if (realpathSync(current) !== current) {
      throw new Error(`Refusing non-canonical intelligence materialization directory: ${current}`);
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
    throw new Error(`Refusing unsafe intelligence materialization directory: ${path}`);
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
