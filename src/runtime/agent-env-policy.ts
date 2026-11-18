/**
 * Environment policy for agent runtime processes.
 *
 * The daemon's own env carries every secret the operator put in
 * `~/.ravi/.env`: provider keys, the admin token, webhook secrets and
 * third-party API keys. Provider runtimes (Claude Code, Codex, Pi, Grok) spawn
 * the agent's shell, and every command the agent runs inherits the provider
 * process env.
 *
 * A PreToolUse `unset` prefix cannot close this. Hooks that rewrite a Bash
 * command do not compose (each receives the original input and the last
 * `updatedInput` wins; the job wrapper rewrites every command), and even a
 * working `unset` leaves the provider's own env readable from the shell with
 * `ps -E` or `/proc/<pid>/environ`. The boundary is the spawn: a provider
 * process receives only base-env names that pass this allowlist, plus what the
 * request adds on purpose (the Ravi turn env, the selected credential and the
 * provider's own login variables).
 */

import { CLAUDE_INHERITED_AUTH_ENV_KEYS } from "./credential-secret-shape.js";

/** Daemon env names an agent runtime may inherit as-is. */
const ALLOWED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "HOSTNAME",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "SSH_AUTH_SOCK",
  "__CF_USER_TEXT_ENCODING",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "JAVA_HOME",
  "GOPATH",
  "GOROOT",
  "GOBIN",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "VIRTUAL_ENV",
  "PKG_CONFIG_PATH",
  "CPATH",
  "CPLUS_INCLUDE_PATH",
  "LIBRARY_PATH",
  "NATS_URL",
  "NATS_PORT",
  "PM2_HOME",
  "MANPATH",
  "INFOPATH",
]);

/**
 * Prefixes for runtime and toolchain configuration shared by every provider. A
 * name under one of these prefixes still has to pass the secret-name check
 * below, so `RAVI_ADMIN_TOKEN` or `GH_TOKEN` never pass through a prefix.
 */
const ALLOWED_ENV_PREFIXES = [
  "LC_",
  "XDG_",
  "RAVI_",
  "OMNI_",
  "BUN_",
  "NODE_",
  "GH_",
  "GIT_",
  "HOMEBREW_",
  "NVM_",
  "PNPM_",
  "PYENV_",
  "COREPACK_",
];

/**
 * Provider configuration prefixes. A name under one of them reaches only the
 * provider that owns it, also when the operator lists it in the passthrough:
 * `ANTHROPIC_*` never reaches Codex, Pi or Grok.
 */
const PROVIDER_ENV_PREFIXES: Record<string, readonly string[]> = {
  claude: ["CLAUDE_", "ANTHROPIC_"],
  codex: ["CODEX_"],
  pi: ["PI_"],
  grok: ["GROK_"],
};

/**
 * Git's env config injection (`GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_<n>` and
 * `GIT_CONFIG_VALUE_<n>`). Values can carry credentials (for example an
 * `http.extraHeader` with a token), and git refuses to run when the trio is
 * incomplete, so the family is passed or dropped as a whole: dropped by
 * default, passed only when the passthrough names one of its members.
 */
const GIT_CONFIG_ENV_FAMILY = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

/**
 * Names that look like they hold a secret. Applied to every inherited name,
 * including allowlisted prefixes. `TOKENS` is excluded on purpose so limits such
 * as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` keep working.
 */
const SECRET_ENV_NAME_PATTERNS = [
  /TOKEN(?!S)/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /PASSPHRASE/i,
  /CREDENTIAL/i,
  /PRIVATE/i,
  /COOKIE/i,
  /APIKEY/i,
  /(^|_)PASS($|_)/i,
  /(^|_)AUTH($|_)/i,
  /(^|_)(API_)?KEYS?($|_)/i,
  /(^|_)DSN($|_)/i,
  /CONNECTION_STRING/i,
  /(^|_)(DATABASE|DB|POSTGRES|POSTGRESQL|PG|MYSQL|REDIS|MONGO|MONGODB|AMQP|RABBITMQ)_(URL|URI)$/i,
  /^DATABASE_URL$/i,
  // Extra request headers (`ANTHROPIC_CUSTOM_HEADERS`, `OTEL_EXPORTER_OTLP_HEADERS`) usually carry auth.
  /HEADERS?($|_)/i,
  // `git -c` config travels in this variable and can carry credentials.
  /^GIT_CONFIG_PARAMETERS$/,
];

/**
 * Operator escape hatch: names listed here (comma or whitespace separated) are
 * passed to every agent runtime even if they look like secrets. It is read from
 * the daemon env, so only the operator can set it (`~/.ravi/.env`).
 */
export const AGENT_ENV_PASSTHROUGH_VAR = "RAVI_AGENT_ENV_PASSTHROUGH";

export function isSecretShapedEnvName(name: string): boolean {
  return SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** Provider that owns a provider-scoped name, or undefined for a shared name. */
function providerOwningEnvName(name: string): string | undefined {
  for (const [providerId, prefixes] of Object.entries(PROVIDER_ENV_PREFIXES)) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) return providerId;
  }
  return undefined;
}

function isInProviderScope(name: string, runtimeProviderId: string | undefined): boolean {
  const owner = providerOwningEnvName(name);
  return owner === undefined || owner === runtimeProviderId;
}

/**
 * Exact names are checked first: none of them holds a secret, and the
 * secret-name check would otherwise drop `SSH_AUTH_SOCK` (a socket path that
 * git needs for SSH remotes). Provider-scoped prefixes only pass for their own
 * provider; with no provider given, they never pass.
 */
export function isAgentRuntimeEnvNameAllowed(name: string, runtimeProviderId?: string): boolean {
  if (ALLOWED_ENV_NAMES.has(name)) return true;
  if (GIT_CONFIG_ENV_FAMILY.test(name)) return false;
  if (isSecretShapedEnvName(name)) return false;
  if (ALLOWED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  const owner = providerOwningEnvName(name);
  return owner !== undefined && owner === runtimeProviderId;
}

/**
 * A URL with userinfo anywhere in the value (`scheme://<anything>@host`). That
 * covers `user:pass@`, an empty user with a password (`:pass@`) and a token used
 * as the user name (`token@`): any of them can be a credential.
 */
const URL_WITH_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@/i;

export function isSecretShapedEnvValue(value: string): boolean {
  return URL_WITH_USERINFO.test(value);
}

export function parseAgentEnvPassthrough(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

export interface AgentRuntimeBaseEnvOptions {
  /**
   * Provider being started (`claude`, `codex`, `pi`, `grok`). It selects the
   * provider-scoped config names and the login variables (for example
   * `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code) that only this provider may
   * inherit from the daemon env. Without it, no provider-scoped name passes.
   */
  runtimeProviderId?: string;
}

/**
 * Filters the daemon env down to what an agent runtime may inherit.
 *
 * Returns only names that pass the allowlist (and whose value carries no URL
 * userinfo), the operator passthrough list, and the provider's own login
 * variables. Everything else, including every other provider's keys and
 * config, the admin token and third-party API keys, is dropped.
 */
export function filterAgentRuntimeBaseEnv(
  baseEnv: Record<string, string | undefined>,
  options: AgentRuntimeBaseEnvOptions = {},
): Record<string, string> {
  const { runtimeProviderId } = options;
  const explicit = new Set(
    [
      ...parseAgentEnvPassthrough(baseEnv[AGENT_ENV_PASSTHROUGH_VAR]),
      ...resolveProviderLoginEnvKeys(runtimeProviderId),
    ].filter((name) => isInProviderScope(name, runtimeProviderId)),
  );
  const passGitConfigFamily = [...explicit].some((name) => GIT_CONFIG_ENV_FAMILY.test(name));
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    if (GIT_CONFIG_ENV_FAMILY.test(name)) {
      if (passGitConfigFamily) filtered[name] = value;
      continue;
    }
    if (explicit.has(name)) {
      filtered[name] = value;
      continue;
    }
    if (isAgentRuntimeEnvNameAllowed(name, runtimeProviderId) && !isSecretShapedEnvValue(value)) {
      filtered[name] = value;
    }
  }
  return filtered;
}

/**
 * Login variables each provider CLI reads from its own env when no managed
 * credential is selected. Only the provider being started inherits its own
 * entry; Pi gets its login from its auth store or the model broker and inherits
 * none.
 */
const PROVIDER_LOGIN_ENV_KEYS: Record<string, readonly string[]> = {
  claude: CLAUDE_INHERITED_AUTH_ENV_KEYS,
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  grok: ["XAI_API_KEY"],
};

export function resolveProviderLoginEnvKeys(runtimeProviderId: string | undefined): readonly string[] {
  if (!runtimeProviderId) return [];
  return PROVIDER_LOGIN_ENV_KEYS[runtimeProviderId] ?? [];
}
