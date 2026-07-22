import {
  getCredentialConnection,
  resolveCredentialSecret,
  type CredentialBrokerDependencies,
  type CredentialStoreOptions,
} from "../../credentials/index.js";
import type { TinyTenantConfig } from "./config.js";
import type { TinyReadOperation } from "./read-contracts.js";

export interface TinyCredentialStatus {
  provider: "tiny";
  connection: string;
  configured: boolean;
  active: boolean;
  backend: "keychain" | "vault" | null;
  secretExposed: false;
}

export function inspectTinyCredential(
  config: TinyTenantConfig,
  options: CredentialStoreOptions = {},
): TinyCredentialStatus {
  const record = getCredentialConnection(config.credentialProvider, config.credentialConnection, options);
  return {
    provider: "tiny",
    connection: config.credentialConnection,
    configured: record !== null,
    active: record?.status === "active",
    backend: record?.backend ?? null,
    secretExposed: false,
  };
}

export async function resolveTinyReadCredential(
  config: TinyTenantConfig,
  operation: TinyReadOperation,
  options: CredentialStoreOptions = {},
  dependencies: CredentialBrokerDependencies = {},
): Promise<{ secret: string; status: TinyCredentialStatus }> {
  const resolved = await resolveCredentialSecret(
    {
      provider: config.credentialProvider,
      connection: config.credentialConnection,
      action: `${operation}.read`,
      authorization: { tenant: config.tenant },
      options,
    },
    dependencies,
  );
  return {
    secret: resolved.secret,
    status: {
      provider: "tiny",
      connection: resolved.connection.connection,
      configured: true,
      active: true,
      backend: resolved.connection.backend,
      secretExposed: false,
    },
  };
}
