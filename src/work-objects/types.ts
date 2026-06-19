export const WORK_OBJECT_NATS_SUBJECTS = {
  resolve: "ravi.work_objects.resolve",
  update: "ravi.work_objects.update",
  action: "ravi.work_objects.action",
  suggest: "ravi.work_objects.suggest",
} as const;

export const WORK_OBJECT_NATS_COMPAT_SUBJECTS = {
  resolve: "omni.work_objects.resolve",
  update: "omni.work_objects.update",
  action: "omni.work_objects.action",
  suggest: "omni.work_objects.suggest",
} as const;

export const ALL_WORK_OBJECT_NATS_SUBJECTS = [
  ...new Set([...Object.values(WORK_OBJECT_NATS_SUBJECTS), ...Object.values(WORK_OBJECT_NATS_COMPAT_SUBJECTS)]),
];

export interface WorkObjectExternalRef {
  id: string;
  type?: string;
}

export interface WorkObjectActorContext {
  id?: string;
  username?: string;
  displayName?: string;
  teamId?: string;
  enterpriseId?: string;
  locale?: string;
  raw?: Record<string, unknown>;
}

export interface WorkObjectChannelContext {
  channel: string;
  instanceId: string;
  teamId?: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  triggerId?: string;
  raw?: Record<string, unknown>;
}

export interface WorkObjectRequestContext {
  requestId: string;
  instanceId: string;
  channel: WorkObjectChannelContext;
  actor?: WorkObjectActorContext;
  metadata?: Record<string, unknown>;
}

export interface WorkObjectField {
  value?: unknown;
  label?: string;
  type?: string;
  long?: boolean;
  edit?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkObjectCustomField extends WorkObjectField {
  key: string;
  label: string;
  value: string | number | boolean;
}

export interface WorkObjectAction {
  text: string;
  actionId?: string;
  value?: string;
  style?: "primary" | "danger";
  url?: string;
  accessibilityLabel?: string;
  processingState?: {
    enabled: boolean;
    interstitialText?: string;
  };
}

export interface WorkObjectActionSet {
  primaryActions?: WorkObjectAction[];
  overflowActions?: WorkObjectAction[];
  [key: string]: unknown;
}

export interface WorkObject {
  url: string;
  externalRef: WorkObjectExternalRef;
  title: string;
  kind?: string;
  entityType?: string;
  displayId?: string;
  displayType?: string;
  productName?: string;
  productIconUrl?: string;
  status?: string;
  description?: string;
  metadataLastModified?: number;
  revision?: string;
  attributes?: Record<string, unknown>;
  fields?: Record<string, WorkObjectField>;
  actions?: WorkObjectActionSet;
  displayOrder?: string[];
  customFields?: WorkObjectCustomField[];
}

export interface WorkObjectResolveInput {
  url?: string;
  appUnfurlUrl?: string;
  domain?: string;
  externalRef?: WorkObjectExternalRef;
  entityType?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkObjectUpdatePatch {
  values: Record<string, unknown>;
  revision?: string;
  rawPayload?: Record<string, unknown>;
}

export interface WorkObjectUpdateResult {
  object?: WorkObject;
  fieldErrors?: Record<string, string>;
  formError?: string;
  revision?: string;
}

export interface WorkObjectActionInput {
  actionId: string;
  value?: string;
  rawPayload?: Record<string, unknown>;
}

export interface WorkObjectActionResult {
  object?: WorkObject;
  message?: string;
  error?: string;
}

export interface WorkObjectSuggestionInput {
  fieldId: string;
  query?: string;
  rawPayload?: Record<string, unknown>;
}

export interface WorkObjectSuggestionOption {
  text: string;
  value: string;
}

export interface WorkObjectAdapter {
  id: string;
  canResolve?: (input: WorkObjectResolveInput, context: WorkObjectRequestContext) => boolean;
  resolveWorkObject(input: WorkObjectResolveInput, context: WorkObjectRequestContext): Promise<WorkObject | null>;
  updateWorkObject?(
    ref: WorkObjectExternalRef,
    patch: WorkObjectUpdatePatch,
    context: WorkObjectRequestContext,
  ): Promise<WorkObjectUpdateResult | null>;
  executeWorkObjectAction?(
    ref: WorkObjectExternalRef,
    action: WorkObjectActionInput,
    context: WorkObjectRequestContext,
  ): Promise<WorkObjectActionResult | null>;
  suggestWorkObjectOptions?(
    ref: WorkObjectExternalRef,
    suggestion: WorkObjectSuggestionInput,
    context: WorkObjectRequestContext,
  ): Promise<WorkObjectSuggestionOption[] | null>;
}

export interface WorkObjectAdapterResult<T> {
  providerId: string;
  result: T;
}
