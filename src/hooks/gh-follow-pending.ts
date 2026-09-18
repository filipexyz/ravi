/**
 * Fila de acompanhamentos pendentes.
 *
 * `gh pr create` é o comando que expressa intenção de acompanhar, mas o número da
 * PR **não existe** no comando: ele nasce durante a execução. Então a intenção é
 * registrada aqui e resolvida no tick seguinte, quando a PR já existe.
 *
 * Sem isso, o único jeito de acompanhar seria reagir à visualização da PR criada —
 * que é justamente a regra errada.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TriggerReplySource } from "../triggers/types.js";
import { getRaviStateDir } from "../utils/paths.js";

export interface PendingGhFollow {
  repo: string;
  /** cwd da sessão: é como a PR recém-criada é encontrada (branch atual). */
  cwd: string | null;
  agentId?: string;
  sessionName?: string;
  sessionKey?: string;
  source?: TriggerReplySource;
  createdAt: number;
}

/** Pendência mais velha que isso não é mais resolvível com confiança. */
export const PENDING_GH_FOLLOW_TTL_MS = 15 * 60_000;

export function pendingGhFollowPath(stateDir = getRaviStateDir()): string {
  return join(stateDir, "gh-follow", "pending.json");
}

export function readPendingGhFollows(stateDir?: string): PendingGhFollow[] {
  const file = pendingGhFollowPath(stateDir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as PendingGhFollow[]) : [];
  } catch {
    return [];
  }
}

export function writePendingGhFollows(entries: PendingGhFollow[], stateDir?: string): void {
  const file = pendingGhFollowPath(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(temp, file);
}

/**
 * Idempotente por (repo, cwd): criar cinco PRs do mesmo repo no mesmo cwd não
 * deve enfileirar cinco resoluções idênticas que resolveriam a mesma PR.
 */
export function addPendingGhFollow(entry: PendingGhFollow, stateDir?: string): PendingGhFollow[] {
  const current = readPendingGhFollows(stateDir);
  const key = `${entry.repo}\0${entry.cwd ?? ""}`;
  const next = current.filter((item) => `${item.repo}\0${item.cwd ?? ""}` !== key);
  next.push(entry);
  writePendingGhFollows(next, stateDir);
  return next;
}

export function dropExpiredPendingGhFollows(entries: PendingGhFollow[], now = Date.now()): PendingGhFollow[] {
  return entries.filter((entry) => now - entry.createdAt < PENDING_GH_FOLLOW_TTL_MS);
}

export function removePendingGhFollow(
  entries: PendingGhFollow[],
  match: (entry: PendingGhFollow) => boolean,
  stateDir?: string,
): PendingGhFollow[] {
  const next = entries.filter((entry) => !match(entry));
  writePendingGhFollows(next, stateDir);
  return next;
}
