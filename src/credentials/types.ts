export type CredentialBackend = "file" | "keychain" | "vault";

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
  /** Lifecycle metadata (spec credentials: owner, purpose, rotation, expiration, disable). Never a secret. */
  owner: string | null;
  purpose: string | null;
  rotatedAt: number | null;
  expiresAt: number | null;
  disabledAt: number | null;
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

/**
 * What a backend can say about a secret WITHOUT reading its value.
 * `available: false` is the degraded case (no permission, sealed, unreachable,
 * backend without metadata): the inventory still lists the connection.
 */
export type CredentialSecretDescription =
  | {
      available: true;
      exists: boolean;
      version: number | null;
      createdAt: number | null;
      updatedAt: number | null;
      deleted: boolean;
    }
  | {
      available: false;
      reason: CredentialSecretUnavailableReason;
    };

export type CredentialSecretUnavailableReason =
  | "unsupported"
  | "not_configured"
  | "forbidden"
  | "sealed"
  | "unreachable"
  | "invalid_ref"
  | "redirected"
  | "error";

export interface CredentialInventoryItem {
  id: string;
  provider: string;
  connection: string;
  label: string | null;
  backend: CredentialBackend;
  secretRefAlias: string;
  status: CredentialConnectionStatus;
  scopes: string[];
  owner: string | null;
  purpose: string | null;
  createdAt: number;
  updatedAt: number;
  rotatedAt: number | null;
  expiresAt: number | null;
  disabledAt: number | null;
  lastUsedAt: number | null;
  secret: CredentialSecretDescription | null;
}

export interface CredentialInventoryAuditEntry {
  at: number;
  provider: string;
  connection: string;
  action: string;
  decision: string;
  resultStatus: string | null;
  errorCode: string | null;
}

export interface CredentialInventory {
  generatedAt: number;
  degraded: boolean;
  degradedReasons: CredentialSecretUnavailableReason[];
  total: number;
  items: CredentialInventoryItem[];
  audit: CredentialInventoryAuditEntry[];
}
