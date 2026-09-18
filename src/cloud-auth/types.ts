export const DEFAULT_CONSOLE_URL = "https://console.ravi.bot";

export interface CloudAuthUser {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  displayName?: string | null;
}

export interface CloudAuthOrganization {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
}

export interface CloudCredentials {
  version: 1;
  consoleUrl: string;
  installationId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt?: string | null;
  scopes: string[];
  user?: CloudAuthUser | null;
  organization?: CloudAuthOrganization | null;
  createdAt: string;
  updatedAt: string;
}

export const CLOUD_AUTH_BACKENDS = ["file", "libsecret", "keychain"] as const;
export type CloudAuthBackendName = (typeof CLOUD_AUTH_BACKENDS)[number];

export const LEGACY_CLOUD_AUTH_USER_ID = "_legacy";

export interface CloudAuthStorePointer {
  version: 1;
  activeUserId: string;
  backend: CloudAuthBackendName;
}

export interface ActorPlatformIdentity {
  channel?: string;
  accountId?: string;
  platformUserId?: string;
  platformIdentityId?: string;
}

export interface ActorBinding {
  id?: string;
  contactId: string;
  actorPrincipal: string;
  consoleUserId: string;
  orgId: string;
  installationId: string;
  platformIdentity?: ActorPlatformIdentity | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ActorBindingCacheRecord {
  version: 1;
  binding: ActorBinding;
  expiresAt: string;
  updatedAt: string;
}

export interface ActorBindingUpsertInput {
  contactId: string;
  installationId?: string;
  organizationId?: string;
  consoleUserId?: string;
  platformIdentities?: ActorPlatformIdentity | Record<string, unknown> | null;
}

export interface ActorBindingUnlinkInput {
  contactId?: string;
  bindingId?: string;
  installationId?: string;
  organizationId?: string;
}

export interface ActorBindingResolveQuery {
  contactId?: string;
  consoleUserId?: string;
  installationId?: string;
  organizationId?: string;
}

export interface SafeCloudAuthSession {
  consoleUrl: string;
  user: CloudAuthUser | null;
  organization: CloudAuthOrganization | null;
  installation: {
    id: string;
  };
  scopes: string[];
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
}

export interface ConsoleAuthConfig {
  consoleUrl?: string;
  authorizationUrl?: string;
  authUrl?: string;
  loginUrl?: string;
  verificationUri?: string;
  verificationUrl?: string;
  verificationUriComplete?: string;
  userCode?: string;
  deviceCode?: string;
  expiresIn?: number;
  interval?: number;
  provider?: string;
  configured?: boolean;
  clientId?: string | null;
  scopes?: string[];
  endpoints?: {
    deviceAuthorization?: string | null;
    token?: string | null;
    exchange?: string | null;
    refresh?: string | null;
    logout?: string | null;
    me?: string | null;
  };
  [key: string]: unknown;
}

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number | null;
  interval: number | null;
}

export interface DeviceTokenResponse {
  accessToken: string;
  refreshToken?: string | null;
  idToken?: string | null;
  tokenType?: string | null;
  expiresIn?: number | null;
}

export interface ConsoleMeResponse {
  user?: CloudAuthUser | null;
  organization?: CloudAuthOrganization | null;
  org?: CloudAuthOrganization | null;
  installation?: { id?: string | null; installationId?: string | null } | null;
  installationId?: string | null;
  scopes?: string[];
  accessTokenExpiresAt?: string | null;
  expiresAt?: string | null;
  refreshTokenExpiresAt?: string | null;
  [key: string]: unknown;
}

export interface CredentialExchangeInput {
  installationId: string;
  workosAccessToken?: string;
  providerAccessToken?: string;
  deviceCode?: string;
  userCode?: string;
  installation?: {
    name?: string;
    hostname?: string;
    platform?: string;
    raviVersion?: string;
    machineFingerprint?: string;
  };
}

export interface CredentialRefreshInput {
  refreshToken: string;
  installationId: string;
}

export interface LogoutInput {
  refreshToken: string;
  installationId: string;
}
