import type { OrganizationAction, PROJECT_ACTIONS } from "./project-authorization";
export type ApiKeyAction = OrganizationAction | (typeof PROJECT_ACTIONS)[number];
export type ApiKeySubject = { kind: "user" | "service"; id: string };
export type ApiKeyMetadata = {
  id: string; name: string; prefix: string; status: string; revision: number;
  subjectKind: "unclassified" | "user" | "service"; subjectId: string | null;
  subjectName: string | null; authorName: string | null;
  projectId: string | null; projectName: string | null; scopes: ApiKeyAction[];
  expiresAt: string | null; revokedAt: string | null; rotationRequired: boolean;
};
export type ServicePrincipalMetadata = { id: string; name: string; status: "active" | "revoked"; revision: number };
export type ApiKeyInventory = {
  keys: ApiKeyMetadata[]; services: ServicePrincipalMetadata[];
  users: { id: string; name: string }[]; projects: { id: string; name: string }[];
  unresolved: number;
};
export type ApiKeyReceipt = { operationId: string; key?: ApiKeyMetadata; service?: ServicePrincipalMetadata; token?: string };
