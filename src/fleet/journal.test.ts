import { sleep } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { FleetJournal } from "./journal.js";
import { commandDigest } from "@ravi/operation-contracts/digest";
import type { CommandEnvelope, OperationResult } from "@ravi/operation-contracts/console";
const identity = { installationId: crypto.randomUUID(), organizationId: crypto.randomUUID() };
const health: OperationResult = { kind: "health", health: { version: "test", platform: "test", channels: [] } };
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function path() {
  const dir = mkdtempSync(join(tmpdir(), "ravi-journal-test-"));
  directories.push(dir);
  return join(dir, "receipts.sqlite");
}
async function command(): Promise<CommandEnvelope> {
  const operationId = crypto.randomUUID(),
    command = { kind: "health" as const };
  return {
    ...identity,
    operationId,
    command,
    subject: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    revision: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    digest: await commandDigest(identity.installationId, operationId, command),
  };
}
describe("durable management receipts", () => {
  test("unacknowledged results survive restart and only their exact acknowledgement clears them", async () => {
    const file = path(),
      envelope = await command();
    let journal = new FleetJournal(file);
    const result = await journal.execute(envelope, identity, async () => health);
    journal.close();
    journal = new FleetJournal(file);
    expect(journal.pending(identity.installationId)).toEqual([result]);
    expect(journal.pending(crypto.randomUUID())).toEqual([]);
    journal.acknowledge({ ...result, status: "uncertain", result: null, error: "result_unknown" });
    expect(journal.pending(identity.installationId)).toEqual([result]);
    journal.acknowledge(result);
    expect(journal.pending(identity.installationId)).toEqual([]);
    journal.close();
  });
  test("lost acknowledgement and restart return the same receipt without repeating an effect", async () => {
    const file = path(),
      envelope = await command();
    let effects = 0;
    let journal = new FleetJournal(file);
    const first = await journal.execute(envelope, identity, async () => {
      effects++;
      return health;
    });
    journal.close();
    journal = new FleetJournal(file);
    expect(
      await journal.execute(envelope, identity, async () => {
        effects++;
        return health;
      }),
    ).toEqual(first);
    expect(effects).toBe(1);
    journal.close();
  });
  test("concurrent delivery admits one effect; a pending effect is uncertain", async () => {
    const journal = new FleetJournal(path()),
      envelope = await command();
    let release!: () => void,
      effects = 0;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = journal.execute(envelope, identity, async () => {
      effects++;
      await blocked;
      return health;
    });
    await sleep(10);
    expect(
      (
        await journal.execute(envelope, identity, async () => {
          effects++;
          return health;
        })
      ).status,
    ).toBe("uncertain");
    release();
    expect((await first).status).toBe("succeeded");
    expect(effects).toBe(1);
    journal.close();
  });
  test("interruption after admission cannot be replayed as a fresh command", async () => {
    const file = path(),
      journal = new FleetJournal(file),
      envelope = await command();
    const db = new Database(file);
    db.query("insert into management_receipts(operation_id,installation_id,digest) values(?,?,?)").run(
      envelope.operationId,
      envelope.installationId,
      envelope.digest,
    );
    db.close();
    let effects = 0;
    expect(
      (
        await journal.execute(envelope, identity, async () => {
          effects++;
          return health;
        })
      ).status,
    ).toBe("uncertain");
    expect(effects).toBe(0);
    journal.close();
  });
  test("wrong installation, changed payload and expired grant cannot execute", async () => {
    const journal = new FleetJournal(path()),
      envelope = await command();
    let effects = 0;
    const effect = async () => {
      effects++;
      return health;
    };
    await expect(
      journal.execute(envelope, { ...identity, installationId: crypto.randomUUID() }, effect),
    ).rejects.toThrow("authority");
    await expect(journal.execute({ ...envelope, digest: "0".repeat(64) }, identity, effect)).rejects.toThrow(
      "authority",
    );
    expect(
      (await journal.execute({ ...envelope, expiresAt: new Date(0).toISOString() }, identity, effect)).status,
    ).toBe("failed");
    expect(effects).toBe(0);
    journal.close();
  });
  test("invalid output after execution remains uncertain instead of claiming success", async () => {
    const journal = new FleetJournal(path()),
      envelope = await command();
    const receipt = await journal.execute(envelope, identity, async () => {
      throw new Error("effect response unavailable");
    });
    expect(receipt).toMatchObject({ status: "uncertain", error: "result_unknown", result: null });
    journal.close();
  });
});
