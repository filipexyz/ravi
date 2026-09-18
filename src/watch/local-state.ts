/**
 * Estado durável do poller local.
 *
 * O runner local deriva eventos da diferença entre duas leituras, então precisa
 * lembrar a última. Esse arquivo é essa memória.
 *
 * Duas decisões moram aqui:
 *
 * 1. Caminho e formato têm dono único. Antes o runner escrevia e ninguém limpava:
 *    deletar um watch deixava o snapshot pra trás, e como o id do watch é
 *    determinístico (hash de provider+repo+eventos), recriar o mesmo watch
 *    herdava o estado de um período que ninguém lembra.
 * 2. Escrita por tmp + rename. Um snapshot truncado por crash seria lido como
 *    "sem estado", e o baseline descarta as transições daquele tick em silêncio —
 *    exatamente o erro que o poller existe pra evitar.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import type { LocalWatchSnapshot } from "./local-events.js";

export function localWatchStateDir(stateDir = getRaviStateDir()): string {
  return join(stateDir, "watch-local");
}

export function localWatchSnapshotPath(watchId: string, stateDir?: string): string {
  return join(localWatchStateDir(stateDir), `${watchId}.json`);
}

export function readLocalWatchSnapshot(watchId: string, stateDir?: string): LocalWatchSnapshot | null {
  const file = localWatchSnapshotPath(watchId, stateDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LocalWatchSnapshot;
  } catch {
    return null;
  }
}

export function writeLocalWatchSnapshot(watchId: string, snapshot: LocalWatchSnapshot, stateDir?: string): void {
  const dir = localWatchStateDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const target = localWatchSnapshotPath(watchId, stateDir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(snapshot)}\n`);
  renameSync(temp, target);
}

/** Idempotente: apagar um watch sem snapshot não é erro. */
export function clearLocalWatchSnapshot(watchId: string, stateDir?: string): boolean {
  const file = localWatchSnapshotPath(watchId, stateDir);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}
