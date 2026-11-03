import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { InvocationOrigin } from "@/shared/console-gateway";
import { canonicalBridgeJson } from "@/shared/human-bridge";
import { FleetError, type FleetActor } from "./contract";
import type { GatewayInput } from "./gateway";

/** Console owns delivery confirmation. Prompts, private history and execution receipts
 * remain on the installation. No response cache can bypass current authorization. */
export async function gatewayDelivery(
  sql: Sql,
  actor: Pick<FleetActor, "organizationId" | "userId">,
  input: GatewayInput,
  origin: InvocationOrigin,
  state: "pending" | "acknowledged" | "rejected",
) {
  const digest = createHash("sha256").update(canonicalBridgeJson(input)).digest("hex");
  const sourceId =
    origin.kind === "browser"
      ? actor.userId
      : origin.kind === "channel"
        ? canonicalBridgeJson([origin.connectorId, origin.conversationId])
        : origin.automationId;
  const deliveryId = origin.kind === "browser" ? input.operationId : origin.deliveryId;
  await sql.begin(async (tx) => {
    await tx`insert into fleet_gateway_deliveries(organization_id,subject_id,installation_id,project_id,operation_id,input_digest,origin_kind,origin_id,delivery_id,state)
      values(${actor.organizationId},${actor.userId},${input.installationId},${input.projectId},${input.operationId},${digest},${origin.kind},${sourceId},${deliveryId},'pending') on conflict do nothing`;
    const [row] =
      await tx`select input_digest,operation_id,state from fleet_gateway_deliveries where organization_id=${actor.organizationId} and subject_id=${actor.userId} and installation_id=${input.installationId} and origin_kind=${origin.kind} and origin_id=${sourceId} and delivery_id=${deliveryId} for update`;
    if (!row || row.input_digest !== digest || row.operation_id !== input.operationId)
      throw new FleetError("IDEMPOTENCY_CONFLICT", 409);
    // A retry cannot demote an acknowledged delivery to pending, or erase uncertainty
    // by manufacturing a new operation ID for the same upstream delivery.
    if (state !== "pending" && row.state !== "acknowledged")
      await tx`update fleet_gateway_deliveries set state=${state},updated_at=clock_timestamp() where organization_id=${actor.organizationId} and subject_id=${actor.userId} and operation_id=${input.operationId}`;
  });
}
