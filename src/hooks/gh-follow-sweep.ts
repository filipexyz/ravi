/**
 * Manutenção do ciclo de vida dos acompanhamentos de PR.
 *
 * Duas tarefas, as duas líder-gated, no mesmo tick porque são a mesma pergunta
 * ("essa PR ainda existe e ainda vive?"):
 *
 * 1. Resolver pendências. `gh pr create` registra intenção sem número, porque o
 *    número nasce durante a execução. O tick seguinte descobre a PR pelo cwd.
 * 2. Remover acompanhamento de PR morta. Trigger não tem TTL, então sem isso cada
 *    PR já fechada deixa um trigger eterno avaliando filtro em todo evento.
 *
 * Regra que atravessa as duas: **na dúvida, não mexer**. Se não deu pra saber o
 * estado da PR, o trigger fica. Apagar o que não foi verificado é pior que manter
 * lixo por um tick.
 */

import { execFileSync } from "node:child_process";
import { dbDeleteTrigger, dbListTriggers, type Trigger } from "../triggers/index.js";
import { removeWatch as removeWatchOperation, listWatchRecords } from "../watch/index.js";
import type { WatchRecord } from "../watch/types.js";
import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import { ensureGhWatchFollow, isGhFollowManagedWatch } from "./gh-watch.js";
import {
  addPendingGhFollow,
  dropExpiredPendingGhFollows,
  readPendingGhFollows,
  type PendingGhFollow,
  writePendingGhFollows,
} from "./gh-follow-pending.js";

const log = logger.child("gh-follow");

const DEFAULT_INTERVAL_MS = 60_000;
const TRIGGER_PREFIX = "gh-follow:";

export interface GhFollowMaintenanceResult {
  pendingResolved: number;
  pendingDropped: number;
  triggersRemoved: number;
  triggersKept: number;
  watchesRemoved: number;
  errors: number;
}

export interface GhFollowMaintenanceDeps {
  readPending?: () => PendingGhFollow[];
  writePending?: (entries: PendingGhFollow[]) => void;
  listTriggers?: () => Trigger[];
  deleteTrigger?: (id: string) => boolean;
  listWatches?: () => WatchRecord[];
  removeWatch?: (id: string) => Promise<boolean>;
  ensureFollow?: typeof ensureGhWatchFollow;
  resolvePrNumber?: (entry: PendingGhFollow) => number | null;
  listPrStates?: (repo: string) => Map<number, string> | null;
  emitTriggersRefresh?: () => Promise<void>;
  now?: () => number;
}

/**
 * Watches locais que o follow criou e que não têm mais nenhuma PR acompanhada.
 *
 * Só removemos o que carrega a nossa marca: um watch criado pela pessoa não é
 * nosso para apagar. E só quando o repo ficou sem nenhum `gh-follow:` — senão
 * estaríamos derrubando o produtor de CI de um acompanhamento vivo.
 */
export function selectOrphanGhFollowWatches(watches: WatchRecord[], remainingTriggerRepos: Set<string>): WatchRecord[] {
  return watches.filter((watch) => {
    if (watch.placement !== "local" || watch.status !== "active") return false;
    if (!isGhFollowManagedWatch(watch)) return false;
    return !remainingTriggerRepos.has(watch.resourceRef);
  });
}

/** `gh-follow:owner/repo#123` → partes. Formato inválido devolve null. */
export function parseGhFollowTriggerName(name: string): { repo: string; prNumber: number } | null {
  if (!name.startsWith(TRIGGER_PREFIX)) return null;
  const body = name.slice(TRIGGER_PREFIX.length);
  const separator = body.lastIndexOf("#");
  if (separator <= 0) return null;
  const repo = body.slice(0, separator);
  const prNumber = Number.parseInt(body.slice(separator + 1), 10);
  if (!repo.includes("/") || !Number.isFinite(prNumber)) return null;
  return { repo, prNumber };
}

/**
 * Triggers cuja PR não está mais aberta.
 *
 * Estado desconhecido (repo não consultado, PR fora da janela da listagem) mantém
 * o trigger: não removemos o que não conseguimos verificar.
 */
export function selectStaleGhFollowTriggers(
  triggers: Trigger[],
  statesByRepo: Map<string, Map<number, string>>,
): Trigger[] {
  const stale: Trigger[] = [];
  for (const trigger of triggers) {
    const parsed = parseGhFollowTriggerName(trigger.name ?? "");
    if (!parsed) continue;
    const states = statesByRepo.get(parsed.repo);
    if (!states) continue;
    const state = states.get(parsed.prNumber);
    if (!state) continue;
    if (state.toUpperCase() !== "OPEN") stale.push(trigger);
  }
  return stale;
}

function defaultResolvePrNumber(entry: PendingGhFollow): number | null {
  if (!entry.cwd) return null;
  try {
    const raw = execFileSync("gh", ["pr", "view", "--json", "number", "-q", ".number"], {
      cwd: entry.cwd,
      encoding: "utf8",
      timeout: 8_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function defaultListPrStates(repo: string): Map<number, string> | null {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "list", "--repo", repo, "--state", "all", "--limit", "100", "--json", "number,state"],
      {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parsed = JSON.parse(raw) as Array<{ number?: number; state?: string }>;
    const states = new Map<number, string>();
    for (const item of parsed) {
      if (typeof item.number === "number" && typeof item.state === "string") states.set(item.number, item.state);
    }
    return states;
  } catch {
    return null;
  }
}

export async function runGhFollowMaintenance(deps: GhFollowMaintenanceDeps = {}): Promise<GhFollowMaintenanceResult> {
  const now = deps.now ?? (() => Date.now());
  const readPending = deps.readPending ?? (() => readPendingGhFollows());
  const writePending = deps.writePending ?? ((entries: PendingGhFollow[]) => writePendingGhFollows(entries));
  const listTriggers = deps.listTriggers ?? dbListTriggers;
  const deleteTrigger = deps.deleteTrigger ?? dbDeleteTrigger;
  const ensureFollow = deps.ensureFollow ?? ensureGhWatchFollow;
  const resolvePrNumber = deps.resolvePrNumber ?? defaultResolvePrNumber;
  const listPrStates = deps.listPrStates ?? defaultListPrStates;
  const emitRefresh = deps.emitTriggersRefresh ?? (() => nats.emit("ravi.triggers.refresh", {}));

  const result: GhFollowMaintenanceResult = {
    pendingResolved: 0,
    pendingDropped: 0,
    triggersRemoved: 0,
    triggersKept: 0,
    watchesRemoved: 0,
    errors: 0,
  };

  // 1. Pendências: `gh pr create` sem número.
  const pending = readPending();
  const expired = pending.length - dropExpiredPendingGhFollows(pending, now()).length;
  let remaining = dropExpiredPendingGhFollows(pending, now());
  result.pendingDropped = expired;

  const stillPending: PendingGhFollow[] = [];
  for (const entry of remaining) {
    let prNumber: number | null = null;
    try {
      prNumber = resolvePrNumber(entry);
    } catch (error) {
      log.warn("Could not resolve pending PR number", { repo: entry.repo, error });
      result.errors += 1;
    }
    if (prNumber === null) {
      // Ainda não existe (ou não deu pra ver): tenta no próximo tick.
      stillPending.push(entry);
      continue;
    }
    try {
      await ensureFollow({
        repo: entry.repo,
        prNumber,
        context: {
          agentId: entry.agentId,
          sessionName: entry.sessionName,
          sessionKey: entry.sessionKey,
          source: entry.source,
        },
      });
      result.pendingResolved += 1;
    } catch (error) {
      log.warn("Could not create follow trigger for resolved PR", { repo: entry.repo, prNumber, error });
      result.errors += 1;
    }
  }
  remaining = stillPending;
  if (remaining.length !== pending.length) writePending(remaining);

  // 2. Triggers de PR morta.
  const triggers = listTriggers().filter((trigger) => parseGhFollowTriggerName(trigger.name ?? "") !== null);
  const removedTriggerIds = new Set<string>();
  if (triggers.length > 0) {
    const repos = new Set(triggers.map((trigger) => parseGhFollowTriggerName(trigger.name ?? "")!.repo));
    const statesByRepo = new Map<string, Map<number, string>>();
    for (const repo of repos) {
      try {
        const states = listPrStates(repo);
        if (states) statesByRepo.set(repo, states);
      } catch (error) {
        log.warn("Could not list PR states", { repo, error });
        result.errors += 1;
      }
    }

    const stale = selectStaleGhFollowTriggers(triggers, statesByRepo);
    result.triggersKept = triggers.length - stale.length;
    for (const trigger of stale) {
      try {
        if (deleteTrigger(trigger.id)) {
          result.triggersRemoved += 1;
          removedTriggerIds.add(trigger.id);
        }
      } catch (error) {
        log.warn("Could not delete stale follow trigger", { triggerId: trigger.id, error });
        result.errors += 1;
      }
    }
    if (stale.length > 0) {
      try {
        await emitRefresh();
      } catch {
        // Durable: o daemon recarrega no próximo refresh/restart.
      }
    }
  }

  // 3. Watches criados pelo follow que não têm mais acompanhamento.
  //
  // Sem isto o poller continua rodando duas chamadas `gh` por minuto para sempre
  // depois que a última PR do repo fecha: o trigger morre, o watch não.
  const inUseRepos = new Set<string>();
  for (const trigger of triggers) {
    if (removedTriggerIds.has(trigger.id)) continue;
    const parsed = parseGhFollowTriggerName(trigger.name ?? "");
    if (parsed) inUseRepos.add(parsed.repo);
  }
  // Pendência é acompanhamento em formação: o watch ainda é necessário.
  for (const entry of remaining) inUseRepos.add(entry.repo);

  const orphans = selectOrphanGhFollowWatches(
    (deps.listWatches ?? (() => listWatchRecords({ status: "active", limit: 500 }).items))(),
    inUseRepos,
  );
  const removeWatch = deps.removeWatch ?? removeWatchOperation;
  for (const watch of orphans) {
    try {
      if (await removeWatch(watch.id)) result.watchesRemoved += 1;
    } catch (error) {
      log.warn("Could not remove orphan follow watch", { watchId: watch.id, error });
      result.errors += 1;
    }
  }
  if (result.watchesRemoved > 0) {
    log.info("Removed follow watches with no remaining subscription", { count: result.watchesRemoved });
  }

  if (result.pendingResolved || result.triggersRemoved || result.watchesRemoved) {
    log.info("gh follow maintenance", result as unknown as Record<string, unknown>);
  }
  return result;
}

export class GhFollowMaintenanceRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;
  private readonly intervalMs: number;

  constructor(options: { intervalMs?: number } = {}) {
    this.intervalMs = options.intervalMs ?? resolveGhFollowMaintenanceIntervalMs();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.armTimer(5_000);
    log.info("gh follow maintenance runner started", { intervalMs: this.intervalMs });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("gh follow maintenance runner stopped");
  }

  async tick(): Promise<GhFollowMaintenanceResult> {
    if (!this.running || this.processing) {
      return {
        pendingResolved: 0,
        pendingDropped: 0,
        triggersRemoved: 0,
        triggersKept: 0,
        watchesRemoved: 0,
        errors: 0,
      };
    }
    this.processing = true;
    try {
      return await runGhFollowMaintenance();
    } catch (error) {
      log.error("gh follow maintenance tick failed", { error });
      return {
        pendingResolved: 0,
        pendingDropped: 0,
        triggersRemoved: 0,
        triggersKept: 0,
        watchesRemoved: 0,
        errors: 1,
      };
    } finally {
      this.processing = false;
      this.armTimer(this.intervalMs);
    }
  }

  private armTimer(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.tick();
      },
      Math.max(1_000, delayMs),
    );
    this.timer.unref?.();
  }
}

export function resolveGhFollowMaintenanceIntervalMs(value = process.env.RAVI_GH_FOLLOW_MAINTENANCE_MS): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 10_000) return DEFAULT_INTERVAL_MS;
  return parsed;
}

let singleton: GhFollowMaintenanceRunner | null = null;

export function getGhFollowMaintenanceRunner(): GhFollowMaintenanceRunner {
  if (!singleton) singleton = new GhFollowMaintenanceRunner();
  return singleton;
}

export async function startGhFollowMaintenanceRunner(): Promise<void> {
  if (process.env.RAVI_GH_FOLLOW_ENABLED === "0") {
    log.info("gh follow maintenance disabled by RAVI_GH_FOLLOW_ENABLED=0");
    return;
  }
  await getGhFollowMaintenanceRunner().start();
}

export async function stopGhFollowMaintenanceRunner(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
}

export { addPendingGhFollow };
