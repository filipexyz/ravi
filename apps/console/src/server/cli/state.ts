import { cliApiError } from "./errors";
import { CLI_ACCESS_TOKEN_TTL_SECONDS } from "./tokens";

export type CliUserRecord = {
  id: string;
  primaryEmail: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
};

export type CliOrganizationRecord = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

export type CliMembershipRecord = {
  id: string;
  role: string;
  status: string;
};

export type CliInstallationRecord = {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  raviVersion: string | null;
  status: string;
  lastSeenAt: Date;
};

export type CliSessionRecord = {
  id: string;
  status: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
};

export type CliAuthRecords = {
  user: CliUserRecord;
  organization: CliOrganizationRecord;
  membership: CliMembershipRecord;
  localInstallation: CliInstallationRecord;
  cliSession: CliSessionRecord;
  scopes: string[];
};

export type CliCredentialResponse = CliMeResponse & {
  tokenType: "Bearer";
  accessToken: string;
  accessTokenExpiresAt: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};

export type CliMeResponse = {
  version: 1;
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  };
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  membership: {
    id: string;
    role: string;
  };
  localInstallation: {
    id: string;
    name: string;
    hostname: string | null;
    platform: string | null;
    raviVersion: string | null;
    status: string;
    lastSeenAt: string;
  };
  cliSession: {
    id: string;
    status: string;
    expiresAt: string;
    lastUsedAt: string | null;
  };
  scopes: string[];
};

export function assertCliRecordsActive(records: CliAuthRecords, now = new Date()) {
  if (records.localInstallation.status === "revoked") {
    throw cliApiError(403, "INSTALLATION_REVOKED");
  }

  if (records.cliSession.status !== "active" || records.cliSession.expiresAt <= now) {
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  if (
    records.user.status !== "active" ||
    records.organization.status !== "active" ||
    records.membership.status !== "active"
  ) {
    throw cliApiError(
      403,
      "ORG_ACCESS_DENIED",
      "Organization access was denied because the Console user, organization, or membership is not active. Re-run `ravi login` via /cli/authorize?user_code=…, or ask an organization owner to restore access.",
    );
  }
}

export function cliMeResponse(records: CliAuthRecords): CliMeResponse {
  return {
    version: 1,
    user: {
      id: records.user.id,
      email: records.user.primaryEmail,
      name: records.user.displayName,
      avatarUrl: records.user.avatarUrl,
    },
    organization: {
      id: records.organization.id,
      slug: records.organization.slug,
      name: records.organization.name,
    },
    membership: {
      id: records.membership.id,
      role: records.membership.role,
    },
    localInstallation: {
      id: records.localInstallation.id,
      name: records.localInstallation.name,
      hostname: records.localInstallation.hostname,
      platform: records.localInstallation.platform,
      raviVersion: records.localInstallation.raviVersion,
      status: records.localInstallation.status,
      lastSeenAt: records.localInstallation.lastSeenAt.toISOString(),
    },
    cliSession: {
      id: records.cliSession.id,
      status: records.cliSession.status,
      expiresAt: records.cliSession.expiresAt.toISOString(),
      lastUsedAt: records.cliSession.lastUsedAt?.toISOString() ?? null,
    },
    scopes: records.scopes,
  };
}

export function cliCredentialResponse(
  records: CliAuthRecords,
  tokens: {
    accessToken: string;
    accessTokenExpiresAt: Date;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
  },
): CliCredentialResponse {
  return {
    ...cliMeResponse(records),
    tokenType: "Bearer",
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    expiresIn: CLI_ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
  };
}
