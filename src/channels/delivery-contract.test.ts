import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStateDatabase } from "../db/state-boundary.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { readDeliveryContract } from "./delivery-contract.js";
import {
  compareDeliveryCompatibility,
  DELIVERY_CAPABILITIES,
  type DeliveryContract,
  isDeliveryCapabilities,
  isDeliveryContract,
} from "./delivery-protocol.js";

const contract: DeliveryContract = {
  migrationId: "delivery-v2",
  migrationDigest: "a".repeat(64),
  contractEpoch: 1,
  deliveryProtocolFloor: 2,
  activeDeliveryProtocol: 2,
  receiptSchemaVersion: 2,
  requiredFeatures: ["part_receipts", "uncertain"],
};

describe("delivery protocol comparison", () => {
  test("supports exact active protocol, readable/writable schema and both features", () => {
    expect(compareDeliveryCompatibility(contract, DELIVERY_CAPABILITIES).relation).toBe("supports");
    expect(Object.isFrozen(DELIVERY_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(DELIVERY_CAPABILITIES.deliveryProtocolVersions)).toBe(true);
    expect(Object.isFrozen(DELIVERY_CAPABILITIES.receiptSchemaReadVersions)).toBe(true);
    expect(Object.isFrozen(DELIVERY_CAPABILITIES.receiptSchemaWriteVersions)).toBe(true);
    expect(Object.isFrozen(DELIVERY_CAPABILITIES.features)).toBe(true);
  });

  test.each([1, 3])("protocol %i alone cannot serve a domain active in 2", (version) => {
    expect(
      compareDeliveryCompatibility(contract, { ...DELIVERY_CAPABILITIES, deliveryProtocolVersions: [version] }),
    ).toEqual({ relation: "unsupported", reason: "DELIVERY_PROTOCOL_UNSUPPORTED" });
  });

  test.each([
    ["receiptSchemaReadVersions", "RECEIPT_SCHEMA_READ_UNSUPPORTED"],
    ["receiptSchemaWriteVersions", "RECEIPT_SCHEMA_WRITE_UNSUPPORTED"],
  ])("%s must include the installed schema", (field, reason) => {
    expect(compareDeliveryCompatibility(contract, { ...DELIVERY_CAPABILITIES, [field]: [1] })).toEqual({
      relation: "unsupported",
      reason,
    });
  });

  test.each(["part_receipts", "uncertain"])("missing %s is unsupported, not an inferred capability", (feature) => {
    expect(
      compareDeliveryCompatibility(contract, {
        ...DELIVERY_CAPABILITIES,
        features: DELIVERY_CAPABILITIES.features.filter((entry) => entry !== feature),
      }),
    ).toEqual({ relation: "unsupported", reason: "DELIVERY_FEATURE_UNSUPPORTED" });
  });

  test("empty version lists are a valid declaration of no support", () => {
    expect(
      compareDeliveryCompatibility(contract, { ...DELIVERY_CAPABILITIES, deliveryProtocolVersions: [] }).relation,
    ).toBe("unsupported");
  });

  test.each([null, undefined, {}, { readiness: true, THREAD_WRITER_PROTOCOL: 2 }])(
    "missing declaration is unknown regardless of readiness/Threads",
    (value) => {
      expect(compareDeliveryCompatibility(contract, value).relation).toBe("unknown");
      expect(isDeliveryCapabilities(value)).toBe(false);
    },
  );

  test.each([["2"], [0], [1.5], [NaN], [Infinity], [2, 2], new Array(1)].map((versions) => ({ versions })))(
    "malformed protocol version declaration is unknown",
    ({ versions }) => {
      expect(
        compareDeliveryCompatibility(contract, { ...DELIVERY_CAPABILITIES, deliveryProtocolVersions: versions })
          .relation,
      ).toBe("unknown");
    },
  );

  test("a migration cannot drop required safety features or lower its selected protocol below its floor", () => {
    for (const invalid of [
      { ...contract, requiredFeatures: [] },
      { ...contract, requiredFeatures: ["part_receipts"] },
      { ...contract, deliveryProtocolFloor: 3 },
      { ...contract, contractEpoch: 0 },
      { ...contract, contractEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...contract, migrationDigest: "not-a-digest" },
    ]) {
      expect(isDeliveryContract(invalid)).toBe(false);
      expect(compareDeliveryCompatibility(invalid, DELIVERY_CAPABILITIES).relation).toBe("unknown");
    }
  });

  test("new migration-required features also require explicit consumer support", () => {
    expect(
      compareDeliveryCompatibility(
        { ...contract, requiredFeatures: [...contract.requiredFeatures, "future_feature"] },
        DELIVERY_CAPABILITIES,
      ).relation,
    ).toBe("unsupported");
  });
});

describe("read-only installed delivery contract", () => {
  let stateDir: string;
  let dbPath: string;
  let db: Database | undefined;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-delivery-contract-");
    dbPath = join(stateDir, "ravi.db");
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    await cleanupIsolatedRaviState(stateDir);
  });

  function installFixture(): void {
    db = openStateDatabase(dbPath, { create: true });
    db.exec(`CREATE TABLE channel_delivery_contract (
      id TEXT, migration_id TEXT, migration_digest TEXT, contract_epoch INTEGER,
      delivery_protocol_floor INTEGER, active_delivery_protocol INTEGER,
      receipt_schema_version INTEGER, required_features_json TEXT
    )`);
    db.query("INSERT INTO channel_delivery_contract VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "delivery",
      contract.migrationId,
      contract.migrationDigest,
      contract.contractEpoch,
      contract.deliveryProtocolFloor,
      contract.activeDeliveryProtocol,
      contract.receiptSchemaVersion,
      JSON.stringify(contract.requiredFeatures),
    );
  }

  test("missing database, directory and non-file path do not trigger creation or migration", () => {
    const filesBefore = readdirSync(stateDir);
    expect(readDeliveryContract(dbPath).relation).toBe("unknown");
    expect(readDeliveryContract(join(stateDir, "absent", "ravi.db")).relation).toBe("unknown");
    expect(readDeliveryContract(stateDir).relation).toBe("unknown");
    expect(readDeliveryContract(":memory:").relation).toBe("unknown");
    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(stateDir)).toEqual(filesBefore);
  });

  test("an existing database without the floor table stays byte-for-byte unchanged", () => {
    db = openStateDatabase(dbPath, { create: true });
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('untouched')");
    db.close();
    db = undefined;
    const before = readFileSync(dbPath);
    expect(readDeliveryContract(dbPath)).toEqual({
      relation: "unknown",
      reason: "DELIVERY_CONTRACT_SCHEMA_MISSING",
    });
    expect(readFileSync(dbPath)).toEqual(before);
  });

  test("reads the exact installed singleton without mutating it", () => {
    installFixture();
    db?.close();
    db = undefined;
    const before = readFileSync(dbPath);
    const read = readDeliveryContract(dbPath);
    expect(read).toEqual({ relation: "known", contract });
    expect(readFileSync(dbPath)).toEqual(before);
    if (read.relation === "known") {
      expect(Object.isFrozen(read.contract)).toBe(true);
      expect(Object.isFrozen(read.contract.requiredFeatures)).toBe(true);
    }
  });

  test.each([
    "DELETE FROM channel_delivery_contract",
    "UPDATE channel_delivery_contract SET id = 'other'",
    "INSERT INTO channel_delivery_contract SELECT * FROM channel_delivery_contract",
  ])("missing, wrong or duplicate singleton is unknown", (mutation) => {
    installFixture();
    db?.exec(mutation);
    expect(readDeliveryContract(dbPath)).toEqual({
      relation: "unknown",
      reason: "DELIVERY_CONTRACT_SINGLETON_INVALID",
    });
  });

  test.each([
    "UPDATE channel_delivery_contract SET required_features_json = 'not-json'",
    "UPDATE channel_delivery_contract SET required_features_json = '[]'",
    "UPDATE channel_delivery_contract SET required_features_json = '[\"part_receipts\"]'",
    "UPDATE channel_delivery_contract SET migration_digest = 'unverified'",
    "UPDATE channel_delivery_contract SET migration_id = ''",
    "UPDATE channel_delivery_contract SET contract_epoch = 0",
    "UPDATE channel_delivery_contract SET delivery_protocol_floor = 3",
    "UPDATE channel_delivery_contract SET receipt_schema_version = 2.5",
  ])("malformed installed floor blocks without repair", (mutation) => {
    installFixture();
    db?.exec(mutation);
    const before = db?.query("SELECT * FROM channel_delivery_contract").all();
    expect(readDeliveryContract(dbPath).relation).toBe("unknown");
    expect(db?.query("SELECT * FROM channel_delivery_contract").all()).toEqual(before);
  });

  test("a view cannot impersonate the installed floor table", () => {
    db = openStateDatabase(dbPath, { create: true });
    db.exec("CREATE VIEW channel_delivery_contract AS SELECT 'delivery' AS id");
    expect(readDeliveryContract(dbPath).relation).toBe("unknown");
  });

  test("unreadable non-SQLite content fails closed without rewriting the file", () => {
    writeFileSync(dbPath, "not a database");
    expect(readDeliveryContract(dbPath).relation).toBe("unknown");
    expect(readFileSync(dbPath, "utf8")).toBe("not a database");
  });
});
