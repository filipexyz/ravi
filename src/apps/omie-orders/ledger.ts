import type { Database } from "bun:sqlite";
import { assertDatabaseTargetAllowed, openStateDatabase } from "../../db/state-boundary.js";
import { configureStateJournalMode, initializeStateSchema } from "../../db/schema-owner.js";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./domain.js";
import { publicResult } from "./catalogue.js";

/** Must be constructed in the protected host service, not inside the app child. */
export class DurableLedger {
  private db: Database;
  constructor(path: string) {
    assertDatabaseTargetAllowed(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.db = openStateDatabase(path);
    configureStateJournalMode(this.db);
    this.db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;");
    initializeStateSchema(this.db, "omie-orders-ledger", () =>
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS omie_operations (
        operation_key TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, finished_at INTEGER, result_json TEXT, error_code TEXT
      );`),
    );
  }
  async once<T>(key: string, digest: string, effect: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(digest) || key.length < 8 || key.length > 300)
      throw new AppError("OMIE_LEDGER_INPUT_INVALID", "Identificador de operação inválido.");
    const claim = this.db
      .transaction(() => {
        const old = this.db
          .query("SELECT digest,state,result_json FROM omie_operations WHERE operation_key=?")
          .get(key) as any;
        if (old) {
          if (old.digest !== digest)
            throw new AppError("OMIE_IDEMPOTENCY_CONFLICT", "Chave já utilizada para outro conteúdo.");
          if (old.state === "completed") return { cached: true, value: JSON.parse(old.result_json) };
          throw new AppError(
            "OMIE_OUTCOME_UNKNOWN",
            "Operação anterior pendente ou incerta; reconciliar antes de qualquer repetição.",
          );
        }
        this.db
          .query("INSERT INTO omie_operations(operation_key,digest,state,created_at) VALUES (?,?,'pending',?)")
          .run(key, digest, Date.now());
        return { cached: false };
      })
      .immediate();
    if (claim.cached) return claim.value as T;
    try {
      const result = publicResult(await effect());
      this.db
        .query(
          "UPDATE omie_operations SET state='completed',finished_at=?,result_json=? WHERE operation_key=? AND digest=? AND state='pending'",
        )
        .run(Date.now(), JSON.stringify(result), key, digest);
      return result as T;
    } catch (e) {
      // no-cause: Provider/storage exception text may contain secrets; persist only the safe error code and unknown outcome.
      const code = e instanceof AppError ? e.code : "OMIE_EFFECT_UNKNOWN";
      this.db
        .query(
          "UPDATE omie_operations SET state='unknown',finished_at=?,error_code=? WHERE operation_key=? AND state='pending'",
        )
        .run(Date.now(), /^[A-Z0-9_]{1,100}$/.test(code) ? code : "OMIE_EFFECT_UNKNOWN", key);
      // Never persist or return the provider exception text.
      if (e instanceof AppError) throw e;
      throw new AppError("OMIE_OUTCOME_UNKNOWN", "Resultado da operação não confirmado; não repetir automaticamente.");
    }
  }
  summary() {
    return this.db.query("SELECT state,count(*) AS count FROM omie_operations GROUP BY state").all();
  }
  close() {
    this.db.close();
  }
}
