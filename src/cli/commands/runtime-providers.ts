import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { ContractError, CONTRACT_EXIT_USAGE, contractFail } from "../agent-contract.js";
import { readNonInteractiveSecret } from "../secret-input.js";
import { completeProviderLogin, configureClaudeOAuth } from "../../runtime/provider-auth-setup.js";
import {
  type DeviceLoginDeps,
  type DeviceLoginProvider,
  ProviderDeviceLoginError,
  cancelDeviceLogin,
  publicDeviceLogin,
  refreshDeviceLogin,
  requireDeviceLogin,
  startDeviceLogin,
} from "../../runtime/provider-device-login.js";
import { RaviEnvFileError } from "../../runtime/ravi-env-file.js";
import {
  runtimeProviderConfigureReturnSchema,
  runtimeProviderLoginCompleteReturnSchema,
  runtimeProviderLoginReturnSchema,
} from "./operational-return-schemas.js";

export type RuntimeProviderCommandDeps = DeviceLoginDeps & {
  readSecret?: typeof readNonInteractiveSecret;
};

const CLAUDE_CONFIGURE_HELP = `
USE
  Store a Claude Code OAuth token on a closed box and attach it as a
  runtime credential (claude-oauth → CLAUDE_CODE_OAUTH_TOKEN, agents main).
  Gateway-ready: no TTY.

DO NOT USE
  Do not use ravi setup or ravi login. Those are the interactive wizard and
  Ravi Console, not model-provider auth.

REGRAS HARD
  • Token is read from --stdin (CLI) or the redacted token body field (gateway).
  • The token is never echoed, logged, or returned.
  • Env write uses runtime.env.set (allowlist + mode 0600).

EXAMPLES
  printf '%s' "$TOKEN" | ravi runtime providers claude configure --stdin --json
  POST /api/v1/runtime/providers/claude/configure
    { "token":"...", "json":true, "setProvider":true, "agents":"main" }

ON ERROR
  USAGE_ERROR → provide --stdin or token, not both
  ENV_KEY_NOT_ALLOWED → should not happen for CLAUDE_CODE_OAUTH_TOKEN

FONTES
  src/cli/commands/runtime-providers.ts
  src/runtime/provider-auth-setup.ts
`;

const LOGIN_START_HELP = `
USE
  Start a headless device-code login. Returns verificationUrl + userCode for
  the Hub UI. The provider CLI keeps polling until the human authorizes.

DO NOT USE
  Do not run interactive 'codex login' / 'grok login' when a browser cannot
  open on the box.

EXAMPLES
  ravi runtime providers codex login start --json
  ravi runtime providers grok login start --json
  POST /api/v1/runtime/providers/codex/login/start  { "json":true }

ON ERROR
  LOGIN_PROMPT_TIMEOUT → CLI missing or does not support --device-auth
  LOGIN_NOT_FOUND → start first

FONTES
  src/runtime/provider-device-login.ts
`;

const LOGIN_STATUS_HELP = `
USE
  Poll a device login after the human enters the user code.

EXAMPLES
  ravi runtime providers codex login status plogin_abc --json
  POST /api/v1/runtime/providers/codex/login/status  { "id":"plogin_abc", "json":true }

ON ERROR
  LOGIN_NOT_FOUND → start a new login

FONTES
  src/runtime/provider-device-login.ts
`;

const LOGIN_COMPLETE_HELP = `
USE
  After status is authorized, import the provider-native profile into
  runtime.credentials (Codex: --from-codex-home; Grok: --auth-profile).

EXAMPLES
  ravi runtime providers codex login complete plogin_abc --json
  POST /api/v1/runtime/providers/codex/login/complete  { "id":"plogin_abc", "json":true }

ON ERROR
  LOGIN_NOT_READY → wait; retryable
  LOGIN_FAILED / LOGIN_CANCELLED → start again

FONTES
  src/runtime/provider-auth-setup.ts
`;

const LOGIN_CANCEL_HELP = `
USE
  Abort a pending device login and kill its helper process.

EXAMPLES
  ravi runtime providers grok login cancel plogin_abc --json
  POST /api/v1/runtime/providers/grok/login/cancel  { "id":"plogin_abc", "json":true }

FONTES
  src/runtime/provider-device-login.ts
`;

function printPayload(payload: unknown, asJson: boolean, human: () => void): void {
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else human();
}

function splitAgents(value: string | undefined): string[] {
  return (value ?? "main")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function failProvider(op: string, err: unknown, asJson?: boolean): never {
  if (err instanceof ContractError) throw err;
  if (err instanceof ProviderDeviceLoginError) {
    contractFail(op, err.code, err.message, {
      asJson,
      details: {
        retryable: err.retryable,
        suggestedAction:
          err.code === "LOGIN_NOT_READY"
            ? "Complete the device code in the browser, then retry status or complete"
            : err.code === "LOGIN_NOT_FOUND"
              ? "Run login start and use the returned login id"
              : "Start a new device login",
      },
    });
  }
  if (err instanceof RaviEnvFileError) {
    contractFail(op, err.code, err.message, {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: { suggestedAction: "Inspect the env allowlist and retry" },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/agent not found/i.test(message)) {
    contractFail(op, "AGENT_NOT_FOUND", message, {
      asJson,
      details: { suggestedAction: "Create the agent first, or pass --agents with an existing id" },
    });
  }
  contractFail(op, "USAGE_ERROR", message, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: { suggestedAction: "Inspect the command input and retry" },
  });
}

function printLoginHuman(login: {
  id: string;
  status: string;
  verificationUrl: string | null;
  userCode: string | null;
}): void {
  console.log(`${login.id}  status=${login.status}`);
  if (login.verificationUrl) console.log(`  url=${login.verificationUrl}`);
  if (login.userCode) console.log(`  code=${login.userCode}`);
}

async function runLoginStart(provider: DeviceLoginProvider, asJson: boolean, deps: RuntimeProviderCommandDeps) {
  try {
    const login = publicDeviceLogin(await startDeviceLogin(provider, deps));
    const payload = { login };
    printPayload(payload, asJson, () => printLoginHuman(login));
    return payload;
  } catch (err) {
    failProvider(`runtime providers ${provider} login start`, err, asJson);
  }
}

function runLoginStatus(
  provider: DeviceLoginProvider,
  id: string | undefined,
  asJson: boolean,
  deps: RuntimeProviderCommandDeps,
) {
  try {
    if (!id?.trim()) {
      contractFail(`runtime providers ${provider} login status`, "USAGE_ERROR", "Login id is required.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: "Pass the id returned by login start" },
      });
    }
    const session = requireDeviceLogin(id, deps.env ?? process.env);
    if (session.provider !== provider) {
      contractFail(`runtime providers ${provider} login status`, "LOGIN_NOT_FOUND", `Provider login not found: ${id}`, {
        asJson,
        details: { suggestedAction: `Use ravi runtime providers ${session.provider} login status ${id}` },
      });
    }
    const login = publicDeviceLogin(refreshDeviceLogin(id, deps));
    const payload = { login };
    printPayload(payload, asJson, () => printLoginHuman(login));
    return payload;
  } catch (err) {
    failProvider(`runtime providers ${provider} login status`, err, asJson);
  }
}

function runLoginComplete(
  provider: DeviceLoginProvider,
  id: string | undefined,
  agents: string | undefined,
  setProvider: boolean,
  label: string | undefined,
  asJson: boolean,
  deps: RuntimeProviderCommandDeps,
) {
  try {
    if (!id?.trim()) {
      contractFail(`runtime providers ${provider} login complete`, "USAGE_ERROR", "Login id is required.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: "Pass the id returned by login start" },
      });
    }
    const payload = completeProviderLogin(provider, id, { agents: splitAgents(agents), setProvider, label }, deps);
    printPayload(payload, asJson, () => {
      printLoginHuman(payload.login);
      console.log(`  credential=${payload.credential.id} created=${payload.credentialCreated}`);
    });
    return payload;
  } catch (err) {
    failProvider(`runtime providers ${provider} login complete`, err, asJson);
  }
}

function runLoginCancel(
  provider: DeviceLoginProvider,
  id: string | undefined,
  asJson: boolean,
  deps: RuntimeProviderCommandDeps,
) {
  try {
    if (!id?.trim()) {
      contractFail(`runtime providers ${provider} login cancel`, "USAGE_ERROR", "Login id is required.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: "Pass the id returned by login start" },
      });
    }
    const session = requireDeviceLogin(id, deps.env ?? process.env);
    if (session.provider !== provider) {
      contractFail(`runtime providers ${provider} login cancel`, "LOGIN_NOT_FOUND", `Provider login not found: ${id}`, {
        asJson,
      });
    }
    const login = publicDeviceLogin(cancelDeviceLogin(id, deps));
    const payload = { login };
    printPayload(payload, asJson, () => printLoginHuman(login));
    return payload;
  } catch (err) {
    failProvider(`runtime providers ${provider} login cancel`, err, asJson);
  }
}

@Group({
  name: "runtime.providers.claude",
  description: "Configure Claude Code OAuth on a closed Ravi box",
  scope: "admin",
})
export class RuntimeProvidersClaudeCommands {
  constructor(private readonly deps: RuntimeProviderCommandDeps = {}) {}

  @Command({
    name: "configure",
    description: "Set CLAUDE_CODE_OAUTH_TOKEN and attach a claude-oauth runtime credential",
    helpAfter: CLAUDE_CONFIGURE_HELP,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.providers.claude",
    action: "configure",
    risk: "high",
    redactions: ["token"],
  })
  @Returns(runtimeProviderConfigureReturnSchema)
  async configure(
    @Option({ flags: "--token <token>", description: "OAuth token for gateway/JSON callers; redacted from audit" })
    token?: string,
    @Option({ flags: "--stdin", description: "Read the token from redirected stdin (CLI; no TTY)" })
    fromStdin?: boolean,
    @Option({ flags: "--agents <list>", description: "Comma-separated agent allowlist (default: main)" })
    agents?: string,
    @Option({ flags: "--label <label>", description: "Credential label (default: claude-oauth)" })
    label?: string,
    @Option({ flags: "--set-provider", description: "Also run agents.set <id> provider claude" })
    setProvider = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    try {
      const readSecret = this.deps.readSecret ?? readNonInteractiveSecret;
      const nextToken = await readSecret({ provided: token, fromStdin, maxBytes: 8192 });
      const payload = configureClaudeOAuth({
        token: nextToken,
        agents: splitAgents(agents),
        setProvider,
        label,
        env: this.deps.env,
      });
      printPayload(payload, asJson, () => {
        console.log(
          `Claude OAuth configured. credential=${payload.credential.id} created=${payload.credentialCreated}`,
        );
      });
      return payload;
    } catch (err) {
      failProvider("runtime providers claude configure", err, asJson);
    }
  }
}

@Group({
  name: "runtime.providers.codex.login",
  description: "Headless Codex device-code login for Hub / gateway",
  scope: "admin",
})
export class RuntimeProvidersCodexLoginCommands {
  constructor(private readonly deps: RuntimeProviderCommandDeps = {}) {}

  @Command({
    name: "start",
    description: "Start Codex device-code login and return URL + user code",
    helpAfter: LOGIN_START_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.providers.codex.login", action: "start", risk: "high" })
  @Returns(runtimeProviderLoginReturnSchema)
  start(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    return runLoginStart("codex", asJson, this.deps);
  }

  @Command({ name: "status", description: "Poll a Codex device login", helpAfter: LOGIN_STATUS_HELP })
  @CommandAccess({ kind: "read", resource: "runtime.providers.codex.login", action: "status", risk: "low" })
  @Returns(runtimeProviderLoginReturnSchema)
  status(
    @Arg("id", { required: false, description: "Login id from start" }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    return runLoginStatus("codex", id, asJson, this.deps);
  }

  @Command({
    name: "complete",
    description: "Import Codex CODEX_HOME after the human authorizes",
    helpAfter: LOGIN_COMPLETE_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.providers.codex.login", action: "complete", risk: "high" })
  @Returns(runtimeProviderLoginCompleteReturnSchema)
  complete(
    @Arg("id", { required: false, description: "Login id from start" }) id?: string,
    @Option({ flags: "--agents <list>", description: "Comma-separated agent allowlist (default: main)" })
    agents?: string,
    @Option({ flags: "--label <label>", description: "Credential label (default: codex-home)" })
    label?: string,
    @Option({ flags: "--set-provider", description: "Also run agents.set <id> provider codex" })
    setProvider = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    return runLoginComplete("codex", id, agents, setProvider, label, asJson, this.deps);
  }

  @Command({ name: "cancel", description: "Cancel a pending Codex device login", helpAfter: LOGIN_CANCEL_HELP })
  @CommandAccess({ kind: "mutate", resource: "runtime.providers.codex.login", action: "cancel", risk: "medium" })
  @Returns(runtimeProviderLoginReturnSchema)
  cancel(
    @Arg("id", { required: false, description: "Login id from start" }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    return runLoginCancel("codex", id, asJson, this.deps);
  }
}

@Group({
  name: "runtime.providers.grok.login",
  description: "Headless Grok device-code login for Hub / gateway",
  scope: "admin",
})
export class RuntimeProvidersGrokLoginCommands {
  constructor(private readonly deps: RuntimeProviderCommandDeps = {}) {}

  @Command({
    name: "start",
    description: "Start Grok device-code login and return URL + user code",
    helpAfter: LOGIN_START_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.providers.grok.login", action: "start", risk: "high" })
  @Returns(runtimeProviderLoginReturnSchema)
  start(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    return runLoginStart("grok", asJson, this.deps);
  }

  @Command({ name: "status", description: "Poll a Grok device login", helpAfter: LOGIN_STATUS_HELP })
  @CommandAccess({ kind: "read", resource: "runtime.providers.grok.login", action: "status", risk: "low" })
  @Returns(runtimeProviderLoginReturnSchema)
  status(
    @Arg("id", { required: false, description: "Login id from start" }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    return runLoginStatus("grok", id, asJson, this.deps);
  }

  @Command({
    name: "complete",
    description: "Import the Grok auth profile after the human authorizes",
    helpAfter: LOGIN_COMPLETE_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.providers.grok.login", action: "complete", risk: "high" })
  @Returns(runtimeProviderLoginCompleteReturnSchema)
  complete(
    @Arg("id", { required: false, description: "Login id from start" }) id?: string,
    @Option({ flags: "--agents <list>", description: "Comma-separated agent allowlist (default: main)" })
    agents?: string,
    @Option({ flags: "--label <label>", description: "Credential label (default: grok-auth-profile)" })
    label?: string,
    @Option({ flags: "--set-provider", description: "Also run agents.set <id> provider grok" })
    setProvider = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    return runLoginComplete("grok", id, agents, setProvider, label, asJson, this.deps);
  }

  @Command({ name: "cancel", description: "Cancel a pending Grok device login", helpAfter: LOGIN_CANCEL_HELP })
  @CommandAccess({ kind: "mutate", resource: "runtime.providers.grok.login", action: "cancel", risk: "medium" })
  @Returns(runtimeProviderLoginReturnSchema)
  cancel(
    @Arg("id", { required: false, description: "Login id from start" }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    return runLoginCancel("grok", id, asJson, this.deps);
  }
}
