import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { closeConsoleScopeStore } from "../../console-scope/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { CloudScopeCommands } from "./cloud-scope.js";

let stateDir: string | null = null;

afterEach(async () => {
  closeConsoleScopeStore();
  if (stateDir) {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  }
});

describe("cloud scope CLI commands", () => {
  it("sets and shows a session Console project default", async () => {
    stateDir = await createIsolatedRaviState("ravi-cloud-scope-command-test-");
    const client = makeClient();
    const command = new CloudScopeCommands({
      client,
      readCredentials: makeReadCredentials(),
      getContext: () => ({ sessionName: "ravi-console" }),
    });

    const { output: setOutput } = await captureConsole(() =>
      command.set("rbbt-ravi", true, undefined, undefined, undefined, undefined, true),
    );
    const setPayload = JSON.parse(setOutput);

    expect(setPayload).toMatchObject({
      success: true,
      target: {
        scopeKind: "session",
        scopeKey: "ravi-console",
      },
      scope: {
        project: {
          ref: "rbbt-ravi",
          id: "proj_1",
        },
      },
    });

    const { output: showOutput } = await captureConsole(() => command.show(undefined, true));
    const showPayload = JSON.parse(showOutput);

    expect(showPayload).toMatchObject({
      success: true,
      scope: {
        source: "session_default",
        project: {
          ref: "rbbt-ravi",
        },
      },
    });
  });

  it("keeps saved defaults isolated by selected Console organization", async () => {
    stateDir = await createIsolatedRaviState("ravi-cloud-scope-multi-org-test-");

    const luisCommand = new CloudScopeCommands({
      client: makeClient([{ id: "proj_luis", slug: "filipe-ai", name: "Filipe AI" }]),
      readCredentials: makeReadCredentials({ id: "org_luis", slug: "luis", name: "Luis" }),
      getContext: () => ({ sessionName: "ravi-console" }),
    });
    await captureConsole(() => luisCommand.set("filipe-ai", true, undefined, undefined, undefined, undefined, true));

    const rbbtCommand = new CloudScopeCommands({
      client: makeClient([{ id: "proj_rbbt", slug: "rbbt-ravi", name: "RBBT Ravi" }]),
      readCredentials: makeReadCredentials({ id: "org_rbbt", slug: "rbbt", name: "RBBT" }),
      getContext: () => ({ sessionName: "ravi-console" }),
    });
    await captureConsole(() => rbbtCommand.set("rbbt-ravi", true, undefined, undefined, undefined, undefined, true));

    const { output: luisOutput } = await captureConsole(() => luisCommand.show(undefined, true));
    const { output: rbbtOutput } = await captureConsole(() => rbbtCommand.show(undefined, true));

    expect(JSON.parse(luisOutput).scope).toMatchObject({
      organization: { slug: "luis" },
      project: { ref: "filipe-ai" },
    });
    expect(JSON.parse(rbbtOutput).scope).toMatchObject({
      organization: { slug: "rbbt" },
      project: { ref: "rbbt-ravi" },
    });
  });

  it("explains missing project without treating a local project name as remote scope", async () => {
    stateDir = await createIsolatedRaviState("ravi-cloud-scope-missing-test-");
    const client = makeClient([
      { id: "proj_1", slug: "rbbt-ravi", name: "RBBT Ravi" },
      { id: "proj_2", slug: "filipe-ai", name: "Filipe AI" },
    ]);
    const command = new CloudScopeCommands({
      client,
      readCredentials: makeReadCredentials(),
      getContext: () => ({
        sessionName: "ravi-console",
        context: {
          contextId: "ctx_1",
          contextKey: "rctx_1",
          kind: "runtime",
          capabilities: [],
          createdAt: Date.now(),
          metadata: {
            project: { slug: "rbbt" },
          },
        },
      }),
    });

    const { output } = await captureConsole(() => command.explain(undefined, undefined, true));
    const payload = JSON.parse(output);

    expect(payload.resolved.project).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('"ref":"rbbt"');
    expect(JSON.stringify(payload)).toContain("rbbt-ravi");
    expect(JSON.stringify(payload)).toContain("filipe-ai");
    expect(payload.missingProjectCommand).toContain("ravi cloud scope set --project <project-ref>");
  });
});

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

function makeClient(projects: Array<Record<string, unknown>> = [{ id: "proj_1", slug: "rbbt-ravi", name: "RBBT" }]) {
  return {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1", name: "Acme" },
    })),
    requestJson: mock(async (method: string, path: string) => {
      expect(method).toBe("GET");
      expect(path).toBe("/api/cli/projects");
      return projects;
    }),
  } as unknown as ConsoleApiClient;
}

function makeReadCredentials(organization: CloudCredentials["organization"] = { id: "org_1", name: "Acme" }) {
  return () => makeCredentials(organization);
}

function makeCredentials(organization: CloudCredentials["organization"]): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["console.projects.read", "console.projects.link"],
    user: { email: "alice@example.com" },
    organization,
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
