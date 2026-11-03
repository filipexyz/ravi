import { pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";

// No payloads, sessions, JWTs or customer outputs. Keep with the same Postgres
// backup as base_operations/product state. Durable tombstones have no TTL.
export const executorOperations = pgTable("executor_operations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
  siteId: uuid("site_id").notNull(),
  action: text("action").notNull(),
  key: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  sessionHash: text("session_hash").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("executor_operations_scope_key").on(t.organizationId, t.userId, t.siteId, t.action, t.key)]);
