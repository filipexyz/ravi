import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/pg-core';
import { organizations, users, localInstallations } from '@/server/db/schema';
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`);
export const fleetAssociations = pgTable('fleet_associations', {
  id: uuid('id').primaryKey(), challengeHash: text('challenge_hash').notNull().unique(), csr: text('csr').notNull(),
  fingerprint: text('fingerprint').notNull(), name: text('name').notNull(), platform: text('platform').notNull(), status: text('status').notNull().default('pending'),
  organizationId: uuid('organization_id').references(() => organizations.id), installationId: uuid('installation_id').references(() => localInstallations.id),
  approvedBy: uuid('approved_by').references(() => users.id), approvedSession: text('approved_session'), approvalOperation: uuid('approval_operation'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), createdAt: createdAt(),
}, t => [index('fleet_associations_expiry').on(t.expiresAt), check('fleet_associations_status_check', sql`${t.status} IN ('pending','approved','denied')`)]);
export const fleetNodeCredentials = pgTable('fleet_node_credentials', {
  id: uuid('id').primaryKey(), installationId: uuid('installation_id').notNull().references(() => localInstallations.id),
  revision: integer('revision').notNull(), fingerprint: text('fingerprint').notNull().unique(), certificate: text('certificate').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), revokedAt: timestamp('revoked_at', { withTimezone: true }),
  rotationOperation: uuid('rotation_operation'), csrFingerprint: text('csr_fingerprint'), createdAt: createdAt(),
}, t => [uniqueIndex('fleet_node_credentials_installation_id_revision_key').on(t.installationId,t.revision), uniqueIndex('fleet_node_credential_active').on(t.installationId).where(sql`${t.revokedAt} is null`)]);
export const fleetNodeOperations = pgTable('fleet_node_operations', {
  id: uuid('id').primaryKey(), organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  installationId: uuid('installation_id').notNull().references(() => localInstallations.id), subjectId: uuid('subject_id').notNull().references(() => users.id),
  sessionId: text('session_id').notNull(), command: jsonb('command').notNull(), digest: text('digest').notNull(), state: text('state').notNull().default('queued'),
  installationRevision: integer('installation_revision').notNull(), result: jsonb('result'), error: text('error'), createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), deliveredAt: timestamp('delivered_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [index('fleet_node_operations_queue').on(t.installationId,t.state,t.createdAt), check('fleet_node_operations_state_check', sql`${t.state} IN ('queued','delivered','succeeded','failed','uncertain','cancelled')`)]);
export const fleetNodeMutations = pgTable('fleet_node_mutations', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), subjectId: uuid('subject_id').notNull().references(() => users.id),
  operationId: uuid('operation_id').notNull(), action: text('action').notNull(), digest: text('digest').notNull(), result: jsonb('result').notNull(), createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.organizationId,t.subjectId,t.operationId] })]);

export const fleetNativeChannels = pgTable('fleet_native_channels', {
  id: uuid('id').primaryKey(), organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  installationId: uuid('installation_id').notNull().references(() => localInstallations.id), name: text('name').notNull(),
  teamId: text('team_id').notNull(), botUserId: text('bot_user_id').notNull(), credentialConnection: text('credential_connection').notNull(),
  enabled: boolean('enabled').notNull(), operationId: uuid('operation_id').notNull().references(() => fleetNodeOperations.id), createdAt: createdAt(),
}, t => [uniqueIndex('fleet_native_channels_organization_id_team_id_bot_user_id_key').on(t.organizationId,t.teamId,t.botUserId), uniqueIndex('fleet_native_channels_organization_id_installation_id_name_key').on(t.organizationId,t.installationId,t.name)]);
