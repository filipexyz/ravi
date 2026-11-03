import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, users, authIdentities } from "@/server/db/schema";
import type { ProjectPolicy } from "./policy";

// Separate schema ownership. Aggregate export/journal are integrated only after
// the onboarding migration, not by copying another worktree's uncommitted files.
export const authorizationPolicyHeads = pgTable("authorization_policy_heads", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull().default(0),
  activeRevisionId: uuid("active_revision_id"),
  draftRevisionId: uuid("draft_revision_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authorizationPolicyRevisions = pgTable("authorization_policy_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  document: jsonb("document").notNull().$type<ProjectPolicy>(),
  digest: text("digest").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("authorization_revisions_org_id_unique").on(t.organizationId, t.id)]);

export const authorizationPolicyPreviews = pgTable("authorization_policy_previews", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull().references(() => authorizationPolicyRevisions.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  impactDigest: text("impact_digest").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authorizationMutationReceipts = pgTable("authorization_mutation_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  operationKey: uuid("operation_key").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  inputDigest: text("input_digest").notNull(),
  result: jsonb("result").notNull().$type<{ generation: number; activeRevisionId: string | null; draftRevisionId: string | null }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("authorization_mutation_org_key_unique").on(t.organizationId, t.operationKey)]);

export const authorizationAudit = pgTable("authorization_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  projectId: uuid("project_id"),
  revisionId: uuid("revision_id"),
  generation: integer("generation").notNull(),
  requestId: text("request_id").notNull(),
  metadata: jsonb("metadata").notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("authorization_audit_org_created_idx").on(t.organizationId, t.createdAt)]);

export const authorizationBootstrapReceipts = pgTable("authorization_bootstrap_receipts", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  operationKey: uuid("operation_key").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  identityId: uuid("identity_id").notNull().references(() => authIdentities.id, { onDelete: "restrict" }),
  revisionId: uuid("revision_id").notNull().references(() => authorizationPolicyRevisions.id, { onDelete: "restrict" }),
  inputDigest: text("input_digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("authorization_bootstrap_operation_unique").on(t.operationKey)]);
