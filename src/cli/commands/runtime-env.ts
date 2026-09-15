import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { ContractError, CONTRACT_EXIT_USAGE, contractFail } from "../agent-contract.js";
import { readNonInteractiveSecret } from "../secret-input.js";
import {
  RAVI_ENV_ALLOWLIST,
  RaviEnvFileError,
  getRaviEnvKey,
  setRaviEnvKey,
  unsetRaviEnvKey,
  type RaviEnvMutation,
} from "../../runtime/ravi-env-file.js";
import { runtimeEnvEntryReturnSchema, runtimeEnvMutationReturnSchema } from "./operational-return-schemas.js";

const ENV_SET_HELP = `
USE
  Write one allowlisted key into $RAVI_STATE_DIR/.env (default ~/.ravi/.env)
  from a closed box or the SDK gateway. No TTY.

DO NOT USE
  Do not use this for Ravi Console login (ravi login) or the interactive
  wizard (ravi setup). Do not pass secrets as shell flags when a body/stdin
  path exists.

REGRAS HARD
  • Keys must match ^[A-Z][A-Z0-9_]*$ and be in the v1 allowlist.
  • Values must not contain newlines or NUL.
  • File mode is 0600; write is atomic (temp + rename).
  • Secret values are never printed. --value is redacted from gateway audit.
  • Fail closed on unknown keys. Extend the allowlist in source with a comment.

EXAMPLES
  printf '%s' "$TOKEN" | ravi runtime env set CLAUDE_CODE_OAUTH_TOKEN --stdin --json
  ravi runtime env set CODEX_HOME --value ~/.ravi/codex --json
  POST /api/v1/runtime/env/set  { "key":"CLAUDE_CODE_OAUTH_TOKEN", "value":"...", "json":true }

ON ERROR
  ENV_KEY_NOT_ALLOWED → use one of: ${RAVI_ENV_ALLOWLIST.join(", ")}
  ENV_VALUE_INVALID → remove newlines; use unset to delete
  USAGE_ERROR → provide --stdin or --value, not both

FONTES
  src/cli/commands/runtime-env.ts
  src/runtime/ravi-env-file.ts
`;

const ENV_UNSET_HELP = `
USE
  Remove one allowlisted key from the Ravi env file. Idempotent.

DO NOT USE
  Do not unset keys you still need for a live daemon without planning a restart.

EXAMPLES
  ravi runtime env unset ANTHROPIC_API_KEY --json
  POST /api/v1/runtime/env/unset  { "key":"ANTHROPIC_API_KEY", "json":true }

ON ERROR
  ENV_KEY_NOT_ALLOWED → key is outside the v1 allowlist

FONTES
  src/cli/commands/runtime-env.ts
`;

const ENV_GET_HELP = `
USE
  Inspect whether an allowlisted key is present. Secret values are always
  redacted as "[REDACTED]".

DO NOT USE
  Do not expect this command to return OAuth tokens or API keys.

EXAMPLES
  ravi runtime env get CLAUDE_CODE_OAUTH_TOKEN --json
  ravi runtime env get CODEX_HOME --json

ON ERROR
  ENV_KEY_NOT_ALLOWED → key is outside the v1 allowlist

FONTES
  src/cli/commands/runtime-env.ts
`;

function printPayload(payload: unknown, asJson: boolean, human: () => void): void {
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else human();
}

function failEnv(op: string, err: unknown, asJson?: boolean): never {
  if (err instanceof ContractError) throw err;
  if (err instanceof RaviEnvFileError) {
    contractFail(op, err.code, err.message, {
      asJson,
      exitCode:
        err.code === "ENV_KEY_NOT_ALLOWED" || err.code === "ENV_KEY_INVALID" || err.code === "ENV_VALUE_INVALID"
          ? CONTRACT_EXIT_USAGE
          : undefined,
      details: {
        suggestedAction:
          err.code === "ENV_KEY_NOT_ALLOWED"
            ? `Use an allowlisted key: ${RAVI_ENV_ALLOWLIST.join(", ")}`
            : "Inspect the key/value constraints and retry",
        ...(err.code === "ENV_KEY_NOT_ALLOWED" ? { allowedKeys: [...RAVI_ENV_ALLOWLIST] } : {}),
      },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  contractFail(op, "USAGE_ERROR", message, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: { suggestedAction: "Provide --stdin or --value for set; use an allowlisted key" },
  });
}

function printEnvHuman(entry: { key: string; present: boolean; value: string | null; action?: string }): void {
  const action = entry.action ? `${entry.action} ` : "";
  if (!entry.present) {
    console.log(`${action}${entry.key} is not set`);
    return;
  }
  console.log(`${action}${entry.key}=${entry.value ?? "[REDACTED]"}`);
}

@Group({
  name: "runtime.env",
  description: "Allowlisted Ravi env file reads and atomic writes",
  scope: "admin",
})
export class RuntimeEnvCommands {
  @Command({
    name: "set",
    description: "Atomically set one allowlisted key in the Ravi env file",
    helpAfter: ENV_SET_HELP,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.env",
    action: "set",
    risk: "high",
    redactions: ["value"],
  })
  @Returns(runtimeEnvMutationReturnSchema)
  async set(
    @Arg("key", { description: "Allowlisted env key, e.g. CLAUDE_CODE_OAUTH_TOKEN" }) key: string,
    @Option({ flags: "--value <value>", description: "Value for gateway/JSON callers; redacted from audit" })
    value?: string,
    @Option({ flags: "--stdin", description: "Read the value from redirected stdin (CLI; no TTY)" })
    fromStdin?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    try {
      const nextValue = await readNonInteractiveSecret({ provided: value, fromStdin, maxBytes: 8192 });
      const payload = setRaviEnvKey(key, nextValue);
      printPayload(payload, asJson, () => printEnvHuman(payload));
      return payload;
    } catch (err) {
      failEnv("runtime env set", err, asJson);
    }
  }

  @Command({
    name: "unset",
    description: "Remove one allowlisted key from the Ravi env file",
    helpAfter: ENV_UNSET_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.env", action: "unset", risk: "medium" })
  @Returns(runtimeEnvMutationReturnSchema)
  unset(
    @Arg("key", { description: "Allowlisted env key" }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    try {
      const payload = unsetRaviEnvKey(key);
      printPayload(payload, asJson, () => printEnvHuman(payload));
      return payload;
    } catch (err) {
      failEnv("runtime env unset", err, asJson);
    }
  }

  @Command({
    name: "get",
    description: "Show whether an allowlisted env key is set; secret values are redacted",
    helpAfter: ENV_GET_HELP,
  })
  @CommandAccess({ kind: "read", resource: "runtime.env", action: "get", risk: "low" })
  @Returns(runtimeEnvEntryReturnSchema)
  get(
    @Arg("key", { description: "Allowlisted env key" }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    try {
      const payload = getRaviEnvKey(key);
      printPayload(payload, asJson, () => printEnvHuman(payload));
      return payload;
    } catch (err) {
      failEnv("runtime env get", err, asJson);
    }
  }
}

export type { RaviEnvMutation };
