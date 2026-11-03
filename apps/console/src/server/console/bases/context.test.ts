import { describe, expect, test } from "bun:test";

import {
  basesCallerForPagesViewer,
  basesCallerFromCliAuth,
  basesCallerFromConsoleWorkspace,
  basesCallerPrincipal,
  basesCallerViewer,
  basesSystemCaller,
  sanitizeBasesClientHint,
} from "./context";

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const USER = "0a0a0a0a-0000-4000-8000-000000000002";
const INSTALLATION = "0a0a0a0a-0000-4000-8000-000000000003";
const SITE = "0a0a0a0a-0000-4000-8000-000000000004";

type ConsoleInput = Parameters<typeof basesCallerFromConsoleWorkspace>[0];
type CliInput = Parameters<typeof basesCallerFromCliAuth>[0];

function workspace(mode: "workos" | "anonymous", role = "developer") {
  return {
    mode,
    user: { id: USER, primaryEmail: " Luis@Example.COM " },
    organization: { id: ORG },
    membership: { role },
  } as unknown as ConsoleInput;
}

function cliAuth(role = "viewer") {
  return {
    user: { id: USER, primaryEmail: "Dev@Example.com" },
    organization: { id: ORG },
    membership: { role },
    localInstallation: { id: INSTALLATION },
    // authenticateCliRequest always carries the verified session and token id.
    cliSession: { id: "cli-session-1" },
    accessTokenJti: "jti-1",
  } as unknown as CliInput;
}

describe("client hints", () => {
  test("keeps only short string agentId, sessionKey, sdk", () => {
    expect(sanitizeBasesClientHint({ agentId: " main ", sessionKey: "agent:main:main", sdk: "ravi/1", extra: "x" })).toEqual({
      agentId: "main",
      sessionKey: "agent:main:main",
      sdk: "ravi/1",
    });
    expect(sanitizeBasesClientHint({ agentId: 1, sdk: "x".repeat(201) })).toBeNull();
    expect(sanitizeBasesClientHint("main")).toBeNull();
    expect(sanitizeBasesClientHint(null)).toBeNull();
  });
});

describe("callers", () => {
  test("Console sessions are user actors on the console surface", () => {
    const caller = basesCallerFromConsoleWorkspace(workspace("workos"), "req-1");
    expect(caller).toMatchObject({
      organizationId: ORG,
      user: { id: USER, email: "luis@example.com" },
      orgRole: "developer",
      actorType: "user",
      actorId: USER,
      surface: "console",
      requestId: "req-1",
      source: { kind: "user", id: USER },
      pageSiteId: null,
      localInstallationId: null,
      clientHint: null,
    });
  });

  test("anonymous local mode records the anonymous actor type", () => {
    expect(basesCallerFromConsoleWorkspace(workspace("anonymous"), "req").actorType).toBe("anonymous");
  });

  test("CLI sessions are cli actors scoped to the installation", () => {
    const caller = basesCallerFromCliAuth(cliAuth("viewer"), "req-2", { agentId: "main", token: "secret" });
    expect(caller).toMatchObject({
      actorType: "cli",
      actorId: USER,
      surface: "cli",
      orgRole: "viewer",
      source: { kind: "local_installation", id: INSTALLATION },
      localInstallationId: INSTALLATION,
      clientHint: { agentId: "main" },
      user: { id: USER, email: "dev@example.com" },
      authorization: { installationId: INSTALLATION, sessionId: "cli-session-1", bindingId: null, accessTokenJti: "jti-1" },
    });
  });
  test("CLI auth without the verified session is refused", () => {
    const { cliSession: _session, ...unverified } = cliAuth("viewer") as unknown as Record<string, unknown>;
    expect(() => basesCallerFromCliAuth(unverified as unknown as CliInput, "req")).toThrow("Verified installation context is required.");
  });

  test("unknown CLI roles parse to null", () => {
    expect(basesCallerFromCliAuth(cliAuth("superuser"), "req").orgRole).toBeNull();
  });

  test("Pages viewer callers carry the site and the pages session", () => {
    const caller = basesCallerForPagesViewer({
      organizationId: ORG,
      userId: USER,
      email: "Viewer@Example.com",
      pagesSessionId: "ps_1",
      siteId: SITE,
      orgRole: "viewer",
      requestId: "req-3",
    });
    expect(caller).toMatchObject({
      actorType: "user",
      surface: "page",
      source: { kind: "pages_session", id: "ps_1" },
      pageSiteId: SITE,
      user: { id: USER, email: "viewer@example.com" },
    });
  });

  test("viewer variables resolve from the caller and the base organization only", () => {
    const caller = basesCallerFromConsoleWorkspace(workspace("workos"), "req");
    expect(basesCallerViewer(caller, ORG)).toEqual({ raviUserId: USER, raviOrgId: ORG, email: "luis@example.com" });
    expect(basesCallerViewer(basesSystemCaller(ORG, "req"), ORG)).toBeNull();
  });

  test("cursor principals bind the user, or the source for system callers", () => {
    expect(basesCallerPrincipal(basesCallerFromConsoleWorkspace(workspace("workos"), "req"))).toBe(`user:${USER}`);
    expect(basesCallerPrincipal(basesSystemCaller(ORG, "req"))).toBe("system:system");
  });
});
