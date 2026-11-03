import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { gatewayDelivery } from "../../src/server/console/fleet/gateway-delivery";
import type { GatewayInput } from "../../src/server/console/fleet/gateway";
const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const sql = socket
  ? postgres({
      host: socket,
      port: 55439,
      database: "fleet_gateway_fixture",
      username: "fleettest",
      max: 4,
      onnotice() {},
    })
  : null;
const admin = socket
  ? postgres({
      host: socket,
      port: 55439,
      database: "postgres",
      username: "fleettest",
      max: 1,
      onnotice() {},
    })
  : null;
const actor = { organizationId: randomUUID(), userId: randomUUID() };
beforeAll(async () => {
  if (!admin || !sql) return;
  await admin`create database fleet_gateway_fixture`;
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  await sql`insert into organizations(id,name,slug,status) values(${actor.organizationId},'Gateway fixture',${`gateway-${actor.organizationId}`},'active')`;
}, 60000);
afterAll(async () => {
  await sql?.end();
  await admin?.end();
});
const input = (): GatewayInput => ({
  installationId: randomUUID(),
  projectId: randomUUID(),
  operationId: randomUUID(),
  createdAt: Date.now(),
  command: "sessions.conversations.send",
  input: { text: "private fixture text", conversationId: randomUUID(), expectedVersion: 0 },
});
integration(
  "delivery confirmations are durable, monotonic, and contain no private message content",
  async () => {
    const value = input(),
      origin = { kind: "browser" as const, sessionId: "browser-a" };
    await Promise.all([
      gatewayDelivery(sql!, actor, value, origin, "pending"),
      gatewayDelivery(sql!, actor, value, origin, "pending"),
    ]);
    await gatewayDelivery(sql!, actor, value, origin, "acknowledged");
    await gatewayDelivery(sql!, actor, value, { ...origin, sessionId: "browser-b" }, "pending");
    const rows = await sql!`select * from fleet_gateway_deliveries where operation_id=${value.operationId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("acknowledged");
    expect(JSON.stringify(rows)).not.toContain("private fixture text");
    await expect(
      gatewayDelivery(
        sql!,
        actor,
        { ...value, input: { ...value.input, text: "changed" } },
        origin,
        "pending",
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  },
);
integration("channel and automation delivery IDs cannot be re-admitted as new executions", async () => {
  for (const origin of [
    {
      kind: "channel" as const,
      connectorId: "slack-test",
      conversationId: "thread-test",
      deliveryId: randomUUID(),
    },
    { kind: "automation" as const, automationId: "scheduled-test", deliveryId: randomUUID() },
  ]) {
    const value = input();
    await gatewayDelivery(sql!, actor, value, origin, "pending");
    await expect(
      gatewayDelivery(sql!, actor, { ...value, operationId: randomUUID() }, origin, "pending"),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(
      (
        await sql!`select count(*)::int count from fleet_gateway_deliveries where origin_kind=${origin.kind} and delivery_id=${origin.deliveryId}`
      )[0]!.count,
    ).toBe(1);
    if (origin.kind === "channel") {
      // Message IDs may be unique only within a conversation in one connector.
      await gatewayDelivery(
        sql!,
        actor,
        { ...value, operationId: randomUUID() },
        { ...origin, conversationId: "another-thread" },
        "pending",
      );
      expect(
        (
          await sql!`select count(*)::int count from fleet_gateway_deliveries where origin_kind='channel' and delivery_id=${origin.deliveryId}`
        )[0]!.count,
      ).toBe(2);
    }
  }
});
