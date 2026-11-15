import { createHash } from "node:crypto";
import {
  readVerifiedDeliveryBoot,
  type DeliveryBootDeclaration,
  type DeliveryBootExpectation,
} from "./delivery-boot.js";
import { readDeliveryContract } from "./delivery-contract.js";
import { compareDeliveryCompatibility, type CompatibilityRelation } from "./delivery-protocol.js";

export const DELIVERY_EFFECTS = ["recovery", "pull", "claim", "send", "prune"] as const;
export type DeliveryEffect = (typeof DELIVERY_EFFECTS)[number];

/** Supplied by the controller's launch registry, never reconstructed from boot files or health. */
export interface DeliveryConsumerInventory {
  epoch: string;
  consumers: readonly DeliveryBootExpectation[];
}

export interface DeliveryCompatibilitySnapshot {
  relation: CompatibilityRelation;
  reason: string;
  consumers: readonly { pid: number; bootId: string; relation: CompatibilityRelation; reason: string }[];
  fingerprint?: string;
}

declare const compatibilityPermitBrand: unique symbol;
/** Compatibility only. This is NOT a cutover, schema migration or provider-send permit. */
export type DeliveryCompatibilityPermit = Readonly<{ [compatibilityPermitBrand]: true }>;

export class DeliveryCompatibilityBlockedError extends Error {
  readonly code = "DELIVERY_COMPATIBILITY_BLOCKED";
  constructor(
    readonly effect: DeliveryEffect,
    readonly snapshot: DeliveryCompatibilitySnapshot,
  ) {
    super(`Delivery ${effect} blocked: ${snapshot.relation} (${snapshot.reason})`);
    this.name = "DeliveryCompatibilityBlockedError";
  }
}

/**
 * Inactive infrastructure: no timers, subscription, schema initializer or runtime registration.
 * A controller must additionally enforce offline cutover before using these guarded entry points.
 */
export function createDeliveryCompatibilityGate(options: {
  stateDir: string;
  dbPath: string;
  stateIdentity: string;
  consumerDomain: string;
  readInventory: () => DeliveryConsumerInventory | null;
}) {
  const permits = new WeakMap<DeliveryCompatibilityPermit, { fingerprint: string; invalidated: boolean }>();

  function inspect(): DeliveryCompatibilitySnapshot {
    try {
      const first = options.readInventory();
      if (!first || !first.epoch || !Array.isArray(first.consumers) || first.consumers.length === 0) {
        return unknown("INVENTORY_UNPROVEN");
      }
      // Copy the entire registry before observations; detect changes during the inspection as well.
      const inventory: DeliveryConsumerInventory = structuredClone(first);
      const inventoryFingerprint = fingerprint(inventory);
      const pids = new Set<number>();
      for (const expected of inventory.consumers) {
        if (
          !Number.isSafeInteger(expected.pid) ||
          expected.pid <= 0 ||
          pids.has(expected.pid) ||
          expected.stateIdentity !== options.stateIdentity ||
          expected.consumerDomain !== options.consumerDomain
        ) {
          return unknown("INVENTORY_SCOPE_OR_IDENTITY_INVALID");
        }
        pids.add(expected.pid);
      }
      const floor = readDeliveryContract(options.dbPath);
      if (floor.relation !== "known") return unknown(floor.reason);

      const declarations: DeliveryBootDeclaration[] = [];
      const consumers = inventory.consumers.map((expected) => {
        const read = readVerifiedDeliveryBoot({ stateDir: options.stateDir, expected });
        if (read.relation !== "known") {
          return { pid: expected.pid, bootId: expected.bootId, relation: "unknown" as const, reason: read.reason };
        }
        declarations.push(read.boot);
        const verdict = compareDeliveryCompatibility(floor.contract, read.boot);
        return { pid: expected.pid, bootId: expected.bootId, ...verdict };
      });
      const last = options.readInventory();
      const finalFloor = readDeliveryContract(options.dbPath);
      if (
        !last ||
        fingerprint(last) !== inventoryFingerprint ||
        finalFloor.relation !== "known" ||
        fingerprint(finalFloor.contract) !== fingerprint(floor.contract)
      ) {
        return unknown("INVENTORY_OR_CONTRACT_CHANGED_DURING_OBSERVATION");
      }
      const relation = consumers.some((item) => item.relation === "unknown")
        ? "unknown"
        : consumers.some((item) => item.relation === "unsupported")
          ? "unsupported"
          : "supports";
      return {
        relation,
        reason: relation === "supports" ? "ALL_CONSUMERS_SUPPORT_DELIVERY" : "CONSUMER_COMPATIBILITY_BLOCKED",
        consumers,
        ...(relation === "supports"
          ? { fingerprint: fingerprint({ inventory, contract: floor.contract, declarations }) }
          : {}),
      };
    } catch {
      // A failed observer is missing evidence, never permission to probe delivery by sending.
      return unknown("COMPATIBILITY_OBSERVATION_FAILED");
    }
  }

  function acquire():
    | { relation: "supports"; permit: DeliveryCompatibilityPermit; snapshot: DeliveryCompatibilitySnapshot }
    | { relation: "unsupported" | "unknown"; snapshot: DeliveryCompatibilitySnapshot } {
    const snapshot = inspect();
    if (snapshot.relation !== "supports" || !snapshot.fingerprint) {
      return { relation: snapshot.relation === "unsupported" ? "unsupported" : "unknown", snapshot };
    }
    const permit = Object.freeze({}) as DeliveryCompatibilityPermit;
    permits.set(permit, { fingerprint: snapshot.fingerprint, invalidated: false });
    return { relation: "supports", permit, snapshot };
  }

  function run<T>(permit: DeliveryCompatibilityPermit, effect: DeliveryEffect, callback: () => T): T {
    const record = permit && permits.get(permit);
    if (!record || record.invalidated || !DELIVERY_EFFECTS.includes(effect)) {
      throw new DeliveryCompatibilityBlockedError(effect, unknown("PERMIT_INVALID"));
    }
    const snapshot = inspect();
    if (snapshot.relation !== "supports" || snapshot.fingerprint !== record.fingerprint) {
      record.invalidated = true;
      throw new DeliveryCompatibilityBlockedError(
        effect,
        snapshot.relation === "supports" ? unknown("PERMIT_BOOT_OR_CONTRACT_CHANGED") : snapshot,
      );
    }
    // No await between revalidation and invoking the guarded operation.
    return callback();
  }

  return Object.freeze({ inspect, acquire, run });
}

function unknown(reason: string): DeliveryCompatibilitySnapshot {
  return { relation: "unknown", reason, consumers: [] };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
