export type WatchProvider = "github" | "npm" | string;
export type WatchPlacement = "local" | "console" | "auto";
export type EffectiveWatchPlacement = Exclude<WatchPlacement, "auto">;
export type WatchStatus = "active" | "disabled" | "error" | "deleted";
export type WatchFidelity = "full" | "derived" | "best_effort" | "webhook_only";
export type WatchSupportStatus = "supported" | "roadmap";

export interface WatchConnectorEventType {
  eventType: string;
  label: string;
  description?: string;
  placements: EffectiveWatchPlacement[];
  recommendedPlacement: EffectiveWatchPlacement;
  fidelity: WatchFidelity;
  webhookOnly?: boolean;
  requiredCapabilities?: string[];
  requiredProviderPermissions?: string[];
  consoleSupport?: WatchSupportStatus;
  localSupport?: WatchSupportStatus;
}

export interface WatchConnectorDefinition {
  id: WatchProvider;
  label: string;
  description: string;
  placements: EffectiveWatchPlacement[];
  defaultPlacement: WatchPlacement;
  defaultEventTypes: string[];
  eventTypes: WatchConnectorEventType[];
}

export interface WatchRecord {
  id: string;
  name: string | null;
  provider: WatchProvider;
  placement: EffectiveWatchPlacement;
  status: WatchStatus;
  resourceRef: string;
  providerInstallationId: string | null;
  providerResourceId: string | null;
  eventTypes: string[];
  filters: Record<string, unknown>;
  delivery: Record<string, unknown> | null;
  eventSubjects: string[];
  remoteWatch: Record<string, unknown> | null;
  lastEventAt: string | null;
  lastDeliveryAt: string | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
  deletedAt: number | null;
}

export interface WatchCreateInput {
  provider: WatchProvider;
  resourceRef: string;
  placement?: WatchPlacement;
  name?: string | null;
  eventTypes?: string[];
  filters?: Record<string, unknown>;
  providerInstallationId?: string | null;
  providerResourceId?: string | null;
  projectId?: string | null;
}

export interface WatchCapabilities {
  provider: string;
  recommendedPlacement?: EffectiveWatchPlacement;
  placements?: EffectiveWatchPlacement[];
  supportedEventTypes?: string[];
  unsupportedEventTypes?: string[];
  installNeeded?: boolean;
  installUrl?: string;
  connectUrl?: string;
  missingPermissions?: string[];
  missingCapabilities?: string[];
  inboxAvailable?: boolean;
  eventTypes?: Record<
    string,
    {
      placements?: EffectiveWatchPlacement[];
      requiredCapabilities?: string[];
      requiredProviderPermissions?: string[];
      fidelity?: WatchFidelity;
      webhookOnly?: boolean;
      missing?: string[];
      recommendedPlacement?: EffectiveWatchPlacement;
    }
  >;
  [key: string]: unknown;
}

export interface ConsoleWatch {
  id: string;
  provider: string;
  placement: EffectiveWatchPlacement;
  organizationId?: string;
  projectId?: string | null;
  providerInstallationId?: string | null;
  providerResourceId?: string | null;
  providerResourceRef?: string | null;
  resourceRef?: string | null;
  eventTypes?: string[];
  effectiveEventTypes?: string[];
  filters?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  status?: WatchStatus;
  eventSubjects?: string[];
  missingRequirements?: string[];
  statusUrl?: string;
  lastEventAt?: string | null;
  lastDeliveryAt?: string | null;
  lastErrorCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ConsoleWatchCreateRequest {
  provider: string;
  placement: "console";
  organizationId?: string;
  projectId?: string;
  providerInstallationId?: string;
  providerResourceId?: string;
  providerResource?: {
    owner?: string;
    repo?: string;
  };
  eventTypes: string[];
  filters?: Record<string, unknown>;
  delivery: {
    type: "inbox";
    subscriptionId?: string;
  };
  clientRequestId?: string;
  idempotencyKey?: string;
}

export interface WatchListPage {
  total: number;
  items: WatchRecord[];
  limit: number;
  offset: number;
}

export interface WatchNatsPayload {
  version: 1;
  eventId: string;
  watchId: string;
  watchName?: string;
  connector: string;
  placement: EffectiveWatchPlacement;
  eventType: string;
  dedupeKey: string;
  subject: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  links?: Array<Record<string, unknown> & { label?: string; url?: string }>;
  sensitivity?: "public" | "private" | "restricted";
  delivery?: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}
