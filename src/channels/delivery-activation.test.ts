import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { openStateDatabase } from "../db/state-boundary.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  createDeliveryCompatibilityGate,
  DeliveryCompatibilityBlockedError,
  DELIVERY_EFFECTS,
  type DeliveryConsumerInventory,
} from "./delivery-activation.js";
import { deliveryBootPath, observeDeliveryProcess, type DeliveryBootExpectation } from "./delivery-boot.js";

const fixture = fileURLToPath(new URL("./fixtures/delivery-consumer.ts", import.meta.url));
const zero = { recovery: 0, pull: 0, claim: 0, send: 0, prune: 0 };
let stateDir: string;
let dbPath: string;
let inventoryPath: string;
const children: ReturnType<typeof spawn>[] = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-delivery-oracle-");
  dbPath = join(stateDir, "delivery.sqlite");
  inventoryPath = join(stateDir, "inventory.json");
  const db = openStateDatabase(dbPath);
  db.exec(`CREATE TABLE channel_delivery_contract (
    id TEXT PRIMARY KEY, migration_id TEXT, migration_digest TEXT, contract_epoch INTEGER,
    delivery_protocol_floor INTEGER, active_delivery_protocol INTEGER,
    receipt_schema_version INTEGER, required_features_json TEXT);
    CREATE TABLE fixture_receipts(id TEXT PRIMARY KEY, state TEXT);
    INSERT INTO fixture_receipts VALUES ('existing-output','uncertain');`);
  db.query("INSERT INTO channel_delivery_contract VALUES (?,?,?,?,?,?,?,?)").run(
    "delivery",
    "fixture-migration",
    "a".repeat(64),
    1,
    2,
    2,
    2,
    '["part_receipts","uncertain"]',
  );
  db.close();
});

afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exited));
  children.length = 0;
  await cleanupIsolatedRaviState(stateDir);
});

async function consumer(protocol: 1 | 2 = 2, launch: "absolute" | "relative" | "alias" | "removable" = "absolute") {
  const bootId = randomUUID();
  const name = `consumer-${children.length}`;
  const cwd = realpathSync(stateDir);
  const bundleFileName = `${name}-${bootId}.ts`;
  const alias = join(cwd, bundleFileName);
  const bundle = launch === "removable" || launch === "relative" ? alias : fixture;
  if (launch === "removable" || launch === "relative") {
    const source = readFileSync(fixture, "utf8")
      .replace(
        '"../delivery-activation.js"',
        JSON.stringify(fileURLToPath(new URL("./delivery-activation.ts", import.meta.url))),
      )
      .replace('"../delivery-boot.js"', JSON.stringify(fileURLToPath(new URL("./delivery-boot.ts", import.meta.url))));
    writeFileSync(bundle, source);
  }
  if (launch === "alias") symlinkSync(fixture, alias);
  const entrypoint = launch === "relative" ? `./${bundleFileName}` : launch === "alias" ? alias : bundle;
  const args = [entrypoint, stateDir, dbPath, inventoryPath, bootId, name, String(protocol)];
  const child = spawn([process.execPath, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Deliberately no inherited runtime context, broker settings or credentials.
    env: { PATH: process.env.PATH, RAVI_STATE_DIR: stateDir },
  });
  children.push(child);
  const lines = createInterface({ input: Readable.fromWeb(child.stdout as never) })[Symbol.asyncIterator]();
  const next = async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        lines.next(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Consumer timed out")), 10_000);
        }),
      ]);
      if (result.done) throw new Error(`Consumer exited: ${await new Response(child.stderr).text()}`);
      return JSON.parse(result.value);
    } finally {
      clearTimeout(timeout);
    }
  };
  expect(await next()).toEqual({ ready: true, threadProtocolReady: true });
  const observed = observeDeliveryProcess(child.pid);
  expect(observed).not.toBeNull();
  const expected: DeliveryBootExpectation = {
    ...observed!,
    argv1Raw: observed!.argv[1]!,
    processName: name,
    bootId,
    bundlePath: bundle,
    bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
    stateIdentity: dbPath,
    consumerDomain: "fixture-delivery",
  };
  return {
    child,
    cwd,
    expected,
    async command(operation: string) {
      child.stdin.write(`${JSON.stringify({ operation })}\n`);
      await child.stdin.flush();
      return next();
    },
  };
}

function inventory(consumers: readonly DeliveryBootExpectation[], epoch = "cutover-1") {
  const value: DeliveryConsumerInventory = { epoch, consumers };
  writeFileSync(inventoryPath, JSON.stringify(value));
  return value;
}

function gate() {
  return createDeliveryCompatibilityGate({
    stateDir,
    dbPath,
    stateIdentity: dbPath,
    consumerDomain: "fixture-delivery",
    readInventory: () => JSON.parse(readFileSync(inventoryPath, "utf8")),
  });
}

describe("inactive delivery compatibility gate", () => {
  it("consumer started with a relative script from another directory: cohort supports and all operations proceed", async () => {
    const a = await consumer(2, "relative");
    const b = await consumer();
    expect(a.cwd).not.toBe(process.cwd());
    expect(a.expected.argv1Raw).not.toStartWith("/");
    expect(existsSync(resolve(process.cwd(), a.expected.argv1Raw))).toBe(false);
    inventory([a.expected, b.expected]);
    expect(gate().inspect().relation).toBe("supports");
    for (const instance of [a, b]) {
      expect((await instance.command("acquire")).relation).toBe("supports");
      expect(await instance.command("attempt")).toEqual({
        failures: [],
        counters: { recovery: 1, pull: 1, claim: 1, send: 1, prune: 1 },
        relation: "supports",
      });
    }
  });

  it("script that does not match the bundle: cohort unsupported and every operation blocked", async () => {
    const a = await consumer(2, "relative");
    const b = await consumer();
    inventory([a.expected, b.expected]);
    expect((await a.command("acquire")).relation).toBe("supports");
    const otherBundle = join(realpathSync(stateDir), "different-bundle.ts");
    // Identical bytes do not make a different entrypoint the expected bundle.
    writeFileSync(otherBundle, readFileSync(fixture));
    inventory([a.expected, { ...b.expected, bundlePath: otherBundle }]);
    expect(gate().inspect().relation).toBe("unsupported");
    expect(gate().inspect().consumers[1]?.reason).toBe("entrypoint_bundle_mismatch");
    for (const instance of [a, b]) {
      expect(await instance.command("attempt")).toEqual({
        failures: [...DELIVERY_EFFECTS],
        counters: zero,
        relation: "unsupported",
      });
    }
  });

  it("a missing absolute bundle returns unknown with error, no throw, and blocks every operation", async () => {
    const a = await consumer(2, "removable");
    const b = await consumer();
    inventory([a.expected, b.expected]);
    const controller = gate();
    const acquired = controller.acquire();
    if (acquired.relation !== "supports") throw new Error("Expected supported fixture");
    for (const instance of [a, b]) expect((await instance.command("acquire")).relation).toBe("supports");
    const bundleSource = readFileSync(a.expected.bundlePath);
    unlinkSync(a.expected.bundlePath);
    expect(existsSync(a.expected.argv1Raw)).toBe(false);
    const snapshot = controller.inspect();
    expect(snapshot.relation).toBe("unknown");
    expect(snapshot.consumers[0]?.error).toMatchObject({
      code: "DELIVERY_BOOT_OBSERVATION_FAILED",
      cause: { code: "ENOENT" },
    });
    expect(controller.acquire().relation).toBe("unknown");
    for (const instance of [a, b]) {
      expect(await instance.command("attempt")).toEqual({
        failures: [...DELIVERY_EFFECTS],
        counters: zero,
        relation: "unknown",
      });
    }
    const counters = { ...zero };
    expect(() => controller.run(acquired.permit, "recovery", () => counters.recovery++)).toThrow(
      DeliveryCompatibilityBlockedError,
    );
    writeFileSync(a.expected.bundlePath, bundleSource);
    expect(controller.inspect().relation).toBe("supports");
    for (const effect of DELIVERY_EFFECTS) {
      expect(() => controller.run(acquired.permit, effect, () => counters[effect]++)).toThrow(
        DeliveryCompatibilityBlockedError,
      );
    }
    expect(counters).toEqual(zero);
  });

  for (const hasUncertain of [true, false]) {
    it(`two ready consumers, one protocol 1: all effects blocked (uncertain=${hasUncertain})`, async () => {
      if (!hasUncertain) {
        const setup = openStateDatabase(dbPath);
        setup.exec("DELETE FROM fixture_receipts");
        setup.close();
      }
      const before = readFileSync(dbPath);
      const a = await consumer(2);
      const b = await consumer(1);
      inventory([a.expected, b.expected]);
      for (const instance of [a, b]) {
        expect((await instance.command("acquire")).relation).toBe("unsupported");
        expect(await instance.command("attempt")).toEqual({
          failures: [...DELIVERY_EFFECTS],
          counters: zero,
          relation: "unsupported",
        });
      }
      expect(readFileSync(dbPath)).toEqual(before);
    });
  }

  it("missing declaration and orphan boot are unknown, with every operation blocked", async () => {
    const a = await consumer();
    const b = await consumer();
    inventory([a.expected, b.expected]);
    expect((await a.command("acquire")).relation).toBe("supports");
    b.child.kill();
    await b.child.exited;
    expect(await a.command("attempt")).toEqual({
      failures: [...DELIVERY_EFFECTS],
      counters: zero,
      relation: "unknown",
    });
    const orphan = readFileSync(deliveryBootPath(stateDir, b.expected));
    expect(orphan.length).toBeGreaterThan(0);
    unlinkSync(deliveryBootPath(stateDir, a.expected));
    expect((await a.command("acquire")).relation).toBe("unknown");
    expect((await a.command("attempt")).counters).toEqual(zero);
  });

  it("replacing a boot invalidates the old permit; only a fresh permit can proceed", async () => {
    const a = await consumer();
    const b = await consumer();
    inventory([a.expected, b.expected]);
    expect((await a.command("acquire")).relation).toBe("supports");
    b.child.kill();
    await b.child.exited;
    const replacement = await consumer();
    inventory([a.expected, replacement.expected], "cutover-2");
    expect(await a.command("attempt")).toEqual({
      failures: [...DELIVERY_EFFECTS],
      counters: zero,
      relation: "supports",
    });
    expect((await a.command("acquire")).relation).toBe("supports");
    expect((await a.command("attempt")).counters).toEqual({ recovery: 1, pull: 1, claim: 1, send: 1, prune: 1 });
  });

  it("floor change revokes permits and malformed floor never enables recovery", async () => {
    const a = await consumer();
    inventory([a.expected]);
    const controller = gate();
    const acquired = controller.acquire();
    expect(acquired.relation).toBe("supports");
    if (acquired.relation !== "supports") throw new Error("Expected supported fixture");
    const db = openStateDatabase(dbPath);
    db.exec("UPDATE channel_delivery_contract SET contract_epoch=2");
    for (const effect of DELIVERY_EFFECTS) {
      expect(() =>
        controller.run(acquired.permit, effect, () => {
          throw new Error("Effect executed");
        }),
      ).toThrow(DeliveryCompatibilityBlockedError);
    }
    db.exec("UPDATE channel_delivery_contract SET required_features_json='invalid'");
    db.close();
    expect(controller.acquire().relation).toBe("unknown");
  });

  it("absent or duplicate registry and unknown floor cannot acquire a permit", async () => {
    const a = await consumer();
    inventory([]);
    expect(gate().acquire().relation).toBe("unknown");
    inventory([a.expected, a.expected]);
    expect(gate().acquire().relation).toBe("unknown");
    inventory([a.expected]);
    const db = openStateDatabase(dbPath);
    db.exec("DROP TABLE channel_delivery_contract");
    db.close();
    expect(gate().acquire().relation).toBe("unknown");
  });
});
