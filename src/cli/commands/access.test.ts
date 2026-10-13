import { describe, expect, it, mock } from "bun:test";

import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import type { AccessActorDecision } from "../../access/actor.js";
import type { AccessDeps } from "../../access/client.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { getCommandAccessMetadata, getOptionsMetadata } from "../decorators.js";
import { AccessCommands } from "./access.js";
import { InvitesCommands } from "./invites.js";
import { PagesCommands, type PagesCommandDeps } from "./pages.js";

const OPERATOR: AccessActorDecision = { kind: "operator" };

describe("access command surface", () => {
  it("declares its own access resources and brakes only what expands access", () => {
    const pages = getCommandAccessMetadata(PagesCommands);
    expect(pages.get("share")).toMatchObject({ kind: "mutate", resource: "pages.access", action: "share" });
    expect(pages.get("share")?.requiresConfirmation).toBe(true);
    expect(pages.get("unshare")).toMatchObject({ kind: "mutate", resource: "pages.access", action: "unshare" });
    expect(pages.get("unshare")?.requiresConfirmation).toBeUndefined();
    expect(pages.get("access")).toMatchObject({ kind: "read", resource: "pages.access", action: "list" });
    const invites = getCommandAccessMetadata(InvitesCommands);
    expect(invites.get("create")).toMatchObject({ kind: "mutate", resource: "invites", requiresConfirmation: true });
    expect(invites.get("list")).toMatchObject({ kind: "read", resource: "invites" });
    expect(invites.get("revoke")).toMatchObject({ kind: "mutate", resource: "invites", action: "revoke" });
    const access = getCommandAccessMetadata(AccessCommands);
    expect(access.get("request")).toMatchObject({ kind: "mutate", resource: "access.requests", action: "create" });
    expect(access.get("status")).toMatchObject({ kind: "read", resource: "access.requests", action: "show" });

    const flags = (target: object, method: string) => getOptionsMetadata(target, method).map((option) => option.flags);
    expect(flags(new PagesCommands(), "share")).toContain("--execute");
    expect(flags(new PagesCommands(), "unshare")).not.toContain("--execute");
    expect(flags(new InvitesCommands(), "create")).toContain("--execute");
    expect(flags(new InvitesCommands(), "revoke")).not.toContain("--execute");
    expect(flags(new AccessCommands(), "request")).toContain("--execute");
  });
});

describe("write brake", () => {
  it("pages share prints the plan and exits 3 without --execute, then shares with it", async () => {
    const { client, calls } = makeClient(async () => ({
      created: true,
      userCreated: false,
      grant: { id: "grant_1", email: "ana@example.com", scope: "route", url: "https://acme.ravi.page/r" },
    }));
    const command = new PagesCommands(pagesDeps(client));

    const error = await expectContractError(
      () => command.share("https://acme.ravi.page/r", "ana@example.com", false, "30d", undefined, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(error.details.plan).toMatchObject({
      page: "https://acme.ravi.page/r",
      email: "ana@example.com",
      scope: "route",
      actingAs: expect.stringContaining("operator"),
    });
    expect(calls).toEqual([]);

    const result = await quiet(() =>
      command.share("https://acme.ravi.page/r", "ana@example.com", false, undefined, undefined, undefined, true, true),
    );
    expect(result).toMatchObject({ success: true, created: true, grant: { id: "grant_1" } });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/access/pages/share",
        body: { url: "https://acme.ravi.page/r", email: "ana@example.com" },
      },
    ]);
  });

  it("invites create and access request are braked; unshare and revoke apply at once", async () => {
    const { client, calls } = makeClient(async (_method, path) =>
      path.endsWith("/unshare") || path.endsWith("/revoke") ? { revoked: true } : {},
    );
    const invites = new InvitesCommands(accessDeps(client));
    await expectContractError(
      () => invites.create("bia@example.com", "developer", undefined, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    const access = new AccessCommands(accessDeps(client));
    await expectContractError(
      () => access.request("https://other.ravi.page/x", "please", undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(calls).toEqual([]);

    const pages = new PagesCommands(pagesDeps(client));
    await quiet(() => pages.unshare(undefined, undefined, false, "grant_1", undefined, true));
    await quiet(() => invites.revoke("inv_1", undefined, true));
    expect(calls.map((call) => call.path)).toEqual(["/api/cli/access/pages/unshare", "/api/cli/access/invites/revoke"]);
  });

  it("refuses an unattributable turn with exit 3 before the plan", async () => {
    const { client, calls } = makeClient(async () => ({}));
    const refused: AccessActorDecision = { kind: "refused", message: "who is asking?", actorPrincipal: "unknown" };
    const command = new PagesCommands(pagesDeps(client, refused));
    await expectContractError(
      () => command.share("https://acme.ravi.page/r", "ana@example.com", false, undefined, undefined, undefined, true),
      "ACTOR_UNKNOWN",
      3,
    );
    expect(calls).toEqual([]);
  });
});

describe("error mapping", () => {
  it("turns ACTOR_NOT_LINKED into exit 3 that says to send ravi link", async () => {
    const { client } = makeClient(async () => {
      throw new CloudAuthError("ACTOR_NOT_LINKED", "remote", { status: 403 });
    });
    const command = new PagesCommands(pagesDeps(client, { kind: "contact", contactId: "c_ana" }));
    const error = await expectContractError(
      () => command.access("https://acme.ravi.page/r", undefined, true),
      "ACTOR_NOT_LINKED",
      3,
    );
    expect(error.message).toContain("ravi link");
  });

  it("explains a role refusal on invites", async () => {
    const { client } = makeClient(async () => {
      throw new CloudAuthError("PROJECT_ACCESS_DENIED", "remote", { status: 403 });
    });
    const invites = new InvitesCommands(accessDeps(client));
    const error = await expectContractError(
      () => invites.create("bia@example.com", undefined, undefined, undefined, true, true),
      "PROJECT_ACCESS_DENIED",
      1,
    );
    expect(error.message).toContain("owner or admin");
  });
});

function makeClient(handler: (method: string, path: string, body: unknown) => Promise<unknown>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const client = {
    me: mock(async () => ({ user: { email: "alice@example.com" }, organization: { id: "org_1" } })),
    requestJson: mock(async (method: string, path: string, body: unknown) => {
      calls.push({ method, path, body });
      return handler(method, path, body);
    }),
  } as unknown as ConsoleApiClient;
  return { client, calls };
}

function accessDeps(client: ConsoleApiClient, actor: AccessActorDecision = OPERATOR): AccessDeps {
  return { client, readCredentials: () => makeCredentials(), actor, getAgentName: () => null };
}

function pagesDeps(client: ConsoleApiClient, actor: AccessActorDecision = OPERATOR): PagesCommandDeps {
  return accessDeps(client, actor) as PagesCommandDeps;
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await runWithContext({}, run);
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function expectContractError(
  run: () => Promise<unknown>,
  code: string,
  exitCode: number,
): Promise<ContractError> {
  let caught: unknown;
  try {
    await quiet(run);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractError;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2099-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2099-06-10T00:00:00.000Z",
    scopes: ["console.projects.read", "artifacts.publish"],
    user: { id: "user_1", email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
