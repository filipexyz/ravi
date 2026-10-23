/**
 * Local watch runner — executa os watches que não passam pelo Console.
 *
 * O connector do GitHub anuncia `local` como placement e o CLI sugere
 * `--placement local` como fallback, mas nada publicava `ravi.watch.github.*`:
 * o watch era criado, os subjects apareciam em `watch events`, e nenhum evento
 * chegava nunca. Este runner é o lado que faltava.
 *
 * Um watch local observa *estado*, não eventos: a cada tick ele lê o recurso,
 * deriva as transições (ver local-events.ts) e publica no mesmo contrato do
 * Console, para que filtros e triggers funcionem igual.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import { getRaviStateDir } from "../utils/paths.js";
import { eventSubject } from "./connectors.js";
import { readLocalWatchSnapshot, writeLocalWatchSnapshot } from "./local-state.js";
import {
  deriveLocalGitHubEvents,
  PULL_REQUEST_COMMENT_EVENT,
  type DepartedPullRequest,
  type LocalCommentObservation,
  type LocalPullRequestState,
  type LocalWatchSnapshot,
  type LocalWorkflowRunState,
} from "./local-events.js";
import type { WatchNatsPayload, WatchRecord } from "./types.js";
import { listWatches, markWatchEventDelivered } from "./watch-db.js";

const log = logger.child("watch:local-runner");

const DEFAULT_INTERVAL_MS = 60_000;
/** Teto por tick: um repo com dezenas de PRs abertas não pode virar um poll caro. */
const MAX_PULL_REQUESTS = 30;
const MAX_WORKFLOW_RUNS = 30;

export interface LocalWatchTickResult {
  watchesScanned: number;
  eventsPublished: number;
  errors: number;
}

export interface LocalWatchSource {
  readSnapshot(repo: string): LocalWatchSnapshot;
  /**
   * Comentários recentes das PRs abertas.
   *
   * Opcional e opt-in: custa duas chamadas `gh api` por repo e só interessa a
   * watch que assina o evento de comentário. `null` = não deu pra ler (não
   * afirmamos nada, o estado anterior fica).
   */
  readComments?(repo: string, openPullRequests: number[]): LocalCommentObservation[] | null;
  /**
   * Estado final das PRs que saíram da lista de abertas desde a última leitura.
   *
   * Sem isso não dá pra distinguir merge de fechamento: as duas somem da lista de
   * abertas, e o estado final só existe numa consulta específica. A interface
   * separa de propósito — só consultamos quando alguma PR realmente saiu.
   */
  readDeparted(repo: string, numbers: number[]): Record<string, DepartedPullRequest>;
}
export interface LocalWatchRunnerOptions {
  intervalMs?: number;
  source?: LocalWatchSource;
  listLocalWatches?: () => WatchRecord[];
  publish?: (subject: string, payload: WatchNatsPayload) => Promise<void>;
  /** Injetável para teste: sem fake, o teste escreveria no banco de verdade. */
  markEventDelivered?: (watchId: string) => void;
  stateDir?: string;
}

interface GhPullRequest {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  headRefOid?: string;
  headRefName?: string;
}

interface GhWorkflowRun {
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  headBranch?: string;
}

interface GhIssueComment {
  id?: number;
  body?: string;
  html_url?: string;
  issue_url?: string;
  updated_at?: string;
  user?: { login?: string };
}

interface GhReviewComment {
  id?: number;
  body?: string;
  html_url?: string;
  pull_request_url?: string;
  updated_at?: string;
  user?: { login?: string };
}

/** Um repo inteiro em duas chamadas, independente de quantas PRs abertas tem. */
const RECENT_COMMENTS_QUERY = "sort=created&direction=desc&per_page=100";

function trailingNumber(value: string | undefined): number | null {
  const match = /(?:issues|pulls)\/(\d+)$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Comentários recentes do repo, limitados às PRs abertas que a leitura viu.
 *
 * Um comentário em PR fechada não interessa ao acompanhamento, e o número da PR
 * só existe na URL (`issue_url` / `pull_request_url`), não no corpo do comentário.
 */
function readRecentComments(
  runner: (args: string[]) => string,
  repo: string,
  openPullRequests: Set<number>,
): LocalCommentObservation[] | null {
  const observed: LocalCommentObservation[] = [];
  const read = (endpoint: "issues" | "pulls"): Array<GhIssueComment & GhReviewComment> | null => {
    try {
      return parseJson<Array<GhIssueComment & GhReviewComment>>(
        runner(["api", `repos/${repo}/${endpoint}/comments?${RECENT_COMMENTS_QUERY}`]),
      );
    } catch {
      // Sem leitura de comentário não afirmamos nada: o estado anterior fica.
      return null;
    }
  };

  const issueComments = read("issues");
  if (issueComments === null) return null;
  for (const comment of issueComments) {
    const number = trailingNumber(comment.issue_url);
    if (typeof comment.id !== "number" || number === null || !openPullRequests.has(number)) continue;
    observed.push({
      key: `issue:${comment.id}`,
      id: comment.id,
      number,
      url: comment.html_url ?? "",
      body: comment.body ?? "",
      author: comment.user?.login ?? "",
      updatedAt: comment.updated_at ?? "",
    });
  }

  const reviewComments = read("pulls");
  if (reviewComments === null) return null;
  for (const comment of reviewComments) {
    const number = trailingNumber(comment.pull_request_url);
    if (typeof comment.id !== "number" || number === null || !openPullRequests.has(number)) continue;
    observed.push({
      key: `review:${comment.id}`,
      id: comment.id,
      number,
      url: comment.html_url ?? "",
      body: comment.body ?? "",
      author: comment.user?.login ?? "",
      updatedAt: comment.updated_at ?? "",
    });
  }

  return observed;
}

/**
 * Fonte padrão: `gh` local, que já está autenticado na máquina. A leitura é barata
 * (duas chamadas por repo por tick), e comentário acrescenta duas chamadas só para
 * watch que assina o evento.
 */
export function createGhLocalWatchSource(runner: (args: string[]) => string): LocalWatchSource {
  return {
    readSnapshot(repo: string) {
      const prs =
        parseJson<GhPullRequest[]>(
          runner([
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--limit",
            String(MAX_PULL_REQUESTS),
            "--json",
            "number,title,url,isDraft,headRefOid,headRefName",
          ]),
        ) ?? [];
      const runs =
        parseJson<GhWorkflowRun[]>(
          runner([
            "run",
            "list",
            "--repo",
            repo,
            "--limit",
            String(MAX_WORKFLOW_RUNS),
            "--json",
            "databaseId,name,status,conclusion,headBranch",
          ]),
        ) ?? [];

      const pullRequests: Record<string, LocalPullRequestState> = {};
      for (const pr of prs) {
        if (typeof pr.number !== "number") continue;
        pullRequests[String(pr.number)] = {
          number: pr.number,
          title: pr.title ?? "",
          url: pr.url ?? "",
          draft: pr.isDraft === true,
          ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
          ...(pr.headRefName ? { headRefName: pr.headRefName } : {}),
        };
      }

      const workflowRuns: Record<string, LocalWorkflowRunState> = {};
      for (const run of runs) {
        if (typeof run.databaseId !== "number") continue;
        workflowRuns[String(run.databaseId)] = {
          id: run.databaseId,
          name: run.name ?? "",
          status: run.status ?? "",
          conclusion: run.conclusion ?? null,
          // `headBranch` era pedido ao gh e nunca gravado: a correlação run → PR
          // dependia de um campo que ficava sempre vazio.
          ...(run.headBranch ? { branch: run.headBranch } : {}),
        };
      }

      return { version: 1, pullRequests, workflowRuns };
    },

    readComments(repo: string, openPullRequests: number[]) {
      return readRecentComments(runner, repo, new Set(openPullRequests));
    },
    readDeparted(repo: string, numbers: number[]) {
      const departed: Record<string, DepartedPullRequest> = {};
      for (const number of numbers) {
        try {
          const parsed = parseJson<{ state?: string; title?: string; url?: string }>(
            runner(["pr", "view", String(number), "--repo", repo, "--json", "state,title,url"]),
          );
          if (!parsed?.state) continue;
          departed[String(number)] = {
            state: parsed.state,
            title: parsed.title ?? "",
            url: parsed.url ?? "",
          };
        } catch {
          // Sem estado final não afirmamos nada: a derivação cai em CLOSED, e um
          // merge lido como fechamento é menos ruim que um evento inventado.
        }
      }
      return departed;
    },
  };
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Eventos que o Console já entrega para este repo.
 *
 * Console e local podem observar o mesmo repo, e aí o mesmo evento sairia duas
 * vezes: o webhook chega na hora, o poll chega até um minuto depois, e o cooldown
 * do trigger não cobre essa distância. Regra: **onde o Console cobre, o local não
 * publica**. O local existe para preencher o que o Console não entrega — CI, hoje.
 *
 * Os eventTypes do Console vêm prefixados (`watch.github.pull_request.opened`); os
 * do local são bare.
 */
export function consoleCoveredEventTypes(watches: WatchRecord[], provider: string, resourceRef: string): Set<string> {
  const prefix = `watch.${provider}.`;
  const covered = new Set<string>();
  for (const watch of watches) {
    if (watch.placement !== "console" || watch.provider !== provider || watch.resourceRef !== resourceRef) continue;
    for (const eventType of watch.eventTypes) {
      covered.add(eventType.startsWith(prefix) ? eventType.slice(prefix.length) : eventType);
    }
  }
  return covered;
}

/**
 * PRs que saíram da lista de abertas entre duas leituras.
 *
 * É a única razão pela qual o estado final precisa ser consultado, e é por isso que
 * vive fora do runner: o teste de contrato do connector percorre o mesmo caminho em
 * vez de reimplementá-lo.
 */
export function departedNumbersBetween(previous: LocalWatchSnapshot | null, current: LocalWatchSnapshot): number[] {
  return Object.keys(previous?.pullRequests ?? {})
    .filter((key) => !(key in current.pullRequests))
    .map((key) => Number.parseInt(key, 10))
    .filter((value) => Number.isFinite(value));
}

export class LocalWatchRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;
  private readonly intervalMs: number;
  private readonly source: LocalWatchSource;
  private readonly listLocalWatches: () => WatchRecord[];
  private readonly publish: (subject: string, payload: WatchNatsPayload) => Promise<void>;
  private readonly markEventDelivered: (watchId: string) => void;
  private readonly stateDir: string;

  constructor(options: LocalWatchRunnerOptions = {}) {
    this.intervalMs = options.intervalMs ?? resolveLocalWatchIntervalMs();
    this.source = options.source ?? createGhLocalWatchSource(defaultGhRunner);
    this.listLocalWatches =
      options.listLocalWatches ?? (() => listWatches({ provider: "github", status: "active" }).items);
    this.publish = options.publish ?? ((subject, payload) => nats.emit(subject, { ...payload }));
    this.markEventDelivered = options.markEventDelivered ?? markWatchEventDelivered;
    this.stateDir = join(options.stateDir ?? getRaviStateDir(), "watch-local");
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.armTimer(1_000);
    log.info("Local watch runner started", { intervalMs: this.intervalMs });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("Local watch runner stopped");
  }

  async tick(): Promise<LocalWatchTickResult> {
    if (!this.running || this.processing) return { watchesScanned: 0, eventsPublished: 0, errors: 0 };
    this.processing = true;
    const result: LocalWatchTickResult = { watchesScanned: 0, eventsPublished: 0, errors: 0 };
    try {
      const watches = this.listLocalWatches();
      for (const watch of watches) {
        // Um watch local só é útil para provider que a gente sabe pollar.
        if (watch.placement !== "local" || watch.provider !== "github") continue;
        result.watchesScanned += 1;
        try {
          const consoleCovered = consoleCoveredEventTypes(watches, watch.provider, watch.resourceRef);
          result.eventsPublished += await this.pollWatch(watch, consoleCovered);
        } catch (error) {
          result.errors += 1;
          log.warn("Local watch poll failed", { watchId: watch.id, resourceRef: watch.resourceRef, error });
        }
      }
    } finally {
      this.processing = false;
      this.armTimer(this.intervalMs);
    }
    return result;
  }

  private async pollWatch(watch: WatchRecord, consoleCovered: Set<string> = new Set()): Promise<number> {
    const repo = watch.resourceRef.trim();
    if (!repo) return 0;

    const previous = this.readSnapshotState(watch.id);
    const snapshot = this.source.readSnapshot(repo);
    // Só pergunta o estado final de quem de fato saiu da lista de abertas.
    const departedNumbers = departedNumbersBetween(previous, snapshot);
    const departed = departedNumbers.length > 0 ? this.source.readDeparted(repo, departedNumbers) : {};
    // Comentário é caro (duas chamadas) e só quem assina paga.
    const comments = watch.eventTypes.includes(PULL_REQUEST_COMMENT_EVENT)
      ? (this.source.readComments?.(
          repo,
          Object.values(snapshot.pullRequests).map((pullRequest) => pullRequest.number),
        ) ?? undefined)
      : undefined;
    const { events, snapshot: next } = deriveLocalGitHubEvents(repo, {
      previous,
      current: snapshot,
      departed,
      ...(comments ? { comments } : {}),
    });
    this.writeSnapshotState(watch.id, next);

    // O watch declara em quais eventos ele tem interesse; o que o Console já entrega
    // e o resto são descartados aqui, antes de virar tráfego no barramento.
    const allowed = new Set(watch.eventTypes.filter((eventType) => !consoleCovered.has(eventType)));
    let published = 0;
    for (const event of events) {
      // O watch declara em quais eventos ele tem interesse; o resto é descartado
      // aqui e nunca chega a virar tráfego no barramento.
      if (!allowed.has(event.eventType)) continue;
      const payload = this.buildPayload(watch, event.eventType, event.payload);
      await this.publish(payload.subject, payload);
      published += 1;
    }
    if (published > 0) {
      this.markEventDelivered(watch.id);
      log.info("Local watch published events", { watchId: watch.id, resourceRef: repo, count: published });
    }
    return published;
  }

  private buildPayload(watch: WatchRecord, eventType: string, payload: Record<string, unknown>): WatchNatsPayload {
    const now = new Date().toISOString();
    const dedupeKey = `${watch.id}:${eventType}:${JSON.stringify(payload)}`;
    return {
      version: 1,
      eventId: `local_${watch.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      watchId: watch.id,
      ...(watch.name ? { watchName: watch.name } : {}),
      connector: watch.provider,
      placement: "local",
      eventType,
      dedupeKey,
      subject: eventSubject(watch.provider, eventType),
      source: { provider: watch.provider, resource: watch.resourceRef, placement: "local" },
      payload,
      occurredAt: now,
      createdAt: now,
    };
  }

  private readSnapshotState(watchId: string): LocalWatchSnapshot | null {
    return readLocalWatchSnapshot(watchId, this.stateDir);
  }

  private writeSnapshotState(watchId: string, snapshot: LocalWatchSnapshot): void {
    writeLocalWatchSnapshot(watchId, snapshot, this.stateDir);
  }

  private armTimer(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.tick().catch((error) => log.error("Local watch tick crashed", { error }));
      },
      Math.max(1_000, delayMs),
    );
    this.timer.unref?.();
  }
}

function defaultGhRunner(args: string[]): string {
  // `require` dentro de módulo ESM depende do bundler resolver: no bundle do
  // daemon isso é bomba-relógio. Import estático de node:child_process é barato e
  // não depende de shim.
  //
  // Timeout existe porque este runner roda dentro do tick do poller: um `gh`
  // travado (rede, prompt de auth) pararia o poll de todos os watches.
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  }) as string;
}

export function resolveLocalWatchIntervalMs(value = process.env.RAVI_WATCH_LOCAL_INTERVAL_MS): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 10_000) return DEFAULT_INTERVAL_MS;
  return parsed;
}

let singleton: LocalWatchRunner | null = null;

export function getLocalWatchRunner(): LocalWatchRunner {
  if (!singleton) singleton = new LocalWatchRunner();
  return singleton;
}

export async function startLocalWatchRunner(): Promise<void> {
  if (process.env.RAVI_WATCH_LOCAL_ENABLED === "0") {
    log.info("Local watch runner disabled by RAVI_WATCH_LOCAL_ENABLED=0");
    return;
  }
  await getLocalWatchRunner().start();
}

export async function stopLocalWatchRunner(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
}
