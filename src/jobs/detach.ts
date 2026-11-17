/**
 * Detach por tempo decorrido.
 *
 * A promoção antiga (`promotion.ts`) decide **antes** de o comando rodar, e só
 * aceita sintaxe que se declara longa: `timeout` alto, `sleep` longo, `nohup ... & wait`.
 * O problema é que os comandos que realmente prendem o turno não declaram nada —
 * `bun test`, `docker build`, `gh run watch`, deploy — e ficam minutos dentro do
 * turno enquanto a sessão parece morta do outro lado.
 *
 * Aqui a decisão é tomada **enquanto o comando roda**: um wrapper executa o comando
 * de verdade como filho e, se ele passar do limiar, registra um job, devolve o
 * handle e sai. O turno continua. Nada é adivinhado a partir da sintaxe.
 *
 * Contrato do wrapper (`detach-script.ts` gera o script):
 *
 * 1. abaixo do limiar: comportamento indistinguível de rodar o comando solto —
 *    mesma saída, mesmo exit code;
 * 2. acima do limiar: o job é registrado **antes** de o wrapper sair, o comando
 *    fica vivo em outra sessão (setsid) e o agente recebe um handle honesto:
 *    handle, não saída;
 * 3. o desfecho volta para a sessão pelo runner de jobs, com tail, quando termina.
 *
 * Este módulo é a parte pura: decisão de reescrever, texto do resultado e leitura
 * do arquivo de saída. O shell mora em `detach-script.ts`.
 */

import { readFileSync } from "node:fs";

/** Limiar padrão. 25s é folgado para comando rápido e curto para o turno parecer vivo. */
export const DEFAULT_DETACH_AFTER_MS = 25_000;

/** Piso: abaixo disso todo `ls` viraria job, e o handle seria pior que a saída. */
export const MIN_DETACH_AFTER_MS = 200;

export const DETACH_DISABLED_ENV = "RAVI_JOBS_DETACH";
export const DETACH_AFTER_ENV = "RAVI_JOBS_DETACH_AFTER_MS";

export function isDetachEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DETACH_DISABLED_ENV] !== "0";
}

export function resolveDetachAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(String(env[DETACH_AFTER_ENV] ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DETACH_AFTER_MS;
  return Math.max(MIN_DETACH_AFTER_MS, parsed);
}

/**
 * Comando que não deve ser reescrito.
 *
 * O critério não é "vai demorar?" (não sabemos), é "reescrever quebraria ou
 * mentiria?": comando vazio, comando que já é job, e comando que já está dentro
 * do wrapper.
 */
export function shouldWrapBashCommand(
  command: string | null | undefined,
  options: { scriptPath?: string | null; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = options.env ?? process.env;
  if (!isDetachEnabled(env)) return false;
  const trimmed = (command ?? "").trim();
  if (!trimmed) return false;
  if (/\bravi\s+jobs\s+run\b/.test(trimmed)) return false;
  if (options.scriptPath && trimmed.includes(options.scriptPath)) return false;
  if (/\bravi-jobs-exec\b/.test(trimmed)) return false;
  return true;
}

/**
 * Reescreve o comando para passar pelo wrapper.
 *
 * O comando original vai **citado como um argumento só**: junto do `--`, ele é
 * dado, não sintaxe do shell do provider. Sem isso, um `&` no comando destacaria
 * o wrapper e o resto continuaria rodando no turno.
 */
export function buildWrappedBashCommand(input: {
  scriptPath: string;
  command: string;
  sessionName?: string | null;
  agentId?: string | null;
}): string {
  const parts = [shellQuote(input.scriptPath)];
  if (input.sessionName) parts.push("--session", shellQuote(input.sessionName));
  if (input.agentId) parts.push("--agent", shellQuote(input.agentId));
  parts.push("--", shellQuote(input.command));
  return parts.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Arquivo com o exit code do comando, escrito pelo próprio shell que o executou. */
export function jobExitStatePath(logPath: string): string {
  return `${logPath}.exit`;
}

export interface JobExitState {
  exitCode: number;
  /** Quando o shell morreu por sinal, `128 + n` é o código que ele reporta. */
  signal: string | null;
}

export function readJobExitState(logPath: string): JobExitState | null {
  try {
    const raw = readFileSync(jobExitStatePath(logPath), "utf8").trim();
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return { exitCode: parsed, signal: signalFromExitCode(parsed) };
  } catch {
    return null;
  }
}

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  13: "SIGPIPE",
  15: "SIGTERM",
};

/** `143` de um `kill` é SIGTERM: o job foi encerrado, não falhou por conta própria. */
export function signalFromExitCode(exitCode: number): string | null {
  if (exitCode <= 128) return null;
  return SIGNAL_NAMES[exitCode - 128] ?? null;
}

export function jobStatusFromExitCode(exitCode: number): "succeeded" | "failed" | "killed" {
  if (exitCode === 0) return "succeeded";
  if (exitCode > 128 && signalFromExitCode(exitCode)) return "killed";
  return "failed";
}

/**
 * Texto do resultado é do próprio wrapper (`ravi-jobs-exec.sh`), não deste módulo:
 * o shell é quem decide e quem responde, e duplicar a frase em dois lugares
 * garante que um dia os dois vão divergir.
 */
