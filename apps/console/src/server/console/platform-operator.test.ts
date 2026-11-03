import { afterEach, describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { isConsoleManageBugsPath, platformOperatorPageOutcome } from "@/server/console/platform-operator";
import {
  PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV,
  WORKOS_PLATFORM_OPERATOR_METADATA_KEY,
  applyWorkosUserManagementMetadataToIdentity,
  matchesPlatformOperatorDevAllowlist,
  parsePlatformOperatorDevAllowlist,
  platformOperatorFromWorkosMetadata,
  platformOperatorMirrorAction,
  resolvePlatformOperatorGrant,
  sessionProfileHasOperatorMetadataKey,
  workosMetadataFromRawProfile,
} from "./platform-operator";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  VERCEL: process.env.VERCEL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  ALLOWLIST: process.env[PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV],
};

afterEach(() => {
  restoreEnv("NODE_ENV", originalEnv.NODE_ENV);
  restoreEnv("VERCEL", originalEnv.VERCEL);
  restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
  restoreEnv(PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV, originalEnv.ALLOWLIST);
});

describe("WorkOS platform-operator metadata", () => {
  test("treats boolean true and string true as granted", () => {
    expect(platformOperatorFromWorkosMetadata({ [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: true })).toBe(true);
    expect(platformOperatorFromWorkosMetadata({ [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" })).toBe(true);
    expect(platformOperatorFromWorkosMetadata({ [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "TRUE" })).toBe(true);
  });

  test("treats absent or false metadata as not an operator", () => {
    expect(platformOperatorFromWorkosMetadata(undefined)).toBe(false);
    expect(platformOperatorFromWorkosMetadata({})).toBe(false);
    expect(platformOperatorFromWorkosMetadata({ [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: false })).toBe(false);
    expect(platformOperatorFromWorkosMetadata({ [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "false" })).toBe(false);
    expect(platformOperatorFromWorkosMetadata({ [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "yes" })).toBe(false);
  });

  test("does not treat a missing AuthKit metadata object as an operator key", () => {
    expect(sessionProfileHasOperatorMetadataKey({ id: "user_01ABC", email: "ops@ravi.bot" })).toBe(false);
    expect(sessionProfileHasOperatorMetadataKey({ metadata: {} })).toBe(false);
    expect(
      sessionProfileHasOperatorMetadataKey({
        metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" },
      }),
    ).toBe(true);
  });

  test("reads metadata from AuthKit user profiles and nested CLI profiles", () => {
    expect(
      workosMetadataFromRawProfile({
        email: "ops@ravi.bot",
        metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" },
      }),
    ).toEqual({ [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" });

    expect(
      workosMetadataFromRawProfile({
        provider: "workos",
        userProfile: { metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" } },
      }),
    ).toEqual({ [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" });
  });
});

describe("platform-operator grant resolution", () => {
  const user = { id: "11111111-1111-4111-8111-111111111111", primaryEmail: "ops@ravi.bot" };

  test("OIDC metadata and a local allowlist cannot grant central operator access", () => {
    expect(resolvePlatformOperatorGrant({ user, identity: { email: user.primaryEmail,
      provider: "oidc:https://idp.example.test", rawProfile: { metadata: { ravi_platform_operator: true } },
    }, env: { ...developmentEnv(), [PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV]: user.primaryEmail } }))
      .toEqual({ granted: false, source: null });
  });

  test("grants from WorkOS metadata regardless of org role context", () => {
    const grant = resolvePlatformOperatorGrant({
      user,
      identity: {
        email: user.primaryEmail,
        rawProfile: { metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" } },
      },
      env: developmentEnv(),
    });
    expect(grant).toEqual({ granted: true, source: "workos_metadata" });
  });

  test("clears the grant when metadata is absent or false", () => {
    expect(
      resolvePlatformOperatorGrant({
        user,
        identity: { email: user.primaryEmail, rawProfile: {} },
        env: developmentEnv(),
      }),
    ).toEqual({ granted: false, source: null });

    expect(
      resolvePlatformOperatorGrant({
        user,
        identity: {
          email: user.primaryEmail,
          rawProfile: { metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "false" } },
        },
        env: developmentEnv(),
      }),
    ).toEqual({ granted: false, source: null });
  });

  test("honors the local/dev allowlist of emails and user ids", () => {
    const env = developmentEnv({ [PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV]: `${user.primaryEmail},anonymous@local` });
    expect(
      resolvePlatformOperatorGrant({
        user,
        identity: { email: user.primaryEmail, rawProfile: { mode: "anonymous" } },
        env,
      }),
    ).toEqual({ granted: true, source: "env_allowlist" });

    expect(
      parsePlatformOperatorDevAllowlist(`${user.id},Ops@Ravi.bot`),
    ).toEqual({
      emails: ["ops@ravi.bot"],
      userIds: [user.id],
    });
    expect(matchesPlatformOperatorDevAllowlist(user, { emails: [], userIds: [user.id] })).toBe(true);
  });

  test("ignores the allowlist on hosted or production runtimes", () => {
    const env = {
      NODE_ENV: "production",
      [PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV]: user.primaryEmail,
    } as NodeJS.ProcessEnv;
    setEnv("NODE_ENV", "production");
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;

    expect(
      resolvePlatformOperatorGrant({
        user,
        identity: { email: user.primaryEmail, rawProfile: {} },
        env,
      }),
    ).toEqual({ granted: false, source: null });
  });
});

describe("WorkOS User Management metadata sync", () => {
  const user = { id: "11111111-1111-4111-8111-111111111111", primaryEmail: "ops@ravi.bot" };
  const sessionIdentity = {
    email: user.primaryEmail,
    provider: "workos",
    providerUserId: "user_01HPLATFORMOPS",
    rawProfile: {
      id: "user_01HPLATFORMOPS",
      email: user.primaryEmail,
      firstName: "Ops",
      lastName: "User",
    } as Record<string, unknown>,
  };

  test("grants when the AuthKit session user has no metadata but User Management metadata is true", async () => {
    const resolved = await applyWorkosUserManagementMetadataToIdentity(sessionIdentity, {
      fetchMetadata: async () => ({
        ok: true,
        metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" },
      }),
    });

    expect(resolved.metadataSource).toBe("user_management_api");
    expect(resolved.workosMetadataResolved).toBe(true);
    expect(resolved.identity.rawProfile.metadata).toEqual({
      [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true",
    });

    const grant = resolvePlatformOperatorGrant({
      user,
      identity: resolved.identity,
      env: productionEnv(),
      workosMetadataResolved: resolved.workosMetadataResolved,
    });
    expect(grant).toEqual({ granted: true, source: "workos_metadata" });
    expect(platformOperatorMirrorAction(grant)).toBe("upsert");
  });

  test("revokes when User Management metadata is false or absent", async () => {
    const absent = await applyWorkosUserManagementMetadataToIdentity(sessionIdentity, {
      fetchMetadata: async () => ({ ok: true, metadata: {} }),
    });
    const absentGrant = resolvePlatformOperatorGrant({
      user,
      identity: absent.identity,
      env: productionEnv(),
      workosMetadataResolved: absent.workosMetadataResolved,
    });
    expect(absentGrant).toEqual({ granted: false, source: null });
    expect(platformOperatorMirrorAction(absentGrant)).toBe("revoke");

    const denied = await applyWorkosUserManagementMetadataToIdentity(sessionIdentity, {
      fetchMetadata: async () => ({
        ok: true,
        metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "false" },
      }),
    });
    const deniedGrant = resolvePlatformOperatorGrant({
      user,
      identity: denied.identity,
      env: productionEnv(),
      workosMetadataResolved: denied.workosMetadataResolved,
    });
    expect(deniedGrant).toEqual({ granted: false, source: null });
    expect(platformOperatorMirrorAction(deniedGrant)).toBe("revoke");
  });

  test("does not revoke from an AuthKit user that omitted metadata when the API is unavailable", async () => {
    const resolved = await applyWorkosUserManagementMetadataToIdentity(sessionIdentity, {
      fetchMetadata: async () => ({ ok: false, reason: "request_failed" }),
    });
    expect(resolved.metadataSource).toBe("unavailable");
    expect(resolved.workosMetadataResolved).toBe(false);

    const grant = resolvePlatformOperatorGrant({
      user,
      identity: resolved.identity,
      env: productionEnv(),
      workosMetadataResolved: resolved.workosMetadataResolved,
    });
    expect(grant).toEqual({ granted: false, source: null, preserveExisting: true });
    expect(platformOperatorMirrorAction(grant)).toBe("preserve");
  });

  test("prefers User Management metadata over a stale session operator flag", async () => {
    const resolved = await applyWorkosUserManagementMetadataToIdentity(
      {
        ...sessionIdentity,
        rawProfile: {
          ...sessionIdentity.rawProfile,
          metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "true" },
        },
      },
      {
        fetchMetadata: async () => ({
          ok: true,
          metadata: { [WORKOS_PLATFORM_OPERATOR_METADATA_KEY]: "false" },
        }),
      },
    );

    expect(
      resolvePlatformOperatorGrant({
        user,
        identity: resolved.identity,
        env: productionEnv(),
        workosMetadataResolved: resolved.workosMetadataResolved,
      }),
    ).toEqual({ granted: false, source: null });
  });
});

describe("manage page operator gate", () => {
  test("404s when the Ravi platform-operator mirror is missing", () => {
    expect(platformOperatorPageOutcome(false)).toBe("not_found");
  });

  test("renders when the Ravi platform-operator mirror is present", () => {
    expect(platformOperatorPageOutcome(true)).toBe("ok");
  });
});

describe("manage bugs path", () => {
  test("treats manage and admin bug segments as the platform-operator BFF", () => {
    expect(isConsoleManageBugsPath(["manage", "bugs"])).toBe(true);
    expect(isConsoleManageBugsPath(["manage", "bugs", "id", "status"])).toBe(true);
    expect(isConsoleManageBugsPath(["manage", "bugs", "id"])).toBe(true);
    expect(isConsoleManageBugsPath(["admin", "bugs", "id"])).toBe(true);
    expect(isConsoleManageBugsPath(["admin", "bugs"])).toBe(true);
    expect(isConsoleManageBugsPath(["bugs"])).toBe(false);
    expect(isConsoleManageBugsPath(["bugs", "id"])).toBe(false);
    expect(isConsoleManageBugsPath(["admin", "orgs"])).toBe(false);
  });
});

describe("platform-operator API denial", () => {
  test("uses a forbidden envelope that does not mention other reporters", () => {
    const error = new ConsoleApiError(403, { error: "forbidden" });
    expect(error.status).toBe(403);
    expect(error.payload.error).toBe("forbidden");
    expect(JSON.stringify(error.payload)).not.toContain("reporter");
  });
});

function productionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    VERCEL: "1",
  } as NodeJS.ProcessEnv;
}

function developmentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  setEnv("NODE_ENV", "development");
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  return {
    NODE_ENV: "development",
    ...extra,
  } as NodeJS.ProcessEnv;
}

function setEnv(key: string, value: string) {
  process.env[key] = value;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
