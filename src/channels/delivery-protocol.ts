/** Delivery compatibility is independent of runtime readiness and the Threads protocol. */
export interface DeliveryCapabilities {
  readonly deliveryProtocolVersions: readonly number[];
  readonly receiptSchemaReadVersions: readonly number[];
  readonly receiptSchemaWriteVersions: readonly number[];
  readonly features: readonly string[];
}

export interface DeliveryContract {
  readonly migrationId: string;
  readonly migrationDigest: string;
  readonly contractEpoch: number;
  readonly deliveryProtocolFloor: number;
  readonly activeDeliveryProtocol: number;
  readonly receiptSchemaVersion: number;
  readonly requiredFeatures: readonly string[];
}

export type CompatibilityRelation = "supports" | "unsupported" | "unknown";
export interface DeliveryCompatibility {
  readonly relation: CompatibilityRelation;
  readonly reason: string;
}

export const DELIVERY_REQUIRED_FEATURES = Object.freeze(["part_receipts", "uncertain"] as const);

// This module is inert: importing the constants does not activate a consumer.
export const DELIVERY_CAPABILITIES: DeliveryCapabilities = Object.freeze({
  deliveryProtocolVersions: Object.freeze([2]),
  receiptSchemaReadVersions: Object.freeze([2]),
  receiptSchemaWriteVersions: Object.freeze([2]),
  features: DELIVERY_REQUIRED_FEATURES,
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function versions(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > 128) return false;
  for (const entry of value) if (!positiveInteger(entry)) return false;
  return new Set(value).size === value.length;
}

function features(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 128) return false;
  for (const entry of value) {
    if (typeof entry !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(entry)) return false;
  }
  return new Set(value).size === value.length;
}

export function isDeliveryCapabilities(value: unknown): value is DeliveryCapabilities {
  return (
    record(value) &&
    versions(value.deliveryProtocolVersions) &&
    versions(value.receiptSchemaReadVersions) &&
    versions(value.receiptSchemaWriteVersions) &&
    features(value.features)
  );
}

export function isDeliveryContract(value: unknown): value is DeliveryContract {
  if (!record(value)) return false;
  const requiredFeatures = value.requiredFeatures;
  return (
    typeof value.migrationId === "string" &&
    value.migrationId.length > 0 &&
    value.migrationId.length <= 256 &&
    value.migrationId.trim() === value.migrationId &&
    typeof value.migrationDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.migrationDigest) &&
    positiveInteger(value.contractEpoch) &&
    positiveInteger(value.deliveryProtocolFloor) &&
    positiveInteger(value.activeDeliveryProtocol) &&
    value.activeDeliveryProtocol >= value.deliveryProtocolFloor &&
    positiveInteger(value.receiptSchemaVersion) &&
    features(requiredFeatures) &&
    DELIVERY_REQUIRED_FEATURES.every((feature) => requiredFeatures.includes(feature))
  );
}

/** Shape validation is deliberate even for typed callers: files/SQLite are untrusted input. */
export function compareDeliveryCompatibility(contract: unknown, capabilities: unknown): DeliveryCompatibility {
  if (!isDeliveryContract(contract)) return { relation: "unknown", reason: "INVALID_DELIVERY_CONTRACT" };
  if (!isDeliveryCapabilities(capabilities)) return { relation: "unknown", reason: "INVALID_DELIVERY_CAPABILITIES" };
  if (!capabilities.deliveryProtocolVersions.includes(contract.activeDeliveryProtocol)) {
    return { relation: "unsupported", reason: "DELIVERY_PROTOCOL_UNSUPPORTED" };
  }
  if (!capabilities.receiptSchemaReadVersions.includes(contract.receiptSchemaVersion)) {
    return { relation: "unsupported", reason: "RECEIPT_SCHEMA_READ_UNSUPPORTED" };
  }
  if (!capabilities.receiptSchemaWriteVersions.includes(contract.receiptSchemaVersion)) {
    return { relation: "unsupported", reason: "RECEIPT_SCHEMA_WRITE_UNSUPPORTED" };
  }
  if (!contract.requiredFeatures.every((feature) => capabilities.features.includes(feature))) {
    return { relation: "unsupported", reason: "DELIVERY_FEATURE_UNSUPPORTED" };
  }
  return { relation: "supports", reason: "DELIVERY_CONTRACT_SUPPORTED" };
}
