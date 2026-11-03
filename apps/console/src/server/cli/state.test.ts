import { describe, expect, test } from "bun:test";

import { CliApiError } from "./errors";
import {
  assertCliRecordsActive,
  cliCredentialResponse,
  cliMeResponse,
  type CliAuthRecords,
} from "./state";

const now = new Date("2026-05-09T12:00:00.000Z");

describe("CLI auth state", () => {
  test("formats successful local auth state without token hashes", () => {
    const records = activeRecords();
    const response = cliCredentialResponse(records, {
      accessToken: "access-token",
      accessTokenExpiresAt: new Date("2026-05-09T12:15:00.000Z"),
      refreshToken: "refresh-token",
      refreshTokenExpiresAt: new Date("2026-06-08T12:00:00.000Z"),
    });

    expect(response.user.email).toBe("dev@ravi.bot");
    expect(response.organization.slug).toBe("ravi");
    expect(response.localInstallation.id).toBe("installation-1");
    expect(response.cliSession.id).toBe("session-1");
    expect(response.scopes).toEqual(["console.me.read"]);
    expect(JSON.stringify(response)).not.toContain("hash");
  });

  test("rejects revoked local installations", () => {
    const records = activeRecords({
      localInstallation: { status: "revoked" },
    });

    expect(() => assertCliRecordsActive(records, now)).toThrow(CliApiError);

    try {
      assertCliRecordsActive(records, now);
    } catch (error) {
      expect(error).toBeInstanceOf(CliApiError);
      expect((error as CliApiError).code).toBe("INSTALLATION_REVOKED");
    }
  });

  test("rejects revoked and expired CLI sessions", () => {
    const revoked = activeRecords({
      cliSession: { status: "revoked" },
    });
    const expired = activeRecords({
      cliSession: { expiresAt: new Date("2026-05-09T11:59:59.000Z") },
    });

    for (const records of [revoked, expired]) {
      try {
        assertCliRecordsActive(records, now);
      } catch (error) {
        expect(error).toBeInstanceOf(CliApiError);
        expect((error as CliApiError).code).toBe("AUTH_EXPIRED");
      }
    }
  });

  test("rejects inactive organization membership with an actionable org error", () => {
    const records = activeRecords();
    records.membership.status = "removed";

    try {
      assertCliRecordsActive(records, now);
      throw new Error("expected ORG_ACCESS_DENIED");
    } catch (error) {
      expect(error).toBeInstanceOf(CliApiError);
      expect((error as CliApiError).code).toBe("ORG_ACCESS_DENIED");
      expect((error as CliApiError).message).toContain("/cli/authorize?user_code=");
    }
  });

  test("formats /api/cli/me state", () => {
    expect(cliMeResponse(activeRecords())).toMatchObject({
      version: 1,
      user: { id: "user-1", email: "dev@ravi.bot" },
      organization: { id: "org-1", slug: "ravi" },
      membership: { id: "membership-1", role: "owner" },
      localInstallation: { id: "installation-1", status: "active" },
      cliSession: { id: "session-1", status: "active" },
      scopes: ["console.me.read"],
    });
  });
});

function activeRecords(
  overrides: {
    localInstallation?: Partial<CliAuthRecords["localInstallation"]>;
    cliSession?: Partial<CliAuthRecords["cliSession"]>;
  } = {},
): CliAuthRecords {
  return {
    user: {
      id: "user-1",
      primaryEmail: "dev@ravi.bot",
      displayName: "Ravi Dev",
      avatarUrl: null,
      status: "active",
    },
    organization: {
      id: "org-1",
      slug: "ravi",
      name: "Ravi",
      status: "active",
    },
    membership: {
      id: "membership-1",
      role: "owner",
      status: "active",
    },
    localInstallation: {
      id: "installation-1",
      name: "Luis MacBook",
      hostname: "macbook",
      platform: "darwin-arm64",
      raviVersion: "0.1.0",
      status: "active",
      lastSeenAt: now,
      ...overrides.localInstallation,
    },
    cliSession: {
      id: "session-1",
      status: "active",
      expiresAt: new Date("2026-06-08T12:00:00.000Z"),
      lastUsedAt: now,
      ...overrides.cliSession,
    },
    scopes: ["console.me.read"],
  };
}
