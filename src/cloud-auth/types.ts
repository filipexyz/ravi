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
