import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import {
  commandEnvelopeSchema,
  operationResultSchema,
  receiptSchema,
  type CommandEnvelope,
  type OperationResult,
} from "@ravi/operation-contracts/console";
import { commandDigest } from "@ravi/operation-contracts/digest";

type Receipt = ReturnType<typeof receiptSchema.parse>;
/** An admitted operation is never executed a second time after interruption. */
export class FleetJournal {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS management_receipts(operation_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL,
      digest TEXT NOT NULL, receipt TEXT, acknowledged INTEGER NOT NULL DEFAULT 0);`);
  }
  close() {
    this.db.close();
  }
  pending(installationId: string): Receipt[] {
    return this.db
      .query<{ operation_id: string; digest: string; receipt: string | null }, [string]>(
        "SELECT operation_id,digest,receipt FROM management_receipts WHERE installation_id=? AND acknowledged=0 LIMIT 50",
      )
      .all(installationId)
      .map((row) =>
        row.receipt
          ? receiptSchema.parse(JSON.parse(row.receipt))
          : {
              operationId: row.operation_id,
              digest: row.digest,
              status: "uncertain",
              result: null,
              error: "result_unknown",
            },
      );
  }
  acknowledge(receipt: Receipt) {
    this.db
      .query(
        "UPDATE management_receipts SET acknowledged=1 WHERE operation_id=? AND digest=? AND (receipt=? OR (receipt IS NULL AND ?='uncertain'))",
      )
      .run(receipt.operationId, receipt.digest, JSON.stringify(receipt), receipt.status);
  }
  async execute(
    raw: unknown,
    identity: { installationId: string; organizationId: string },
    effect: (command: CommandEnvelope["command"]) => Promise<OperationResult>,
    now = () => Date.now(),
  ): Promise<Receipt> {
    const envelope = commandEnvelopeSchema.parse(raw);
    if (
      envelope.installationId !== identity.installationId ||
      envelope.organizationId !== identity.organizationId ||
      (await commandDigest(envelope.installationId, envelope.operationId, envelope.command)) !== envelope.digest
    )
      throw new Error("Invalid management authority");
    const receipt = (status: Receipt["status"], result: OperationResult | null, error: Receipt["error"]): Receipt => ({
      operationId: envelope.operationId,
      digest: envelope.digest,
      status,
      result,
      error,
    });
    const existing = this.db
      .transaction(() => {
        const row = this.db
          .query<{ installation_id: string; digest: string; receipt: string | null }, [string]>(
            "SELECT * FROM management_receipts WHERE operation_id=?",
          )
          .get(envelope.operationId);
        if (row) {
          if (row.installation_id !== envelope.installationId || row.digest !== envelope.digest)
            throw new Error("Receipt identity conflict");
          return row.receipt
            ? receiptSchema.parse(JSON.parse(row.receipt))
            : receipt("uncertain", null, "result_unknown");
        }
        if (new Date(envelope.expiresAt).getTime() <= now()) return receipt("failed", null, "grant_expired");
        this.db
          .query("INSERT INTO management_receipts(operation_id,installation_id,digest) VALUES(?,?,?)")
          .run(envelope.operationId, envelope.installationId, envelope.digest);
        return null;
      })
      .immediate();
    if (existing) return existing;
    let result: Receipt;
    try {
      if (new Date(envelope.expiresAt).getTime() <= now()) result = receipt("failed", null, "grant_expired");
      else {
        const output = operationResultSchema.parse(await effect(envelope.command));
        if (output.kind !== envelope.command.kind) throw new Error("Invalid result kind");
        result = receipt("succeeded", output, null);
      }
    } catch {
      result = receipt("uncertain", null, "result_unknown");
    }
    this.db
      .query("UPDATE management_receipts SET receipt=?,acknowledged=0 WHERE operation_id=? AND digest=?")
      .run(JSON.stringify(result), envelope.operationId, envelope.digest);
    return result;
  }
}
