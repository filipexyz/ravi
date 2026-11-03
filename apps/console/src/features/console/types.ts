export type AvatarColor = "c1" | "c2" | "c3" | "c4" | "c5";
export type Health = "ok" | "warn" | "err" | "idle";
export type ArtifactStatus = "ready" | "created" | "building" | "failed" | "archived";
export type Visibility = "public" | "private" | "protected_link";
export type PageVisibility = Visibility | "password";

export type Org = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
  mark: string;
  color: AvatarColor;
};

export type OrganizationRole = "owner" | "admin" | "developer" | "viewer" | "billing";
export type MembershipStatus = "active" | "invited" | "suspended" | "removed";

export type Member = {
  id: string;
  membershipId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  status: MembershipStatus;
  mark: string;
  color: AvatarColor;
  joined: number;
};

export type Project = {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string;
  artifactCount: number;
  members: number;
  lastActive: number;
};

export type KnowledgeSourceType =
  | "manual_note"
  | "file_upload"
  | "artifact"
  | "meeting"
  | "mail_thread"
  | "calendar_event"
  | "github_repository"
  | "ravi_page"
  | "provider_resource"
  | "external_rag_collection";
export type KnowledgeSourceStatus = "active" | "disabled" | "revoked" | "deleted";
export type KnowledgeSensitivity = "standard" | "confidential" | "restricted";
export type KnowledgeRawSourceStatus = "pending" | "stored" | "external";
export type KnowledgeRawStorageBackend = "none" | "object_storage" | "external";

export type KnowledgeRawSourceSafeMetadata = {
  status: KnowledgeRawSourceStatus;
  storageBackend: KnowledgeRawStorageBackend;
  sha256: string | null;
  sizeBytes: number | null;
  contentType: string | null;
  storedAt: number | null;
};
export type KnowledgeDocumentStatus = "created" | "parsed" | "chunked" | "indexed" | "failed" | "archived";
export type KnowledgeIngestionJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type KnowledgeRetrievalRunStatus = "completed" | "denied" | "failed";

export type KnowledgeDocumentSummary = {
  id: string;
  sourceId: string;
  projectId: string;
  versionNumber: number;
  title: string;
  status: KnowledgeDocumentStatus;
  contentHash: string | null;
  mimeType: string | null;
  language: string | null;
  parserVersion: string | null;
  sizeBytes: number | null;
  parsedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeIngestionJobSummary = {
  id: string;
  sourceId: string;
  documentId: string | null;
  projectId: string;
  status: KnowledgeIngestionJobStatus;
  triggerType: string;
  attempts: number;
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeIngestionResult = {
  job: KnowledgeIngestionJobSummary;
  document: KnowledgeDocumentSummary;
  chunkCount: number;
  raw: KnowledgeRawSourceSafeMetadata;
};

export type KnowledgeRetrievalRunSummary = {
  id: string;
  projectId: string;
  status: KnowledgeRetrievalRunStatus;
  queryHash: string | null;
  candidateCount: number;
  returnedChunkCount: number;
  deniedReason: string | null;
  durationMs: number | null;
  createdAt: number;
};

export type KnowledgeRetrievalCitationSummary = {
  runId: string;
  rank: number;
  score: number;
  sourceId: string;
  documentId: string;
  chunkId: string;
  sourceTitle: string;
  documentTitle: string;
  sensitivity: string;
  excerpt: string;
  location: Record<string, unknown>;
  metadata: Record<string, unknown>;
  textHash: string;
};

export type KnowledgeRetrievalResult = {
  run: KnowledgeRetrievalRunSummary;
  citations: KnowledgeRetrievalCitationSummary[];
};

export type KnowledgeSourceSummary = {
  id: string;
  projectId: string;
  sourceType: KnowledgeSourceType;
  title: string;
  description: string | null;
  status: KnowledgeSourceStatus;
  sensitivity: KnowledgeSensitivity;
  sourceRef: Record<string, unknown>;
  metadata: Record<string, unknown>;
  raw: KnowledgeRawSourceSafeMetadata;
  access: {
    scope: "project";
    allowedConsumers: string[];
  };
  documentCount: number;
  chunkCount: number;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PageRouteMatchType = "exact" | "prefix" | "spa";
export type PageSiteStatus = "active" | "disabled" | "deleted";
export type PageReleaseStatus = "draft" | "active" | "archived" | "failed";

export type PageSiteSummary = {
  id: string;
  projectId: string;
  slug: string;
  defaultHostname: string;
  defaultVisibility: PageVisibility;
  isDefault: boolean;
  status: PageSiteStatus;
  activeReleaseId: string | null;
  activeRoutes: PageReleaseRoute[];
  releaseCount: number;
  routeCount: number;
  updatedAt: number;
};

/** A custom hostname bound to a Pages host. Only `ready` ones serve, and only they appear in `urls`. */
export type PageCustomDomainSummary = {
  hostname: string;
  status: "ready" | "pending";
  /** The hostname is a root domain, which needs CNAME flattening or ALIAS at the DNS provider. */
  apex?: true;
  /** Pending only: what still blocks serving, as of the binding's last check. */
  nextAction?: {
    code: string;
    message: string;
    dnsRecords: Array<{ name: string; type: string; value: string }>;
  };
};

export type PublishedPageSummary = {
  id: string;
  routeId: string;
  projectId: string;
  siteId: string;
  siteSlug: string;
  defaultHostname: string;
  path: string;
  matchType: PageRouteMatchType;
  priority: number;
  title: string;
  description: string;
  urls: string[];
  /** The host's custom domains, pending ones included, so a hostname that doesn't serve yet is visible. */
  customDomains: PageCustomDomainSummary[];
  artifactId: string;
  artifactName: string;
  artifactDescription: string;
  artifactVersionId: string;
  artifactVersion: string;
  entrypoint: string;
  assetBase: string;
  /** The route policy as published. A `public` route still follows the host default. */
  visibility: PageVisibility;
  /** What visitors get: the route policy, or the host default when the route is `public`. */
  effectiveVisibility: PageVisibility;
  releaseId: string;
  releaseNumber: number;
  releaseStatus: PageReleaseStatus;
  siteStatus: PageSiteStatus;
  status: string;
  thumbnail: {
    /** `current` shows the content served now, `stale` an older version of it. */
    state: "current" | "stale" | "missing";
    /** When there's no current capture: one is being taken, or the last try failed. */
    attempt: { status: "pending" | "failed"; at: number; retryable: boolean } | null;
    captureId: string | null;
    sourceArtifactVersionId: string | null;
    capturedAt: number | null;
    url: string | null;
    width: number | null;
    height: number | null;
    mimeType: string | null;
    sizeBytes: number | null;
  };
  comments: {
    openCount: number;
    unreadCount: number;
    blockingUnreadCount: number;
    hasUnread: boolean;
    latestAt: number | null;
    latestUnreadAt: number | null;
    lastReadAt: number | null;
    items: Array<{
      id: string;
      body: string;
      path: string;
      target: Record<string, unknown>;
      parentId: string | null;
      createdAt: string;
      unread: boolean;
      author: {
        id: string | null;
        displayName: string | null;
      };
    }>;
  };
  /** When this page's current content was published, and by whom (`via` is how: the CLI, the Console or the system). */
  published: {
    at: number;
    by: { name: string | null; via: "cli" | "console" | "system" };
  };
  /** The host's last change, the same for every page on it. Use `published.at` for the page's own time. */
  updatedAt: number;
};

export type PageReleaseRoute = {
  id: string;
  routeId: string;
  path: string;
  matchType: PageRouteMatchType;
  priority: number;
  artifactId: string;
  artifactName: string;
  artifactDescription: string;
  artifactVersionId: string;
  artifactVersion: string;
  entrypoint: string;
  assetBase: string;
  visibility: PageVisibility;
  /** What visitors get: the route policy, or the host default when the route is `public`. */
  effectiveVisibility: PageVisibility;
};

export type PageSiteRelease = {
  id: string;
  siteId: string;
  releaseNumber: number;
  previousReleaseId: string | null;
  status: PageReleaseStatus;
  reason: string | null;
  manifestHash: string | null;
  routeCount: number;
  activatedAt: number | null;
  createdAt: number;
};

export type PageSiteDetail = PageSiteSummary & {
  activeRelease: PageSiteRelease | null;
  activeRoutes: PageReleaseRoute[];
  releases: PageSiteRelease[];
};

export type Artifact = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  visibility: Visibility;
  versions: number;
  latestVersion: string;
  last: number;
};

export type ArtifactVersion = {
  id: string;
  artifactId: string;
  ver: string;
  sha: string;
  author: string;
  authorMark: string;
  color: AvatarColor;
  msg: string;
  at: number;
  on: string[];
  status: ArtifactStatus;
};

export type Event = {
  id: string;
  t: number;
  type: string;
  project: string | null;
  target: string;
  actor: string;
  actorMark: string;
  color: AvatarColor;
  note?: string;
};

export type FeedbackKind = "bug" | "idea" | "ux" | "docs" | "performance" | "security" | "other";
export type FeedbackSeverity = "low" | "medium" | "high" | "critical";
export type FeedbackSource = "console" | "cli" | "agent";

export type FeedbackItem = {
  id: string;
  kind: FeedbackKind;
  severity: FeedbackSeverity;
  title: string | null;
  message: string;
  surface: string | null;
  url: string | null;
  source: FeedbackSource;
  tags: string[];
  projectId: string | null;
  projectSlug: string | null;
  projectName: string | null;
  actor: string;
  actorMark: string;
  color: AvatarColor;
  createdAt: number;
};

export type FeedbackData = {
  total: number;
  items: FeedbackItem[];
};

export type BugReportSeverity = FeedbackSeverity;
export type BugReportStatus =
  | "submitted"
  | "triaging"
  | "in_progress"
  | "resolved"
  | "wontfix"
  | "duplicate";

export type BugReportPriority = "p0" | "p1" | "p2" | "p3";

export type BugReportSummary = {
  id: string;
  title: string;
  summary: string;
  severity: BugReportSeverity;
  surface: string | null;
  status: BugReportStatus;
  statusNote: string | null;
  priority: BugReportPriority | null;
  statusUpdatedAt: number;
  organizationId: string | null;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  consoleUrl: string;
};

export type BugReportComment = {
  id: string;
  bugId: string;
  schemaVersion: string;
  authorUserId: string;
  source: "cli" | "agent" | "console" | "user";
  text: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: number;
};

export type BugReportDetail = BugReportSummary & {
  schemaVersion: string;
  payload: Record<string, unknown>;
  comments?: BugReportComment[];
};

export type BugReportList = {
  total: number;
  items: BugReportSummary[];
};

export type AdminBugTriageSummary = {
  model: string;
  summary: string;
  suggestedPriority: BugReportPriority;
  suggestedStatus: BugReportStatus | null;
  confidence: number;
  similarBugIds: string[];
};

export type BugTriageJobStatus = "queued" | "running" | "completed" | "failed";
export type BugTriageJobTrigger = "create" | "manual";
export type AdminTriageState = "ready" | "pending" | "failed" | "idle";

export type BugTriageJobSummary = {
  id: string;
  bugReportId: string;
  status: BugTriageJobStatus;
  trigger: BugTriageJobTrigger;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type AdminBugReportSummary = BugReportSummary & {
  reporterUserId: string;
  priorityScore: number | null;
  assigneeUserId: string | null;
  duplicateOfId: string | null;
  triagedAt: number | null;
  lastTriageAt: number | null;
  triage: AdminBugTriageSummary | null;
  triageJob: BugTriageJobSummary | null;
};

export type BugTriageV1 = {
  schemaVersion: "ravi.bug_triage/v1";
  model: string;
  summary: string;
  suggestedPriority: BugReportPriority;
  suggestedStatus?: BugReportStatus;
  similarBugIds: string[];
  missingEvidence: string[];
  clarifyingQuestions: string[];
  surfaceNormalized?: string;
  confidence: number;
  priorityScore?: number;
  rawNotes?: string;
};

export type AdminBugReportDetail = AdminBugReportSummary & {
  schemaVersion: string;
  payload: Record<string, unknown>;
  triageJson: BugTriageV1 | null;
  comments?: BugReportComment[];
};

export type AdminBugReportList = {
  total: number;
  limit: number;
  offset: number;
  items: AdminBugReportSummary[];
};

export type AdminBugListFilters = {
  status?: BugReportStatus | "";
  priority?: BugReportPriority | "";
  surface?: string;
  q?: string;
  assigneeUserId?: string;
  limit?: number;
  offset?: number;
};

export type RuntimeRunSummary = {
  id: string;
  externalTraceId: string;
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  localInstallationId: string | null;
  managedRuntimeInstanceId: string | null;
  managedRuntimeSessionId: string | null;
  sessionKey: string;
  sessionName: string | null;
  runId: string | null;
  agentRef: string | null;
  placement: string;
  runtimeProvider: string;
  runtimeModel: string | null;
  sourceAccountId: string | null;
  sourceChannel: string | null;
  sourceChatId: string | null;
  sourceThreadId: string | null;
  canonicalChatId: string | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
  turnCount: number;
  eventCount: number;
  toolCallCount: number;
  warningCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  lastSafePreview: string | null;
  lastErrorPreview: string | null;
};

export type RuntimeRunsData = {
  scope: "organization" | "project";
  projectId: string | null;
  runs: RuntimeRunSummary[];
};

export type RuntimeRunTurn = {
  id: string;
  sourceTurnId: string | null;
  runtimeLeaseId: string | null;
  sandboxId: string | null;
  sequence: number;
  status: string;
  promptSha256: string | null;
  userPromptSha256: string | null;
  systemPromptSha256: string | null;
  requestBlobSha256: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: string | null;
  startedAt: number;
  completedAt: number | null;
};

export type RuntimeRunEvent = {
  id: string;
  turnId: string | null;
  sourceEventId: string;
  runtimeLeaseId: string | null;
  sandboxId: string | null;
  sequence: number;
  eventType: string;
  eventGroup: string;
  severity: string;
  status: string | null;
  safePreview: string | null;
  safePayload: Record<string, unknown>;
  blobRef: string | null;
  occurredAt: number;
};

export type RuntimeRunToolCall = {
  id: string;
  turnId: string | null;
  runtimeLeaseId: string | null;
  sandboxId: string | null;
  toolCallId: string | null;
  toolName: string;
  status: string;
  inputPreview: string | null;
  outputPreview: string | null;
  inputBlobRef: string | null;
  outputBlobRef: string | null;
  approval: Record<string, unknown>;
  durationMs: number | null;
  startedAt: number;
  completedAt: number | null;
};

export type RuntimeRunBlobRef = {
  id: string;
  turnId: string | null;
  runtimeLeaseId: string | null;
  sandboxId: string | null;
  kind: string;
  sha256: string;
  sizeBytes: number;
  sensitivity: string;
  retentionClass: string;
  createdAt: number;
};

export type RuntimeRunDetail = {
  summary: RuntimeRunSummary;
  turns: RuntimeRunTurn[];
  events: RuntimeRunEvent[];
  toolCalls: RuntimeRunToolCall[];
  blobs: RuntimeRunBlobRef[];
};

export type ConsoleFeatureKey =
  | "console.projects"
  | "console.artifacts"
  | "console.knowledge"
  | "console.library"
  | "console.pages"
  | "console.pages.custom_domains"
  | "console.pages.chat"
  | "console.domains"
  | "console.mail"
  | "console.meetings"
  | "console.channels"
  | "console.runtime_runs"
  | "console.github"
  | "console.connectors"
  | "console.audit"
  | "console.feedback"
  | "console.bugs"
  | "console.bases"
  | "console.billing"
  | "console.settings"
  | "console.event_plane"
  | "console.managed_runtime"
  | "console.cloud_agents"
  | "console.internal_control";

export type ConsoleFeatureCategory =
  | "core"
  | "pages"
  | "communication"
  | "operations"
  | "integrations"
  | "admin"
  | "internal";

export type ConsoleFeatureAccessSource = "default" | "plan" | "entitlement" | "disabled";

export type ConsoleFeatureAccessReason =
  | "allowed"
  | "entitlement_required"
  | "entitlement_disabled"
  | "plan_denied"
  | "role_denied";

export type ConsoleFeatureAccessItem = {
  key: ConsoleFeatureKey;
  label: string;
  category: ConsoleFeatureCategory;
  description: string;
  available: boolean;
  authorized: boolean;
  enabled: boolean;
  visible: boolean;
  source: ConsoleFeatureAccessSource;
  reason: ConsoleFeatureAccessReason;
  requiredRoles: string[];
  entitlementKey: string;
  plan: string;
  requestable: boolean;
};

export type ConsoleFeatureAccessData = {
  organizationId: string;
  plan: string;
  role: string;
  features: ConsoleFeatureAccessItem[];
  byKey: Record<ConsoleFeatureKey, ConsoleFeatureAccessItem>;
};

export type MailDomainStatus = "pending" | "verified" | "disabled" | "deleted";
export type MailMailboxStatus = "active" | "disabled" | "deleted";
export type MailMessageDirection = "inbound" | "outbound";
export type MailMessageStatus = "received" | "queued" | "sent" | "delivered" | "failed" | "rejected" | "deleted";

export type DomainClaimSummary = {
  id: string;
  domain: string;
  displayDomain: string;
  ownershipMode: "ravi_managed" | "customer_managed";
  status: "pending" | "active" | "disabled" | "deleted";
  verificationStatus: "pending" | "verified" | "failed" | "expired";
  verificationMethod: string;
  verification: {
    expected?: {
      name?: string;
      type?: string;
      value?: string;
    };
    lastCheck?: unknown;
    lastCheckedAt?: string;
    schemaVersion?: number;
  };
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DomainBindingSummary = {
  id: string;
  claimId: string;
  product: "pages" | "mail";
  hostname: string;
  status: "pending" | "active" | "disabled" | "deleted" | "failed";
  readiness: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type DomainClaimsData = {
  claims: DomainClaimSummary[];
  bindings: DomainBindingSummary[];
};

export type MailDomainSummary = {
  id: string;
  domain: string;
  status: MailDomainStatus;
  providerAdapter: string;
  managed: boolean;
  mailboxCount: number;
  routeCount: number;
  updatedAt: number;
};

export type MailboxSummary = {
  id: string;
  address: string;
  localPart: string;
  domainId: string;
  domain: string;
  projectId: string | null;
  projectName: string | null;
  agentId: string | null;
  status: MailMailboxStatus;
  defaultVisibility: Visibility;
  keyScope: string;
  routeCount: number;
  messageCount: number;
  lastMessageAt: number | null;
  updatedAt: number;
};

export type MailMessageSummary = {
  bodyHtml: string | null;
  bodyPreview: string | null;
  bodyText: string | null;
  cc: string[];
  decrypted: boolean;
  decryptError: string | null;
  from: string[];
  id: string;
  internetMessageId: string | null;
  mailboxId: string;
  direction: MailMessageDirection;
  status: MailMessageStatus;
  hasAddressSummary: boolean;
  hasParsedBody: boolean;
  hasSubject: boolean;
  fromHash: string | null;
  sizeBytes: number | null;
  subject: string | null;
  to: string[];
  receivedAt: number | null;
  sentAt: number | null;
  updatedAt: number;
};

export type MailOverviewData = {
  scope: "organization" | "project";
  projectId: string | null;
  domains: MailDomainSummary[];
  mailboxes: MailboxSummary[];
  messages: MailMessageSummary[];
  managedDomains: string[];
  agentAddressPattern: {
    canonicalExample: string;
    aliasCandidate: string;
    plusAddressingReserved: boolean;
  };
};

export type GithubAppRepository = {
  defaultBranch: string | null;
  fullName: string;
  id: string;
  name: string;
  selected: boolean;
  visibility: string | null;
};

/** A GitHub App installation linked to the organization. */
export type GithubAppConnection = {
  id: string;
  accountId: string | null;
  accountLogin: string | null;
  accountType: string | null;
  capabilities: string[];
  displayName: string;
  grantedAt: string;
  githubUrl: string | null;
  installationId: string;
  repositories: GithubAppRepository[];
  repositorySelection: string | null;
  requiresReauth: boolean;
  status: string;
  updatedAt: string;
};

/** An installation of the Ravi app that the signed-in GitHub user can reach. */
export type GithubAvailableInstallation = {
  accountId: string | null;
  accountLogin: string;
  accountType: string | null;
  avatarUrl: string | null;
  githubUrl: string | null;
  installationId: string;
  linked: boolean;
  repositorySelection: string | null;
  suspended: boolean;
};

export type OrganizationGithubConfig = {
  /** Null until the person signs in with GitHub in this browser. */
  available: GithubAvailableInstallation[] | null;
  callbackUrl: string;
  canManage: boolean;
  configured: { install: boolean; signIn: boolean };
  connectUrl: string;
  connections: GithubAppConnection[];
  githubLogin: string | null;
  installUrl: string;
  setupUrl: string;
  supportedEventTypes: string[];
  webhookUrl: string;
};

/** A project uses its organization's GitHub installations. */
export type ProjectGithubAppConfig = {
  connections: GithubAppConnection[];
  manageUrl: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  supportedEventTypes: string[];
};

export type ManagedRaviDesiredState = "running" | "stopped" | "deleted";

export type ManagedRaviObservedState =
  | "provisioning"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "restarting"
  | "degraded"
  | "deleting"
  | "deleted"
  | "failed";

export type ManagedRaviOperationAction =
  | "create"
  | "start"
  | "stop"
  | "restart"
  | "retry"
  | "delete"
  | "backup"
  | "restore"
  | "rotate_controller";

export type ManagedRaviOperation = {
  id: string;
  action: ManagedRaviOperationAction;
  status: "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
  phase: string | null;
  progressPercent: number;
  attemptCount: number;
  failureCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ManagedRaviConnection = {
  id: string;
  kind: "private_ravi_sdk" | "remote_relay";
  status: "connecting" | "online" | "stale" | "offline" | "revoked";
  protocolVersion: string;
  lastConnectedAt: string | null;
  lastHeartbeatAt: string | null;
  revokedAt: string | null;
};

export type ManagedRaviInstance = {
  id: string;
  projectId: string;
  displayName: string;
  desiredState: ManagedRaviDesiredState;
  observedState: ManagedRaviObservedState;
  provisioningPhase: string | null;
  failureCode: string | null;
  runtimeProvider: "codex";
  runtimeModel: string | null;
  runtimeVersion: string | null;
  placementClass: string;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ManagedRaviBackup = {
  backupRef: string;
  contentDigest: string;
  createdAt: string;
  operationId: string;
  sizeBytes: number;
  sourceVmId: string;
};

export type ManagedRaviAggregate = {
  version?: 1;
  instance: ManagedRaviInstance;
  latestOperation: ManagedRaviOperation | null;
  connections: ManagedRaviConnection[];
  backups: ManagedRaviBackup[];
};

export type ManagedRaviInstancesData = {
  version: 1;
  items: ManagedRaviAggregate[];
};

export type ManagedRaviSession = {
  id: string;
  instanceId: string;
  sessionKey: string;
  runtimeProvider: "codex";
  runtimeModel: string | null;
  status: string;
  startedAt: string | null;
  updatedAt: string;
};

export type ManagedRaviCommandAction = "session_sync" | "prompt_send" | "turn_interrupt";
export type ManagedRaviCommandStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";

export type ManagedRaviCommand = {
  id: string;
  instanceId: string;
  sessionId: string | null;
  action: ManagedRaviCommandAction;
  status: ManagedRaviCommandStatus;
  phase: string | null;
  attemptCount: number;
  failureCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
};

export type ManagedRaviSessionData = {
  version: 1;
  session: ManagedRaviSession;
  commands: ManagedRaviCommand[];
  latestEventSequence: number;
};

export type ManagedRaviSessionEvent = {
  id: string;
  commandId: string;
  eventType: string;
  sequence: number;
  severity: "debug" | "info" | "warning" | "error";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ManagedRaviSessionEventsData = {
  version: 1;
  items: ManagedRaviSessionEvent[];
  nextSequence: number;
};

export type ManagedRaviCommandResponse = {
  version: 1;
  command: ManagedRaviCommand;
};

export type RaviControlChatBinding = {
  id: string;
  installationId: string;
  targetAgentId: string;
  status: "pending" | "active" | "stale" | "revoked";
  bindingVersion: number;
  lastSyncedAt: string | null;
  updatedAt: string;
};

export type RaviControlChatMessage = {
  id: string;
  mirrorId: string;
  operationId: string | null;
  clientMessageId: string;
  replyToMessageId: string | null;
  actorType: string;
  actorId: string | null;
  status: "queued" | "accepted" | "canonical" | "failed";
  content: Record<string, unknown>;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RaviControlOperation = {
  id: string;
  action: "chat_message_create" | "chat_sync" | "turn_interrupt";
  status: ManagedRaviCommandStatus;
  phase: string | null;
  failureCode: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RaviControlChatData = {
  version: 1;
  installation: Pick<
    ManagedRaviInstance,
    "id" | "displayName" | "observedState" | "runtimeProvider" | "runtimeModel"
  > & { connectionStatus: string | null };
  binding: RaviControlChatBinding | null;
  messages: RaviControlChatMessage[];
};

export type RaviControlMessageResponse = {
  version: 1;
  duplicate: boolean;
  binding: RaviControlChatBinding;
  message: RaviControlChatMessage;
  operation: RaviControlOperation;
};

export type RaviControlOperationResponse = {
  version: 1;
  binding: RaviControlChatBinding;
  operation: RaviControlOperation;
};

export type RaviControlProjectSummary = Pick<Project, "id" | "name" | "slug">;

export type RaviControlInstallationSummary = ManagedRaviAggregate & {
  project: RaviControlProjectSummary;
};

export type RaviControlInstallationsData = {
  version: 1;
  organization: Pick<Org, "id" | "name" | "slug">;
  projects: RaviControlProjectSummary[];
  items: RaviControlInstallationSummary[];
};

export type OrganizationSettingsData = { id: string; name: string; slug: string };

export type SettingsData = {
  canManageMembers: boolean;
  currentRole: OrganizationRole;
  currentUserId: string;
  id: string;
  name: string;
  slug: string;
  visibility: Visibility;
  members: Member[];
};

export function relTime(input: number | Date | null | undefined) {
  if (!input) return "none";
  const value = input instanceof Date ? input.getTime() : input;
  const diff = Math.max(0, Date.now() - value);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function markFor(value: string | null | undefined) {
  return (value?.trim() || "?").slice(0, 1).toUpperCase();
}

export function colorFor(value: string | null | undefined): AvatarColor {
  const input = value?.trim() || "ravi";
  let hash = 0;
  for (const char of input) hash = (hash + char.charCodeAt(0)) % 5;
  return `c${hash + 1}` as AvatarColor;
}
