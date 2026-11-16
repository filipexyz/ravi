import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createBashPermissionHook, evaluateBashPermission } from "../bash/hook.js";
import { runWithContext } from "../cli/context.js";
import { dbCreateAgent, dbUpdateAgent, type ContextCapability } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { createRuntimeHostServices } from "../runtime/host-services.js";

let stateDir: string | null = null;
const agentId = "bash-policy-regression";
const wildcard: ContextCapability[] = [
  { permission: "use", objectType: "tool", objectId: "Bash" },
  { permission: "execute", objectType: "executable", objectId: "*" },
];
const restricted: ContextCapability[] = [
  { permission: "use", objectType: "tool", objectId: "Bash" },
  ...["printf", "cat", "python3", "git", "cd", "pwd"].map((objectId) => ({
    permission: "execute",
    objectType: "executable",
    objectId,
  })),
];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-bash-execution-policy-");
  dbCreateAgent({ id: agentId, cwd: stateDir });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

function context(capabilities = wildcard) {
  return createRuntimeContext({
    kind: "cli-runtime",
    agentId,
    sessionName: "bash-policy-regression",
    capabilities,
  });
}

const compoundCommands = [
  "printf '%s' $(date)",
  "printf '%s' `date`",
  "cat <<'EOF'\nliteral\nEOF",
  "cat <(printf ok)",
  "python3 -c 'print(1)'",
  "printf 'print(1)' | python3",
  "bash -c 'printf ok'",
  "sh ./fixture.sh",
  ". ./fixture.sh",
  "cd ./nested && pwd",
];

describe("effective arbitrary execution permission", () => {
  it.each(compoundCommands)(
    "admits an already-authorized compound command through both host paths: %s",
    async (command) => {
      const issued = context();
      const hook = createBashPermissionHook({ getAgentId: () => agentId }).hooks[0]!;
      const sdk = await runWithContext({ agentId, context: issued }, () =>
        hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, null, {
          signal: new AbortController().signal,
        }),
      );
      expect((sdk.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision).not.toBe(
        "deny",
      );
      const host = createRuntimeHostServices({
        context: issued,
        agentId,
        sessionName: "bash-policy-regression",
        toolContext: {},
      });
      expect((await host.authorizeCommandExecution({ command, input: {} })).approved).toBe(true);
    },
  );

  it("does not confer arbitrary execution through named interpreter grants", () => {
    const issued = context(restricted);
    for (const command of compoundCommands.slice(0, -1)) {
      expect(evaluateBashPermission(command, issued).allowed, command).toBe(false);
    }
    expect(evaluateBashPermission("python3 ./fixture.py", issued).allowed).toBe(true);
    expect(evaluateBashPermission("cd nested && pwd", issued).allowed).toBe(true);
  });

  it("retains identity and session restrictions on execute wildcard", () => {
    const issued = context();
    expect(evaluateBashPermission("RAVI_AGENT_ID=main git status", issued).denialType).toBe("env_spoofing");
    expect(evaluateBashPermission("env -u RAVI_CONTEXT_KEY git status", issued).denialType).toBe("env_spoofing");
    expect(evaluateBashPermission("ravi sessions send other 'hello'", issued).denialType).toBe("session_scope");
  });

  it("keeps narrowed, unresolved and contact-limited contexts restricted under a full-access executor", () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });
    for (const metadata of [
      { authorityMode: "agent-identity", actorResolution: "missing_contact" },
      { authorityMode: "agent-identity", actorResolution: "resolved", relayNarrowing: true },
      { authorityMode: "agent-identity", actorResolution: "resolved", turnCapabilityCount: 1 },
      { authorityMode: "agent-identity", actorResolution: "resolved", actorAuthorizationMode: "user-overlay" },
    ]) {
      expect(
        evaluateBashPermission("printf '%s' $(date)", {
          agentId,
          kind: "turn-runtime",
          capabilities: restricted,
          metadata,
        }).allowed,
      ).toBe(false);
    }
    expect(evaluateBashPermission("bash -c 'printf ok'", context(restricted)).allowed).toBe(false);
  });

  it("rechecks a live executor reduction instead of retaining stale wildcard authority", () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });
    const turn = {
      agentId,
      kind: "turn-runtime",
      capabilities: wildcard,
      metadata: { authorityMode: "agent-identity", actorResolution: "resolved" },
    };
    expect(evaluateBashPermission("printf '%s' $(date)", turn).allowed).toBe(true);
    dbUpdateAgent(agentId, {
      defaults: { runtimePermissions: { profile: "explicit-only", capabilities: ["execute:executable:printf"] } },
    });
    expect(evaluateBashPermission("printf '%s' $(date)", turn).allowed).toBe(false);
  });
});
