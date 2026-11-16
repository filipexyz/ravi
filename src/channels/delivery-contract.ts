import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type DeliveryContract, isDeliveryContract } from "./delivery-protocol.js";

export type DeliveryContractReadResult =
  | { readonly relation: "known"; readonly contract: DeliveryContract }
  | { readonly relation: "unknown"; readonly reason: string };

/**
 * Inspect an installed contract only. Missing schema is not permission to migrate.
 * No store initializer, schema owner or writable SQLite connection is imported.
 */
export function readDeliveryContract(dbPath: string): DeliveryContractReadResult {
  let db: Database | undefined;
  try {
    if (!isAbsolute(dbPath) || !statSync(dbPath).isFile()) {
      return { relation: "unknown", reason: "DELIVERY_CONTRACT_DATABASE_UNAVAILABLE" };
    }
    db = new Database(dbPath, { readonly: true, create: false });
    const schema = db.query("SELECT type FROM sqlite_schema WHERE name = 'channel_delivery_contract'").get() as {
      type: string;
    } | null;
    if (schema?.type !== "table") return { relation: "unknown", reason: "DELIVERY_CONTRACT_SCHEMA_MISSING" };
    const rows = db
      .query(
        `SELECT id, migration_id, migration_digest, contract_epoch,
                delivery_protocol_floor, active_delivery_protocol,
                receipt_schema_version, required_features_json
         FROM channel_delivery_contract LIMIT 2`,
      )
      .all() as Record<string, unknown>[];
    const row = rows[0];
    if (rows.length !== 1 || row?.id !== "delivery") {
      return { relation: "unknown", reason: "DELIVERY_CONTRACT_SINGLETON_INVALID" };
    }
    if (typeof row.required_features_json !== "string" || row.required_features_json.length > 65536) {
      return { relation: "unknown", reason: "INVALID_DELIVERY_CONTRACT" };
    }
    const contract = {
      migrationId: row.migration_id,
      migrationDigest: row.migration_digest,
      contractEpoch: row.contract_epoch,
      deliveryProtocolFloor: row.delivery_protocol_floor,
      activeDeliveryProtocol: row.active_delivery_protocol,
      receiptSchemaVersion: row.receipt_schema_version,
      requiredFeatures: JSON.parse(row.required_features_json),
    };
    if (!isDeliveryContract(contract)) return { relation: "unknown", reason: "INVALID_DELIVERY_CONTRACT" };
    return {
      relation: "known",
      contract: Object.freeze({ ...contract, requiredFeatures: Object.freeze([...contract.requiredFeatures]) }),
    };
  } catch {
    // no-cause: An absent, unreadable or malformed floor cannot establish compatibility.
    return { relation: "unknown", reason: "DELIVERY_CONTRACT_UNREADABLE" };
  } finally {
    db?.close();
  }
}
