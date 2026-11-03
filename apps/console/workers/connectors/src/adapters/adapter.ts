/**
 * Connector adapter interface.
 *
 * Every external provider is implemented as a single adapter that owns
 * its OAuth flow shape, refresh semantics, and capability execution.
 * Adapters MUST NOT persist credentials or log raw request/response
 * bodies. Token custody and audit live outside the adapter.
 */

export interface ProviderTokenBundle {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresInSeconds?: number;
  scopes: string[];
  externalAccountId?: string;
  externalAccountLogin?: string;
}

export interface AdapterAuthorizationInput {
  state: string;
  pkceChallenge?: string;
  scopes: string[];
  redirectUri: string;
  loginHint?: string;
  /**
   * Whether the new token also covers what the account granted the Ravi
   * client before (incremental authorization). Default true; a read-only
   * connect asks for exactly the scopes it requests.
   */
  includeGrantedScopes?: boolean;
}

export interface AdapterExchangeInput {
  code: string;
  pkceVerifier?: string;
  redirectUri: string;
}

export interface AdapterRefreshInput {
  refreshToken: string;
}

export interface AdapterRevokeInput {
  accessToken?: string;
  refreshToken?: string;
}

export interface AdapterExecuteInput<TIn> {
  capability: string;
  parameters: TIn;
  accessToken: string;
  abortSignal: AbortSignal;
}

export interface ConnectorAdapter {
  readonly providerId: string;
  readonly displayName: string;
  readonly supportsPkce: boolean;
  readonly defaultScopes: string[];
  /** Scopes always requested so the account's identity can be read from the token response. */
  readonly identityScopes?: readonly string[];
  /** Granted scopes that allow writing; `read_only` access drops them from the request. */
  readonly writeScopes?: readonly string[];

  buildAuthorizationUrl(input: AdapterAuthorizationInput): string;
  exchangeAuthorizationCode(input: AdapterExchangeInput): Promise<ProviderTokenBundle>;
  refresh(input: AdapterRefreshInput): Promise<ProviderTokenBundle>;
  revoke(input: AdapterRevokeInput): Promise<void>;
  executeCapability<TIn, TOut>(input: AdapterExecuteInput<TIn>): Promise<TOut>;
}

export class AdapterProviderError extends Error {
  constructor(
    public readonly status: number,
    public readonly providerCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AdapterProviderError";
  }
}
