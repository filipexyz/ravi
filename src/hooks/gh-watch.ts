/**
 * GH Watch — transforma uso de `gh` em acompanhamento durável.
 *
 * O problema: a intenção de acompanhar uma PR nasce na conversa ("olha o CI
 * dessa PR"), mas o watch e o trigger só existiam se alguém digitasse
 * `ravi watch create` + `ravi triggers add` à mão. Ninguém digita. Então o watch
 * publicava no vazio, e o acompanhamento virava cron job por PR.
 *
 * Aqui a intenção vira subscrição: quando um `gh` de leitura sobre PR/repo passa
 * pela execução de comando do Ravi, garantimos (a) um watch do repo e (b) um
 * trigger filtrado naquela PR, apontando para a sessão que olhou.
 *
 * O ponto de entrada é `observeGhBashCommand`, chamado pelos três caminhos de
 * aprovação de comando do Ravi (hook in-process, CLI do codex e host services do
 * pi/grok). Não é um hook de runtime: é o próprio Ravi observando todo comando
 * que ele autoriza a rodar, independente de qual provider está no turno.
 */

import { execFileSync } from "node:child_process";
import { dbGetAgent } from "../router/router-db.js";
import type { ContextSource } from "../router/router-db.js";
import { dbCreateTrigger, dbListTriggers, type Trigger, type TriggerInput } from "../triggers/index.js";
import type { TriggerReplySource } from "../triggers/types.js";
import { logger } from "../utils/logger.js";
import { createWatch, listWatchConnectors, listWatchRecords } from "../watch/index.js";
import type { WatchRecord } from "../watch/types.js";
import { addPendingGhFollow, type PendingGhFollow } from "./gh-follow-pending.js";

const log = logger.child("gh-watch");

/** Subcomandos de `gh` que caracterizam observação, não administração. */
/**
 * Subcomandos que expressam "essa PR é minha": comandos que criam ou mutam a
 * própria PR. Só eles viram acompanhamento — visualizar uma PR não é intenção de
 * acompanhar, é consulta.
 *
 * Ficam de fora os terminais (`merge`, `close`): acompanhar algo que está
 * acabando não serve pra nada. E ficam de fora `review`/`comment`, que em geral
 * são sobre PR de outra pessoa.
 */
const GH_FOLLOW_SUBCOMMANDS = new Set(["create", "ready", "edit"]);

const GH_READ_SCOPES: Record<string, Set<string>> = {
  pr: new Set([
    "view",
    "list",
    "checks",
    "diff",
    "status",
    "merge",
    "close",
    "reopen",
    "edit",
    "review",
    "comment",
    "ready",
    "create",
  ]),
  run: new Set(["list", "view", "watch", "rerun", "cancel", "download"]),
  repo: new Set(["view"]),
  api: new Set(),
};

/** Subcomandos administrativos: mexem em conta/config, não em atividade de repo. */
const GH_ADMIN_SCOPES = new Set([
  "auth",
  "config",
  "extension",
  "alias",
  "help",
  "completion",
  "gpg-key",
  "ssh-key",
  "codespace",
  "search",
]);

export const GH_FOLLOW_COOLDOWN_MS = 30_000;

/**
 * O follow precisa dos dois lados: o evento de ciclo de vida da PR e o resultado
 * de CI. `ravi.watch.github.*` cobre ambos (o filtro por repo+PR descarta o
 * resto), enquanto um tópico só de `pull_request.*` deixaria "o CI quebrou" sem
 * caminho até a sessão.
 */
export const GH_PR_FOLLOW_TOPIC = "ravi.watch.github.*";

export interface GhWatchIntent {
  scope: "pr" | "run" | "repo" | "api";
  repo: string | null;
  prNumber: number | null;
  /**
   * `true` quando o comando expressa intenção de acompanhar (criar/mutar a
   * própria PR). Visualizar não acompanha.
   */
  follow: boolean;
}

export interface GhWatchFollowContext {
  agentId?: string;
  accountId?: string;
  sessionName?: string;
  sessionKey?: string;
  source?: TriggerReplySource;
}

export interface GhWatchFollowResult {
  repo: string;
  watchId: string | null;
  watchReused: boolean;
  /** Watch local que cobre CI. Sem ele o follow só vê ciclo de vida de PR. */
  ciWatchId?: string | null;
  ciWatchReused?: boolean;
  triggerId?: string;
  triggerReused?: boolean;
  triggerSkipped?: "no_pr_number";
  warning?: string;
}

export interface GhWatchFollowDeps {
  listWatches?: typeof listWatchRecords;
  createWatch?: typeof createWatch;
  listTriggers?: () => Trigger[];
  createTrigger?: (input: TriggerInput) => Trigger;
  emitTriggersRefresh?: () => Promise<void>;
  resolveAccountForAgent?: (agentId: string) => string | undefined;
}

export interface GhBashObservationContext {
  agentId?: string;
  sessionName?: string;
  sessionKey?: string;
  source?: ContextSource | TriggerReplySource;
  /** cwd autoritativo da sessão. Nunca `process.cwd()`. */
  cwd?: string | null;
}

/**
 * Tokeniza o comando respeitando aspas. Não é um shell: só precisamos achar
 * argumentos inteiros, então aspas, espaços e separadores bastam.
 */
export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    if (char === "|" || char === "&" || char === ";" || char === "(" || char === ")") {
      if (current) tokens.push(current);
      current = "";
      // `&&` e `||` são um separador só: manter juntos preserva a leitura de
      // "isto começa um comando novo".
      if ((char === "&" || char === "|") && command[index + 1] === char) {
        tokens.push(char + char);
        index += 1;
      } else {
        tokens.push(char);
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;
const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const COMMAND_SEPARATORS = new Set(["&&", "||", ";", "|", "(", ")"]);

/** Índices em que começa um comando: o início ou logo depois de um separador. */
function commandStartIndexes(tokens: string[]): number[] {
  const starts = [0];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (COMMAND_SEPARATORS.has(tokens[index]!)) starts.push(index + 1);
  }
  return starts;
}

function normalizeRepo(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (!trimmed || !REPO_SLUG.test(trimmed)) return null;
  return trimmed;
}

function isGhExecutable(token: string | undefined): boolean {
  if (!token) return false;
  const base = token.split("/").pop() ?? token;
  return base === "gh";
}

/**
 * Extrai uma intenção de observação de um comando Bash.
 *
 * Devolve `null` para tudo que não seja um `gh` de leitura sobre PR/repo/CI —
 * inclusive comandos que só mencionam `gh` de passagem.
 */
export function parseGhWatchIntent(command: string): GhWatchIntent | null {
  const tokens = tokenizeShellCommand(command);
  // `gh` só conta no começo de um comando: `echo gh pr view 1` é texto, não
  // intenção de observar PR.
  const ghIndex = commandStartIndexes(tokens).find((index) => isGhExecutable(tokens[index]));
  if (ghIndex === undefined || ghIndex === -1) return null;

  const args = tokens.slice(ghIndex + 1).filter((token) => !COMMAND_SEPARATORS.has(token));
  const scopeToken = args.find((token) => !token.startsWith("-"));
  if (!scopeToken || GH_ADMIN_SCOPES.has(scopeToken)) return null;

  const subcommand = args[args.indexOf(scopeToken) + 1];
  const knownSubcommands = GH_READ_SCOPES[scopeToken];
  if (!knownSubcommands) return null;
  if (subcommand && subcommand.startsWith("-")) return null;
  if (subcommand && knownSubcommands.size > 0 && !knownSubcommands.has(subcommand)) return null;

  let repo: string | null = null;
  let prNumber: number | null = null;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--repo" || token === "-R") {
      repo = normalizeRepo(args[index + 1]) ?? repo;
      continue;
    }
    if (token.startsWith("--repo=")) {
      repo = normalizeRepo(token.slice("--repo=".length)) ?? repo;
      continue;
    }
    const url = PR_URL.exec(token);
    if (url) {
      repo = repo ?? normalizeRepo(`${url[1]}/${url[2]}`);
      prNumber = prNumber ?? Number.parseInt(url[3]!, 10);
      continue;
    }
    if (token.startsWith("-")) continue;
    positionals.push(token);
  }

  const scopePositionals = positionals.slice(1);
  for (const token of scopePositionals) {
    if (repo) break;
    repo = normalizeRepo(token);
  }
  if (scopeToken === "pr") {
    for (const token of scopePositionals) {
      const value = Number.parseInt(token, 10);
      if (Number.isFinite(value) && String(value) === token) {
        prNumber = prNumber ?? value;
        break;
      }
    }
  }
  if (scopeToken === "api") {
    const path = scopePositionals.find((token) => token.includes("/"));
    const match = /repos\/([\w.-]+)\/([\w.-]+)/.exec(path ?? "");
    if (match) {
      repo = repo ?? normalizeRepo(`${match[1]}/${match[2]}`);
      const number = /pulls\/(\d+)/.exec(path ?? "");
      if (number) prNumber = prNumber ?? Number.parseInt(number[1]!, 10);
    }
  }

  return {
    scope: scopeToken as GhWatchIntent["scope"],
    repo,
    prNumber,
    follow: scopeToken === "pr" && !!subcommand && GH_FOLLOW_SUBCOMMANDS.has(subcommand),
  };
}

export function ghFollowTriggerName(repo: string, prNumber: number): string {
  return `gh-follow:${repo}#${prNumber}`;
}

/**
 * Filtra por repo *e* número: número de PR sozinho colide entre repositórios.
 */
export function ghFollowFilter(repo: string, prNumber: number): string {
  return `data.payload.repository == ${JSON.stringify(repo)} && (data.payload.number == ${prNumber} || data.payload.pull_request.number == ${prNumber})`;
}

export function buildGhFollowTriggerInput(
  repo: string,
  prNumber: number,
  context: GhWatchFollowContext = {},
): TriggerInput {
  return {
    name: ghFollowTriggerName(repo, prNumber),
    topic: GH_PR_FOLLOW_TOPIC,
    message: `Activity on ${repo}#${prNumber} (PR lifecycle or CI result). Tell the user in one short line what changed — state and title, or the CI conclusion when present — and include the url from this event.`,
    agentId: context.agentId,
    accountId: context.accountId,
    replySession: context.sessionName ?? context.sessionKey,
    replySource: context.source,
    session: "main",
    cooldownMs: GH_FOLLOW_COOLDOWN_MS,
    filter: ghFollowFilter(repo, prNumber),
  };
}

export function findExistingGhFollowTrigger(repo: string, prNumber: number, triggers: Trigger[]): Trigger | undefined {
  const name = ghFollowTriggerName(repo, prNumber);
  return triggers.find((trigger) => trigger.name === name);
}

/**
 * Marca de propriedade nos watches que o follow cria.
 *
 * Sem isso o watch local de CI é indistinguível de um watch que a pessoa criou, e
 * a manutenção nunca poderia removê-lo. Foi o que deixou um poller de duas
 * chamadas `gh` por minuto vivo para sempre depois que a última PR do repo fechou.
 */
export const GH_FOLLOW_MANAGED_FILTER = { managedBy: "gh-follow" } as const;

/** Um watch é nosso quando carrega a marca de propriedade. */
export function isGhFollowManagedWatch(watch: { filters?: Record<string, unknown> | null }): boolean {
  return watch.filters?.managedBy === GH_FOLLOW_MANAGED_FILTER.managedBy;
}

/**
 * Eventos que o placement local sabe produzir, lidos do próprio catálogo do
 * connector.
 *
 * Não é uma lista escrita à mão de propósito: se o poller passar a derivar mais
 * eventos, o watch local criado aqui acompanha sozinho, e se um evento sair da
 * lista o watch para de assinar o que não existe.
 */
export function locallySupportedEventTypes(provider = "github"): string[] {
  const connector = listWatchConnectors(provider)[0];
  return (connector?.eventTypes ?? [])
    .filter((eventType) => eventType.localSupport === "supported")
    .map((eventType) => eventType.eventType);
}

/**
 * Um watch por repo, reaproveitando o que já existe — inclusive watch de
 * Console, que é o caminho de entrega que hoje funciona sem depender de poller.
 *
 * Além dele, garante um watch **local** com os eventos que o Console não entrega
 * (CI). São dois watches porque servem a dois produtores diferentes, e o filtro do
 * trigger não se importa de onde o evento veio.
 */
export async function ensureRepoWatch(
  repo: string,
  deps: Pick<GhWatchFollowDeps, "listWatches" | "createWatch"> & { localEventTypes?: () => string[] } = {},
): Promise<{ watchId: string | null; reused: boolean; ciWatchId: string | null; ciWatchReused: boolean }> {
  const listWatches = deps.listWatches ?? listWatchRecords;
  const create = deps.createWatch ?? createWatch;
  const localEventTypes = (deps.localEventTypes ?? locallySupportedEventTypes)();

  let activeWatches: WatchRecord[] = [];
  try {
    activeWatches = listWatches({ provider: "github", status: "active", limit: 200 }).items.filter(
      (watch) => watch.resourceRef === repo,
    );
  } catch (error) {
    log.warn("Could not list watches while ensuring repo watch", { repo, error });
  }

  const anyWatch = activeWatches[0];
  const localWatch = activeWatches.find((watch) => watch.placement === "local");

  let ciWatchId: string | null = localWatch?.id ?? null;
  let ciWatchReused = Boolean(localWatch);
  if (!localWatch) {
    if (localEventTypes.length > 0) {
      try {
        const created = await create({
          provider: "github",
          resourceRef: repo,
          placement: "local",
          eventTypes: localEventTypes,
          filters: { ...GH_FOLLOW_MANAGED_FILTER },
        });
        ciWatchId = created.watch.id;
        ciWatchReused = false;
      } catch (error) {
        log.warn("Could not create local CI watch", { repo, error });
      }
    }
  }

  if (anyWatch) return { watchId: anyWatch.id, reused: true, ciWatchId, ciWatchReused };

  try {
    const created = await create({ provider: "github", resourceRef: repo });
    return { watchId: created.watch.id, reused: false, ciWatchId, ciWatchReused };
  } catch (error) {
    // Sem login de Console, o único caminho restante é polling local: o watch
    // existe e passa a produzir assim que o runner local estiver ativo.
    log.warn("Could not create console watch, relying on local", { repo, error });
    return { watchId: ciWatchId, reused: false, ciWatchId, ciWatchReused };
  }
}

export async function ensureGhWatchFollow(
  input: { repo: string; prNumber: number | null; context?: GhWatchFollowContext },
  deps: GhWatchFollowDeps = {},
): Promise<GhWatchFollowResult> {
  const context = input.context ?? {};
  const watch = await ensureRepoWatch(input.repo, deps);
  const result: GhWatchFollowResult = {
    repo: input.repo,
    watchId: watch.watchId,
    watchReused: watch.reused,
    ciWatchId: watch.ciWatchId,
    ciWatchReused: watch.ciWatchReused,
  };

  if (input.prNumber === null) {
    result.triggerSkipped = "no_pr_number";
    return result;
  }

  const listTriggers = deps.listTriggers ?? dbListTriggers;
  const existing = findExistingGhFollowTrigger(input.repo, input.prNumber, listTriggers());
  if (existing) {
    result.triggerId = existing.id;
    result.triggerReused = true;
    return result;
  }

  const resolved: GhWatchFollowContext = { ...context };
  if (!resolved.accountId && resolved.agentId) {
    try {
      const { getAccountForAgent } = await import("../router/router-db.js");
      resolved.accountId = (deps.resolveAccountForAgent ?? getAccountForAgent)(resolved.agentId);
    } catch {
      // Lookup opcional: o roteamento em fire-time ainda resolve a conta.
    }
  }

  const trigger = (deps.createTrigger ?? dbCreateTrigger)(
    buildGhFollowTriggerInput(input.repo, input.prNumber, resolved),
  );
  result.triggerId = trigger.id;
  result.triggerReused = false;

  try {
    await (deps.emitTriggersRefresh ?? defaultEmitTriggersRefresh)();
  } catch {
    // Durable: o daemon recarrega no próximo refresh/restart.
  }
  return result;
}

async function defaultEmitTriggersRefresh(): Promise<void> {
  const { nats } = await import("../nats.js");
  await nats.emit("ravi.triggers.refresh", {});
}

const repoCache = new Map<string, string | null>();
const ensured = new Set<string>();

export function resetGhWatchCaches(): void {
  repoCache.clear();
  ensured.clear();
}

function defaultResolveRepoFromCwd(cwd: string): string | null {
  const cached = repoCache.get(cwd);
  if (cached !== undefined) return cached;
  let resolved: string | null = null;
  try {
    const raw = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd,
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    resolved = normalizeRepo(String(raw).trim());
  } catch {
    resolved = null;
  }
  repoCache.set(cwd, resolved);
  return resolved;
}

/**
 * cwd da sessão, nunca o do processo: criar watch pro repo errado é pior que não
 * criar nada.
 */
function resolveCwd(ctx: GhBashObservationContext): string | null {
  if (ctx.cwd) return ctx.cwd;
  if (!ctx.agentId) return null;
  try {
    return dbGetAgent(ctx.agentId)?.cwd ?? null;
  } catch {
    return null;
  }
}

export interface GhWatchObservationDeps extends GhWatchFollowDeps {
  resolveRepoFromCwd?: (cwd: string) => string | null;
  addPending?: (entry: PendingGhFollow) => void;
}

/**
 * Ponto único de observação. Chamado pelos três caminhos que autorizam comando
 * no Ravi, depois do "pode rodar" e antes de devolver a decisão.
 *
 * Só comando que **cria ou muta a própria PR** vira acompanhamento. Visualizar
 * uma PR é consulta, não intenção — e `gh pr create` ainda traz um problema
 * próprio: o número da PR não está no comando, nasce durante a execução. Por isso
 * a intenção é enfileirada e resolvida no tick seguinte.
 *
 * Nunca lança: um observador que derruba a tool call é pior que não existir.
 */
export async function observeGhBashCommand(
  command: string,
  ctx: GhBashObservationContext = {},
  deps: GhWatchObservationDeps = {},
): Promise<void> {
  try {
    if (process.env.RAVI_WATCH_GH_AUTODETECT === "0") return;
    if (!command.includes("gh")) return;

    const intent = parseGhWatchIntent(command);
    if (!intent?.follow) return;

    const cwd = resolveCwd(ctx);
    const repo = intent.repo ?? (cwd ? (deps.resolveRepoFromCwd ?? defaultResolveRepoFromCwd)(cwd) : null);
    if (!repo) return;

    const key = `${repo}#${intent.prNumber ?? "*"}`;

    const context = {
      agentId: ctx.agentId,
      sessionName: ctx.sessionName,
      sessionKey: ctx.sessionKey,
      source: ctx.source,
    };

    // Sem número: registra a intenção e garante o watch. O tick de manutenção
    // resolve a PR recém-criada pelo cwd.
    //
    // Este caminho **não** memoriza. A chave seria `repo#*`, então a primeira PR
    // criada travaria o resto da vida do processo: a segunda PR do mesmo repo
    // nunca entraria na fila. Quem deduplica aqui é a própria fila.
    if (intent.prNumber === null) {
      const watch = await ensureRepoWatch(repo, deps);
      if (watch.watchId) {
        (deps.addPending ?? ((entry: PendingGhFollow) => addPendingGhFollow(entry)))({
          repo,
          cwd,
          ...context,
          createdAt: Date.now(),
        });
      }
      log.info("gh follow pending queued", { repo, cwd });
      return;
    }

    if (ensured.has(key)) return;

    const result = await ensureGhWatchFollow({ repo, prNumber: intent.prNumber, context }, deps);
    // Só memoriza quando algo foi de fato garantido: uma falha de DB não pode
    // virar "já tratei" para o resto da vida do processo.
    if (result.watchId && result.triggerId) {
      ensured.add(key);
    }
    log.info("gh watch follow ensured", { prNumber: intent.prNumber, ...result });
  } catch (error) {
    log.warn("gh watch observation failed", { error });
  }
}

/** Assinatura de watch usada só em teste: mantém o tipo explícito no lugar. */
export type { WatchRecord };
