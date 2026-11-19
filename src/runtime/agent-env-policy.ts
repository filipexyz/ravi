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

import { RAVI_APP_GATEWAY_ENV_KEYS } from "../apps/command.js";
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
  // Capability, not configuration: it lets the agent use the operator's SSH
  // keys (sign, push) without reading them. See the SPEC.
  "SSH_AUTH_SOCK",
  // Capability: the PM2 home lets the agent control PM2, including the daemon.
  "PM2_HOME",
  // Capability, not a secret: the operator declares the host a sandbox. Claude
  // Code refuses `--dangerously-skip-permissions` as root without it, so on a
  // host that runs Ravi as root every turn failed. Only reaches the agent when
  // the operator set it in the daemon env.
  "IS_SANDBOX",
  "MANPATH",
  "INFOPATH",
  // Ravi names are listed one by one, never by prefix: a new RAVI_* secret must
  // not reach agents just because its name does not look like one.
  "RAVI_STATE_DIR",
  "RAVI_HOME",
  ...RAVI_APP_GATEWAY_ENV_KEYS,
  "RAVI_BIN",
  "RAVI_BUNDLE",
  // Read by `bin/ravi` (stale-bundle escape hatch) and by the Claude provider.
  "RAVI_ALLOW_STALE_BUNDLE",
  "RAVI_CLAUDE_CODE_EXECUTABLE",
  "RAVI_CLI_BIN",
  "RAVI_CLI_INSTALLATION_NAME",
  "RAVI_LOG_LEVEL",
  "RAVI_CLI_LOG_LEVEL",
  // Read by the Codex provider from the request env, not from the daemon's.
  "RAVI_CODEX_TRANSPORT",
  "RAVI_CODEX_RUST_LOG",
  "RUST_LOG",
  "RAVI_EXECUTION_PLANE",
  "RAVI_HOST_CLI_GATEWAY",
  "RAVI_BASH_TRUSTED_EXECUTABLE_ROOTS",
  "RAVI_JOBS_CLI",
  "RAVI_JOBS_DETACH",
  "RAVI_JOBS_DETACH_AFTER_MS",
  "RAVI_PM2_EXECUTABLE",
  "RAVI_DAEMON_CWD",
  "RAVI_DAEMON_RESTART_DETACH_TIMEOUT_MS",
  "RAVI_DAEMON_RESTART_POLL_MS",
  "RAVI_DAEMON_RESTART_READY_TIMEOUT_MS",
  "OMNI_API_URL",
  "OMNI_API_PORT",
]);

/**
 * Prefixes for toolchain configuration shared by every provider. A name under
 * one of these prefixes still has to pass the secret-name check below, so
 * `GH_TOKEN` or `NODE_AUTH_TOKEN` never pass through a prefix. `RAVI_*` and
 * `OMNI_*` are not prefixes here: their names are listed one by one above.
 */
const ALLOWED_ENV_PREFIXES = [
  "LC_",
  "XDG_",
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
  // Personal access tokens (`GITHUB_PAT`, `COLOSSEUM_COPILOT_PAT`).
  /(^|_)PAT($|_)/i,
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
// The scheme is bounded (RFC 3986 schemes are short): an unbounded `[a-z0-9+.-]*`
// retried from every position makes a long value cost quadratic time.
const URL_WITH_USERINFO = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#@]*@/i;

/**
 * Values shaped like a credential, whatever the variable is called: provider
 * keys (`sk-...`), GitHub tokens (`ghp_...`, `github_pat_...`), Slack tokens
 * (`xoxb-...`), JWTs (`eyJ...`), PEM blocks (`-----BEGIN ...`) and AWS access
 * key ids (`AKIA...`).
 */
const TOKEN_SHAPED_VALUES = [
  /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  /(^|[^A-Za-z0-9_])(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /(^|[^A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{10,}/,
  /(^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z0-9 ]+-----/,
  /(^|[^A-Z0-9])AKIA[0-9A-Z]{16}($|[^A-Z0-9])/,
];

/**
 * Variables that hold a list of directories (`PATH`, `GOPATH`, `MANPATH`,
 * `PKG_CONFIG_PATH`, ...). A directory named like a token (`sk-...`) is not a
 * credential, and dropping the variable would drop the whole search path, so
 * the token-shape check does not apply to them.
 */
function isPathListEnvName(name: string): boolean {
  // `PATH`, `GOPATH`, `MANPATH`, `INFOPATH`, `CPATH`, `PKG_CONFIG_PATH`, `NODE_PATH`, ...
  return name.endsWith("PATH");
}

/**
 * True when the value carries a credential: a URL with userinfo, or (except
 * for directory lists) a value shaped like a token.
 */
export function isSecretShapedEnvValue(value: string, name?: string): boolean {
  if (URL_WITH_USERINFO.test(value)) return true;
  if (name !== undefined && isPathListEnvName(name)) return false;
  return TOKEN_SHAPED_VALUES.some((pattern) => pattern.test(value));
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
 * userinfo and is not shaped like a token), the operator passthrough list, and
 * the provider's own login variables. Everything else, including every other provider's keys and
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
    if (isAgentRuntimeEnvNameAllowed(name, runtimeProviderId) && !isSecretShapedEnvValue(value, name)) {
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
