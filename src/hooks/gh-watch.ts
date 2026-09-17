/**
 * GH Watch Hook — transforma uso de `gh` em acompanhamento durável.
 *
 * O problema: a intenção de acompanhar uma PR nasce na conversa ("olha o CI
 * dessa PR"), mas o watch e o trigger só existiam se alguém digitasse
 * `ravi watch create` + `ravi triggers add` à mão. Ninguém digita. Então o watch
 * publicava no vazio, e o acompanhamento virava cron job por PR.
 *
 * Aqui a intenção vira subscrição: quando um `gh` de leitura sobre PR/repo passa
 * pelo Bash, o hook garante (a) um watch do repo e (b) um trigger filtrado
 * naquela PR, apontando para a sessão que olhou.
 *
 * Regras de convivência:
 * - Nunca bloqueia a tool call: a decisão de permissão é de outro hook.
 * - Idempotente: um watch por repo, um trigger por (repo, PR). Ver 50 vezes a
 *   mesma PR cria exatamente uma subscrição.
 * - Silencioso quando não entende o comando. Erro aqui não vira erro do usuário.
 */

import { execFileSync } from "node:child_process";
import { getContext } from "../cli/context.js";
import { getAccountForAgent } from "../router/router-db.js";
import { dbCreateTrigger, dbListTriggers, type Trigger, type TriggerInput } from "../triggers/index.js";
import type { TriggerReplySource } from "../triggers/types.js";
import { logger } from "../utils/logger.js";
import { createWatch, listWatchRecords } from "../watch/index.js";
import type { HookCallbackMatcher } from "../bash/hook.js";

const log = logger.child("hooks:gh-watch");

/** Subcomandos de `gh` que caracterizam observação, não administração. */
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
export const GH_PR_FOLLOW_TOPIC = "ravi.watch.github.pull_request.*";

export interface GhWatchIntent {
  scope: "pr" | "run" | "repo" | "api";
  repo: string | null;
  prNumber: number | null;
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

/**
 * Tokeniza o comando respeitando aspas. Não é um shell: só precisamos achar
 * argumentos inteiros, então aspas e espaços bastam.
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
 * inclusive comandos encadeados que só mencionam `gh` de passagem.
 */
export function parseGhWatchIntent(command: string): GhWatchIntent | null {
  const tokens = tokenizeShellCommand(command);
  // `gh` só conta no começo de um comando: `echo gh pr view 1` é texto, não
  // intenção de observar PR.
  const ghIndex = commandStartIndexes(tokens).find((index) => isGhExecutable(tokens[index]));
  if (ghIndex === undefined) return null;

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
    message: `Activity on ${repo}#${prNumber}. Tell the user in one short line what changed (state, title, CI conclusion when present) and the url from this event.`,
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
 * Um watch por repo, reaproveitando o que já existe — inclusive watch de
 * Console, que é o caminho de entrega que hoje funciona sem depender de poller.
 */
export async function ensureRepoWatch(
  repo: string,
  deps: Pick<GhWatchFollowDeps, "listWatches" | "createWatch"> = {},
): Promise<{ watchId: string | null; reused: boolean }> {
  const listWatches = deps.listWatches ?? listWatchRecords;
  const create = deps.createWatch ?? createWatch;

  try {
    const existing = listWatches({ provider: "github", status: "active", limit: 200 }).items.find(
      (watch) => watch.resourceRef === repo,
    );
    if (existing) return { watchId: existing.id, reused: true };
  } catch (error) {
    log.warn("Could not list watches while ensuring repo watch", { repo, error });
  }

  try {
    const created = await create({ provider: "github", resourceRef: repo });
    return { watchId: created.watch.id, reused: false };
  } catch (error) {
    // Sem login de Console, o único caminho restante é polling local: o watch
    // existe e passa a produzir assim que o runner local estiver ativo.
    try {
      const created = await create({ provider: "github", resourceRef: repo, placement: "local" });
      return { watchId: created.watch.id, reused: false };
    } catch (fallbackError) {
      log.warn("Could not create repo watch", { repo, error, fallbackError });
      return { watchId: null, reused: false };
    }
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

function resolveFollowContext(): GhWatchFollowContext {
  const ctx = getContext();
  if (!ctx) return {};
  const source =
    ctx.source?.channel && ctx.source.accountId && ctx.source.chatId
      ? {
          channel: ctx.source.channel,
          accountId: ctx.source.accountId,
          chatId: ctx.source.chatId,
          ...(ctx.source.threadId ? { threadId: ctx.source.threadId } : {}),
        }
      : undefined;
  return {
    agentId: ctx.agentId,
    accountId: ctx.source?.accountId,
    sessionName: ctx.sessionName,
    sessionKey: ctx.sessionKey,
    source,
  };
}

export interface GhWatchHookOptions {
  cwd?: string;
  context?: GhWatchFollowContext;
  deps?: GhWatchFollowDeps;
  /** Resolve `owner/repo` quando o comando não diz qual repo. */
  resolveRepoFromCwd?: (cwd: string) => string | null;
  enabled?: boolean;
}

const repoCache = new Map<string, string | null>();
const ensured = new Set<string>();

export function resetGhWatchHookCaches(): void {
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
 * Hook PreToolUse: observa o comando, garante a subscrição, nunca altera nada.
 */
export function createGhWatchHook(options: GhWatchHookOptions = {}): HookCallbackMatcher {
  const enabled = options.enabled ?? process.env.RAVI_WATCH_GH_AUTODETECT !== "0";
  const cwd = options.cwd ?? process.cwd();
  const resolveRepo = options.resolveRepoFromCwd ?? defaultResolveRepoFromCwd;

  return {
    matcher: "Bash",
    hooks: [
      async (input) => {
        try {
          if (!enabled) return {};
          const command = (input.tool_input as { command?: string } | undefined)?.command;
          if (!command || !command.includes("gh")) return {};

          const intent = parseGhWatchIntent(command);
          if (!intent) return {};

          const repo = intent.repo ?? resolveRepo(cwd);
          if (!repo) return {};

          const key = `${repo}#${intent.prNumber ?? "*"}`;
          if (ensured.has(key)) return {};

          const result = await ensureGhWatchFollow(
            { repo, prNumber: intent.prNumber, context: options.context ?? resolveFollowContext() },
            options.deps,
          );
          // Só memoriza quando algo foi de fato garantido: uma falha de DB não
          // pode virar "já tratei" para o resto da vida do processo.
          if (result.watchId && (result.triggerId || result.triggerSkipped === "no_pr_number")) {
            ensured.add(key);
          }
          log.info("gh watch follow ensured", { prNumber: intent.prNumber, ...result });
        } catch (error) {
          // Um hook é observador: falhar aqui não pode derrubar a tool call.
          log.warn("gh watch hook failed", { error });
        }
        return {};
      },
    ],
  };
}
