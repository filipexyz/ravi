import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type JsonRecord = Record<string, unknown>;

const emptyJson = sql<JsonRecord>`'{}'::jsonb`;
const emptyJsonArray = sql<string[]>`'[]'::jsonb`;
const emptyJsonRecordArray = sql<JsonRecord[]>`'[]'::jsonb`;

const lifecycleColumns = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const userStatus = pgEnum("user_status", [
  "active",
  "disabled",
  "deleted",
]);

export const organizationStatus = pgEnum("organization_status", [
  "active",
  "suspended",
  "deleted",
]);

export const membershipStatus = pgEnum("membership_status", [
  "active",
  "invited",
  "suspended",
  "removed",
]);

export const organizationRole = pgEnum("organization_role", [
  "owner",
  "admin",
  "developer",
  "viewer",
  "billing",
]);

export const projectStatus = pgEnum("project_status", [
  "active",
  "archived",
  "deleted",
]);

export const projectRole = pgEnum("project_role", [
  "project_admin",
  "developer",
  "viewer",
]);

export const environmentName = pgEnum("environment_name", [
  "development",
  "preview",
  "production",
]);

export const environmentStatus = pgEnum("environment_status", [
  "active",
  "paused",
  "archived",
]);

export const visibility = pgEnum("visibility", [
  "public",
  "private",
  "protected_link",
]);

export const pageVisibility = pgEnum("page_visibility", [
  "public",
  "private",
  "protected_link",
  "password",
]);

export const artifactStatus = pgEnum("artifact_status", [
  "active",
  "archived",
  "deleted",
]);

export const artifactVersionStatus = pgEnum("artifact_version_status", [
  "created",
  "building",
  "ready",
  "failed",
  "archived",
]);

export const deploymentStatus = pgEnum("deployment_status", [
  "queued",
  "building",
  "deployed",
  "failed",
  "archived",
  "rolled_back",
]);

export const pageSiteStatus = pgEnum("page_site_status", [
  "active",
  "disabled",
  "deleted",
]);

export const pageRouteStatus = pgEnum("page_route_status", [
  "active",
  "disabled",
  "deleted",
]);

export const pagePasswordPolicyStatus = pgEnum("page_password_policy_status", [
  "active",
  "disabled",
]);

export const pageRouteMatchType = pgEnum("page_route_match_type", [
  "exact",
  "prefix",
  "spa",
]);

export const pageSiteReleaseStatus = pgEnum("page_site_release_status", [
  "draft",
  "active",
  "archived",
  "failed",
]);

export const pagePublishStatus = pgEnum("page_publish_status", [
  "started",
  "uploading",
  "validating",
  "completed",
  "failed",
]);

export const pageUploadSessionStatus = pgEnum("page_upload_session_status", [
  "created",
  "uploading",
  "uploaded",
  "finalized",
  "expired",
  "failed",
]);

export const pageCommentStatus = pgEnum("page_comment_status", [
  "open",
  "resolved",
  "deleted",
]);

export const pageCaptureMode = pgEnum("page_capture_mode", [
  "thumbnail",
  "full_page",
  "segmented",
]);

export const pageCaptureStatus = pgEnum("page_capture_status", [
  "pending",
  "capturing",
  "ready",
  "failed",
]);

export const pageCaptureImageRole = pgEnum("page_capture_image_role", [
  "thumbnail",
  "full_page",
  "segment",
]);

export const domainOwnershipMode = pgEnum("domain_ownership_mode", [
  "ravi_managed",
  "customer_managed",
]);

export const domainClaimStatus = pgEnum("domain_claim_status", [
  "pending",
  "active",
  "disabled",
  "deleted",
]);

export const domainVerificationStatus = pgEnum("domain_verification_status", [
  "pending",
  "verified",
  "failed",
  "expired",
]);

export const domainBindingProduct = pgEnum("domain_binding_product", [
  "pages",
  "mail",
]);

export const domainBindingStatus = pgEnum("domain_binding_status", [
  "pending",
  "active",
  "disabled",
  "deleted",
  "failed",
]);

export const pagesClaimCodeStatus = pgEnum("pages_claim_code_status", [
  "active",
  "consumed",
  "expired",
  "revoked",
]);

export const pagesSessionStatus = pgEnum("pages_session_status", [
  "active",
  "revoked",
  "expired",
]);

export const mailDomainStatus = pgEnum("mail_domain_status", [
  "pending",
  "verified",
  "disabled",
  "deleted",
]);

export const mailMailboxStatus = pgEnum("mail_mailbox_status", [
  "active",
  "disabled",
  "deleted",
]);

export const mailKeyScope = pgEnum("mail_key_scope", [
  "organization",
  "project",
  "mailbox",
  "agent",
]);

export const mailRouteMatchType = pgEnum("mail_route_match_type", [
  "exact",
  "local_part",
  "catch_all",
  "pattern",
]);

export const mailRouteAction = pgEnum("mail_route_action", [
  "deliver",
  "reject",
  "drop",
  "forward",
]);

export const mailRouteStatus = pgEnum("mail_route_status", [
  "active",
  "disabled",
  "deleted",
]);

export const mailThreadStatus = pgEnum("mail_thread_status", [
  "active",
  "archived",
  "deleted",
]);

export const mailMessageDirection = pgEnum("mail_message_direction", [
  "inbound",
  "outbound",
]);

export const mailMessageStatus = pgEnum("mail_message_status", [
  "received",
  "queued",
  "sent",
  "delivered",
  "failed",
  "rejected",
  "deleted",
]);

export const mailAttachmentStatus = pgEnum("mail_attachment_status", [
  "unscanned",
  "available",
  "quarantined",
  "deleted",
]);

export const mailDeliveryEventStatus = pgEnum("mail_delivery_event_status", [
  "recorded",
  "ignored",
  "failed",
]);

export const mailKeyRefStatus = pgEnum("mail_key_ref_status", [
  "active",
  "rotated",
  "revoked",
]);

export const actorType = pgEnum("actor_type", [
  "user",
  "agent",
  "api_key",
  "cli",
  "system",
  "anonymous",
]);

export const knowledgeSourceType = pgEnum("knowledge_source_type", [
  "manual_note",
  "file_upload",
  "artifact",
  "meeting",
  "mail_thread",
  "calendar_event",
  "github_repository",
  "ravi_page",
  "provider_resource",
  "external_rag_collection",
]);

export const knowledgeSourceStatus = pgEnum("knowledge_source_status", [
  "active",
  "disabled",
  "revoked",
  "deleted",
]);

export const knowledgeSensitivity = pgEnum("knowledge_sensitivity", [
  "standard",
  "confidential",
  "restricted",
]);

export const knowledgeDocumentStatus = pgEnum("knowledge_document_status", [
  "created",
  "parsed",
  "chunked",
  "indexed",
  "failed",
  "archived",
]);

export const knowledgeChunkStatus = pgEnum("knowledge_chunk_status", [
  "active",
  "redacted",
  "deleted",
]);

export const knowledgeIngestionJobStatus = pgEnum("knowledge_ingestion_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
]);

export const knowledgeIndexStatus = pgEnum("knowledge_index_status", [
  "active",
  "rebuilding",
  "stale",
  "disabled",
  "deleted",
]);

export const knowledgeRetrievalStrategyStatus = pgEnum("knowledge_retrieval_strategy_status", [
  "active",
  "disabled",
]);

export const knowledgeRetrievalRunStatus = pgEnum("knowledge_retrieval_run_status", [
  "completed",
  "denied",
  "failed",
]);

export const knowledgeTrustTier = pgEnum("knowledge_trust_tier", [
  "approved",
  "published",
  "said",
  "inferred",
]);

export const knowledgeProposalKind = pgEnum("knowledge_proposal_kind", [
  "note",
  "gap",
  "correction",
  "transcript",
]);

export const knowledgeProposalStatus = pgEnum("knowledge_proposal_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "withdrawn",
]);

export const apiKeyStatus = pgEnum("api_key_status", [
  "active",
  "revoked",
  "expired",
]);

export const billingStatus = pgEnum("billing_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "disabled",
]);

export const billingContractStatus = pgEnum("billing_contract_status", [
  "active",
  "ended",
]);

export const billingContractItemKind = pgEnum("billing_contract_item_kind", [
  "fixed",
  "metered",
]);

export const billingInvoiceStatus = pgEnum("billing_invoice_status", [
  "draft",
  "issued",
  "paid",
  "overdue",
  "canceled",
  "refunded",
]);

export const localInstallationStatus = pgEnum("local_installation_status", [
  "active",
  "revoked",
  "decommissioned",
]);

/**
 * Who the credential belongs to: a person (`user`, the `ravi login` path) or
 * the installation itself (`installation`, issued by a bootstrap token). An
 * installation credential is scoped to its own installation only.
 */
export const installationSubjectType = pgEnum("installation_subject_type", [
  "user",
  "installation",
]);

/** Desired-vs-observed lifecycle from console/managed-runtime (installations). */
export const installationState = pgEnum("installation_state", [
  "requested",
  "bootstrapped",
  "configured",
  "healthy",
  "live",
  "blocked_human",
  "drifted",
  "degraded",
  "revoked",
  "decommissioned",
]);

export const raviActorBindingStatus = pgEnum("ravi_actor_binding_status", [
  "active",
  "revoked",
]);

export const raviLinkRequestStatus = pgEnum("ravi_link_request_status", [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);

export const meetingBotStatus = pgEnum("meeting_bot_status", [
  "requested",
  "joining",
  "waiting_room",
  "in_call",
  "recording",
  "ended",
  "done",
  "failed",
]);

export const runtimeHostStatus = pgEnum("runtime_host_status", [
  "provisioning",
  "active",
  "degraded",
  "draining",
  "disabled",
]);

export const runtimeImageStatus = pgEnum("runtime_image_status", [
  "building",
  "active",
  "deprecated",
  "disabled",
]);

export const runtimeLeaseStatus = pgEnum("runtime_lease_status", [
  "requested",
  "assigned",
  "booting",
  "running",
  "draining",
  "completed",
  "failed",
  "expired",
  "revoked",
]);

export const managedRuntimeInstanceStatus = pgEnum("managed_runtime_instance_status", [
  "provisioning",
  "active",
  "degraded",
  "draining",
  "disabled",
  "deleted",
]);

export const managedRuntimeDesiredState = pgEnum("managed_runtime_desired_state", [
  "running",
  "stopped",
  "deleted",
]);

export const managedRuntimeObservedState = pgEnum("managed_runtime_observed_state", [
  "provisioning",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "restarting",
  "degraded",
  "deleting",
  "deleted",
  "failed",
]);

export const managedRuntimeOperationAction = pgEnum("managed_runtime_operation_action", [
  "create",
  "start",
  "stop",
  "restart",
  "retry",
  "delete",
  "backup",
  "restore",
  "rotate_controller",
]);

export const managedRuntimeOperationStatus = pgEnum("managed_runtime_operation_status", [
  "pending",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const managedRuntimeCommandAction = pgEnum("managed_runtime_command_action", [
  "session_sync",
  "prompt_send",
  "turn_interrupt",
  "chat_message_create",
  "chat_sync",
]);

export const managedRuntimeCommandStatus = pgEnum("managed_runtime_command_status", [
  "pending",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const raviControlChatBindingStatus = pgEnum(
  "ravi_control_chat_binding_status",
  ["pending", "active", "stale", "revoked"],
);

export const raviControlMessageMirrorStatus = pgEnum(
  "ravi_control_message_mirror_status",
  ["queued", "accepted", "canonical", "failed"],
);

export const managedRuntimeConnectionKind = pgEnum("managed_runtime_connection_kind", [
  "private_ravi_sdk",
  "remote_relay",
]);

export const managedRuntimeConnectionStatus = pgEnum("managed_runtime_connection_status", [
  "connecting",
  "online",
  "stale",
  "offline",
  "revoked",
]);

export const managedRuntimeSessionStatus = pgEnum("managed_runtime_session_status", [
  "starting",
  "active",
  "idle",
  "completed",
  "failed",
  "interrupted",
  "expired",
]);

export const managedRuntimeEventSeverity = pgEnum("managed_runtime_event_severity", [
  "debug",
  "info",
  "warning",
  "error",
]);

export const eventPlaneCellStatus = pgEnum("event_plane_cell_status", [
  "provisioning",
  "active",
  "degraded",
  "draining",
  "disabled",
  "deleted",
]);

export const eventPlaneOrgBindingStatus = pgEnum("event_plane_org_binding_status", [
  "provisioning",
  "active",
  "suspended",
  "migrating",
  "failed",
  "deleted",
]);

export const eventPlaneIdentityType = pgEnum("event_plane_identity_type", [
  "control_service",
  "managed_runtime",
  "bridge",
  "enterprise_client",
]);

export const eventPlaneIdentityStatus = pgEnum("event_plane_identity_status", [
  "provisioning",
  "active",
  "rotating",
  "revoked",
  "expired",
  "failed",
]);

export const eventPlaneCredentialGrantStatus = pgEnum("event_plane_credential_grant_status", [
  "pending",
  "issued",
  "active",
  "revoked",
  "expired",
  "failed",
]);

export const eventPlanePolicyScopeType = pgEnum("event_plane_policy_scope_type", [
  "global",
  "cell",
  "organization",
  "identity",
]);

export const eventPlanePolicyStatus = pgEnum("event_plane_policy_status", [
  "draft",
  "active",
  "superseded",
  "revoked",
]);

export const eventPlaneCrossAccountLinkType = pgEnum("event_plane_cross_account_link_type", [
  "export",
  "import",
  "service",
]);

export const eventPlaneCrossAccountLinkStatus = pgEnum("event_plane_cross_account_link_status", [
  "proposed",
  "active",
  "suspended",
  "revoked",
]);

export const eventPlaneControlOperationStatus = pgEnum("event_plane_control_operation_status", [
  "started",
  "completed",
  "failed",
]);

export const managedExecutionHarnessStatus = pgEnum("managed_execution_harness_status", [
  "draft",
  "active",
  "disabled",
  "deleted",
]);

export const managedExecutionToolProjectionStatus = pgEnum("managed_execution_tool_projection_status", [
  "active",
  "disabled",
]);

export const cliSessionStatus = pgEnum("cli_session_status", [
  "active",
  "revoked",
  "expired",
]);

export const cliDeviceAuthorizationStatus = pgEnum(
  "cli_device_authorization_status",
  ["pending", "approved", "consumed", "expired", "denied"],
);

export const agentInboxSeverity = pgEnum("agent_inbox_severity", [
  "info",
  "success",
  "warning",
  "error",
  "action_required",
]);

export const agentInboxSensitivity = pgEnum("agent_inbox_sensitivity", [
  "metadata",
  "customer_data",
  "secret_adjacent",
  "restricted",
]);

export const agentInboxSubscriptionStatus = pgEnum("agent_inbox_subscription_status", [
  "active",
  "paused",
  "revoked",
]);

export const agentInboxDeliveryMode = pgEnum("agent_inbox_delivery_mode", [
  "poll",
]);

export const agentInboxReceiptStatus = pgEnum("agent_inbox_receipt_status", [
  "leased",
  "delivered",
  "read",
  "resolved",
  "failed",
  "skipped",
]);

export const agentInboxOutboxStatus = pgEnum("agent_inbox_outbox_status", [
  "pending",
  "publishing",
  "published",
  "failed",
  "dead_letter",
]);

export const connectorStatus = pgEnum("connector_status", [
  "active",
  "degraded",
  "suspended",
  "revoke_pending",
  "revoked_by_user",
  "revoked_by_operator",
  "revoked_by_provider",
  "tampered",
]);

export const consoleWatchPlacement = pgEnum("console_watch_placement", [
  "console",
  "local",
  "auto",
]);

export const consoleWatchStatus = pgEnum("console_watch_status", [
  "active",
  "disabled",
  "deleted",
  "degraded",
]);

export const providerWebhookDeliveryStatus = pgEnum(
  "provider_webhook_delivery_status",
  ["received", "matched", "ignored", "failed"],
);

export const channelHostProvider = pgEnum("channel_host_provider", ["omni"]);

export const channelHostEnvironment = pgEnum("channel_host_environment", [
  "production",
  "staging",
  "development",
]);

export const channelHostTenantMode = pgEnum("channel_host_tenant_mode", [
  "shared",
  "dedicated",
]);

export const channelHostStatus = pgEnum("channel_host_status", [
  "active",
  "degraded",
  "disabled",
]);

export const channelInstanceChannel = pgEnum("channel_instance_channel", [
  "whatsapp",
]);

export const channelInstanceProvider = pgEnum("channel_instance_provider", [
  "omni",
]);

export const channelInstanceStatus = pgEnum("channel_instance_status", [
  "provisioning",
  "qr_pending",
  "connected",
  "disconnected",
  "degraded",
  "disabled",
  "deleting",
  "deleted",
]);

export const channelCredentialKind = pgEnum("channel_credential_kind", [
  "omni_instance_api_key",
]);

export const channelCredentialStatus = pgEnum("channel_credential_status", [
  "active",
  "rotated",
  "revoked",
  "tampered",
]);

export const channelEventSeverity = pgEnum("channel_event_severity", [
  "info",
  "warning",
  "error",
]);

export const channelIdempotencyStatus = pgEnum("channel_idempotency_status", [
  "started",
  "completed",
  "failed",
]);

export const connectorScopeKind = pgEnum("connector_scope_kind", [
  "user",
  "organization",
  "project",
]);

export const connectorGrantOrigin = pgEnum("connector_grant_origin", [
  "cli",
  "ui",
]);

export const connectorGrantStatus = pgEnum("connector_grant_status", [
  "pending",
  "consumed",
  "expired",
  "rejected",
]);

export const connectorCredentialKind = pgEnum("connector_credential_kind", [
  "access_token",
  "refresh_token",
  "id_token",
]);

export const connectorStepupFactor = pgEnum("connector_stepup_factor", [
  "passkey",
  "totp",
  "sms",
  "password",
]);

export const connectorStepupStatus = pgEnum("connector_stepup_status", [
  "issued",
  "consumed",
  "expired",
  "rejected",
]);

export const connectorAccessMode = pgEnum("connector_access_mode", [
  "full",
  "read_only",
]);

export const connectorToolPolicy = pgEnum("connector_tool_policy", [
  "always_allow",
  "needs_approval",
  "blocked",
]);

export const connectorApprovalStatus = pgEnum("connector_approval_status", [
  "pending",
  "approved",
  "denied",
  "consumed",
  "expired",
]);

export const connectorAgentGrantMode = pgEnum("connector_agent_grant_mode", [
  "person_asking",
  "shared",
]);

export const connectorAgentGrantStatus = pgEnum("connector_agent_grant_status", [
  "active",
  "revoked",
]);

export const connectorConsentRequestStatus = pgEnum(
  "connector_consent_request_status",
  ["pending", "approved", "denied", "expired"],
);

export const connectorRevocationStatus = pgEnum("connector_revocation_status", [
  "pending",
  "done",
  "failed",
]);

export const mcpBridgeStatus = pgEnum("mcp_bridge_status", [
  "active",
  "revoked",
  "paused",
]);

export const mcpOAuthClientAuthMethod = pgEnum(
  "mcp_oauth_client_auth_method",
  ["none", "client_secret_basic"],
);

export const mcpBridgeEventType = pgEnum("mcp_bridge_event_type", [
  "connect",
  "disconnect",
  "initialize",
  "tools_list",
  "tools_call",
  "resources_read",
  "prompts_get",
  "error",
  "daemon_offline",
  "rate_limited",
]);

export const mcpBridgeEventStatusClass = pgEnum(
  "mcp_bridge_event_status_class",
  ["ok", "client_error", "server_error", "upstream_unavailable"],
);

export const bugReportSeverity = pgEnum("bug_report_severity", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const bugReportStatus = pgEnum("bug_report_status", [
  "submitted",
  "triaging",
  "in_progress",
  "resolved",
  "wontfix",
  "duplicate",
]);

export const bugReportPriority = pgEnum("bug_report_priority", [
  "p0",
  "p1",
  "p2",
  "p3",
]);

export const bugTriageJobStatus = pgEnum("bug_triage_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const bugTriageJobTrigger = pgEnum("bug_triage_job_trigger", [
  "create",
  "manual",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    primaryEmail: text("primary_email").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    status: userStatus("status").default("active").notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("users_primary_email_unique").on(table.primaryEmail),
    index("users_status_idx").on(table.status),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: organizationStatus("status").default("active").notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("organizations_slug_unique").on(table.slug),
    index("organizations_status_idx").on(table.status),
  ],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: organizationRole("role").default("developer").notNull(),
    status: membershipStatus("status").default("active").notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("organization_memberships_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    index("organization_memberships_user_idx").on(table.userId),
    index("organization_memberships_role_idx").on(table.role),
  ],
);

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email"),
    rawProfileJson: jsonb("raw_profile_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("auth_identities_provider_user_unique").on(
      table.provider,
      table.providerUserId,
    ),
    index("auth_identities_user_idx").on(table.userId),
  ],
);

export const consoleBrowserSessions = pgTable(
  "console_browser_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    authIdentityId: uuid("auth_identity_id").notNull().references(() => authIdentities.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    oidcGroups: jsonb("oidc_groups").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("console_browser_sessions_token_hash_unique").on(table.tokenHash),
    index("console_browser_sessions_user_idx").on(table.userId),
    index("console_browser_sessions_expires_idx").on(table.expiresAt),
  ],
);

// Fleet values are Vault references/metadata only. Never add a plaintext secret column.
export const fleetCredentials = pgTable("fleet_credentials", {
  id: uuid("id").notNull(), organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  label: text("label").notNull(), kind: text("kind").notNull(), bindingJson: jsonb("binding_json").default(sql`'null'::jsonb`).notNull(),
  revision: integer("revision").notNull(), secretVersion: integer("secret_version").notNull(), status: text("status").notNull(),
  ...lifecycleColumns(),
}, table => [primaryKey({ columns: [table.organizationId, table.id] }),
  check("fleet_credentials_kind_check", sql`${table.kind} IN ('ssh_private_key','oidc_client_secret')`),
  check("fleet_credentials_revision_check", sql`${table.revision}>0`), check("fleet_credentials_secret_version_check", sql`${table.secretVersion}>0`),
  check("fleet_credentials_status_check", sql`${table.status} IN ('active','revoked')`)]);

export const fleetInstallations = pgTable("fleet_installations", {
  id: uuid("id").notNull(), organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  label: text("label").notNull(), hostname: text("hostname").notNull(), port: integer("port").notNull(), username: text("username").notNull(),
  hostFingerprint: text("host_fingerprint").notNull(), credentialId: uuid("credential_id").notNull(), revision: integer("revision").notNull(),
  status: text("status").notNull(), testedCredentialRevision: integer("tested_credential_revision"),
  testedAt: timestamp("tested_at", { withTimezone: true }), cliVersion: text("cli_version"), failureCode: text("failure_code"), ...lifecycleColumns(),
}, table => [primaryKey({ columns: [table.organizationId, table.id] }),
  foreignKey({ columns: [table.organizationId, table.credentialId], foreignColumns: [fleetCredentials.organizationId, fleetCredentials.id] }),
  check("fleet_installations_port_check", sql`${table.port} BETWEEN 1 AND 65535`), check("fleet_installations_username_check", sql`${table.username}<>'root'`),
  check("fleet_installations_revision_check", sql`${table.revision}>0`), check("fleet_installations_status_check", sql`${table.status} IN ('draft','tested','active','failed')`)]);

export const fleetMutationReceipts = pgTable("fleet_mutation_receipts", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id), operationId: uuid("operation_id").notNull(),
  inputHash: text("input_hash").notNull(), resultJson: jsonb("result_json").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.organizationId, table.operationId] })]);

export const fleetIoReservations = pgTable("fleet_io_reservations", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  operationId: text("operation_id").notNull(), actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  inputHash: text("input_hash").notNull(), leaseId: uuid("lease_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.organizationId, table.operationId] })]);

export const fleetSsoConnections = pgTable("fleet_sso_connections", {
  id: uuid("id").notNull(), organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  revision: integer("revision").notNull(), status: text("status").notNull(), issuer: text("issuer").notNull(), clientId: text("client_id").notNull(),
  credentialId: uuid("credential_id").notNull(), credentialVersion: integer("credential_version").notNull(), configJson: jsonb("config_json").default(emptyJson).notNull(),
  testedAt: timestamp("tested_at", { withTimezone: true }), testedBy: uuid("tested_by").references(() => users.id),
  testedSessionHash: text("tested_session_hash"), testedSubject: text("tested_subject"), testedEmail: text("tested_email"), testedGroups: jsonb("tested_groups"), ...lifecycleColumns(),
}, table => [primaryKey({ columns: [table.organizationId, table.id] }),
  foreignKey({ columns: [table.organizationId, table.credentialId], foreignColumns: [fleetCredentials.organizationId, fleetCredentials.id] }),
  uniqueIndex("fleet_sso_one_active").on(table.organizationId).where(sql`${table.status}='active'`),
  check("fleet_sso_connections_revision_check", sql`${table.revision}>0`), check("fleet_sso_connections_credential_version_check", sql`${table.credentialVersion}>0`),
  check("fleet_sso_connections_status_check", sql`${table.status} IN ('draft','tested','active','retired')`)]);

export const fleetSsoChallenges = pgTable("fleet_sso_challenges", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id), id: uuid("id").notNull(), connectionId: uuid("connection_id").notNull(),
  connectionRevision: integer("connection_revision").notNull(), credentialVersion: integer("credential_version").notNull(), actorId: uuid("actor_id").notNull().references(() => users.id),
  sessionHash: text("session_hash").notNull(), stateHash: text("state_hash").notNull().unique(), inputHash: text("input_hash").notNull(),
  transactionCiphertext: text("transaction_ciphertext").notNull(), authorizationUrl: text("authorization_url").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, table => [primaryKey({ columns: [table.organizationId, table.id] }),
  foreignKey({ columns: [table.organizationId, table.connectionId], foreignColumns: [fleetSsoConnections.organizationId, fleetSsoConnections.id] })]);

export const fleetBootstrapGrants = pgTable("fleet_bootstrap_grants", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id), tokenHash: text("token_hash").notNull(),
  expectedEmail: text("expected_email").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }), claimedBy: uuid("claimed_by").references(() => users.id),
  attemptId: uuid("attempt_id"), stateHash: text("state_hash"), transactionCiphertext: text("transaction_ciphertext"), authorizationUrl: text("authorization_url"),
  attemptExpiresAt: timestamp("attempt_expires_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const fleetOnboarding = pgTable("fleet_onboarding", {
  flowVersion: integer("flow_version").notNull().default(1),
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id), completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  completedBy: uuid("completed_by").notNull().references(() => users.id), snapshotHash: text("snapshot_hash").notNull(),
});

export const authOrganizationLinks = pgTable(
  "auth_organization_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerOrganizationId: text("provider_organization_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("auth_organization_links_provider_unique").on(
      table.provider,
      table.providerOrganizationId,
    ),
    index("auth_organization_links_org_idx").on(table.organizationId),
  ],
);

export const platformOperators = pgTable(
  "platform_operators",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    ...lifecycleColumns(),
  },
  (table) => [index("platform_operators_source_idx").on(table.source)],
);

export const authMembershipLinks = pgTable(
  "auth_membership_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerMembershipId: text("provider_membership_id").notNull(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("auth_membership_links_provider_unique").on(
      table.provider,
      table.providerMembershipId,
    ),
    index("auth_membership_links_membership_idx").on(table.membershipId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: projectStatus("status").default("active").notNull(),
    defaultVisibility: visibility("default_visibility")
      .default("private")
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("projects_org_slug_unique").on(table.organizationId, table.slug),
    index("projects_org_idx").on(table.organizationId),
    index("projects_status_idx").on(table.status),
  ],
);

export const projectMemberships = pgTable(
  "project_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: projectRole("role").default("developer").notNull(),
    status: membershipStatus("status").default("active").notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("project_memberships_project_user_unique").on(
      table.projectId,
      table.userId,
    ),
    index("project_memberships_user_idx").on(table.userId),
  ],
);

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: environmentName("name").notNull(),
    status: environmentStatus("status").default("active").notNull(),
    defaultVisibility: visibility("default_visibility")
      .default("private")
      .notNull(),
    deploymentPolicyJson: jsonb("deployment_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    quotaPolicyJson: jsonb("quota_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("environments_project_name_unique").on(table.projectId, table.name),
    index("environments_project_idx").on(table.projectId),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    localArtifactId: text("local_artifact_id"),
    visibility: visibility("visibility").default("private").notNull(),
    status: artifactStatus("status").default("active").notNull(),
    lastLocalVersion: text("last_local_version"),
    lastCloudVersion: integer("last_cloud_version"),
    syncStatus: text("sync_status").default("local_only").notNull(),
    syncMetadataJson: jsonb("sync_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("artifacts_project_slug_unique").on(table.projectId, table.slug),
    index("artifacts_project_idx").on(table.projectId),
    index("artifacts_local_artifact_idx").on(table.localArtifactId),
    index("artifacts_visibility_idx").on(table.visibility),
  ],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    status: artifactVersionStatus("status").default("created").notNull(),
    sha256: text("sha256"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sourceJson: jsonb("source_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("artifact_versions_artifact_version_unique").on(
      table.artifactId,
      table.versionNumber,
    ),
    index("artifact_versions_artifact_idx").on(table.artifactId),
    index("artifact_versions_created_at_idx").on(table.createdAt),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    artifactVersionId: uuid("artifact_version_id").references(
      () => artifactVersions.id,
      { onDelete: "set null" },
    ),
    role: text("role").default("file").notNull(),
    path: text("path").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    visibility: visibility("visibility").default("private").notNull(),
    storageJson: jsonb("storage_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    index("assets_artifact_idx").on(table.artifactId),
    index("assets_artifact_version_idx").on(table.artifactVersionId),
    index("assets_path_idx").on(table.path),
  ],
);

export const pageSites = pgTable(
  "page_sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    defaultHostname: text("default_hostname").notNull(),
    defaultVisibility: pageVisibility("default_visibility")
      .default("private")
      .notNull(),
    activeReleaseId: uuid("active_release_id"),
    isDefault: boolean("is_default").default(false).notNull(),
    status: pageSiteStatus("status").default("active").notNull(),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_sites_slug_unique").on(table.slug),
    uniqueIndex("page_sites_default_hostname_unique").on(table.defaultHostname),
    uniqueIndex("page_sites_project_default_unique")
      .on(table.projectId)
      .where(sql`${table.isDefault} = true`),
    index("page_sites_org_idx").on(table.organizationId),
    index("page_sites_project_idx").on(table.projectId),
    index("page_sites_status_idx").on(table.status),
  ],
);

export const domainClaims = pgTable(
  "domain_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    normalizedDomain: text("normalized_domain").notNull(),
    displayDomain: text("display_domain").notNull(),
    ownershipMode: domainOwnershipMode("ownership_mode")
      .default("customer_managed")
      .notNull(),
    status: domainClaimStatus("status").default("pending").notNull(),
    verificationStatus: domainVerificationStatus("verification_status")
      .default("pending")
      .notNull(),
    verificationMethod: text("verification_method").default("dns_txt").notNull(),
    verificationJson: jsonb("verification_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("domain_claims_normalized_active_unique")
      .on(table.normalizedDomain)
      .where(sql`${table.deletedAt} IS NULL`),
    index("domain_claims_org_idx").on(table.organizationId),
    index("domain_claims_status_idx").on(table.status),
    index("domain_claims_verification_idx").on(table.verificationStatus),
  ],
);

export const domainBindings = pgTable(
  "domain_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainClaimId: uuid("domain_claim_id")
      .notNull()
      .references(() => domainClaims.id, { onDelete: "cascade" }),
    product: domainBindingProduct("product").notNull(),
    hostname: text("hostname").notNull(),
    status: domainBindingStatus("status").default("pending").notNull(),
    readinessJson: jsonb("readiness_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    policyJson: jsonb("policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("domain_bindings_product_hostname_active_unique")
      .on(table.product, table.hostname)
      .where(sql`${table.status} <> 'deleted'`),
    index("domain_bindings_org_idx").on(table.organizationId),
    index("domain_bindings_claim_idx").on(table.domainClaimId),
    index("domain_bindings_product_idx").on(table.product),
    index("domain_bindings_status_idx").on(table.status),
  ],
);

export const pageDomainBindings = pgTable(
  "page_domain_bindings",
  {
    domainBindingId: uuid("domain_binding_id")
      .primaryKey()
      .references(() => domainBindings.id, { onDelete: "cascade" }),
    pageSiteId: uuid("page_site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    edgeReadinessJson: jsonb("edge_readiness_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_domain_bindings_hostname_unique").on(table.hostname),
    index("page_domain_bindings_site_idx").on(table.pageSiteId),
  ],
);

export const pageRoutes = pgTable(
  "page_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    matchType: pageRouteMatchType("match_type").notNull(),
    priority: integer("priority").default(0).notNull(),
    defaultVisibility: pageVisibility("default_visibility")
      .default("private")
      .notNull(),
    visibility: pageVisibility("visibility").default("private").notNull(),
    status: pageRouteStatus("status").default("active").notNull(),
    routeConfigJson: jsonb("route_config_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_routes_site_path_match_unique").on(
      table.siteId,
      table.path,
      table.matchType,
    ),
    index("page_routes_org_idx").on(table.organizationId),
    index("page_routes_project_idx").on(table.projectId),
    index("page_routes_site_idx").on(table.siteId),
    index("page_routes_match_idx").on(table.siteId, table.matchType, table.priority),
  ],
);

export const pagePasswordPolicies = pgTable(
  "page_password_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").references(() => pageRoutes.id, {
      onDelete: "cascade",
    }),
    passwordHash: text("password_hash").notNull(),
    version: integer("version").default(1).notNull(),
    status: pagePasswordPolicyStatus("status").default("active").notNull(),
    configuredByUserId: uuid("configured_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_password_policies_site_default_unique")
      .on(table.siteId)
      .where(sql`${table.routeId} IS NULL`),
    uniqueIndex("page_password_policies_route_unique")
      .on(table.routeId)
      .where(sql`${table.routeId} IS NOT NULL`),
    index("page_password_policies_org_idx").on(table.organizationId),
    index("page_password_policies_project_idx").on(table.projectId),
    index("page_password_policies_site_idx").on(table.siteId),
    index("page_password_policies_status_idx").on(table.status),
  ],
);

export const pagePasswordSessions = pgTable(
  "page_password_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionTokenHash: text("session_token_hash").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").references(() => pageRoutes.id, {
      onDelete: "cascade",
    }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => pagePasswordPolicies.id, { onDelete: "cascade" }),
    policyVersion: integer("policy_version").notNull(),
    status: pagesSessionStatus("status").default("active").notNull(),
    issuedForHost: text("issued_for_host").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastRequestId: text("last_request_id"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_password_sessions_token_hash_unique").on(
      table.sessionTokenHash,
    ),
    index("page_password_sessions_org_idx").on(table.organizationId),
    index("page_password_sessions_project_idx").on(table.projectId),
    index("page_password_sessions_site_idx").on(table.siteId),
    index("page_password_sessions_policy_idx").on(table.policyId),
    index("page_password_sessions_status_idx").on(table.status),
    index("page_password_sessions_expires_at_idx").on(table.expiresAt),
    index("page_password_sessions_host_idx").on(table.issuedForHost),
  ],
);

export const pageSiteReleases = pgTable(
  "page_site_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    releaseNumber: integer("release_number").notNull(),
    previousReleaseId: uuid("previous_release_id"),
    status: pageSiteReleaseStatus("status").default("draft").notNull(),
    reason: text("reason"),
    manifestHash: text("manifest_hash"),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("page_site_releases_site_number_unique").on(
      table.siteId,
      table.releaseNumber,
    ),
    index("page_site_releases_org_idx").on(table.organizationId),
    index("page_site_releases_project_idx").on(table.projectId),
    index("page_site_releases_site_idx").on(table.siteId),
    index("page_site_releases_status_idx").on(table.status),
  ],
);

export const pageReleaseRoutes = pgTable(
  "page_release_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => pageSiteReleases.id, { onDelete: "cascade" }),
    routeId: uuid("route_id")
      .notNull()
      .references(() => pageRoutes.id, { onDelete: "restrict" }),
    path: text("path").notNull(),
    matchType: pageRouteMatchType("match_type").notNull(),
    priority: integer("priority").default(0).notNull(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    artifactVersionId: uuid("artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "restrict" }),
    entrypoint: text("entrypoint").default("index.html").notNull(),
    assetBase: text("asset_base").notNull(),
    visibility: pageVisibility("visibility").default("private").notNull(),
    routeConfigJson: jsonb("route_config_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("page_release_routes_release_route_unique").on(
      table.releaseId,
      table.routeId,
    ),
    index("page_release_routes_release_idx").on(table.releaseId),
    index("page_release_routes_site_idx").on(table.siteId),
    index("page_release_routes_artifact_version_idx").on(table.artifactVersionId),
    index("page_release_routes_match_idx").on(table.releaseId, table.matchType, table.priority),
  ],
);

export const pageComments = pgTable(
  "page_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").references(() => pageRoutes.id, {
      onDelete: "set null",
    }),
    releaseId: uuid("release_id").references(() => pageSiteReleases.id, {
      onDelete: "set null",
    }),
    releaseRouteId: uuid("release_route_id").references(() => pageReleaseRoutes.id, {
      onDelete: "set null",
    }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    artifactVersionId: uuid("artifact_version_id").references(
      () => artifactVersions.id,
      { onDelete: "set null" },
    ),
    path: text("path").notNull(),
    body: text("body").notNull(),
    targetJson: jsonb("target_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    status: pageCommentStatus("status").default("open").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    index("page_comments_org_idx").on(table.organizationId),
    index("page_comments_project_idx").on(table.projectId),
    index("page_comments_site_path_idx").on(table.siteId, table.path),
    index("page_comments_route_idx").on(table.routeId),
    index("page_comments_release_idx").on(table.releaseId),
    index("page_comments_author_idx").on(table.createdByUserId),
    index("page_comments_status_created_at_idx").on(table.status, table.createdAt),
  ],
);

export const pageCommentReadReceipts = pgTable(
  "page_comment_read_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadCommentCreatedAt: timestamp("last_read_comment_created_at", {
      withTimezone: true,
    }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_comment_read_receipts_site_path_user_unique").on(
      table.siteId,
      table.path,
      table.userId,
    ),
    index("page_comment_read_receipts_org_idx").on(table.organizationId),
    index("page_comment_read_receipts_project_idx").on(table.projectId),
    index("page_comment_read_receipts_user_idx").on(table.userId),
  ],
);

export const pageCaptureSets = pgTable(
  "page_capture_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    routeId: uuid("route_id")
      .notNull()
      .references(() => pageRoutes.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => pageSiteReleases.id, { onDelete: "cascade" }),
    releaseRouteId: uuid("release_route_id")
      .notNull()
      .references(() => pageReleaseRoutes.id, { onDelete: "cascade" }),
    sourceArtifactId: uuid("source_artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    sourceArtifactVersionId: uuid("source_artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "restrict" }),
    captureArtifactId: uuid("capture_artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    captureArtifactVersionId: uuid("capture_artifact_version_id").references(
      () => artifactVersions.id,
      { onDelete: "set null" },
    ),
    mode: pageCaptureMode("mode").default("thumbnail").notNull(),
    status: pageCaptureStatus("status").default("pending").notNull(),
    provider: text("provider").default("cloudflare_browser_run").notNull(),
    configHash: text("config_hash").notNull(),
    configJson: jsonb("config_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestedByActorType: actorType("requested_by_actor_type")
      .default("user")
      .notNull(),
    requestedByActorId: text("requested_by_actor_id"),
    failureCode: text("failure_code"),
    failureMetadataJson: jsonb("failure_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_capture_sets_project_idempotency_unique").on(
      table.organizationId,
      table.projectId,
      table.idempotencyKey,
    ),
    index("page_capture_sets_project_idx").on(table.projectId),
    index("page_capture_sets_site_route_idx").on(table.siteId, table.routeId),
    index("page_capture_sets_source_version_idx").on(table.sourceArtifactVersionId),
    index("page_capture_sets_status_created_at_idx").on(table.status, table.createdAt),
  ],
);

export const pageCaptureImages = pgTable(
  "page_capture_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    captureSetId: uuid("capture_set_id")
      .notNull()
      .references(() => pageCaptureSets.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    role: pageCaptureImageRole("role").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    clipJson: jsonb("clip_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("page_capture_images_set_sequence_unique").on(table.captureSetId, table.sequence),
    uniqueIndex("page_capture_images_asset_unique").on(table.assetId),
    index("page_capture_images_set_idx").on(table.captureSetId),
  ],
);

export const pagePublishes = pgTable(
  "page_publishes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    artifactVersionId: uuid("artifact_version_id").references(
      () => artifactVersions.id,
      { onDelete: "set null" },
    ),
    siteId: uuid("site_id").references(() => pageSites.id, {
      onDelete: "set null",
    }),
    siteReleaseId: uuid("site_release_id").references(() => pageSiteReleases.id, {
      onDelete: "set null",
    }),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref"),
    status: pagePublishStatus("status").default("started").notNull(),
    manifestKey: text("manifest_key"),
    manifestHash: text("manifest_hash"),
    objectCount: integer("object_count"),
    totalBytes: bigint("total_bytes", { mode: "number" }),
    visibility: visibility("visibility").default("private").notNull(),
    routeChangesJson: jsonb("route_changes_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    idempotencyKey: text("idempotency_key"),
    errorCode: text("error_code"),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_publishes_idempotency_unique")
      .on(
        table.organizationId,
        table.projectId,
        table.createdByActorType,
        table.createdByActorId,
        table.idempotencyKey,
      )
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("page_publishes_org_idx").on(table.organizationId),
    index("page_publishes_project_idx").on(table.projectId),
    index("page_publishes_site_idx").on(table.siteId),
    index("page_publishes_status_idx").on(table.status),
    index("page_publishes_created_at_idx").on(table.createdAt),
  ],
);

export const pageUploadSessions = pgTable(
  "page_upload_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => pageSites.id, {
      onDelete: "set null",
    }),
    status: pageUploadSessionStatus("status").default("created").notNull(),
    stagingPrefix: text("staging_prefix").notNull(),
    idempotencyKey: text("idempotency_key"),
    fileManifestJson: jsonb("file_manifest_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    uploadPolicyJson: jsonb("upload_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    errorCode: text("error_code"),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_upload_sessions_idempotency_unique")
      .on(
        table.organizationId,
        table.projectId,
        table.createdByActorType,
        table.createdByActorId,
        table.idempotencyKey,
      )
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("page_upload_sessions_org_idx").on(table.organizationId),
    index("page_upload_sessions_project_idx").on(table.projectId),
    index("page_upload_sessions_site_idx").on(table.siteId),
    index("page_upload_sessions_status_idx").on(table.status),
    index("page_upload_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const pagesClaimCodes = pgTable(
  "pages_claim_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: text("code_hash").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").references(() => pageRoutes.id, {
      onDelete: "set null",
    }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    artifactVersionId: uuid("artifact_version_id").references(
      () => artifactVersions.id,
      { onDelete: "set null" },
    ),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    returnUrl: text("return_url").notNull(),
    requestedHost: text("requested_host").notNull(),
    requestedPath: text("requested_path").notNull(),
    status: pagesClaimCodeStatus("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedRequestId: text("consumed_request_id"),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("pages_claim_codes_hash_unique").on(table.codeHash),
    index("pages_claim_codes_org_idx").on(table.organizationId),
    index("pages_claim_codes_project_idx").on(table.projectId),
    index("pages_claim_codes_site_idx").on(table.siteId),
    index("pages_claim_codes_user_idx").on(table.userId),
    index("pages_claim_codes_status_idx").on(table.status),
    index("pages_claim_codes_expires_at_idx").on(table.expiresAt),
  ],
);

export const pagesSessions = pgTable(
  "pages_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionTokenHash: text("session_token_hash").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: pagesSessionStatus("status").default("active").notNull(),
    issuedForHost: text("issued_for_host").notNull(),
    issuedFromClaimCodeId: uuid("issued_from_claim_code_id").references(
      () => pagesClaimCodes.id,
      { onDelete: "set null" },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastRequestId: text("last_request_id"),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("pages_sessions_token_hash_unique").on(table.sessionTokenHash),
    index("pages_sessions_org_idx").on(table.organizationId),
    index("pages_sessions_project_idx").on(table.projectId),
    index("pages_sessions_site_idx").on(table.siteId),
    index("pages_sessions_user_idx").on(table.userId),
    index("pages_sessions_status_idx").on(table.status),
    index("pages_sessions_expires_at_idx").on(table.expiresAt),
    index("pages_sessions_host_idx").on(table.issuedForHost),
  ],
);

export const pageViewerAssertionAudiences = pgTable(
  "page_viewer_assertion_audiences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    audience: text("audience").notNull(),
    origins: jsonb("origins")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    status: text("status").default("active").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_viewer_assertion_audiences_site_audience_unique").on(
      table.siteId,
      table.audience,
    ),
    index("page_viewer_assertion_audiences_org_idx").on(table.organizationId),
    index("page_viewer_assertion_audiences_project_idx").on(table.projectId),
    index("page_viewer_assertion_audiences_site_idx").on(table.siteId),
    index("page_viewer_assertion_audiences_status_idx").on(table.status),
  ],
);

export const mailDomains = pgTable(
  "mail_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainClaimId: uuid("domain_claim_id").references(() => domainClaims.id, {
      onDelete: "set null",
    }),
    domain: text("domain").notNull(),
    status: mailDomainStatus("status").default("pending").notNull(),
    providerAdapter: text("provider_adapter").notNull(),
    dnsStatusJson: jsonb("dns_status_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    authStatusJson: jsonb("auth_status_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("mail_domains_org_domain_unique").on(
      table.organizationId,
      table.domain,
    ),
    index("mail_domains_org_idx").on(table.organizationId),
    index("mail_domains_domain_claim_idx").on(table.domainClaimId),
    index("mail_domains_domain_idx").on(table.domain),
    index("mail_domains_status_idx").on(table.status),
  ],
);

export const mailDomainBindings = pgTable(
  "mail_domain_bindings",
  {
    domainBindingId: uuid("domain_binding_id")
      .primaryKey()
      .references(() => domainBindings.id, { onDelete: "cascade" }),
    mailDomainId: uuid("mail_domain_id")
      .notNull()
      .references(() => mailDomains.id, { onDelete: "cascade" }),
    inboundReadinessJson: jsonb("inbound_readiness_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    outboundReadinessJson: jsonb("outbound_readiness_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    catchAllPolicyJson: jsonb("catch_all_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("mail_domain_bindings_mail_domain_unique").on(table.mailDomainId),
  ],
);

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id"),
    localPart: text("local_part").notNull(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => mailDomains.id, { onDelete: "restrict" }),
    address: text("address").notNull(),
    status: mailMailboxStatus("status").default("active").notNull(),
    defaultVisibility: visibility("default_visibility")
      .default("private")
      .notNull(),
    keyScope: mailKeyScope("key_scope").default("mailbox").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("mailboxes_address_unique").on(table.address),
    uniqueIndex("mailboxes_domain_local_unique").on(
      table.domainId,
      table.localPart,
    ),
    index("mailboxes_org_idx").on(table.organizationId),
    index("mailboxes_project_idx").on(table.projectId),
    index("mailboxes_agent_idx").on(table.agentId),
    index("mailboxes_domain_idx").on(table.domainId),
    index("mailboxes_status_idx").on(table.status),
  ],
);

export const mailRoutes = pgTable(
  "mail_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => mailDomains.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id, {
      onDelete: "set null",
    }),
    matchType: mailRouteMatchType("match_type").notNull(),
    pattern: text("pattern").notNull(),
    action: mailRouteAction("action").notNull(),
    priority: integer("priority").default(0).notNull(),
    status: mailRouteStatus("status").default("active").notNull(),
    policyJson: jsonb("policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("mail_routes_domain_match_unique").on(
      table.domainId,
      table.matchType,
      table.pattern,
    ),
    index("mail_routes_org_idx").on(table.organizationId),
    index("mail_routes_domain_idx").on(table.domainId),
    index("mail_routes_mailbox_idx").on(table.mailboxId),
    index("mail_routes_match_idx").on(
      table.domainId,
      table.matchType,
      table.priority,
    ),
    index("mail_routes_status_idx").on(table.status),
  ],
);

export const mailThreads = pgTable(
  "mail_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    contactId: text("contact_id"),
    subjectCipherRef: jsonb("subject_cipher_ref").$type<JsonRecord>(),
    normalizedSubjectHash: text("normalized_subject_hash"),
    status: mailThreadStatus("status").default("active").notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("mail_threads_org_idx").on(table.organizationId),
    index("mail_threads_project_idx").on(table.projectId),
    index("mail_threads_mailbox_idx").on(table.mailboxId),
    index("mail_threads_contact_idx").on(table.contactId),
    index("mail_threads_subject_hash_idx").on(table.normalizedSubjectHash),
    index("mail_threads_last_message_idx").on(
      table.organizationId,
      table.lastMessageAt,
    ),
  ],
);

export const mailMessages = pgTable(
  "mail_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => mailThreads.id, {
      onDelete: "set null",
    }),
    direction: mailMessageDirection("direction").notNull(),
    providerAdapter: text("provider_adapter").notNull(),
    providerMessageRefHash: text("provider_message_ref_hash"),
    internetMessageIdHash: text("internet_message_id_hash"),
    fromHash: text("from_hash"),
    toHashesJson: jsonb("to_hashes_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    subjectCipherRef: jsonb("subject_cipher_ref").$type<JsonRecord>(),
    rawMimeCipherRef: jsonb("raw_mime_cipher_ref")
      .$type<JsonRecord>()
      .notNull(),
    parsedBodyCipherRef: jsonb("parsed_body_cipher_ref").$type<JsonRecord>(),
    addressSummaryCipherRef: jsonb("address_summary_cipher_ref").$type<JsonRecord>(),
    headersCipherRef: jsonb("headers_cipher_ref")
      .$type<JsonRecord>()
      .notNull(),
    status: mailMessageStatus("status").default("received").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("mail_messages_provider_ref_unique")
      .on(
        table.organizationId,
        table.providerAdapter,
        table.providerMessageRefHash,
      )
      .where(sql`${table.providerMessageRefHash} IS NOT NULL`),
    index("mail_messages_org_idx").on(table.organizationId),
    index("mail_messages_project_idx").on(table.projectId),
    index("mail_messages_mailbox_idx").on(table.mailboxId),
    index("mail_messages_thread_idx").on(table.threadId),
    index("mail_messages_internet_id_idx").on(table.internetMessageIdHash),
    index("mail_messages_received_idx").on(
      table.organizationId,
      table.receivedAt,
    ),
    index("mail_messages_sent_idx").on(table.organizationId, table.sentAt),
    index("mail_messages_status_idx").on(table.status),
  ],
);

export const mailAttachments = pgTable(
  "mail_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => mailMessages.id, { onDelete: "cascade" }),
    filenameCipherRef: jsonb("filename_cipher_ref").$type<JsonRecord>(),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    objectCipherRef: jsonb("object_cipher_ref")
      .$type<JsonRecord>()
      .notNull(),
    status: mailAttachmentStatus("status").default("unscanned").notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("mail_attachments_org_idx").on(table.organizationId),
    index("mail_attachments_project_idx").on(table.projectId),
    index("mail_attachments_mailbox_idx").on(table.mailboxId),
    index("mail_attachments_message_idx").on(table.messageId),
    index("mail_attachments_sha256_idx").on(table.sha256),
    index("mail_attachments_status_idx").on(table.status),
  ],
);

export const mailDeliveryEvents = pgTable(
  "mail_delivery_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => mailMessages.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    providerAdapter: text("provider_adapter").notNull(),
    providerEventRefHash: text("provider_event_ref_hash"),
    status: mailDeliveryEventStatus("status").default("recorded").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("mail_delivery_events_provider_ref_unique")
      .on(
        table.organizationId,
        table.providerAdapter,
        table.providerEventRefHash,
      )
      .where(sql`${table.providerEventRefHash} IS NOT NULL`),
    index("mail_delivery_events_org_idx").on(table.organizationId),
    index("mail_delivery_events_mailbox_idx").on(table.mailboxId),
    index("mail_delivery_events_message_idx").on(table.messageId),
    index("mail_delivery_events_type_idx").on(table.eventType),
    index("mail_delivery_events_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);

export const mailKeyRefs = pgTable(
  "mail_key_refs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id, {
      onDelete: "cascade",
    }),
    keyScope: mailKeyScope("key_scope").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    keyVersion: integer("key_version").default(1).notNull(),
    algorithm: text("algorithm").notNull(),
    wrappedKeyRef: text("wrapped_key_ref").notNull(),
    aadHash: text("aad_hash"),
    status: mailKeyRefStatus("status").default("active").notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("mail_key_refs_resource_version_unique").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
      table.keyVersion,
    ),
    index("mail_key_refs_org_idx").on(table.organizationId),
    index("mail_key_refs_project_idx").on(table.projectId),
    index("mail_key_refs_mailbox_idx").on(table.mailboxId),
    index("mail_key_refs_scope_idx").on(table.keyScope),
    index("mail_key_refs_status_idx").on(table.status),
  ],
);

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sourceType: knowledgeSourceType("source_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: knowledgeSourceStatus("status").default("active").notNull(),
    sensitivity: knowledgeSensitivity("sensitivity").default("standard").notNull(),
    sourceRefJson: jsonb("source_ref_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    rawRefJson: jsonb("raw_ref_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    accessPolicyJson: jsonb("access_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    retentionPolicyJson: jsonb("retention_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    originKey: text("origin_key"),
    trustTier: knowledgeTrustTier("trust_tier").default("said").notNull(),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("knowledge_sources_org_status_idx").on(table.organizationId, table.status),
    index("knowledge_sources_project_status_idx").on(table.projectId, table.status),
    index("knowledge_sources_owner_idx").on(table.ownerUserId),
    index("knowledge_sources_type_idx").on(table.sourceType),
    index("knowledge_sources_sensitivity_idx").on(table.sensitivity),
    index("knowledge_sources_updated_at_idx").on(table.updatedAt),
    uniqueIndex("knowledge_sources_org_origin_key_unique")
      .on(table.organizationId, table.originKey)
      .where(sql`${table.originKey} IS NOT NULL`),
    index("knowledge_sources_retain_until_idx").on(table.retainUntil),
  ],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    status: knowledgeDocumentStatus("status").default("created").notNull(),
    contentHash: text("content_hash"),
    mimeType: text("mime_type"),
    language: text("language"),
    parserVersion: text("parser_version"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sourceLocationJson: jsonb("source_location_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    failureJson: jsonb("failure_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("knowledge_documents_source_version_unique").on(
      table.sourceId,
      table.versionNumber,
    ),
    index("knowledge_documents_org_status_idx").on(table.organizationId, table.status),
    index("knowledge_documents_project_status_idx").on(table.projectId, table.status),
    index("knowledge_documents_source_idx").on(table.sourceId),
    index("knowledge_documents_content_hash_idx").on(table.contentHash),
    index("knowledge_documents_updated_at_idx").on(table.updatedAt),
    index("knowledge_documents_source_status_idx").on(table.sourceId, table.status),
  ],
);

export const knowledgePermissionSnapshots = pgTable(
  "knowledge_permission_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    snapshotHash: text("snapshot_hash").notNull(),
    policyJson: jsonb("policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    capturedByActorType: actorType("captured_by_actor_type")
      .default("system")
      .notNull(),
    capturedByActorId: text("captured_by_actor_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("knowledge_permission_snapshots_org_idx").on(table.organizationId),
    index("knowledge_permission_snapshots_project_idx").on(table.projectId),
    index("knowledge_permission_snapshots_source_idx").on(table.sourceId),
    index("knowledge_permission_snapshots_document_idx").on(table.documentId),
    index("knowledge_permission_snapshots_hash_idx").on(table.snapshotHash),
    index("knowledge_permission_snapshots_captured_at_idx").on(table.capturedAt),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    permissionSnapshotId: uuid("permission_snapshot_id")
      .notNull()
      .references(() => knowledgePermissionSnapshots.id, { onDelete: "cascade" }),
    chunkOrdinal: integer("chunk_ordinal").notNull(),
    chunkKey: text("chunk_key").notNull(),
    text: text("text").notNull(),
    textHash: text("text_hash").notNull(),
    tokenCount: integer("token_count"),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    status: knowledgeChunkStatus("status").default("active").notNull(),
    stableKey: text("stable_key"),
    trustTier: knowledgeTrustTier("trust_tier").default("said").notNull(),
    searchVector: tsvector("search_vector"),
    searchVectorStem: tsvector("search_vector_stem"),
    locationJson: jsonb("location_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("knowledge_chunks_document_ordinal_unique").on(
      table.documentId,
      table.chunkOrdinal,
    ),
    uniqueIndex("knowledge_chunks_document_key_unique").on(
      table.documentId,
      table.chunkKey,
    ),
    index("knowledge_chunks_org_status_idx").on(table.organizationId, table.status),
    index("knowledge_chunks_project_status_idx").on(table.projectId, table.status),
    index("knowledge_chunks_source_idx").on(table.sourceId),
    index("knowledge_chunks_document_idx").on(table.documentId),
    index("knowledge_chunks_permission_snapshot_idx").on(table.permissionSnapshotId),
    index("knowledge_chunks_text_hash_idx").on(table.textHash),
    index("knowledge_chunks_source_stable_key_idx").on(table.sourceId, table.stableKey),
    index("knowledge_chunks_search_idx").using("gin", table.searchVector),
    index("knowledge_chunks_search_stem_idx").using("gin", table.searchVectorStem),
  ],
);

export const knowledgeIngestionJobs = pgTable(
  "knowledge_ingestion_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => knowledgeDocuments.id, {
      onDelete: "set null",
    }),
    status: knowledgeIngestionJobStatus("status").default("queued").notNull(),
    triggerType: text("trigger_type").default("manual").notNull(),
    idempotencyKey: text("idempotency_key"),
    requestId: text("request_id"),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    inputJson: jsonb("input_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    resultJson: jsonb("result_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    requestedByActorType: actorType("requested_by_actor_type")
      .default("user")
      .notNull(),
    requestedByActorId: text("requested_by_actor_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("knowledge_ingestion_jobs_org_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("knowledge_ingestion_jobs_org_status_idx").on(table.organizationId, table.status),
    index("knowledge_ingestion_jobs_project_status_idx").on(table.projectId, table.status),
    index("knowledge_ingestion_jobs_source_idx").on(table.sourceId),
    index("knowledge_ingestion_jobs_document_idx").on(table.documentId),
    index("knowledge_ingestion_jobs_request_idx").on(table.requestId),
    index("knowledge_ingestion_jobs_updated_at_idx").on(table.updatedAt),
    index("knowledge_ingestion_jobs_due_idx").on(table.status, table.nextAttemptAt),
    index("knowledge_ingestion_jobs_locked_until_idx").on(table.lockedUntil),
  ],
);

export const knowledgeIndexes = pgTable(
  "knowledge_indexes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    backend: text("backend").notNull(),
    isolationTier: text("isolation_tier").default("standard").notNull(),
    status: knowledgeIndexStatus("status").default("active").notNull(),
    strategyJson: jsonb("strategy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    lastRebuildAt: timestamp("last_rebuild_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("knowledge_indexes_org_key_unique").on(table.organizationId, table.key),
    index("knowledge_indexes_org_status_idx").on(table.organizationId, table.status),
    index("knowledge_indexes_project_idx").on(table.projectId),
    index("knowledge_indexes_backend_idx").on(table.backend),
  ],
);

export const knowledgeRetrievalStrategies = pgTable(
  "knowledge_retrieval_strategies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    projectScope: text("project_scope").default("*").notNull(),
    indexId: uuid("index_id").references(() => knowledgeIndexes.id, {
      onDelete: "set null",
    }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    status: knowledgeRetrievalStrategyStatus("status").default("active").notNull(),
    defaultLimit: integer("default_limit").default(8).notNull(),
    pipelineJson: jsonb("pipeline_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("knowledge_retrieval_strategies_scope_key_unique").on(
      table.organizationId,
      table.projectScope,
      table.key,
    ),
    index("knowledge_retrieval_strategies_org_status_idx").on(table.organizationId, table.status),
    index("knowledge_retrieval_strategies_project_idx").on(table.projectId),
    index("knowledge_retrieval_strategies_index_idx").on(table.indexId),
  ],
);

export const knowledgeRetrievalRuns = pgTable(
  "knowledge_retrieval_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    strategyId: uuid("strategy_id").references(() => knowledgeRetrievalStrategies.id, {
      onDelete: "set null",
    }),
    actorType: actorType("actor_type").default("user").notNull(),
    actorId: text("actor_id"),
    status: knowledgeRetrievalRunStatus("status").notNull(),
    queryText: text("query_text"),
    queryHash: text("query_hash"),
    requestedScopeJson: jsonb("requested_scope_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    prefilterJson: jsonb("prefilter_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    postfilterJson: jsonb("postfilter_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    candidateCount: integer("candidate_count").default(0).notNull(),
    returnedChunkCount: integer("returned_chunk_count").default(0).notNull(),
    deniedReason: text("denied_reason"),
    durationMs: integer("duration_ms"),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    audience: text("audience").default("operator").notNull(),
    callerJson: jsonb("caller_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    deniedJson: jsonb("denied_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    normalizedQuery: text("normalized_query"),
    costJson: jsonb("cost_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    localInstallationId: uuid("local_installation_id"),
    turnKey: text("turn_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "knowledge_runs_installation_fk",
      columns: [table.localInstallationId],
      foreignColumns: [localInstallations.id],
    }).onDelete("set null"),
    index("knowledge_retrieval_runs_org_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("knowledge_retrieval_runs_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("knowledge_retrieval_runs_strategy_idx").on(table.strategyId),
    index("knowledge_retrieval_runs_actor_idx").on(table.actorType, table.actorId),
    index("knowledge_retrieval_runs_status_idx").on(table.status),
    index("knowledge_retrieval_runs_query_hash_idx").on(table.queryHash),
    index("knowledge_retrieval_runs_installation_turn_idx").on(
      table.localInstallationId,
      table.turnKey,
    ),
    index("knowledge_retrieval_runs_created_at_idx").on(table.createdAt),
  ],
);

export const knowledgeCitations = pgTable(
  "knowledge_citations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    retrievalRunId: uuid("retrieval_run_id")
      .notNull()
      .references(() => knowledgeRetrievalRuns.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => knowledgeSources.id, {
      onDelete: "set null",
    }),
    documentId: uuid("document_id").references(() => knowledgeDocuments.id, {
      onDelete: "set null",
    }),
    chunkId: uuid("chunk_id").references(() => knowledgeChunks.id, {
      onDelete: "set null",
    }),
    rank: integer("rank").notNull(),
    score: numeric("score", { precision: 10, scale: 6 }),
    excerpt: text("excerpt"),
    textHash: text("text_hash"),
    documentVersion: integer("document_version"),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    trustTier: knowledgeTrustTier("trust_tier"),
    citationJson: jsonb("citation_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("knowledge_citations_run_rank_unique").on(
      table.retrievalRunId,
      table.rank,
    ),
    index("knowledge_citations_org_idx").on(table.organizationId),
    index("knowledge_citations_project_idx").on(table.projectId),
    index("knowledge_citations_run_idx").on(table.retrievalRunId),
    index("knowledge_citations_source_idx").on(table.sourceId),
    index("knowledge_citations_document_idx").on(table.documentId),
    index("knowledge_citations_chunk_idx").on(table.chunkId),
  ],
);

/**
 * A change proposed to the organization's knowledge (a note, a correction, an
 * approved local transcript or a client question with no answer yet). Only a
 * web decision turns a proposal into a knowledge source or a /faq answer.
 */
export const knowledgeProposals = pgTable(
  "knowledge_proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id"),
    kind: knowledgeProposalKind("kind").notNull(),
    status: knowledgeProposalStatus("status").default("pending").notNull(),
    title: text("title"),
    // Null once purged (a decided transcript, an expired proposal, a gap or transcript 30 days after it closed).
    body: text("body"),
    // sha256 hex of the body, kept when the body is purged.
    bodyHash: text("body_hash"),
    answerText: text("answer_text"),
    faqQuestion: text("faq_question"),
    evidenceJson: jsonb("evidence_json")
      .$type<JsonRecord[]>()
      .default(emptyJsonRecordArray)
      .notNull(),
    supersedesRef: text("supersedes_ref"),
    requestedAudienceJson: jsonb("requested_audience_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    proposedByJson: jsonb("proposed_by_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    localInstallationId: uuid("local_installation_id"),
    dedupeKey: text("dedupe_key"),
    idempotencyKey: text("idempotency_key"),
    waitingCount: integer("waiting_count").default(1).notNull(),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    resultSourceId: uuid("result_source_id"),
    resultJson: jsonb("result_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    foreignKey({
      name: "knowledge_proposals_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_proposals_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_proposals_installation_fk",
      columns: [table.localInstallationId],
      foreignColumns: [localInstallations.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_proposals_decided_by_fk",
      columns: [table.decidedByUserId],
      foreignColumns: [users.id],
    }).onDelete("set null"),
    foreignKey({
      name: "knowledge_proposals_result_source_fk",
      columns: [table.resultSourceId],
      foreignColumns: [knowledgeSources.id],
    }).onDelete("set null"),
    index("knowledge_proposals_org_status_created_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index("knowledge_proposals_project_status_idx").on(table.projectId, table.status),
    index("knowledge_proposals_installation_idx").on(table.localInstallationId),
    index("knowledge_proposals_expires_at_idx").on(table.expiresAt),
    uniqueIndex("knowledge_proposals_pending_dedupe_unique")
      .on(table.organizationId, table.localInstallationId, table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL AND ${table.status} = 'pending'`),
    uniqueIndex("knowledge_proposals_idempotency_unique")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    artifactVersionId: uuid("artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "restrict" }),
    status: deploymentStatus("status").default("queued").notNull(),
    visibility: visibility("visibility").default("private").notNull(),
    urlAssignmentsJson: jsonb("url_assignments_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    logsSummaryJson: jsonb("logs_summary_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    sourceJson: jsonb("source_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("deployments_project_idx").on(table.projectId),
    index("deployments_environment_idx").on(table.environmentId),
    index("deployments_artifact_version_idx").on(table.artifactVersionId),
    index("deployments_status_idx").on(table.status),
    index("deployments_created_at_idx").on(table.createdAt),
  ],
);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    hostname: text("hostname").notNull(),
    status: text("status").default("pending").notNull(),
    verificationJson: jsonb("verification_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    assignedDeploymentId: uuid("assigned_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("domains_hostname_unique").on(table.hostname),
    index("domains_org_idx").on(table.organizationId),
    index("domains_project_idx").on(table.projectId),
  ],
);

export const apiKeyServicePrincipals = pgTable("api_key_service_principals", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  status: text("status").$type<"active" | "revoked">().notNull().default("active"),
  revision: integer("revision").notNull().default(1),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...lifecycleColumns(),
}, table => [
  unique("api_key_service_principals_organization_id_id_key").on(table.organizationId, table.id),
  check("api_key_service_principals_name_check", sql`length(${table.name}) BETWEEN 1 AND 120`),
  check("api_key_service_principals_status_check", sql`${table.status} IN ('active','revoked')`),
  check("api_key_service_principals_revision_check", sql`${table.revision}>0`),
]);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    subjectKind: text("subject_kind").$type<"unclassified" | "user" | "service">().notNull().default("unclassified"),
    subjectUserId: uuid("subject_user_id"),
    servicePrincipalId: uuid("service_principal_id"),
    hashVersion: text("hash_version").$type<"legacy" | "sha256">().notNull().default("legacy"),
    revision: integer("revision").notNull().default(1),
    status: apiKeyStatus("status").default("active").notNull(),
    scopesJson: jsonb("scopes_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_unique").on(table.keyHash),
    index("api_keys_org_idx").on(table.organizationId),
    index("api_keys_project_idx").on(table.projectId),
    index("api_keys_prefix_idx").on(table.keyPrefix),
    index("api_keys_status_idx").on(table.status),
    index("api_keys_subject_user_idx").on(table.organizationId, table.subjectUserId),
    index("api_keys_service_idx").on(table.organizationId, table.servicePrincipalId),
    foreignKey({ name: "api_keys_user_org_fk", columns: [table.organizationId, table.subjectUserId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.userId] }),
    foreignKey({ name: "api_keys_service_org_fk", columns: [table.organizationId, table.servicePrincipalId],
      foreignColumns: [apiKeyServicePrincipals.organizationId, apiKeyServicePrincipals.id] }),
    check("api_keys_subject_shape", sql`(${table.subjectKind}='unclassified' AND ${table.subjectUserId} IS NULL AND ${table.servicePrincipalId} IS NULL) OR
      (${table.subjectKind}='user' AND ${table.subjectUserId} IS NOT NULL AND ${table.servicePrincipalId} IS NULL) OR
      (${table.subjectKind}='service' AND ${table.subjectUserId} IS NULL AND ${table.servicePrincipalId} IS NOT NULL)`),
    check("api_keys_revision_positive", sql`${table.revision}>0`),
    check("api_keys_hash_version", sql`${table.hashVersion} IN ('legacy','sha256')`),
  ],
);

export const localInstallations = pgTable(
  "local_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Null for an installation credential: the machine belongs to the
    // organization, not to the person who happened to run `ravi login`.
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    subjectType: installationSubjectType("subject_type").default("user").notNull(),
    name: text("name").notNull(),
    hostname: text("hostname"),
    platform: text("platform"),
    machineFingerprintHash: text("machine_fingerprint_hash"),
    raviVersion: text("ravi_version"),
    status: localInstallationStatus("status").default("active").notNull(),
    /** Desired state from the Console: the install.yaml, its version and hash. */
    installState: installationState("install_state").default("live").notNull(),
    installStateReason: text("install_state_reason"),
    desiredJson: jsonb("desired_json").$type<JsonRecord>().default(emptyJson).notNull(),
    desiredVersion: integer("desired_version").default(0).notNull(),
    managementRevision: integer("management_revision").default(0).notNull(),
    desiredHash: text("desired_hash"),
    appliedHash: text("applied_hash"),
    /** Last state pushed by the installation. Derived summary only, never content. */
    observedJson: jsonb("observed_json").$type<JsonRecord>().default(emptyJson).notNull(),
    stateReportedAt: timestamp("state_reported_at", { withTimezone: true }),
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
    decommissionReason: text("decommission_reason"),
    capabilitiesJson: jsonb("capabilities_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    billable: boolean("billable").default(false).notNull(),
    billableNote: text("billable_note"),
    billableMarkedAt: timestamp("billable_marked_at", { withTimezone: true }),
    billableMarkedByUserId: uuid("billable_marked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("local_installations_fingerprint_unique").on(
      table.organizationId,
      table.userId,
      table.machineFingerprintHash,
    ),
    index("local_installations_org_idx").on(table.organizationId),
    index("local_installations_user_idx").on(table.userId),
    index("local_installations_status_idx").on(table.status),
    index("local_installations_subject_idx").on(table.subjectType),
    index("local_installations_org_fingerprint_idx").on(
      table.organizationId,
      table.machineFingerprintHash,
    ),
    index("local_installations_last_seen_idx").on(table.lastSeenAt),
    index("local_installations_billable_idx").on(table.organizationId, table.billable),
  ],
);

export const installationBootstrapTokens = pgTable(
  "installation_bootstrap_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("installation_bootstrap_tokens_hash_unique").on(table.tokenHash),
    index("installation_bootstrap_tokens_installation_idx").on(
      table.installationId,
    ),
    index("installation_bootstrap_tokens_org_idx").on(table.organizationId),
    index("installation_bootstrap_tokens_expires_idx").on(table.expiresAt),
  ],
);

export const cliDeviceAuthorizations = pgTable(
  "cli_device_authorizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull(),
    userCodeHash: text("user_code_hash").notNull(),
    status: cliDeviceAuthorizationStatus("status")
      .default("pending")
      .notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    membershipId: uuid("membership_id").references(
      () => organizationMemberships.id,
      { onDelete: "set null" },
    ),
    scopesJson: jsonb("scopes_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("cli_device_authorizations_device_hash_unique").on(
      table.deviceCodeHash,
    ),
    uniqueIndex("cli_device_authorizations_user_hash_unique").on(
      table.userCodeHash,
    ),
    index("cli_device_authorizations_status_idx").on(table.status),
    index("cli_device_authorizations_expires_idx").on(table.expiresAt),
    index("cli_device_authorizations_user_idx").on(table.userId),
    index("cli_device_authorizations_org_idx").on(table.organizationId),
  ],
);

export const cliSessions = pgTable(
  "cli_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    localInstallationId: uuid("local_installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    subjectType: installationSubjectType("subject_type").default("user").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    previousRefreshTokenHash: text("previous_refresh_token_hash"),
    accessTokenJti: text("access_token_jti").notNull(),
    scopesJson: jsonb("scopes_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    status: cliSessionStatus("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("cli_sessions_refresh_hash_unique").on(table.refreshTokenHash),
    uniqueIndex("cli_sessions_access_jti_unique").on(table.accessTokenJti),
    index("cli_sessions_previous_refresh_hash_idx").on(
      table.previousRefreshTokenHash,
    ),
    index("cli_sessions_installation_idx").on(table.localInstallationId),
    index("cli_sessions_org_idx").on(table.organizationId),
    index("cli_sessions_user_idx").on(table.userId),
    index("cli_sessions_subject_idx").on(table.subjectType),
    index("cli_sessions_status_idx").on(table.status),
    index("cli_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const raviActorBindings = pgTable(
  "ravi_actor_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    consoleUserId: uuid("console_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contactId: text("contact_id").notNull(),
    platformIdentitiesJson: jsonb("platform_identities_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    status: raviActorBindingStatus("status").default("active").notNull(),
    linkedBy: uuid("linked_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("ravi_actor_bindings_installation_contact_active_unique")
      .on(table.installationId, table.contactId)
      .where(sql`${table.status} = 'active'`),
    index("ravi_actor_bindings_installation_user_idx").on(
      table.installationId,
      table.consoleUserId,
    ),
    index("ravi_actor_bindings_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("ravi_actor_bindings_contact_idx").on(table.contactId),
  ],
);

export const raviLinkRequests = pgTable(
  "ravi_link_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    cliSessionId: uuid("cli_session_id").references(() => cliSessions.id, {
      onDelete: "set null",
    }),
    contactId: text("contact_id").notNull(),
    platformIdentitiesJson: jsonb("platform_identities_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    requesterDisplayName: text("requester_display_name"),
    expectedEmailHash: text("expected_email_hash"),
    status: raviLinkRequestStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    bindingId: uuid("binding_id").references(() => raviActorBindings.id, {
      onDelete: "set null",
    }),
    failureReason: text("failure_reason"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("ravi_link_requests_token_hash_unique").on(table.tokenHash),
    uniqueIndex("ravi_link_requests_installation_contact_pending_unique")
      .on(table.installationId, table.contactId)
      .where(sql`${table.status} = 'pending'`),
    index("ravi_link_requests_installation_status_idx").on(
      table.installationId,
      table.status,
    ),
    index("ravi_link_requests_expires_idx").on(table.expiresAt),
  ],
);

export const agentInboxItems = pgTable(
  "agent_inbox_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    eventType: text("event_type").notNull(),
    category: text("category").notNull(),
    severity: agentInboxSeverity("severity").default("info").notNull(),
    sensitivity: agentInboxSensitivity("sensitivity").default("metadata").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    actorType: actorType("actor_type"),
    actorId: text("actor_id"),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    dedupeKey: text("dedupe_key").notNull(),
    payloadJson: jsonb("payload_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    linksJson: jsonb("links_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("agent_inbox_items_sequence_unique").on(table.sequence),
    uniqueIndex("agent_inbox_items_org_dedupe_unique").on(
      table.organizationId,
      table.dedupeKey,
    ),
    index("agent_inbox_items_org_sequence_idx").on(
      table.organizationId,
      table.sequence,
    ),
    index("agent_inbox_items_project_sequence_idx").on(
      table.projectId,
      table.sequence,
    ),
    index("agent_inbox_items_source_idx").on(
      table.sourceType,
      table.sourceId,
    ),
    index("agent_inbox_items_event_type_idx").on(table.eventType),
    index("agent_inbox_items_category_idx").on(table.category),
    index("agent_inbox_items_severity_idx").on(table.severity),
    index("agent_inbox_items_created_at_idx").on(table.createdAt),
  ],
);

export const agentInboxSubscriptions = pgTable(
  "agent_inbox_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    localInstallationId: uuid("local_installation_id")
      .notNull()
      .references(
        () => localInstallations.id,
        { onDelete: "cascade" },
      ),
    name: text("name").notNull(),
    status: agentInboxSubscriptionStatus("status").default("active").notNull(),
    deliveryMode: agentInboxDeliveryMode("delivery_mode").default("poll").notNull(),
    filtersJson: jsonb("filters_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    capabilitiesJson: jsonb("capabilities_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    lastDeliveredSequence: bigint("last_delivered_sequence", { mode: "number" })
      .default(0)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("agent_inbox_subscriptions_global_unique").on(
      table.organizationId,
      table.localInstallationId,
      table.name,
    ),
    index("agent_inbox_subscriptions_org_idx").on(table.organizationId),
    index("agent_inbox_subscriptions_user_idx").on(table.userId),
    index("agent_inbox_subscriptions_installation_idx").on(table.localInstallationId),
    index("agent_inbox_subscriptions_status_idx").on(table.status),
  ],
);

export const agentInboxWatermarks = pgTable(
  "agent_inbox_watermarks",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    generation: bigint("generation", { mode: "number" }).default(0).notNull(),
    latestSequence: bigint("latest_sequence", { mode: "number" })
      .default(0)
      .notNull(),
    latestItemAt: timestamp("latest_item_at", { withTimezone: true }),
    cacheKey: text("cache_key").default("0").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_inbox_watermarks_updated_at_idx").on(table.updatedAt),
  ],
);

export const agentInboxReceipts = pgTable(
  "agent_inbox_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => agentInboxSubscriptions.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => agentInboxItems.id, { onDelete: "cascade" }),
    status: agentInboxReceiptStatus("status").default("leased").notNull(),
    leaseId: text("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureCount: integer("failure_count").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    localEventId: text("local_event_id"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("agent_inbox_receipts_subscription_item_unique").on(
      table.subscriptionId,
      table.itemId,
    ),
    index("agent_inbox_receipts_subscription_status_idx").on(
      table.subscriptionId,
      table.status,
    ),
    index("agent_inbox_receipts_lease_expires_at_idx").on(table.leaseExpiresAt),
    index("agent_inbox_receipts_item_idx").on(table.itemId),
  ],
);

export const agentInboxOutboxEvents = pgTable(
  "agent_inbox_outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    inboxItemId: uuid("inbox_item_id")
      .notNull()
      .references(() => agentInboxItems.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    subject: text("subject").default("ravi.console.inbox.item").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadJson: jsonb("payload_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    status: agentInboxOutboxStatus("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(8).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deadLetterAt: timestamp("dead_letter_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    correlationId: text("correlation_id").notNull(),
    traceJson: jsonb("trace_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("agent_inbox_outbox_events_item_unique").on(table.inboxItemId),
    uniqueIndex("agent_inbox_outbox_events_org_event_unique").on(
      table.organizationId,
      table.eventId,
    ),
    index("agent_inbox_outbox_events_status_next_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("agent_inbox_outbox_events_lock_idx").on(table.lockedUntil),
    index("agent_inbox_outbox_events_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const cloudSyncEvents = pgTable(
  "cloud_sync_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    originInstallationId: uuid("origin_installation_id").references(
      () => localInstallations.id,
      { onDelete: "set null" },
    ),
    sourceKind: text("source_kind").default("local_installation").notNull(),
    sourceId: text("source_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    domain: text("domain").notNull(),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    entityRevision: integer("entity_revision"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    payloadJson: jsonb("payload_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    evidenceJson: jsonb("evidence_json")
      .$type<JsonRecord[]>()
      .default(emptyJsonRecordArray)
      .notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("cloud_sync_events_sequence_unique").on(table.sequence),
    uniqueIndex("cloud_sync_events_source_event_unique").on(
      table.organizationId,
      table.sourceKind,
      table.sourceId,
      table.sourceEventId,
    ),
    uniqueIndex("cloud_sync_events_idempotency_unique").on(
      table.organizationId,
      table.sourceKind,
      table.sourceId,
      table.idempotencyKey,
    ),
    index("cloud_sync_events_org_sequence_idx").on(
      table.organizationId,
      table.sequence,
    ),
    index("cloud_sync_events_org_domain_sequence_idx").on(
      table.organizationId,
      table.domain,
      table.sequence,
    ),
    index("cloud_sync_events_project_domain_sequence_idx").on(
      table.projectId,
      table.domain,
      table.sequence,
    ),
    index("cloud_sync_events_entity_idx").on(
      table.organizationId,
      table.domain,
      table.entityType,
      table.entityId,
    ),
    index("cloud_sync_events_origin_installation_idx").on(
      table.originInstallationId,
    ),
  ],
);

export const cloudSyncCursors = pgTable(
  "cloud_sync_cursors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    localInstallationId: uuid("local_installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    projectScope: text("project_scope").default("*").notNull(),
    domain: text("domain").notNull(),
    lastDeliveredSequence: bigint("last_delivered_sequence", { mode: "number" })
      .default(0)
      .notNull(),
    lastAckedSequence: bigint("last_acked_sequence", { mode: "number" })
      .default(0)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("cloud_sync_cursors_installation_domain_unique").on(
      table.organizationId,
      table.localInstallationId,
      table.projectScope,
      table.domain,
    ),
    index("cloud_sync_cursors_org_idx").on(table.organizationId),
    index("cloud_sync_cursors_installation_idx").on(table.localInstallationId),
    index("cloud_sync_cursors_project_idx").on(table.projectId),
  ],
);

export const eventPlaneCells = pgTable(
  "event_plane_cells",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),
    environment: text("environment").notNull(),
    region: text("region").notNull(),
    placementClass: text("placement_class").notNull(),
    status: eventPlaneCellStatus("status").default("provisioning").notNull(),
    endpointRef: text("endpoint_ref"),
    systemAccountRef: text("system_account_ref"),
    resolverRef: text("resolver_ref"),
    capacityJson: jsonb("capacity_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    observedCapacityJson: jsonb("observed_capacity_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    policyVersion: integer("policy_version").default(1).notNull(),
    version: integer("version").default(1).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("event_plane_cells_provider_ref_unique")
      .on(table.provider, table.providerRef)
      .where(sql`${table.providerRef} IS NOT NULL`),
    index("event_plane_cells_env_region_status_idx").on(
      table.environment,
      table.region,
      table.status,
    ),
    index("event_plane_cells_provider_idx").on(table.provider),
    index("event_plane_cells_heartbeat_idx").on(table.lastHeartbeatAt),
  ],
);

export const eventPlaneOrgBindings = pgTable(
  "event_plane_org_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cellId: uuid("cell_id")
      .notNull()
      .references(() => eventPlaneCells.id, { onDelete: "restrict" }),
    providerAccountRef: text("provider_account_ref"),
    accountPublicKey: text("account_public_key"),
    status: eventPlaneOrgBindingStatus("status").default("provisioning").notNull(),
    placementReason: text("placement_reason").notNull(),
    quotaPolicyJson: jsonb("quota_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    streamPolicyJson: jsonb("stream_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    activePolicyVersion: integer("active_policy_version").default(1).notNull(),
    version: integer("version").default(1).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("event_plane_org_bindings_org_active_unique")
      .on(table.organizationId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("event_plane_org_bindings_org_cell_live_unique")
      .on(table.organizationId, table.cellId)
      .where(sql`${table.status} <> 'deleted'`),
    uniqueIndex("event_plane_org_bindings_account_key_unique")
      .on(table.accountPublicKey)
      .where(sql`${table.accountPublicKey} IS NOT NULL`),
    uniqueIndex("event_plane_org_bindings_provider_account_unique")
      .on(table.providerAccountRef)
      .where(sql`${table.providerAccountRef} IS NOT NULL`),
    index("event_plane_org_bindings_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("event_plane_org_bindings_cell_status_idx").on(table.cellId, table.status),
  ],
);

export const eventPlaneIdentities = pgTable(
  "event_plane_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => eventPlaneOrgBindings.id, { onDelete: "cascade" }),
    identityType: eventPlaneIdentityType("identity_type").notNull(),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    displayName: text("display_name").notNull(),
    status: eventPlaneIdentityStatus("status").default("provisioning").notNull(),
    permissionsJson: jsonb("permissions_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    policyVersion: integer("policy_version").default(1).notNull(),
    version: integer("version").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("event_plane_identities_binding_principal_active_unique")
      .on(table.bindingId, table.identityType, table.principalType, table.principalId)
      .where(sql`${table.status} IN ('provisioning', 'active', 'rotating', 'failed')`),
    index("event_plane_identities_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("event_plane_identities_binding_status_idx").on(
      table.bindingId,
      table.status,
    ),
    index("event_plane_identities_principal_idx").on(
      table.principalType,
      table.principalId,
    ),
  ],
);

export const eventPlaneCredentialGrants = pgTable(
  "event_plane_credential_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => eventPlaneIdentities.id, { onDelete: "cascade" }),
    providerUserPublicKey: text("provider_user_public_key"),
    secretRef: text("secret_ref"),
    status: eventPlaneCredentialGrantStatus("status").default("pending").notNull(),
    version: integer("version").default(1).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("event_plane_credential_grants_public_key_unique")
      .on(table.providerUserPublicKey)
      .where(sql`${table.providerUserPublicKey} IS NOT NULL`),
    index("event_plane_credential_grants_identity_status_idx").on(
      table.identityId,
      table.status,
    ),
    index("event_plane_credential_grants_expires_idx").on(table.expiresAt),
  ],
);

export const eventPlanePolicyVersions = pgTable(
  "event_plane_policy_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeType: eventPlanePolicyScopeType("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    version: integer("version").notNull(),
    policyHash: text("policy_hash").notNull(),
    policyJson: jsonb("policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    status: eventPlanePolicyStatus("status").default("draft").notNull(),
    approvedBy: text("approved_by"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("event_plane_policy_versions_scope_version_unique").on(
      table.scopeType,
      table.scopeId,
      table.version,
    ),
    uniqueIndex("event_plane_policy_versions_scope_active_unique")
      .on(table.scopeType, table.scopeId)
      .where(sql`${table.status} = 'active'`),
    index("event_plane_policy_versions_hash_idx").on(table.policyHash),
    index("event_plane_policy_versions_status_idx").on(table.status),
  ],
);

export const eventPlaneCrossAccountLinks = pgTable(
  "event_plane_cross_account_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceBindingId: uuid("source_binding_id")
      .notNull()
      .references(() => eventPlaneOrgBindings.id, { onDelete: "cascade" }),
    targetBindingId: uuid("target_binding_id").references(
      () => eventPlaneOrgBindings.id,
      { onDelete: "set null" },
    ),
    targetSystemService: text("target_system_service"),
    linkType: eventPlaneCrossAccountLinkType("link_type").notNull(),
    subjectPattern: text("subject_pattern").notNull(),
    responsePattern: text("response_pattern"),
    status: eventPlaneCrossAccountLinkStatus("status").default("proposed").notNull(),
    justification: text("justification").notNull(),
    policyVersion: integer("policy_version").notNull(),
    approvedBy: text("approved_by"),
    version: integer("version").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("event_plane_cross_account_links_source_status_idx").on(
      table.sourceBindingId,
      table.status,
    ),
    index("event_plane_cross_account_links_target_idx").on(table.targetBindingId),
    index("event_plane_cross_account_links_service_idx").on(table.targetSystemService),
    index("event_plane_cross_account_links_subject_idx").on(table.subjectPattern),
  ],
);

export const eventPlaneControlOperations = pgTable(
  "event_plane_control_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeKey: text("scope_key").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: eventPlaneControlOperationStatus("status").default("started").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    responseJson: jsonb("response_json").$type<JsonRecord>(),
    errorCode: text("error_code"),
    actorType: actorType("actor_type").default("system").notNull(),
    actorId: text("actor_id"),
    requestId: text("request_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("event_plane_control_operations_idempotency_unique").on(
      table.scopeKey,
      table.operation,
      table.idempotencyKey,
    ),
    index("event_plane_control_operations_org_idx").on(table.organizationId),
    index("event_plane_control_operations_status_idx").on(table.status),
    index("event_plane_control_operations_request_idx").on(table.requestId),
    index("event_plane_control_operations_target_idx").on(
      table.targetType,
      table.targetId,
    ),
    index("event_plane_control_operations_expires_idx").on(table.expiresAt),
  ],
);

export const runtimeHosts = pgTable(
  "runtime_hosts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    hostname: text("hostname").notNull(),
    region: text("region"),
    environment: environmentName("environment").default("development").notNull(),
    status: runtimeHostStatus("status").default("provisioning").notNull(),
    placementClassesJson: jsonb("placement_classes_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    capacityJson: jsonb("capacity_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    healthJson: jsonb("health_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("runtime_hosts_hostname_unique").on(table.hostname),
    index("runtime_hosts_status_idx").on(table.status),
    index("runtime_hosts_provider_region_idx").on(table.provider, table.region),
    index("runtime_hosts_heartbeat_idx").on(table.lastHeartbeatAt),
  ],
);

export const runtimeImages = pgTable(
  "runtime_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    architecture: text("architecture").notNull(),
    baseOs: text("base_os").notNull(),
    providerSupportJson: jsonb("provider_support_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    kernelRef: text("kernel_ref").notNull(),
    rootfsRef: text("rootfs_ref").notNull(),
    digest: text("digest").notNull(),
    status: runtimeImageStatus("status").default("building").notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("runtime_images_digest_unique").on(table.digest),
    uniqueIndex("runtime_images_name_version_arch_unique").on(
      table.name,
      table.version,
      table.architecture,
    ),
    index("runtime_images_status_idx").on(table.status),
  ],
);

export const managedRuntimeInstances = pgTable(
  "managed_runtime_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    hostId: uuid("host_id").references(() => runtimeHosts.id, {
      onDelete: "set null",
    }),
    imageId: uuid("image_id").references(() => runtimeImages.id, {
      onDelete: "set null",
    }),
    installationId: uuid("installation_id").references(
      () => localInstallations.id,
      { onDelete: "set null" },
    ),
    displayName: text("display_name").notNull(),
    desiredState: managedRuntimeDesiredState("desired_state").default("running").notNull(),
    observedState: managedRuntimeObservedState("observed_state").default("provisioning").notNull(),
    provisioningPhase: text("provisioning_phase"),
    failureCode: text("failure_code"),
    runtimeProvider: text("runtime_provider").default("codex").notNull(),
    runtimeModel: text("runtime_model"),
    status: managedRuntimeInstanceStatus("status").default("provisioning").notNull(),
    runtimeVersion: text("runtime_version"),
    placementClass: text("placement_class").notNull(),
    localStateRef: text("local_state_ref"),
    syncCursorJson: jsonb("sync_cursor_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("managed_runtime_instances_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("managed_runtime_instances_org_desired_observed_idx").on(
      table.organizationId,
      table.desiredState,
      table.observedState,
    ),
    index("managed_runtime_instances_project_idx").on(table.projectId),
    index("managed_runtime_instances_host_idx").on(table.hostId),
    index("managed_runtime_instances_installation_idx").on(table.installationId),
    index("managed_runtime_instances_heartbeat_idx").on(table.lastHeartbeatAt),
  ],
);

export const managedRuntimeOperations = pgTable(
  "managed_runtime_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => managedRuntimeInstances.id, { onDelete: "cascade" }),
    actorType: actorType("actor_type").default("system").notNull(),
    actorId: text("actor_id"),
    action: managedRuntimeOperationAction("action").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: managedRuntimeOperationStatus("status").default("pending").notNull(),
    phase: text("phase"),
    progressPercent: integer("progress_percent"),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    safeInputJson: jsonb("safe_input_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeResultJson: jsonb("safe_result_json").$type<JsonRecord>(),
    failureCode: text("failure_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("managed_runtime_operations_org_action_idempotency_unique").on(
      table.organizationId,
      table.action,
      table.idempotencyKey,
    ),
    index("managed_runtime_operations_instance_created_idx").on(
      table.instanceId,
      table.createdAt,
    ),
    index("managed_runtime_operations_claim_idx").on(
      table.status,
      table.claimExpiresAt,
      table.createdAt,
    ),
    index("managed_runtime_operations_project_idx").on(table.projectId),
  ],
);

export const managedRuntimeConnections = pgTable(
  "managed_runtime_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => managedRuntimeInstances.id, { onDelete: "cascade" }),
    kind: managedRuntimeConnectionKind("kind").notNull(),
    status: managedRuntimeConnectionStatus("status").default("connecting").notNull(),
    protocolVersion: text("protocol_version").notNull(),
    safeEndpointRef: text("safe_endpoint_ref"),
    credentialRef: text("credential_ref"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("managed_runtime_connections_instance_kind_unique").on(
      table.instanceId,
      table.kind,
    ),
    index("managed_runtime_connections_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("managed_runtime_connections_heartbeat_idx").on(table.lastHeartbeatAt),
  ],
);

export const runtimeLeases = pgTable(
  "runtime_leases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id"),
    sessionKey: text("session_key"),
    managedRuntimeInstanceId: uuid("managed_runtime_instance_id").references(
      () => managedRuntimeInstances.id,
      { onDelete: "set null" },
    ),
    runtimeProvider: text("runtime_provider").notNull(),
    runtimeModel: text("runtime_model"),
    placement: text("placement").default("cloud").notNull(),
    hostId: uuid("host_id").references(() => runtimeHosts.id, {
      onDelete: "set null",
    }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => runtimeImages.id, { onDelete: "restrict" }),
    sandboxId: text("sandbox_id"),
    status: runtimeLeaseStatus("status").default("requested").notNull(),
    leaseTokenHash: text("lease_token_hash").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    limitsJson: jsonb("limits_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("runtime_leases_token_hash_unique").on(table.leaseTokenHash),
    index("runtime_leases_org_status_idx").on(table.organizationId, table.status),
    index("runtime_leases_project_idx").on(table.projectId),
    index("runtime_leases_host_status_idx").on(table.hostId, table.status),
    index("runtime_leases_instance_idx").on(table.managedRuntimeInstanceId),
    index("runtime_leases_expires_idx").on(table.leaseExpiresAt),
  ],
);

export const managedRuntimeSessions = pgTable(
  "managed_runtime_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    instanceId: uuid("instance_id").references(
      () => managedRuntimeInstances.id,
      { onDelete: "set null" },
    ),
    leaseId: uuid("lease_id").references(() => runtimeLeases.id, {
      onDelete: "set null",
    }),
    hostId: uuid("host_id").references(() => runtimeHosts.id, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id"),
    sessionKey: text("session_key"),
    runtimeProvider: text("runtime_provider").notNull(),
    runtimeModel: text("runtime_model"),
    providerSessionStateJson: jsonb("provider_session_state_json")
      .$type<JsonRecord | null>(),
    status: managedRuntimeSessionStatus("status").default("starting").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("managed_runtime_sessions_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("managed_runtime_sessions_project_idx").on(table.projectId),
    index("managed_runtime_sessions_instance_idx").on(table.instanceId),
    index("managed_runtime_sessions_lease_idx").on(table.leaseId),
    index("managed_runtime_sessions_session_key_idx").on(
      table.organizationId,
      table.sessionKey,
    ),
    uniqueIndex("managed_runtime_sessions_instance_session_key_unique")
      .on(table.instanceId, table.sessionKey)
      .where(sql`${table.instanceId} IS NOT NULL AND ${table.sessionKey} IS NOT NULL`),
  ],
);

export const raviControlChatBindings = pgTable(
  "ravi_control_chat_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => managedRuntimeInstances.id, { onDelete: "cascade" }),
    actorType: actorType("actor_type").default("user").notNull(),
    actorId: text("actor_id").notNull(),
    targetAgentId: text("target_agent_id").notNull(),
    localActorId: text("local_actor_id"),
    localPlatformIdentityId: text("local_platform_identity_id"),
    localChatId: text("local_chat_id"),
    localSessionKey: text("local_session_key"),
    bindingVersion: integer("binding_version").default(1).notNull(),
    status: raviControlChatBindingStatus("status").default("pending").notNull(),
    chatCursor: text("chat_cursor"),
    sessionCursor: text("session_cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("ravi_control_chat_bindings_principal_unique").on(
      table.organizationId,
      table.instanceId,
      table.actorId,
      table.targetAgentId,
    ),
    uniqueIndex("ravi_control_chat_bindings_local_chat_unique")
      .on(table.instanceId, table.localChatId)
      .where(sql`${table.localChatId} IS NOT NULL`),
    index("ravi_control_chat_bindings_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("ravi_control_chat_bindings_project_idx").on(table.projectId),
    index("ravi_control_chat_bindings_instance_idx").on(table.instanceId),
  ],
);

export const managedRuntimeCommands = pgTable(
  "managed_runtime_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => managedRuntimeInstances.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => managedRuntimeSessions.id, {
      onDelete: "set null",
    }),
    actorType: actorType("actor_type").default("system").notNull(),
    actorId: text("actor_id"),
    action: managedRuntimeCommandAction("action").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: managedRuntimeCommandStatus("status").default("pending").notNull(),
    phase: text("phase"),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    encryptedInputJson: jsonb("encrypted_input_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    encryptedResultJson: jsonb("encrypted_result_json").$type<JsonRecord>(),
    safeResultJson: jsonb("safe_result_json").$type<JsonRecord>(),
    failureCode: text("failure_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("managed_runtime_commands_org_action_idempotency_unique").on(
      table.organizationId,
      table.action,
      table.idempotencyKey,
    ),
    index("managed_runtime_commands_claim_idx").on(
      table.status,
      table.claimExpiresAt,
      table.createdAt,
    ),
    index("managed_runtime_commands_instance_created_idx").on(
      table.instanceId,
      table.createdAt,
    ),
    index("managed_runtime_commands_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    uniqueIndex("managed_runtime_commands_session_execution_active_unique")
      .on(table.sessionId)
      .where(
        sql`${table.sessionId} IS NOT NULL AND ${table.action} <> 'turn_interrupt' AND ${table.status} IN ('pending', 'claimed', 'running')`,
      ),
    uniqueIndex("managed_runtime_commands_session_interrupt_active_unique")
      .on(table.sessionId)
      .where(
        sql`${table.sessionId} IS NOT NULL AND ${table.action} = 'turn_interrupt' AND ${table.status} IN ('pending', 'claimed', 'running')`,
      ),
    index("managed_runtime_commands_project_idx").on(table.projectId),
  ],
);

export const raviControlMessageMirrors = pgTable(
  "ravi_control_message_mirrors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => managedRuntimeInstances.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => raviControlChatBindings.id, { onDelete: "cascade" }),
    commandId: uuid("command_id").references(() => managedRuntimeCommands.id, {
      onDelete: "set null",
    }),
    localMessageId: text("local_message_id"),
    clientMessageId: text("client_message_id").notNull(),
    replyToLocalMessageId: text("reply_to_local_message_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    status: raviControlMessageMirrorStatus("status").default("queued").notNull(),
    cursor: text("cursor"),
    encryptedContentJson: jsonb("encrypted_content_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    failureCode: text("failure_code"),
    localCreatedAt: timestamp("local_created_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("ravi_control_message_mirrors_client_unique").on(
      table.bindingId,
      table.clientMessageId,
    ),
    uniqueIndex("ravi_control_message_mirrors_local_unique")
      .on(table.bindingId, table.localMessageId)
      .where(sql`${table.localMessageId} IS NOT NULL`),
    index("ravi_control_message_mirrors_binding_created_idx").on(
      table.bindingId,
      table.createdAt,
    ),
    index("ravi_control_message_mirrors_command_idx").on(table.commandId),
    index("ravi_control_message_mirrors_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const managedRuntimeEvents = pgTable(
  "managed_runtime_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => managedRuntimeSessions.id, {
      onDelete: "set null",
    }),
    leaseId: uuid("lease_id").references(() => runtimeLeases.id, {
      onDelete: "set null",
    }),
    hostId: uuid("host_id").references(() => runtimeHosts.id, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id"),
    commandId: uuid("command_id").references(() => managedRuntimeCommands.id, {
      onDelete: "set null",
    }),
    sourceEventId: text("source_event_id"),
    eventType: text("event_type").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    severity: managedRuntimeEventSeverity("severity").default("info").notNull(),
    safePayloadJson: jsonb("safe_payload_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    encryptedPayloadJson: jsonb("encrypted_payload_json").$type<JsonRecord>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("managed_runtime_events_session_source_unique")
      .on(table.sessionId, table.sourceEventId)
      .where(sql`${table.sessionId} IS NOT NULL AND ${table.sourceEventId} IS NOT NULL`),
    index("managed_runtime_events_org_idx").on(table.organizationId, table.createdAt),
    index("managed_runtime_events_session_idx").on(table.sessionId, table.sequence),
    index("managed_runtime_events_command_idx").on(table.commandId, table.sequence),
    index("managed_runtime_events_lease_idx").on(table.leaseId, table.sequence),
    index("managed_runtime_events_type_idx").on(table.eventType),
  ],
);

export const managedExecutionHarnesses = pgTable(
  "managed_execution_harnesses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    status: managedExecutionHarnessStatus("status").default("draft").notNull(),
    version: integer("version").default(1).notNull(),
    baseAgentId: text("base_agent_id"),
    baseProfileId: text("base_profile_id"),
    runtimePolicyJson: jsonb("runtime_policy_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    harnessHash: text("harness_hash").notNull(),
    compiledBundleJson: jsonb("compiled_bundle_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdByActorType: actorType("created_by_actor_type")
      .default("user")
      .notNull(),
    createdByActorId: text("created_by_actor_id"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("managed_execution_harnesses_org_slug_unique").on(
      table.organizationId,
      table.slug,
    ),
    index("managed_execution_harnesses_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("managed_execution_harnesses_project_idx").on(table.projectId),
    index("managed_execution_harnesses_base_agent_idx").on(
      table.organizationId,
      table.baseAgentId,
    ),
    index("managed_execution_harnesses_hash_idx").on(table.harnessHash),
  ],
);

export const managedExecutionHarnessApps = pgTable(
  "managed_execution_harness_apps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    harnessId: uuid("harness_id")
      .notNull()
      .references(() => managedExecutionHarnesses.id, { onDelete: "cascade" }),
    position: integer("position").default(0).notNull(),
    appId: text("app_id").notNull(),
    appVersion: text("app_version").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifestSource: text("manifest_source"),
    manifestPath: text("manifest_path"),
    required: boolean("required").default(true).notNull(),
    selectedOperationsJson: jsonb("selected_operations_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    selectedSkillsJson: jsonb("selected_skills_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    permissionProjectionJson: jsonb("permission_projection_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    toolProjectionJson: jsonb("tool_projection_json")
      .$type<JsonRecord[]>()
      .default(emptyJsonRecordArray)
      .notNull(),
    manifestSummaryJson: jsonb("manifest_summary_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("managed_execution_harness_apps_harness_app_unique").on(
      table.harnessId,
      table.appId,
    ),
    index("managed_execution_harness_apps_org_idx").on(table.organizationId),
    index("managed_execution_harness_apps_project_idx").on(table.projectId),
    index("managed_execution_harness_apps_harness_idx").on(
      table.harnessId,
      table.position,
    ),
    index("managed_execution_harness_apps_manifest_hash_idx").on(
      table.manifestHash,
    ),
  ],
);

export const managedExecutionToolProjections = pgTable(
  "managed_execution_tool_projections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    harnessId: uuid("harness_id")
      .notNull()
      .references(() => managedExecutionHarnesses.id, { onDelete: "cascade" }),
    harnessAppId: uuid("harness_app_id")
      .notNull()
      .references(() => managedExecutionHarnessApps.id, { onDelete: "cascade" }),
    appId: text("app_id").notNull(),
    operationId: text("operation_id").notNull(),
    toolId: text("tool_id").notNull(),
    toolName: text("tool_name").notNull(),
    interfaceName: text("interface_name").notNull(),
    mutating: boolean("mutating").default(false).notNull(),
    permissionRequirementJson: jsonb("permission_requirement_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    inputSchemaJson: jsonb("input_schema_json"),
    outputSchemaJson: jsonb("output_schema_json"),
    status: managedExecutionToolProjectionStatus("status")
      .default("active")
      .notNull(),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("managed_execution_tool_projections_harness_tool_unique").on(
      table.harnessId,
      table.toolId,
    ),
    uniqueIndex("managed_execution_tool_projections_harness_operation_unique").on(
      table.harnessId,
      table.appId,
      table.operationId,
    ),
    index("managed_execution_tool_projections_org_idx").on(table.organizationId),
    index("managed_execution_tool_projections_project_idx").on(table.projectId),
    index("managed_execution_tool_projections_harness_idx").on(table.harnessId),
    index("managed_execution_tool_projections_app_idx").on(table.appId),
  ],
);

export const runtimeTraceSessions = pgTable(
  "runtime_trace_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    localInstallationId: uuid("local_installation_id").references(
      () => localInstallations.id,
      { onDelete: "set null" },
    ),
    externalTraceId: text("external_trace_id").notNull(),
    sessionKey: text("session_key").notNull(),
    sessionName: text("session_name"),
    runId: text("run_id"),
    agentRef: text("agent_ref"),
    sourceChannel: text("source_channel"),
    sourceAccountId: text("source_account_id"),
    sourceChatId: text("source_chat_id"),
    sourceThreadId: text("source_thread_id"),
    canonicalChatId: text("canonical_chat_id"),
    managedRuntimeSessionId: text("managed_runtime_session_id"),
    managedRuntimeInstanceId: uuid("managed_runtime_instance_id").references(
      () => managedRuntimeInstances.id,
      { onDelete: "set null" },
    ),
    placement: text("placement").default("local").notNull(),
    runtimeProvider: text("runtime_provider").notNull(),
    runtimeModel: text("runtime_model"),
    status: text("status").default("active").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("runtime_trace_sessions_installation_external_unique").on(
      table.organizationId,
      table.localInstallationId,
      table.externalTraceId,
    ),
    index("runtime_trace_sessions_org_started_idx").on(
      table.organizationId,
      table.startedAt,
    ),
    index("runtime_trace_sessions_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
    index("runtime_trace_sessions_status_idx").on(table.status),
    index("runtime_trace_sessions_installation_idx").on(table.localInstallationId),
    index("runtime_trace_sessions_managed_instance_idx").on(
      table.managedRuntimeInstanceId,
    ),
    index("runtime_trace_sessions_session_key_idx").on(
      table.organizationId,
      table.sessionKey,
    ),
    index("runtime_trace_sessions_source_chat_idx").on(
      table.organizationId,
      table.sourceChannel,
      table.sourceAccountId,
      table.sourceChatId,
      table.startedAt,
    ),
    index("runtime_trace_sessions_canonical_chat_idx").on(
      table.organizationId,
      table.canonicalChatId,
      table.startedAt,
    ),
  ],
);

export const runtimeTraceTurns = pgTable(
  "runtime_trace_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traceSessionId: uuid("trace_session_id")
      .notNull()
      .references(() => runtimeTraceSessions.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    sourceTurnId: text("source_turn_id"),
    runtimeLeaseId: uuid("runtime_lease_id").references(() => runtimeLeases.id, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id"),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    status: text("status").default("running").notNull(),
    promptSha256: text("prompt_sha256"),
    userPromptSha256: text("user_prompt_sha256"),
    systemPromptSha256: text("system_prompt_sha256"),
    requestBlobSha256: text("request_blob_sha256"),
    requestBlobRef: text("request_blob_ref"),
    responseBlobRef: text("response_blob_ref"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    cacheReadTokens: integer("cache_read_tokens").default(0).notNull(),
    cacheCreationTokens: integer("cache_creation_tokens").default(0).notNull(),
    costUsd: numeric("cost_usd", { precision: 20, scale: 8 }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runtime_trace_turns_session_sequence_unique").on(
      table.traceSessionId,
      table.sequence,
    ),
    uniqueIndex("runtime_trace_turns_session_source_unique")
      .on(table.traceSessionId, table.sourceTurnId)
      .where(sql`${table.sourceTurnId} IS NOT NULL`),
    index("runtime_trace_turns_org_idx").on(table.organizationId),
    index("runtime_trace_turns_project_idx").on(table.projectId),
    index("runtime_trace_turns_session_idx").on(table.traceSessionId),
    index("runtime_trace_turns_lease_idx").on(table.runtimeLeaseId),
    index("runtime_trace_turns_status_idx").on(table.status),
  ],
);

export const runtimeTraceEvents = pgTable(
  "runtime_trace_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traceSessionId: uuid("trace_session_id")
      .notNull()
      .references(() => runtimeTraceSessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => runtimeTraceTurns.id, {
      onDelete: "set null",
    }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceEventId: text("source_event_id").notNull(),
    runtimeLeaseId: uuid("runtime_lease_id").references(() => runtimeLeases.id, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id"),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    eventGroup: text("event_group").notNull(),
    severity: text("severity").default("info").notNull(),
    status: text("status"),
    safePreview: text("safe_preview"),
    safePayloadJson: jsonb("safe_payload_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    blobRef: text("blob_ref"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runtime_trace_events_session_source_unique").on(
      table.traceSessionId,
      table.sourceEventId,
    ),
    index("runtime_trace_events_org_idx").on(table.organizationId),
    index("runtime_trace_events_lease_idx").on(table.runtimeLeaseId),
    index("runtime_trace_events_session_idx").on(
      table.traceSessionId,
      table.sequence,
    ),
    index("runtime_trace_events_session_time_idx").on(
      table.traceSessionId,
      table.occurredAt,
      table.sequence,
    ),
    index("runtime_trace_events_turn_idx").on(table.turnId, table.sequence),
    index("runtime_trace_events_type_idx").on(table.eventType),
    index("runtime_trace_events_group_idx").on(table.eventGroup),
    index("runtime_trace_events_occurred_idx").on(table.occurredAt),
  ],
);

export const runtimeTraceToolCalls = pgTable(
  "runtime_trace_tool_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traceSessionId: uuid("trace_session_id")
      .notNull()
      .references(() => runtimeTraceSessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => runtimeTraceTurns.id, {
      onDelete: "set null",
    }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runtimeLeaseId: uuid("runtime_lease_id").references(() => runtimeLeases.id, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id"),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name").notNull(),
    status: text("status").default("started").notNull(),
    inputPreview: text("input_preview"),
    outputPreview: text("output_preview"),
    inputBlobRef: text("input_blob_ref"),
    outputBlobRef: text("output_blob_ref"),
    approvalJson: jsonb("approval_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runtime_trace_tool_calls_session_tool_unique")
      .on(table.traceSessionId, table.toolCallId)
      .where(sql`${table.toolCallId} IS NOT NULL`),
    index("runtime_trace_tool_calls_org_idx").on(table.organizationId),
    index("runtime_trace_tool_calls_lease_idx").on(table.runtimeLeaseId),
    index("runtime_trace_tool_calls_session_idx").on(table.traceSessionId),
    index("runtime_trace_tool_calls_turn_idx").on(table.turnId),
    index("runtime_trace_tool_calls_status_idx").on(table.status),
    index("runtime_trace_tool_calls_name_idx").on(table.toolName),
  ],
);

export const runtimeTraceBlobs = pgTable(
  "runtime_trace_blobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    traceSessionId: uuid("trace_session_id")
      .notNull()
      .references(() => runtimeTraceSessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => runtimeTraceTurns.id, {
      onDelete: "set null",
    }),
    runtimeLeaseId: uuid("runtime_lease_id").references(() => runtimeLeases.id, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id"),
    kind: text("kind").notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sensitivity: text("sensitivity").default("content").notNull(),
    encryptionJson: jsonb("encryption_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    retentionClass: text("retention_class").default("default").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runtime_trace_blobs_session_kind_hash_unique").on(
      table.traceSessionId,
      table.kind,
      table.sha256,
    ),
    index("runtime_trace_blobs_org_idx").on(table.organizationId),
    index("runtime_trace_blobs_lease_idx").on(table.runtimeLeaseId),
    index("runtime_trace_blobs_session_idx").on(table.traceSessionId),
    index("runtime_trace_blobs_turn_idx").on(table.turnId),
    index("runtime_trace_blobs_kind_idx").on(table.kind, table.createdAt),
    index("runtime_trace_blobs_sha_idx").on(table.sha256),
  ],
);

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerCustomerId: text("provider_customer_id"),
    status: billingStatus("status").default("trialing").notNull(),
    planKey: text("plan_key").default("free").notNull(),
    legalName: text("legal_name"),
    taxId: text("tax_id"),
    billingEmail: text("billing_email"),
    phone: text("phone"),
    addressJson: jsonb("address_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    profileUpdatedAt: timestamp("profile_updated_at", { withTimezone: true }),
    profileUpdatedByUserId: uuid("profile_updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("billing_accounts_org_unique").on(table.organizationId),
    index("billing_accounts_provider_customer_idx").on(
      table.provider,
      table.providerCustomerId,
    ),
    index("billing_accounts_status_idx").on(table.status),
  ],
);

export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueJson: jsonb("value_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    source: text("source").default("manual").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("entitlements_org_key_unique").on(table.organizationId, table.key),
    index("entitlements_org_idx").on(table.organizationId),
  ],
);

export const quotaUsage = pgTable(
  "quota_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    used: numeric("used", { precision: 20, scale: 6 }).default("0").notNull(),
    limit: numeric("limit", { precision: 20, scale: 6 }),
    unit: text("unit").default("count").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("quota_usage_window_unique").on(
      table.organizationId,
      table.projectId,
      table.key,
      table.windowStart,
    ),
    index("quota_usage_org_idx").on(table.organizationId),
    index("quota_usage_project_idx").on(table.projectId),
    index("quota_usage_key_idx").on(table.key),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    siteId: uuid("site_id").references(() => pageSites.id, {
      onDelete: "set null",
    }),
    releaseId: uuid("release_id").references(() => pageSiteReleases.id, {
      onDelete: "set null",
    }),
    routeId: uuid("route_id").references(() => pageRoutes.id, {
      onDelete: "set null",
    }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    artifactVersionId: uuid("artifact_version_id").references(() => artifactVersions.id, {
      onDelete: "set null",
    }),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    publishId: uuid("publish_id").references(() => pagePublishes.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    metricKey: text("metric_key").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 })
      .default("0")
      .notNull(),
    unit: text("unit").default("count").notNull(),
    dimensionsJson: jsonb("dimensions_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    measurementsJson: jsonb("measurements_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    evidenceJson: jsonb("evidence_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    idempotencyKey: text("idempotency_key"),
    requestId: text("request_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("usage_events_idempotency_unique").on(
      table.organizationId,
      table.eventType,
      table.idempotencyKey,
    ),
    index("usage_events_org_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
    index("usage_events_project_occurred_idx").on(
      table.projectId,
      table.occurredAt,
    ),
    index("usage_events_site_occurred_idx").on(table.siteId, table.occurredAt),
    index("usage_events_artifact_version_idx").on(table.artifactVersionId),
    index("usage_events_asset_idx").on(table.assetId),
    index("usage_events_publish_idx").on(table.publishId),
    index("usage_events_metric_idx").on(table.metricKey),
    index("usage_events_request_idx").on(table.requestId),
  ],
);

export const usageRollups = pgTable(
  "usage_rollups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    siteId: uuid("site_id").references(() => pageSites.id, {
      onDelete: "set null",
    }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    artifactVersionId: uuid("artifact_version_id").references(() => artifactVersions.id, {
      onDelete: "set null",
    }),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    metricKey: text("metric_key").notNull(),
    interval: text("interval").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    dimensionHash: text("dimension_hash").notNull(),
    dimensionsJson: jsonb("dimensions_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 })
      .default("0")
      .notNull(),
    unit: text("unit").default("count").notNull(),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 20, scale: 8 }),
    evidenceJson: jsonb("evidence_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("usage_rollups_window_unique").on(
      table.organizationId,
      table.dimensionHash,
      table.metricKey,
      table.interval,
      table.windowStart,
    ),
    index("usage_rollups_org_window_idx").on(
      table.organizationId,
      table.windowStart,
    ),
    index("usage_rollups_project_window_idx").on(
      table.projectId,
      table.windowStart,
    ),
    index("usage_rollups_site_window_idx").on(table.siteId, table.windowStart),
    index("usage_rollups_metric_idx").on(table.metricKey),
  ],
);

export const billingContracts = pgTable(
  "billing_contracts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: billingContractStatus("status").default("active").notNull(),
    startsPeriod: text("starts_period").notNull(),
    endsPeriod: text("ends_period"),
    currency: text("currency").default("BRL").notNull(),
    dueDay: integer("due_day").default(10).notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("billing_contracts_org_version_unique").on(table.organizationId, table.version),
    index("billing_contracts_org_period_idx").on(table.organizationId, table.startsPeriod),
  ],
);

export const billingContractItems = pgTable(
  "billing_contract_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => billingContracts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: billingContractItemKind("kind").notNull(),
    description: text("description").notNull(),
    metricKey: text("metric_key"),
    quantity: numeric("quantity", { precision: 20, scale: 6 }),
    includedQuantity: numeric("included_quantity", { precision: 20, scale: 6 }),
    capQuantity: numeric("cap_quantity", { precision: 20, scale: 6 }),
    unit: text("unit").default("unit").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    ...lifecycleColumns(),
  },
  (table) => [index("billing_contract_items_contract_idx").on(table.contractId, table.position)],
);

export const billingInvoices = pgTable(
  "billing_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").references(() => billingContracts.id, {
      onDelete: "set null",
    }),
    period: text("period").notNull(),
    status: billingInvoiceStatus("status").default("draft").notNull(),
    currency: text("currency").default("BRL").notNull(),
    totalCents: bigint("total_cents", { mode: "number" }).default(0).notNull(),
    dueDate: text("due_date"),
    provider: text("provider"),
    providerCustomerId: text("provider_customer_id"),
    providerPaymentId: text("provider_payment_id"),
    providerInvoiceUrl: text("provider_invoice_url"),
    pixCopyPaste: text("pix_copy_paste"),
    boletoLine: text("boleto_line"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    preparedByUserId: uuid("prepared_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("billing_invoices_org_period_open_unique")
      .on(table.organizationId, table.period)
      .where(sql`${table.status} <> 'canceled'`),
    uniqueIndex("billing_invoices_provider_payment_unique").on(table.provider, table.providerPaymentId),
    index("billing_invoices_org_idx").on(table.organizationId, table.period),
    index("billing_invoices_status_idx").on(table.status),
  ],
);

export const billingInvoiceLines = pgTable(
  "billing_invoice_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => billingInvoices.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    source: text("source").notNull(),
    contractItemId: uuid("contract_item_id").references(() => billingContractItems.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    metricKey: text("metric_key"),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).default("1").notNull(),
    unit: text("unit").default("unit").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    detailsJson: jsonb("details_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [index("billing_invoice_lines_invoice_idx").on(table.invoiceId, table.position)],
);

export const billingProviderEvents = pgTable(
  "billing_provider_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    providerPaymentId: text("provider_payment_id"),
    invoiceId: uuid("invoice_id").references(() => billingInvoices.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome"),
    payloadJson: jsonb("payload_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("billing_provider_events_event_unique").on(table.provider, table.providerEventId),
    index("billing_provider_events_payment_idx").on(table.provider, table.providerPaymentId),
  ],
);

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    // GitHub installations belong to the organization (older rows still name
    // the project that installed them). Every other provider belongs to a
    // person (scope_kind user) or to the organization, with no project.
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    scopeKind: connectorScopeKind("scope_kind").notNull(),
    externalAccountId: text("external_account_id"),
    externalAccountLogin: text("external_account_login"),
    displayName: text("display_name").notNull(),
    status: connectorStatus("status").default("active").notNull(),
    scopesJson: jsonb("scopes_json").$type<string[]>().default(emptyJsonArray).notNull(),
    capabilitiesJson: jsonb("capabilities_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    requiresReauth: boolean("requires_reauth").default(false).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    managedByUserId: uuid("managed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastReauthAt: timestamp("last_reauth_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("provider_connections_org_idx").on(table.organizationId),
    index("provider_connections_user_idx").on(table.userId),
    index("provider_connections_project_idx").on(table.projectId),
    index("provider_connections_provider_idx").on(table.provider),
    index("provider_connections_status_idx").on(table.status),
    index("provider_connections_external_account_idx").on(
      table.provider,
      table.externalAccountId,
    ),
    uniqueIndex("provider_connections_project_provider_external_unique").on(
      table.projectId,
      table.provider,
      table.externalAccountId,
    ),
    uniqueIndex("provider_connections_user_account_unique")
      .on(table.organizationId, table.userId, table.provider, table.externalAccountId)
      .where(
        sql`${table.scopeKind} = 'user' AND ${table.externalAccountId} IS NOT NULL AND ${table.status} NOT IN ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider')`,
      ),
    uniqueIndex("provider_connections_org_account_unique")
      .on(table.organizationId, table.provider, table.externalAccountId)
      .where(
        sql`${table.scopeKind} = 'organization' AND ${table.externalAccountId} IS NOT NULL AND ${table.status} NOT IN ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider')`,
      ),
    uniqueIndex("provider_connections_user_default_unique")
      .on(table.organizationId, table.userId, table.provider)
      .where(sql`${table.isDefault} = true AND ${table.scopeKind} = 'user'`),
    // GitHub App installations belong to the organization (rows from before
    // that still carry a project); never to one person.
    check(
      "provider_connections_github_scope_check",
      sql`${table.provider} <> 'github' OR ${table.scopeKind} IN ('organization', 'project')`,
    ),
    check(
      "provider_connections_user_no_project_check",
      sql`${table.scopeKind} <> 'user' OR ${table.projectId} IS NULL`,
    ),
    check(
      "provider_connections_org_no_project_check",
      sql`${table.scopeKind} <> 'organization' OR ${table.projectId} IS NULL`,
    ),
  ],
);

export const consoleWatches = pgTable(
  "console_watches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    localInstallationId: uuid("local_installation_id").references(
      () => localInstallations.id,
      { onDelete: "set null" },
    ),
    provider: text("provider").notNull(),
    placement: consoleWatchPlacement("placement").default("console").notNull(),
    providerConnectionId: uuid("provider_connection_id").references(
      () => providerConnections.id,
      { onDelete: "set null" },
    ),
    providerInstallationId: text("provider_installation_id"),
    providerResourceId: text("provider_resource_id"),
    resourceRef: text("resource_ref").notNull(),
    watchKey: text("watch_key").notNull(),
    name: text("name"),
    description: text("description"),
    eventTypesJson: jsonb("event_types_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    filtersJson: jsonb("filters_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    deliveryJson: jsonb("delivery_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    status: consoleWatchStatus("status").default("active").notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("console_watches_org_watch_key_unique").on(
      table.organizationId,
      table.watchKey,
    ),
    index("console_watches_org_idx").on(table.organizationId),
    index("console_watches_project_idx").on(table.projectId),
    index("console_watches_created_by_idx").on(table.createdByUserId),
    index("console_watches_installation_idx").on(table.localInstallationId),
    index("console_watches_provider_idx").on(table.provider),
    index("console_watches_status_idx").on(table.status),
    index("console_watches_provider_resource_idx").on(
      table.provider,
      table.providerInstallationId,
      table.providerResourceId,
    ),
  ],
);

export const providerWebhookDeliveries = pgTable(
  "provider_webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    providerDeliveryId: text("provider_delivery_id").notNull(),
    providerInstallationId: text("provider_installation_id").notNull(),
    providerResourceId: text("provider_resource_id"),
    providerEventType: text("provider_event_type").notNull(),
    status: providerWebhookDeliveryStatus("status")
      .default("received")
      .notNull(),
    matchedWatchIdsJson: jsonb("matched_watch_ids_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    inboxItemIdsJson: jsonb("inbox_item_ids_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    requestId: text("request_id").notNull(),
    safeEnvelopeJson: jsonb("safe_envelope_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    errorCode: text("error_code"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("provider_webhook_deliveries_provider_delivery_unique").on(
      table.provider,
      table.providerInstallationId,
      table.providerDeliveryId,
    ),
    index("provider_webhook_deliveries_org_idx").on(table.organizationId),
    index("provider_webhook_deliveries_provider_idx").on(table.provider),
    index("provider_webhook_deliveries_status_idx").on(table.status),
    index("provider_webhook_deliveries_resource_idx").on(
      table.provider,
      table.providerInstallationId,
      table.providerResourceId,
    ),
  ],
);

export const channelHosts = pgTable(
  "channel_hosts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: channelHostProvider("provider").notNull(),
    displayName: text("display_name").notNull(),
    environment: channelHostEnvironment("environment")
      .default("production")
      .notNull(),
    region: text("region"),
    tenantMode: channelHostTenantMode("tenant_mode").default("shared").notNull(),
    controlBaseUrlRef: text("control_base_url_ref").notNull(),
    status: channelHostStatus("status").default("active").notNull(),
    capacityJson: jsonb("capacity_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    healthJson: jsonb("health_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("channel_hosts_provider_idx").on(table.provider),
    index("channel_hosts_status_idx").on(table.status),
    index("channel_hosts_environment_idx").on(table.environment),
  ],
);

export const channelInstances = pgTable(
  "channel_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    hostId: uuid("host_id")
      .references(() => channelHosts.id, { onDelete: "restrict" })
      .notNull(),
    channel: channelInstanceChannel("channel").notNull(),
    provider: channelInstanceProvider("provider").notNull(),
    externalInstanceId: text("external_instance_id").notNull(),
    externalInstanceName: text("external_instance_name").notNull(),
    displayName: text("display_name").notNull(),
    phoneE164: text("phone_e164"),
    phoneDisplay: text("phone_display"),
    status: channelInstanceStatus("status").default("provisioning").notNull(),
    connectionState: text("connection_state"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastDisconnectedAt: timestamp("last_disconnected_at", { withTimezone: true }),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("channel_instances_host_external_unique").on(
      table.hostId,
      table.externalInstanceId,
    ),
    index("channel_instances_org_idx").on(table.organizationId),
    index("channel_instances_host_idx").on(table.hostId),
    index("channel_instances_status_idx").on(table.status),
    index("channel_instances_channel_idx").on(table.channel),
    index("channel_instances_created_by_idx").on(table.createdByUserId),
  ],
);

export const channelInstanceCredentials = pgTable(
  "channel_instance_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelInstanceId: uuid("channel_instance_id")
      .references(() => channelInstances.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    credentialKind: channelCredentialKind("credential_kind").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    aadHash: text("aad_hash").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    dekKeyVersion: integer("dek_key_version").notNull(),
    payloadKeyVersion: integer("payload_key_version").default(1).notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    status: channelCredentialStatus("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("channel_instance_credentials_active_unique")
      .on(table.channelInstanceId, table.credentialKind)
      .where(sql`${table.status} = 'active'`),
    index("channel_instance_credentials_org_idx").on(table.organizationId),
    index("channel_instance_credentials_instance_idx").on(
      table.channelInstanceId,
    ),
    index("channel_instance_credentials_prefix_idx").on(table.keyPrefix),
    index("channel_instance_credentials_status_idx").on(table.status),
  ],
);

export const channelInstanceEvents = pgTable(
  "channel_instance_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    channelInstanceId: uuid("channel_instance_id").references(
      () => channelInstances.id,
      { onDelete: "set null" },
    ),
    hostId: uuid("host_id").references(() => channelHosts.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    severity: channelEventSeverity("severity").default("info").notNull(),
    requestId: text("request_id").notNull(),
    actorType: actorType("actor_type"),
    actorId: text("actor_id"),
    safeMetadataJson: jsonb("safe_metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    index("channel_instance_events_org_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("channel_instance_events_instance_idx").on(
      table.channelInstanceId,
      table.createdAt,
    ),
    index("channel_instance_events_host_idx").on(table.hostId),
    index("channel_instance_events_type_idx").on(table.eventType),
    index("channel_instance_events_request_idx").on(table.requestId),
  ],
);

export const channelOperationIdempotency = pgTable(
  "channel_operation_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    status: channelIdempotencyStatus("status").default("started").notNull(),
    channelInstanceId: uuid("channel_instance_id").references(
      () => channelInstances.id,
      { onDelete: "set null" },
    ),
    responseJson: jsonb("response_json").$type<JsonRecord>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("channel_operation_idempotency_org_key_operation_unique").on(
      table.organizationId,
      table.idempotencyKey,
      table.operation,
    ),
    index("channel_operation_idempotency_org_idx").on(table.organizationId),
    index("channel_operation_idempotency_status_idx").on(table.status),
    index("channel_operation_idempotency_expires_idx").on(table.expiresAt),
  ],
);

export const connectorCredentials = pgTable(
  "connector_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerConnectionId: uuid("provider_connection_id")
      .references(() => providerConnections.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    payloadKind: connectorCredentialKind("payload_kind").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    aadHash: text("aad_hash").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    dekKeyVersion: integer("dek_key_version").notNull(),
    payloadKeyVersion: integer("payload_key_version").default(1).notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    refreshSupported: boolean("refresh_supported").default(false).notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    index("connector_credentials_org_idx").on(table.organizationId),
    index("connector_credentials_user_idx").on(table.userId),
    uniqueIndex("connector_credentials_conn_kind_unique").on(
      table.providerConnectionId,
      table.payloadKind,
    ),
  ],
);

export const connectorGrantsPending = pgTable(
  "connector_grants_pending",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    // Placeholder until the signed-in initiator continues; then the hash of
    // the OAuth state token.
    stateTokenHash: text("state_token_hash").notNull(),
    // Single-use token in the Console page `/connect/<token>`.
    connectTokenHash: text("connect_token_hash"),
    continuedAt: timestamp("continued_at", { withTimezone: true }),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    codeEncrypted: text("code_encrypted"),
    resultTokenHash: text("result_token_hash"),
    targetScopeKind: connectorScopeKind("target_scope_kind").default("user").notNull(),
    reconnectConnectionId: uuid("reconnect_connection_id").references(
      () => providerConnections.id,
      { onDelete: "set null" },
    ),
    accessMode: connectorAccessMode("access_mode").default("full").notNull(),
    pkceVerifierEncrypted: text("pkce_verifier_encrypted"),
    requestedScopesJson: jsonb("requested_scopes_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    requestedDisplayName: text("requested_display_name"),
    origin: connectorGrantOrigin("origin").notNull(),
    cliSessionId: uuid("cli_session_id").references(() => cliSessions.id, {
      onDelete: "set null",
    }),
    status: connectorGrantStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    resultingConnectionId: uuid("resulting_connection_id"),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("connector_grants_pending_state_hash_unique").on(table.stateTokenHash),
    uniqueIndex("connector_grants_pending_connect_hash_unique")
      .on(table.connectTokenHash)
      .where(sql`${table.connectTokenHash} IS NOT NULL`),
    index("connector_grants_pending_user_idx").on(table.userId),
    index("connector_grants_pending_org_idx").on(table.organizationId),
    index("connector_grants_pending_project_idx").on(table.projectId),
    index("connector_grants_pending_status_idx").on(table.status),
    index("connector_grants_pending_expires_idx").on(table.expiresAt),
  ],
);

export const connectorStepupChallenges = pgTable(
  "connector_stepup_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerConnectionId: uuid("provider_connection_id")
      .references(() => providerConnections.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    capability: text("capability").notNull(),
    capabilityClass: text("capability_class").notNull(),
    factor: connectorStepupFactor("factor"),
    status: connectorStepupStatus("status").default("issued").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("connector_stepup_token_hash_unique").on(table.tokenHash),
    index("connector_stepup_conn_idx").on(table.providerConnectionId),
    index("connector_stepup_user_idx").on(table.userId),
    index("connector_stepup_status_idx").on(table.status),
    index("connector_stepup_expires_idx").on(table.expiresAt),
  ],
);

export const connectorOrgPolicies = pgTable(
  "connector_org_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    provider: text("provider").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    writesAllowed: boolean("writes_allowed").default(true).notNull(),
    sharedAllowed: boolean("shared_allowed").default(false).notNull(),
    toolCeilingsJson: jsonb("tool_ceilings_json")
      .$type<Record<string, "always_allow" | "needs_approval" | "blocked">>()
      .default(emptyJson)
      .notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("connector_org_policies_org_provider_unique").on(
      table.organizationId,
      table.provider,
    ),
  ],
);

export const connectorToolPolicies = pgTable(
  "connector_tool_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerConnectionId: uuid("provider_connection_id")
      .references(() => providerConnections.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    capability: text("capability").notNull(),
    policy: connectorToolPolicy("policy").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("connector_tool_policies_conn_capability_unique").on(
      table.providerConnectionId,
      table.capability,
    ),
    index("connector_tool_policies_org_idx").on(table.organizationId),
  ],
);

export const connectorActionApprovals = pgTable(
  "connector_action_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    providerConnectionId: uuid("provider_connection_id")
      .references(() => providerConnections.id, { onDelete: "cascade" })
      .notNull(),
    ownerUserId: uuid("owner_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    localInstallationId: uuid("local_installation_id").references(
      () => localInstallations.id,
      { onDelete: "set null" },
    ),
    cliSessionId: uuid("cli_session_id").references(() => cliSessions.id, {
      onDelete: "set null",
    }),
    capability: text("capability").notNull(),
    capabilityClass: text("capability_class").notNull(),
    paramsHash: text("params_hash").notNull(),
    previewEncrypted: text("preview_encrypted"),
    reason: text("reason").default("policy").notNull(),
    execContextJson: jsonb("exec_context_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    status: connectorApprovalStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("connector_action_approvals_owner_status_idx").on(table.ownerUserId, table.status),
    index("connector_action_approvals_conn_idx").on(table.providerConnectionId),
    index("connector_action_approvals_expires_idx").on(table.expiresAt),
  ],
);

export const connectorUsage = pgTable(
  "connector_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerConnectionId: uuid("provider_connection_id")
      .references(() => providerConnections.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    localInstallationId: uuid("local_installation_id")
      .references(() => localInstallations.id, { onDelete: "cascade" })
      .notNull(),
    agentId: text("agent_id").default("").notNull(),
    routineKey: text("routine_key").default("").notNull(),
    mode: text("mode").default("owner").notNull(),
    conversation: text("conversation").default("terminal").notNull(),
    lastCapability: text("last_capability"),
    useCount: integer("use_count").default(0).notNull(),
    firstUsedAt: timestamp("first_used_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("connector_usage_key_unique").on(
      table.providerConnectionId,
      table.localInstallationId,
      table.agentId,
      table.routineKey,
      table.mode,
    ),
    index("connector_usage_org_idx").on(table.organizationId),
  ],
);

export const connectorTurnReads = pgTable(
  "connector_turn_reads",
  {
    localInstallationId: uuid("local_installation_id")
      .references(() => localInstallations.id, { onDelete: "cascade" })
      .notNull(),
    turnKeyHash: text("turn_key_hash").notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.localInstallationId, table.turnKeyHash] }),
    index("connector_turn_reads_expires_idx").on(table.expiresAt),
  ],
);

export const agentConnectorGrants = pgTable(
  "agent_connector_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    localInstallationId: uuid("local_installation_id")
      .references(() => localInstallations.id, { onDelete: "cascade" })
      .notNull(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    mode: connectorAgentGrantMode("mode").notNull(),
    providerConnectionId: uuid("provider_connection_id").references(
      () => providerConnections.id,
      { onDelete: "cascade" },
    ),
    // Always the account owner (person_asking) or the organization
    // connection's manager (shared). Never the operator on someone's behalf.
    grantedByUserId: uuid("granted_by_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    conversationsJson: jsonb("conversations_json")
      .$type<string[]>()
      .default(sql`'["dm"]'::jsonb`)
      .notNull(),
    status: connectorAgentGrantStatus("status").default("active").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("agent_connector_grants_active_unique")
      .on(
        table.localInstallationId,
        table.agentId,
        table.provider,
        table.grantedByUserId,
        table.mode,
      )
      .where(sql`${table.status} = 'active'`),
    index("agent_connector_grants_org_idx").on(table.organizationId),
    index("agent_connector_grants_granted_by_idx").on(table.grantedByUserId),
    index("agent_connector_grants_conn_idx").on(table.providerConnectionId),
  ],
);

export const connectorConsentRequests = pgTable(
  "connector_consent_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    localInstallationId: uuid("local_installation_id")
      .references(() => localInstallations.id, { onDelete: "cascade" })
      .notNull(),
    agentId: text("agent_id").notNull(),
    agentDisplayName: text("agent_display_name"),
    provider: text("provider").notNull(),
    contactId: text("contact_id").notNull(),
    bindingId: uuid("binding_id")
      .references(() => raviActorBindings.id, { onDelete: "cascade" })
      .notNull(),
    consoleUserId: uuid("console_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: connectorConsentRequestStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    grantId: uuid("grant_id").references(() => agentConnectorGrants.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("connector_consent_requests_token_hash_unique").on(table.tokenHash),
    uniqueIndex("connector_consent_requests_pending_unique")
      .on(table.localInstallationId, table.agentId, table.provider, table.consoleUserId)
      .where(sql`${table.status} = 'pending'`),
    index("connector_consent_requests_user_idx").on(table.consoleUserId),
  ],
);

export const connectorRevocationOutbox = pgTable(
  "connector_revocation_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    providerConnectionId: uuid("provider_connection_id")
      .references(() => providerConnections.id, { onDelete: "cascade" })
      .notNull(),
    reason: text("reason").notNull(),
    status: connectorRevocationStatus("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    index("connector_revocation_outbox_due_idx").on(table.status, table.nextAttemptAt),
    index("connector_revocation_outbox_conn_idx").on(table.providerConnectionId),
  ],
);

export const mcpBridges = pgTable(
  "mcp_bridges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sessionRef: text("session_ref").notNull(),
    channelId: text("channel_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: mcpBridgeStatus("status").default("active").notNull(),
    bridgeTokenHash: text("bridge_token_hash").notNull(),
    previousBridgeTokenHash: text("previous_bridge_token_hash"),
    lastUrlRotationAt: timestamp("last_url_rotation_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    allowedCapabilityClassesJson: jsonb("allowed_capability_classes_json")
      .$type<string[]>()
      .default(sql<string[]>`'["read"]'::jsonb`)
      .notNull(),
    rateLimitOverridesJson: jsonb("rate_limit_overrides_json").$type<JsonRecord>(),
    cachedToolsJson: jsonb("cached_tools_json").$type<JsonRecord>(),
    cachedToolsAt: timestamp("cached_tools_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("mcp_bridges_token_hash_unique").on(table.bridgeTokenHash),
    uniqueIndex("mcp_bridges_previous_token_hash_unique")
      .on(table.previousBridgeTokenHash)
      .where(sql`${table.previousBridgeTokenHash} IS NOT NULL`),
    index("mcp_bridges_org_idx").on(table.organizationId),
    index("mcp_bridges_project_idx").on(table.projectId),
    index("mcp_bridges_created_by_idx").on(table.createdByUserId),
    index("mcp_bridges_status_idx").on(table.status),
    index("mcp_bridges_last_used_idx").on(table.lastUsedAt),
  ],
);

export const mcpOAuthClients = pgTable(
  "mcp_oauth_clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    bridgeId: uuid("bridge_id")
      .references(() => mcpBridges.id, { onDelete: "cascade" })
      .notNull(),
    clientId: text("client_id").notNull(),
    clientSecretHash: text("client_secret_hash"),
    clientName: text("client_name").notNull(),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    redirectUrisJson: jsonb("redirect_uris_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    grantTypesJson: jsonb("grant_types_json")
      .$type<string[]>()
      .default(sql<string[]>`'["authorization_code","refresh_token"]'::jsonb`)
      .notNull(),
    tokenEndpointAuthMethod: mcpOAuthClientAuthMethod(
      "token_endpoint_auth_method",
    )
      .default("none")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mcp_oauth_clients_client_id_unique").on(table.clientId),
    index("mcp_oauth_clients_org_idx").on(table.organizationId),
    index("mcp_oauth_clients_project_idx").on(table.projectId),
    index("mcp_oauth_clients_bridge_idx").on(table.bridgeId),
  ],
);

export const mcpOAuthAuthorizations = pgTable(
  "mcp_oauth_authorizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    bridgeId: uuid("bridge_id")
      .references(() => mcpBridges.id, { onDelete: "cascade" })
      .notNull(),
    oauthClientId: uuid("oauth_client_id")
      .references(() => mcpOAuthClients.id, { onDelete: "cascade" })
      .notNull(),
    codeHash: text("code_hash").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scopesJson: jsonb("scopes_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    subjectUserId: uuid("subject_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mcp_oauth_authorizations_code_hash_unique").on(table.codeHash),
    index("mcp_oauth_authorizations_org_idx").on(table.organizationId),
    index("mcp_oauth_authorizations_project_idx").on(table.projectId),
    index("mcp_oauth_authorizations_bridge_idx").on(table.bridgeId),
    index("mcp_oauth_authorizations_client_idx").on(table.oauthClientId),
    index("mcp_oauth_authorizations_subject_idx").on(table.subjectUserId),
    index("mcp_oauth_authorizations_expires_idx").on(table.expiresAt),
  ],
);

export const mcpOAuthTokens = pgTable(
  "mcp_oauth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    bridgeId: uuid("bridge_id")
      .references(() => mcpBridges.id, { onDelete: "cascade" })
      .notNull(),
    oauthClientId: uuid("oauth_client_id")
      .references(() => mcpOAuthClients.id, { onDelete: "cascade" })
      .notNull(),
    subjectUserId: uuid("subject_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    scopesJson: jsonb("scopes_json")
      .$type<string[]>()
      .default(emptyJsonArray)
      .notNull(),
    deviceLabel: text("device_label"),
    rotatedFromTokenId: uuid("rotated_from_token_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("mcp_oauth_tokens_access_hash_unique").on(
      table.accessTokenHash,
    ),
    uniqueIndex("mcp_oauth_tokens_refresh_hash_unique").on(
      table.refreshTokenHash,
    ),
    index("mcp_oauth_tokens_org_idx").on(table.organizationId),
    index("mcp_oauth_tokens_project_idx").on(table.projectId),
    index("mcp_oauth_tokens_bridge_idx").on(table.bridgeId),
    index("mcp_oauth_tokens_client_idx").on(table.oauthClientId),
    index("mcp_oauth_tokens_subject_idx").on(table.subjectUserId),
    index("mcp_oauth_tokens_revoked_idx").on(table.revokedAt),
    index("mcp_oauth_tokens_access_expires_idx").on(
      table.accessTokenExpiresAt,
    ),
    index("mcp_oauth_tokens_refresh_expires_idx").on(
      table.refreshTokenExpiresAt,
    ),
  ],
);

export const mcpBridgeEvents = pgTable(
  "mcp_bridge_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bridgeId: uuid("bridge_id")
      .references(() => mcpBridges.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    eventType: mcpBridgeEventType("event_type").notNull(),
    toolName: text("tool_name"),
    model: text("model"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    costEstimateUsd: numeric("cost_estimate_usd", {
      precision: 10,
      scale: 6,
    }),
    durationMs: integer("duration_ms").notNull(),
    statusClass: mcpBridgeEventStatusClass("status_class").notNull(),
    requestId: text("request_id").notNull(),
    oauthClientId: uuid("oauth_client_id").references(
      () => mcpOAuthClients.id,
      { onDelete: "set null" },
    ),
    clientUserAgent: text("client_user_agent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("mcp_bridge_events_org_idx").on(table.organizationId),
    index("mcp_bridge_events_project_idx").on(table.projectId),
    index("mcp_bridge_events_bridge_occurred_idx").on(
      table.bridgeId,
      table.occurredAt,
    ),
    index("mcp_bridge_events_type_idx").on(table.eventType),
    index("mcp_bridge_events_client_idx").on(table.oauthClientId),
    index("mcp_bridge_events_request_idx").on(table.requestId),
  ],
);

export const mcpBridgeUsage = pgTable(
  "mcp_bridge_usage",
  {
    bridgeId: uuid("bridge_id")
      .references(() => mcpBridges.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    day: date("day").notNull(),
    callsTotal: integer("calls_total").default(0).notNull(),
    callsOk: integer("calls_ok").default(0).notNull(),
    callsError: integer("calls_error").default(0).notNull(),
    tokensInputTotal: bigint("tokens_input_total", { mode: "number" })
      .default(0)
      .notNull(),
    tokensOutputTotal: bigint("tokens_output_total", { mode: "number" })
      .default(0)
      .notNull(),
    costEstimateTotalUsd: numeric("cost_estimate_total_usd", {
      precision: 12,
      scale: 6,
    })
      .default("0")
      .notNull(),
    uniqueClients: integer("unique_clients").default(0).notNull(),
    daemonOfflineCount: integer("daemon_offline_count").default(0).notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    primaryKey({
      columns: [table.bridgeId, table.day],
      name: "mcp_bridge_usage_pk",
    }),
    index("mcp_bridge_usage_org_day_idx").on(table.organizationId, table.day),
    index("mcp_bridge_usage_project_day_idx").on(table.projectId, table.day),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    actorType: actorType("actor_type").default("system").notNull(),
    actorId: text("actor_id"),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    action: text("action").notNull(),
    requestId: text("request_id"),
    beforeJson: jsonb("before_json").$type<JsonRecord>(),
    afterJson: jsonb("after_json").$type<JsonRecord>(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_events_org_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("audit_events_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("audit_events_action_idx").on(table.action),
    index("audit_events_actor_idx").on(table.actorType, table.actorId),
    index("audit_events_request_idx").on(table.requestId),
  ],
);

export const bugReports = pgTable(
  "bug_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    schemaVersion: text("schema_version")
      .default("ravi.bug_report/v1")
      .notNull(),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    severity: bugReportSeverity("severity").notNull(),
    surface: text("surface"),
    status: bugReportStatus("status").default("submitted").notNull(),
    statusNote: text("status_note"),
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    payloadJson: jsonb("payload_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    priority: bugReportPriority("priority"),
    priorityScore: integer("priority_score"),
    duplicateOfId: uuid("duplicate_of_id"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    triageJson: jsonb("triage_json").$type<JsonRecord>(),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    lastTriageAt: timestamp("last_triage_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    foreignKey({
      columns: [table.duplicateOfId],
      foreignColumns: [table.id],
      name: "bug_reports_duplicate_of_id_bug_reports_id_fk",
    }).onDelete("set null"),
    index("bug_reports_reporter_user_id_idx").on(table.reporterUserId),
    index("bug_reports_status_idx").on(table.status),
    index("bug_reports_created_at_idx").on(table.createdAt),
    index("bug_reports_priority_idx").on(table.priority),
    index("bug_reports_assignee_user_id_idx").on(table.assigneeUserId),
    index("bug_reports_duplicate_of_id_idx").on(table.duplicateOfId),
    index("bug_reports_status_priority_score_idx").on(table.status, table.priorityScore),
  ],
);

export const bugTriageJobs = pgTable(
  "bug_triage_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bugReportId: uuid("bug_report_id")
      .notNull()
      .references(() => bugReports.id, { onDelete: "cascade" }),
    status: bugTriageJobStatus("status").default("queued").notNull(),
    trigger: bugTriageJobTrigger("trigger").notNull(),
    requestId: text("request_id"),
    attempts: integer("attempts").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("bug_triage_jobs_active_unique")
      .on(table.bugReportId)
      .where(sql`${table.status} IN ('queued', 'running')`),
    index("bug_triage_jobs_status_created_idx").on(table.status, table.createdAt),
    index("bug_triage_jobs_bug_report_id_idx").on(table.bugReportId),
    index("bug_triage_jobs_locked_until_idx").on(table.lockedUntil),
  ],
);

export const bugReportSubscriptions = pgTable(
  "bug_report_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bugReportId: uuid("bug_report_id")
      .notNull()
      .references(() => bugReports.id, { onDelete: "cascade" }),
    localInstallationId: uuid("local_installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("bug_report_subscriptions_bug_installation_unique").on(
      table.bugReportId,
      table.localInstallationId,
    ),
    index("bug_report_subscriptions_bug_report_id_idx").on(table.bugReportId),
    index("bug_report_subscriptions_installation_idx").on(table.localInstallationId),
    index("bug_report_subscriptions_user_id_idx").on(table.userId),
  ],
);

export const bugReportComments = pgTable(
  "bug_report_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bugReportId: uuid("bug_report_id")
      .notNull()
      .references(() => bugReports.id, { onDelete: "cascade" }),
    schemaVersion: text("schema_version")
      .default("ravi.bug_comment/v1")
      .notNull(),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    source: text("source").notNull(),
    text: text("text"),
    payloadJson: jsonb("payload_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("bug_report_comments_bug_idempotency_unique").on(
      table.bugReportId,
      table.idempotencyKey,
    ),
    index("bug_report_comments_bug_report_id_idx").on(table.bugReportId),
    index("bug_report_comments_created_at_idx").on(table.createdAt),
    index("bug_report_comments_author_user_id_idx").on(table.authorUserId),
  ],
);

// ---------------------------------------------------------------------------
// Bases (`.ravi/specs/console/bases`). Values are keyed by property id; the
// Query AST compiler is the only reader of `values_json`.

export const bases = pgTable(
  "bases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    timezone: text("timezone").default("UTC").notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    version: integer("version").default(1).notNull(),
    status: text("status").default("active").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id"),
    updatedByActorType: actorType("updated_by_actor_type").notNull(),
    updatedByActorId: text("updated_by_actor_id"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("bases_project_slug_unique").on(table.projectId, table.slug),
    index("bases_organization_id_idx").on(table.organizationId),
    index("bases_project_status_idx").on(table.projectId, table.status),
  ],
);

export const baseProperties = pgTable(
  "base_properties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    baseId: uuid("base_id")
      .notNull()
      .references(() => bases.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull(),
    configJson: jsonb("config_json").$type<JsonRecord>().default(emptyJson).notNull(),
    position: integer("position").default(0).notNull(),
    required: boolean("required").default(false).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("base_properties_base_key_active_unique")
      .on(table.baseId, table.key)
      .where(sql`${table.deletedAt} IS NULL`),
    index("base_properties_base_id_idx").on(table.baseId),
    index("base_properties_organization_id_idx").on(table.organizationId),
    index("base_properties_project_id_idx").on(table.projectId),
  ],
);

export const baseRows = pgTable(
  "base_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    baseId: uuid("base_id")
      .notNull()
      .references(() => bases.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    valuesJson: jsonb("values_json").$type<JsonRecord>().default(emptyJson).notNull(),
    body: text("body"),
    version: integer("version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id"),
    updatedByActorType: actorType("updated_by_actor_type").notNull(),
    updatedByActorId: text("updated_by_actor_id"),
    ...lifecycleColumns(),
  },
  (table) => [
    index("base_rows_base_active_created_idx").on(table.baseId, table.archivedAt, table.createdAt, table.id),
    index("base_rows_values_json_gin_idx").using("gin", table.valuesJson.op("jsonb_path_ops")),
    index("base_rows_organization_id_idx").on(table.organizationId),
    index("base_rows_project_id_idx").on(table.projectId),
  ],
);

export const baseRowLedger = pgTable(
  "base_row_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    baseId: uuid("base_id")
      .notNull()
      .references(() => bases.id, { onDelete: "cascade" }),
    // No FK: purge deletes the row and keeps a tombstone entry.
    rowId: uuid("row_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    action: text("action").notNull(),
    changedPropertyIds: jsonb("changed_property_ids").$type<string[]>().default(emptyJsonArray).notNull(),
    beforeJson: jsonb("before_json").$type<JsonRecord>().default(emptyJson).notNull(),
    afterJson: jsonb("after_json").$type<JsonRecord>().default(emptyJson).notNull(),
    bodyChanged: boolean("body_changed").default(false).notNull(),
    lastWriteWins: boolean("last_write_wins").default(false).notNull(),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    surface: text("surface").notNull(),
    viewId: uuid("view_id"),
    requestId: text("request_id"),
    clientHintJson: jsonb("client_hint_json").$type<JsonRecord>(),
    // The agent that wrote for the accountable actor above, asserted by a CLI
    // installation's client hint; null otherwise. No FK: history outlives it.
    agentId: text("agent_id"),
    localInstallationId: uuid("local_installation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("base_row_ledger_sequence_unique").on(table.sequence),
    index("base_row_ledger_row_sequence_idx").on(table.rowId, table.sequence),
    index("base_row_ledger_base_sequence_idx").on(table.baseId, table.sequence),
    index("base_row_ledger_organization_id_idx").on(table.organizationId),
    index("base_row_ledger_project_id_idx").on(table.projectId),
  ],
);

export const baseViews = pgTable(
  "base_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    baseId: uuid("base_id")
      .notNull()
      .references(() => bases.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Stored with property ids, system column names, or "body".
    columnsJson: jsonb("columns_json").$type<string[]>().default(emptyJsonArray).notNull(),
    queryJson: jsonb("query_json").$type<JsonRecord>().default(emptyJson).notNull(),
    layoutJson: jsonb("layout_json").$type<JsonRecord>().default(emptyJson).notNull(),
    accessJson: jsonb("access_json").$type<JsonRecord>().default(emptyJson).notNull(),
    position: integer("position").default(0).notNull(),
    version: integer("version").default(1).notNull(),
    status: text("status").default("active").notNull(),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id"),
    updatedByActorType: actorType("updated_by_actor_type").notNull(),
    updatedByActorId: text("updated_by_actor_id"),
    ...lifecycleColumns(),
  },
  (table) => [
    index("base_views_base_status_idx").on(table.baseId, table.status),
    index("base_views_organization_id_idx").on(table.organizationId),
    index("base_views_project_id_idx").on(table.projectId),
  ],
);

export const baseCharts = pgTable(
  "base_charts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    baseId: uuid("base_id")
      .notNull()
      .references(() => bases.id, { onDelete: "cascade" }),
    viewId: uuid("view_id")
      .notNull()
      .references(() => baseViews.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Stored with property ids in encoding fields.
    specJson: jsonb("spec_json").$type<JsonRecord>().default(emptyJson).notNull(),
    position: integer("position").default(0).notNull(),
    version: integer("version").default(1).notNull(),
    status: text("status").default("active").notNull(),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id"),
    updatedByActorType: actorType("updated_by_actor_type").notNull(),
    updatedByActorId: text("updated_by_actor_id"),
    ...lifecycleColumns(),
  },
  (table) => [
    index("base_charts_base_status_idx").on(table.baseId, table.status),
    index("base_charts_view_id_idx").on(table.viewId),
    index("base_charts_organization_id_idx").on(table.organizationId),
    index("base_charts_project_id_idx").on(table.projectId),
  ],
);

export const baseOperations = pgTable(
  "base_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    baseId: uuid("base_id")
      .notNull()
      .references(() => bases.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    // { rowIds, versions } only; never values.
    resultJson: jsonb("result_json").$type<JsonRecord>().default(emptyJson).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("base_operations_scope_key_unique").on(
      table.organizationId,
      table.sourceKind,
      table.sourceId,
      table.operation,
      table.idempotencyKey,
    ),
    index("base_operations_base_id_idx").on(table.baseId),
    index("base_operations_project_id_idx").on(table.projectId),
    index("base_operations_expires_at_idx").on(table.expiresAt),
  ],
);

export const baseSubscriptions = pgTable(
  "base_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    baseId: uuid("base_id")
      .notNull()
      .references(() => bases.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    localInstallationId: uuid("local_installation_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").default("active").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // { viewId, propertyIds, events } (canonical, ids); {} when unfiltered.
    filterJson: jsonb("filter_json").$type<JsonRecord>().default(emptyJson).notNull(),
    // Hash of the canonical filter; '' when unfiltered.
    filterKey: text("filter_key").default("").notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    foreignKey({
      name: "base_subscriptions_installation_fk",
      columns: [table.localInstallationId],
      foreignColumns: [localInstallations.id],
    }).onDelete("cascade"),
    uniqueIndex("base_subscriptions_base_installation_filter_active_unique")
      .on(table.baseId, table.localInstallationId, table.filterKey)
      .where(sql`${table.status} = 'active'`),
    index("base_subscriptions_base_status_idx").on(table.baseId, table.status),
    index("base_subscriptions_installation_idx").on(table.localInstallationId),
    index("base_subscriptions_organization_id_idx").on(table.organizationId),
    index("base_subscriptions_project_id_idx").on(table.projectId),
  ],
);

// One cloud bot sent into a call by `ravi meetings join --cloud`. The vendor
// (Recall.ai today) holds the media; this row holds the lifecycle, the usage
// facts and which local installation gets the recording.
export const meetingBots = pgTable(
  "meeting_bots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    localInstallationId: uuid("local_installation_id").references(() => localInstallations.id, {
      onDelete: "set null",
    }),
    provider: text("provider").default("recall").notNull(),
    providerBotId: text("provider_bot_id"),
    platform: text("platform").notNull(),
    meetingUrl: text("meeting_url").notNull(),
    meetingCode: text("meeting_code"),
    botName: text("bot_name").notNull(),
    title: text("title"),
    language: text("language").notNull(),
    clientRef: text("client_ref"),
    status: meetingBotStatus("status").default("requested").notNull(),
    statusSubCode: text("status_sub_code"),
    transcriptStatus: text("transcript_status").default("pending").notNull(),
    joinAt: timestamp("join_at", { withTimezone: true }),
    recordingStartedAt: timestamp("recording_started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    recordingSeconds: integer("recording_seconds"),
    maxRecordingSeconds: integer("max_recording_seconds").notNull(),
    readyNotifiedAt: timestamp("ready_notified_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("meeting_bots_provider_bot_unique")
      .on(table.provider, table.providerBotId)
      .where(sql`${table.providerBotId} IS NOT NULL`),
    index("meeting_bots_org_created_idx").on(table.organizationId, table.createdAt),
    index("meeting_bots_org_status_idx").on(table.organizationId, table.status),
    index("meeting_bots_project_idx").on(table.projectId),
    index("meeting_bots_installation_idx").on(table.localInstallationId),
  ],
);

export const organizationInviteStatus = pgEnum("organization_invite_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

/**
 * A link that adds one person to an organization. Single use, bound to the
 * invited email, and stored as a hash: the raw token only ever goes back to
 * whoever created the invite.
 */
export const organizationInvites = pgTable(
  "organization_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: organizationRole("role").default("viewer").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: organizationInviteStatus("status").default("pending").notNull(),
    invitedByActorType: actorType("invited_by_actor_type").default("user").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("organization_invites_token_hash_unique").on(table.tokenHash),
    uniqueIndex("organization_invites_org_email_pending_unique")
      .on(table.organizationId, table.email)
      .where(sql`${table.status} = 'pending'`),
    index("organization_invites_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const accessObjectType = pgEnum("access_object_type", ["page_site", "page_route", "meeting"]);

export const accessRelation = pgEnum("access_relation", ["viewer"]);

export const accessSubjectType = pgEnum("access_subject_type", ["user"]);

/**
 * Access given to one person on one resource, stored as a relation tuple
 * (`object#relation@subject`, the OpenFGA shape) so groups and custom roles
 * can join later without a new model. `page_site_id` scopes every Pages tuple
 * to its site and `meeting_bot_id` every meeting tuple to its meeting, so
 * deleting the resource removes them.
 */
export const accessGrants = pgTable(
  "access_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageSiteId: uuid("page_site_id").references(() => pageSites.id, { onDelete: "cascade" }),
    meetingBotId: uuid("meeting_bot_id").references(() => meetingBots.id, { onDelete: "cascade" }),
    objectType: accessObjectType("object_type").notNull(),
    objectId: uuid("object_id").notNull(),
    relation: accessRelation("relation").default("viewer").notNull(),
    subjectType: accessSubjectType("subject_type").default("user").notNull(),
    subjectId: uuid("subject_id").notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByActorType: actorType("created_by_actor_type").default("user").notNull(),
    createdByActorId: text("created_by_actor_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByActorType: actorType("revoked_by_actor_type"),
    revokedByActorId: text("revoked_by_actor_id"),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("access_grants_tuple_active_unique")
      .on(table.objectType, table.objectId, table.relation, table.subjectType, table.subjectId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("access_grants_subject_idx").on(table.subjectType, table.subjectId),
    index("access_grants_site_idx").on(table.pageSiteId),
    index("access_grants_meeting_idx").on(table.meetingBotId),
    index("access_grants_org_idx").on(table.organizationId),
    check(
      "access_grants_object_scope_check",
      sql`(${table.objectType}::text IN ('page_site', 'page_route') AND ${table.pageSiteId} IS NOT NULL) OR (${table.objectType}::text = 'meeting' AND ${table.meetingBotId} IS NOT NULL)`,
    ),
  ],
);

/**
 * A rule an organization's owner or admin sets for the whole organization,
 * one row per key. Absent means the rule's default, which is always the
 * narrower choice.
 */
export const organizationPolicies = pgTable(
  "organization_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueJson: jsonb("value_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...lifecycleColumns(),
  },
  (table) => [uniqueIndex("organization_policies_org_key_unique").on(table.organizationId, table.key)],
);

/**
 * Calendar sync and recording choices for one person's Google connection
 * (`console/calendar`). `null` modes mean never chosen.
 */
export const calendarSettings = pgTable(
  "calendar_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerConnectionId: uuid("provider_connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    syncEnabled: boolean("sync_enabled").default(false).notNull(),
    recordMode: text("record_mode"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    briefingEnabled: boolean("briefing_enabled"),
    briefingMinutes: integer("briefing_minutes").default(30).notNull(),
    followupEnabled: boolean("followup_enabled"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("calendar_settings_connection_unique").on(table.providerConnectionId),
    index("calendar_settings_user_idx").on(table.organizationId, table.userId),
    index("calendar_settings_sync_idx").on(table.syncEnabled, table.lastSyncedAt),
    check(
      "calendar_settings_record_mode_check",
      sql`${table.recordMode} IS NULL OR ${table.recordMode} IN ('off', 'ask', 'auto')`,
    ),
  ],
);

export type CalendarAttendee = {
  email: string;
  name: string | null;
  response: string | null;
  organizer: boolean;
  self: boolean;
};

/** The upcoming window of one synced calendar, one row per provider event. */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerConnectionId: uuid("provider_connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    providerCalendarId: text("provider_calendar_id").default("primary").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    icalUid: text("ical_uid"),
    recurringEventId: text("recurring_event_id"),
    title: text("title").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").default(false).notNull(),
    status: text("status").default("confirmed").notNull(),
    meetingUrl: text("meeting_url"),
    meetingCode: text("meeting_code"),
    organizerEmail: text("organizer_email"),
    selfResponse: text("self_response"),
    attendeesJson: jsonb("attendees_json")
      .$type<CalendarAttendee[]>()
      .default(sql<CalendarAttendee[]>`'[]'::jsonb`)
      .notNull(),
    externalAttendees: boolean("external_attendees").default(false).notNull(),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    recordDecision: text("record_decision"),
    recordDecisionProjectId: uuid("record_decision_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    recordDecidedAt: timestamp("record_decided_at", { withTimezone: true }),
    meetingBotId: uuid("meeting_bot_id").references(() => meetingBots.id, { onDelete: "set null" }),
    recordError: text("record_error"),
    briefingMarkdown: text("briefing_markdown"),
    briefingUpdatedAt: timestamp("briefing_updated_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("calendar_events_connection_event_unique").on(table.providerConnectionId, table.providerEventId),
    index("calendar_events_user_start_idx").on(table.organizationId, table.userId, table.startAt),
    index("calendar_events_meeting_idx").on(table.organizationId, table.meetingCode, table.startAt),
    index("calendar_events_start_idx").on(table.startAt),
    index("calendar_events_updated_idx").on(table.userId, table.updatedAt),
    check(
      "calendar_events_record_decision_check",
      sql`${table.recordDecision} IS NULL OR ${table.recordDecision} IN ('record', 'skip')`,
    ),
  ],
);

export const accessRequestStatus = pgEnum("access_request_status", [
  "pending",
  "approved",
  "denied",
  "cancelled",
]);

export const accessRequestVia = pgEnum("access_request_via", ["page", "cli"]);

/**
 * Someone asking for access to a private page. Whoever can share the site
 * approves it (which creates an `access_grants` tuple) or denies it.
 */
export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageSiteId: uuid("page_site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").references(() => pageRoutes.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message"),
    via: accessRequestVia("via").notNull(),
    requesterOrganizationId: uuid("requester_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    localInstallationId: uuid("local_installation_id").references(() => localInstallations.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id"),
    agentName: text("agent_name"),
    status: accessRequestStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    grantId: uuid("grant_id").references(() => accessGrants.id, { onDelete: "set null" }),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("access_requests_pending_unique")
      .on(table.pageSiteId, table.path, table.requesterUserId)
      .where(sql`${table.status} = 'pending'`),
    index("access_requests_site_status_idx").on(table.pageSiteId, table.status),
    index("access_requests_requester_idx").on(table.requesterUserId, table.createdAt),
  ],
);

export const libraryItemKind = pgEnum("library_item_kind", ["skill", "agent", "theme", "widget"]);

export const libraryVersionStatus = pgEnum("library_version_status", [
  "draft",
  "proposed",
  "published",
  "rejected",
  "superseded",
  "withdrawn",
]);

/**
 * A skill (or, later, an agent definition) the organization shares with its
 * agents: owned by the organization (`project_id` null) or by one project.
 * The slug is unique in what an agent sees: an org slug repeats in no project
 * and a project slug repeats no org slug (checked under an advisory lock).
 */
export const libraryItems = pgTable(
  "library_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    kind: libraryItemKind("kind").default("skill").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    externalAllowed: boolean("external_allowed").default(false).notNull(),
    currentVersionId: uuid("current_version_id"),
    currentVersionNumber: integer("current_version_number"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: uuid("archived_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    searchText: text("search_text").default("").notNull(),
    searchVector: tsvector("search_vector"),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("library_items_org_scope_slug_unique")
      .on(table.organizationId, table.kind, table.slug)
      .where(sql`${table.projectId} IS NULL`),
    uniqueIndex("library_items_project_scope_slug_unique")
      .on(table.organizationId, table.kind, table.projectId, table.slug)
      .where(sql`${table.projectId} IS NOT NULL`),
    index("library_items_org_project_idx").on(table.organizationId, table.projectId),
    index("library_items_search_idx").using("gin", table.searchVector),
  ],
);

/**
 * A version of a Library item. Published (and superseded) versions never
 * change and are numbered 1, 2, 3; a proposal (`draft`, `proposed`, then
 * `published`, `rejected` or `withdrawn`) has a `proposal_number` and gets a
 * `version_number` only when published. Only `published` reaches an agent.
 */
export const libraryVersions = pgTable(
  "library_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => libraryItems.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number"),
    proposalNumber: integer("proposal_number"),
    baseVersionNumber: integer("base_version_number"),
    round: integer("round").default(1).notNull(),
    status: libraryVersionStatus("status").default("published").notNull(),
    name: text("name"),
    description: text("description"),
    externalAllowed: boolean("external_allowed"),
    contentHash: text("content_hash").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    note: text("note"),
    authorType: text("author_type").default("user").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authorAgentId: text("author_agent_id"),
    localInstallationId: uuid("local_installation_id").references(() => localInstallations.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decisionReason: text("decision_reason"),
    /**
     * Accessibility audit of a widget version with `widget.js`
     * (`WidgetScriptAudit`: status, violations, scriptSha256, auditedBy,
     * auditedAt). Null until an org owner or admin runs it in the Console.
     */
    scriptAudit: jsonb("script_audit").$type<JsonRecord>(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("library_versions_item_number_unique").on(table.itemId, table.versionNumber),
    uniqueIndex("library_versions_item_proposal_unique")
      .on(table.itemId, table.proposalNumber)
      .where(sql`${table.proposalNumber} IS NOT NULL`),
    index("library_versions_item_status_idx").on(table.itemId, table.status),
    index("library_versions_org_status_idx").on(table.organizationId, table.status),
  ],
);

/** A version's files (`SKILL.md`, `references/*`), stored as UTF-8 text. */
export const libraryFiles = pgTable(
  "library_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => libraryVersions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("library_files_version_path_unique").on(table.versionId, table.path)],
);

/**
 * Review comments on a proposal, optionally anchored to a file line of the
 * round they were made on. Replies are one level deep.
 */
export const libraryComments = pgTable(
  "library_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => libraryItems.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => libraryVersions.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    path: text("path"),
    line: integer("line"),
    round: integer("round").notNull(),
    body: text("body").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authorAgentId: text("author_agent_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "library_comments_parent_id_library_comments_id_fk",
    }).onDelete("cascade"),
    index("library_comments_version_idx").on(table.versionId, table.createdAt),
  ],
);

/** Agents a linked installation reported, for pins and the agent directory. */
export const installationAgents = pgTable(
  "installation_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    localInstallationId: uuid("local_installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    name: text("name"),
    provider: text("provider"),
    model: text("model"),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    description: text("description"),
    acceptsRequests: boolean("accepts_requests").default(false).notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("installation_agents_installation_agent_unique").on(
      table.localInstallationId,
      table.agentId,
    ),
    index("installation_agents_org_idx").on(table.organizationId),
  ],
);

export const libraryPins = pgTable(
  "library_pins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => libraryItems.id, { onDelete: "cascade" }),
    localInstallationId: uuid("local_installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    pinnedByUserId: uuid("pinned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("library_pins_item_installation_agent_unique").on(
      table.itemId,
      table.localInstallationId,
      table.agentId,
    ),
    index("library_pins_installation_idx").on(table.localInstallationId),
  ],
);

/**
 * The theme an organization (`project_id` null) or one project uses. The
 * effective theme of a project is its own pointer, else the org's; it follows
 * the item's current published version.
 */
export const libraryThemePointers = pgTable(
  "library_theme_pointers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => libraryItems.id, { onDelete: "cascade" }),
    setByUserId: uuid("set_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    setAt: timestamp("set_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("library_theme_pointers_org_unique")
      .on(table.organizationId)
      .where(sql`${table.projectId} IS NULL`),
    uniqueIndex("library_theme_pointers_project_unique")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    index("library_theme_pointers_item_idx").on(table.itemId),
  ],
);

export const agentRequests = pgTable(
  "agent_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    fromInstallationId: uuid("from_installation_id").references(
      () => localInstallations.id,
      { onDelete: "set null" },
    ),
    fromAgentId: text("from_agent_id"),
    fromUserId: uuid("from_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    toInstallationId: uuid("to_installation_id")
      .notNull()
      .references(() => localInstallations.id, { onDelete: "cascade" }),
    toAgentId: text("to_agent_id").notNull(),
    message: text("message").notNull(),
    status: text("status").default("pending").notNull(),
    reply: text("reply"),
    failureReason: text("failure_reason"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    replyDeliveredAt: timestamp("reply_delivered_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    index("agent_requests_to_status_idx").on(
      table.toInstallationId,
      table.status,
    ),
    index("agent_requests_from_status_idx").on(
      table.fromInstallationId,
      table.status,
    ),
    index("agent_requests_org_idx").on(table.organizationId),
  ],
);

// Ravi chat inside Pages (text). One shared room per published route plus one
// private room per (route, person). The Console tables are the record; the
// Pages Worker's room Durable Object only fans out live events. See
// `.ravi/specs/console/pages/chat-rooms/SPEC.md`.
export const pageChatRooms = pgTable(
  "page_chat_rooms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    routeId: uuid("route_id")
      .notNull()
      .references(() => pageRoutes.id, { onDelete: "cascade" }),
    /** `shared` (everyone who can open the route) or `private` (one person and the agent). */
    kind: text("kind").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    path: text("path").notNull(),
    lastSeq: integer("last_seq").default(0).notNull(),
    metadataJson: jsonb("metadata_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("page_chat_rooms_shared_unique")
      .on(table.routeId)
      .where(sql`${table.kind} = 'shared'`),
    uniqueIndex("page_chat_rooms_private_unique")
      .on(table.routeId, table.ownerUserId)
      .where(sql`${table.kind} = 'private'`),
    index("page_chat_rooms_org_idx").on(table.organizationId),
    index("page_chat_rooms_site_idx").on(table.siteId),
    check(
      "page_chat_rooms_kind_check",
      sql`(${table.kind} = 'shared' AND ${table.ownerUserId} IS NULL) OR (${table.kind} = 'private' AND ${table.ownerUserId} IS NOT NULL)`,
    ),
  ],
);

export const pageChatMessages = pgTable(
  "page_chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => pageChatRooms.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** `user`, `agent` or `system`. */
    authorType: text("author_type").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authorName: text("author_name").notNull(),
    /** `member` or `guest` for a user author; null otherwise. */
    authorRole: text("author_role"),
    body: text("body").default("").notNull(),
    partsJson: jsonb("parts_json")
      .$type<JsonRecord[]>()
      .default(emptyJsonRecordArray)
      .notNull(),
    /** `complete`, `streaming` or `failed`. */
    status: text("status").default("complete").notNull(),
    /** `text`, `voice` or `comment`. */
    source: text("source").default("text").notNull(),
    clientMessageId: text("client_message_id"),
    anchorJson: jsonb("anchor_json").$type<JsonRecord>(),
    turnId: uuid("turn_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("page_chat_messages_room_seq_unique").on(table.roomId, table.seq),
    uniqueIndex("page_chat_messages_client_unique")
      .on(table.roomId, table.authorUserId, table.clientMessageId)
      .where(sql`${table.clientMessageId} IS NOT NULL`),
    index("page_chat_messages_org_idx").on(table.organizationId),
    index("page_chat_messages_author_idx").on(table.authorUserId),
  ],
);

export const pageChatReads = pgTable(
  "page_chat_reads",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => pageChatRooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadSeq: integer("last_read_seq").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.userId] })],
);

export const pageChatTurns = pgTable(
  "page_chat_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => pageChatRooms.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => pageSites.id, { onDelete: "cascade" }),
    triggerMessageId: uuid("trigger_message_id").references(() => pageChatMessages.id, {
      onDelete: "set null",
    }),
    replyMessageId: uuid("reply_message_id").references(() => pageChatMessages.id, {
      onDelete: "set null",
    }),
    /** The person the turn acts for: every tool runs with this person's rights. */
    speakerUserId: uuid("speaker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `member` or `guest`. */
    speakerKind: text("speaker_kind").notNull(),
    speakerOrgRole: text("speaker_org_role"),
    /** `pages_sessions.id` (never the token) the speaker wrote with. */
    pagesSessionId: uuid("pages_session_id"),
    /** `queued`, `running`, `waiting_confirmation`, `complete` or `failed`. */
    status: text("status").default("queued").notNull(),
    runId: text("run_id"),
    model: text("model").notNull(),
    stateJson: jsonb("state_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    cachedInputTokens: integer("cached_input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    costUsd: numeric("cost_usd", { precision: 20, scale: 8 }),
    toolCalls: integer("tool_calls").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    index("page_chat_turns_room_idx").on(table.roomId, table.createdAt),
    index("page_chat_turns_org_created_idx").on(table.organizationId, table.createdAt),
    index("page_chat_turns_speaker_idx").on(table.speakerUserId, table.createdAt),
  ],
);

export const pageChatConfirmations = pgTable(
  "page_chat_confirmations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => pageChatRooms.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => pageChatTurns.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => pageChatMessages.id, { onDelete: "cascade" }),
    forUserId: uuid("for_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    operationId: text("operation_id").notNull(),
    inputJson: jsonb("input_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    summary: text("summary").notNull(),
    /** `pending`, `confirmed`, `cancelled` or `expired`. */
    status: text("status").default("pending").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("page_chat_confirmations_turn_idx").on(table.turnId),
    index("page_chat_confirmations_room_status_idx").on(table.roomId, table.status),
  ],
);

/**
 * The organization's own provider key for cloud agents (D5). One non-revoked
 * row per (organization, provider); the secret is AES-256-GCM under
 * `RAVI_CLOUD_AGENTS_KEY` and never leaves the server.
 */
export const cloudAgentCredentials = pgTable(
  "cloud_agent_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `anthropic`. */
    provider: text("provider").notNull(),
    /** Null once revoked. */
    secretEncrypted: text("secret_encrypted"),
    keyHint: text("key_hint"),
    /** `active`, `invalid` or `revoked`. */
    status: text("status").default("active").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    monthlyAlertUsd: integer("monthly_alert_usd"),
    /** `YYYY-MM` of the last monthly alert sent. */
    alertedMonth: text("alerted_month"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("cloud_agent_credentials_org_provider_unique")
      .on(table.organizationId, table.provider)
      .where(sql`${table.status} <> 'revoked'`),
  ],
);

/**
 * A Library agent deployed to a cloud provider in one project. Provider ids
 * are provenance, never Ravi keys.
 */
export const cloudAgents = pgTable(
  "cloud_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    libraryItemId: uuid("library_item_id")
      .notNull()
      .references(() => libraryItems.id, { onDelete: "cascade" }),
    libraryVersionId: uuid("library_version_id").references(() => libraryVersions.id, {
      onDelete: "set null",
    }),
    libraryVersionNumber: integer("library_version_number"),
    name: text("name").notNull(),
    provider: text("provider").default("anthropic").notNull(),
    model: text("model"),
    providerAgentId: text("provider_agent_id"),
    providerAgentVersion: integer("provider_agent_version"),
    providerEnvironmentId: text("provider_environment_id"),
    /** Skill content hash -> `{ skillId, version }` at the provider. */
    skillsJson: jsonb("skills_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    compiledHash: text("compiled_hash"),
    /** The resolved cloud block plus the provider-side hashes. */
    configJson: jsonb("config_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    /** `ready`, `failed` or `archived`. */
    status: text("status").default("ready").notNull(),
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code"),
    deployedByUserId: uuid("deployed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("cloud_agents_project_item_unique")
      .on(table.projectId, table.libraryItemId)
      .where(sql`${table.status} <> 'archived'`),
    index("cloud_agents_org_idx").on(table.organizationId),
  ],
);

/** One cloud run: a provider session acting as `actor_user_id` (D6). */
export const cloudAgentRuns = pgTable(
  "cloud_agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => cloudAgents.id, { onDelete: "cascade" }),
    libraryVersionId: uuid("library_version_id").references(() => libraryVersions.id, {
      onDelete: "set null",
    }),
    provider: text("provider").default("anthropic").notNull(),
    providerSessionId: text("provider_session_id"),
    providerVaultId: text("provider_vault_id"),
    providerVaultCredentialId: text("provider_vault_credential_id"),
    /**
     * `starting`, `running`, `waiting_approval`, `completed`, `failed`,
     * `stopped` or `budget_exceeded`.
     */
    status: text("status").default("starting").notNull(),
    /** `manual`, `schedule`, `task`, `page` or `agent`. */
    trigger: text("trigger").default("manual").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    scheduleId: uuid("schedule_id"),
    promptEncrypted: text("prompt_encrypted").notNull(),
    resultEncrypted: text("result_encrypted"),
    budgetUsdCents: integer("budget_usd_cents").notNull(),
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }).default(0).notNull(),
    runningSeconds: integer("running_seconds").default(0).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).default(0).notNull(),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).default(0).notNull(),
    /** Opaque provider event cursor. */
    eventCursor: text("event_cursor"),
    eventCount: integer("event_count").default(0).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** The root `mcp_oauth_tokens` row of the current run token. */
    mcpTokenId: uuid("mcp_token_id"),
    runtimeTraceSessionId: uuid("runtime_trace_session_id"),
    originJson: jsonb("origin_json").$type<JsonRecord>(),
    idempotencyKey: text("idempotency_key"),
    /** sha256 of (agent, prompt) to tell a replay from a conflict. */
    requestHash: text("request_hash"),
    /** Usage already written to `usage_events`, so sync records deltas. */
    usageRecordedJson: jsonb("usage_recorded_json")
      .$type<JsonRecord>()
      .default(emptyJson)
      .notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    hardEndAt: timestamp("hard_end_at", { withTimezone: true }).notNull(),
    providerDeletedAt: timestamp("provider_deleted_at", { withTimezone: true }),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("cloud_agent_runs_org_idempotency_unique")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("cloud_agent_runs_project_started_idx").on(table.projectId, table.startedAt),
    index("cloud_agent_runs_agent_started_idx").on(table.agentId, table.startedAt),
    index("cloud_agent_runs_status_idx").on(table.status),
    index("cloud_agent_runs_actor_idx").on(table.actorUserId, table.status),
    index("cloud_agent_runs_mcp_token_idx").on(table.mcpTokenId),
    index("cloud_agent_runs_ended_idx").on(table.endedAt),
  ],
);

/** A tool call a cloud run paused on until a person decides it. */
export const cloudAgentApprovals = pgTable(
  "cloud_agent_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => cloudAgentRuns.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The provider tool-use event id the confirmation answers. */
    providerEventId: text("provider_event_id").notNull(),
    toolName: text("tool_name").notNull(),
    serverName: text("server_name"),
    inputHash: text("input_hash").notNull(),
    inputPreviewEncrypted: text("input_preview_encrypted"),
    /** `pending`, `approved`, `denied` or `expired`. */
    status: text("status").default("pending").notNull(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    inboxItemId: uuid("inbox_item_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...lifecycleColumns(),
  },
  (table) => [
    uniqueIndex("cloud_agent_approvals_run_event_unique").on(
      table.runId,
      table.providerEventId,
    ),
    index("cloud_agent_approvals_run_status_idx").on(table.runId, table.status),
    index("cloud_agent_approvals_status_expires_idx").on(table.status, table.expiresAt),
  ],
);

/** A Console-owned schedule (D8); runs act as `actor_user_id`. */
export const cloudAgentSchedules = pgTable(
  "cloud_agent_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => cloudAgents.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    /** Null runs the agent's HEARTBEAT.md. */
    promptEncrypted: text("prompt_encrypted"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    budgetUsdCents: integer("budget_usd_cents"),
    enabled: boolean("enabled").default(true).notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id"),
    lastError: text("last_error"),
    ...lifecycleColumns(),
  },
  (table) => [
    index("cloud_agent_schedules_due_idx").on(table.enabled, table.nextRunAt),
    index("cloud_agent_schedules_project_idx").on(table.projectId),
    index("cloud_agent_schedules_agent_idx").on(table.agentId),
  ],
);
export {
  authorizationPolicyHeads, authorizationPolicyRevisions, authorizationPolicyPreviews,
  authorizationMutationReceipts, authorizationAudit, authorizationBootstrapReceipts,
} from "../console/authorization/schema";

// Console delivery state; no installation prompt/history or cached authorization.
export const fleetGatewayDeliveries = pgTable("fleet_gateway_deliveries", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id), subjectId: uuid("subject_id").notNull(),
  installationId: uuid("installation_id").notNull(), projectId: uuid("project_id").notNull(), operationId: uuid("operation_id").notNull(),
  inputDigest: text("input_digest").notNull(), originKind: text("origin_kind").notNull(), originId: text("origin_id").notNull(), deliveryId: text("delivery_id").notNull(), state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.organizationId, table.subjectId, table.operationId] }), uniqueIndex("fleet_gateway_delivery_source").on(table.organizationId,table.subjectId,table.installationId,table.originKind,table.originId,table.deliveryId),
  check("fleet_gateway_delivery_origin",sql`${table.originKind} IN ('browser','channel','automation')`),check("fleet_gateway_delivery_state",sql`${table.state} IN ('pending','acknowledged','rejected')`)]);

export { fleetAssociations, fleetNodeCredentials, fleetNodeOperations, fleetNodeMutations, fleetNativeChannels } from "../console/fleet/node-schema";
