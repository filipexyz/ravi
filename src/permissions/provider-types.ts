import type { ContextCapability } from "../router/router-db.js";

export type PermissionDecisionValue = "allow" | "deny" | "needs_approval" | "not_applicable";

export interface CapabilityContextLike {
  agentId?: string | null;
  kind?: string | null;
  capabilities: ContextCapability[];
  metadata?: Record<string, unknown> | null;
}

export interface PermissionProviderSubject {
  type: string;
  id: string;
}

export interface PermissionProviderCapabilityOptions {
  includeRoles?: boolean;
  includeConstraints?: boolean;
}

export interface PermissionProviderRequest {
  requestId?: string;
  /**
   * Explicit break-glass/local operator request.
   *
   * Missing subject/context/capabilities is not enough to imply local operator
   * authority; callers must opt in deliberately.
   */
  localOperator?: boolean;
  subject?: PermissionProviderSubject | null;
  context?: CapabilityContextLike | null;
  capabilities?: ContextCapability[] | null;
  permission: string;
  objectType: string;
  objectId: string;
}

export interface PermissionProviderDecision {
  decision: PermissionDecisionValue;
  allowed: boolean;
  providerId: string;
  providerVersion: string;
  reasonCode: string;
  permission: string;
  objectType: string;
  objectId: string;
  requestId?: string;
  durationMs?: number;
  subject?: PermissionProviderSubject;
  contextId?: string;
  evidence?: unknown[];
}

export interface PermissionProvider {
  id: string;
  version: string;
  required: boolean;
  supports(request: PermissionProviderRequest): boolean;
  authorize(request: PermissionProviderRequest): PermissionProviderDecision;
  materializeCapabilities?(
    subject: PermissionProviderSubject,
    options?: PermissionProviderCapabilityOptions,
  ): ContextCapability[];
  materializeDelegationOverrides?(
    subject: PermissionProviderSubject,
    options?: PermissionProviderCapabilityOptions,
  ): ContextCapability[];
}
