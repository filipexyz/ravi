export type CredentialBackend = "keychain" | "vault";

export type ConnectionStatus = "active" | "disabled";

export interface CredentialConnectionRecord {
  id: string;
  provider: string;
  connection: string;
  label: string | null;
  backend: CredentialBackend;
  secretRef: string;
  scopes: string[];
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionPage {
  total: number;
  limit: number;
  offset: number;
  items: CredentialConnectionRecord[];
}

export interface PolicyExplanation {
  provider: string;
  connection: string;
  action: string;
  requiredCapabilities: string[];
  approval: {
    required: boolean;
    reason: string;
  };
}
