export type CredentialBackend = "keychain" | "vault";

export type CredentialConnectionStatus = "active" | "disabled";

export interface CredentialConnectionRecord {
  id: string;
  provider: string;
  connection: string;
  label: string | null;
  backend: CredentialBackend;
  secretRef: string;
  scopes: string[];
  status: CredentialConnectionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface PublicCredentialConnection {
  id: string;
  provider: string;
  connection: string;
  label: string | null;
  backend: CredentialBackend;
  secretRef: string;
  scopes: string[];
  status: CredentialConnectionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialConnectionPage {
  total: number;
  limit: number;
  offset: number;
  items: CredentialConnectionRecord[];
}

export interface CredentialPolicyExplanation {
  provider: string;
  connection: string;
  action: string;
  requiredCapabilities: string[];
  approval: {
    required: boolean;
    reason: string;
  };
}

export interface CredentialAuditEventInput {
  provider: string;
  connection: string;
  action: string;
  decision: string;
  approvalRequired?: boolean;
  approvalStatus?: string | null;
  resultStatus?: string | null;
  errorCode?: string | null;
  actorContextId?: string | null;
  agentId?: string | null;
  createdAt?: number;
}

export interface CredentialAuditEvent {
  id: string;
  connectionId: string | null;
  provider: string;
  connection: string;
  action: string;
  actorContextId: string | null;
  agentId: string | null;
  decision: string;
  approvalRequired: boolean;
  approvalStatus: string | null;
  resultStatus: string | null;
  errorCode: string | null;
  createdAt: number;
}
