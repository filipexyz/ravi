/**
 * O wrapper que se auto-destaca.
 *
 * O shell vive em `ravi-jobs-exec.sh` (importado como texto, então o bundle
 * carrega o script junto). Este módulo resolve o caminho, o comando do CLI que o
 * script chama e materializa o arquivo no disco.
 *
 * Por que um script de shell e não um subcomando do CLI: o wrapper roda em
 * **toda** chamada de Bash. Medido nesta máquina, `ravi --version` custa ~5s de
 * startup; o script de shell custa milissegundos. Pagar o CLI no caminho quente
 * seria trocar um problema de latência por outro.
 *
 * O CLI só é chamado no caminho de destacar/terminar, onde o custo desaparece
 * dentro do próprio trabalho longo.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { DETACH_AFTER_ENV, DEFAULT_DETACH_AFTER_MS, resolveDetachAfterMs } from "./detach.js";
import DETACH_SCRIPT_SOURCE from "./ravi-jobs-exec.sh" with { type: "text" };

export const DETACH_SCRIPT_FILENAME = "ravi-jobs-exec.sh";

/** Onde o script é materializado. Estável entre execuções para o hook poder citá-lo. */
export function resolveDetachScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "jobs", DETACH_SCRIPT_FILENAME);
}

export interface DetachCliCommand {
  /** Executável: o bun que está rodando agora, `ravi` do PATH, ou RAVI_BIN. */
  bin: string;
  /** Argumento fixo antes dos subcomandos: o bundle, quando o CLI é `bun <bundle>`. */
  arg: string | null;
}

/**
 * Comando do CLI que o script chama para registrar/encerrar jobs.
 *
 * Precisa ser o **mesmo runtime que gerou o script**: um CLI global de outra
 * versão pode não ter `jobs register`, e aí o detach falharia calado no meio do
 * caminho. `argv[1]` é o bundle que está rodando agora.
 */
export function resolveDetachCliCommand(env: NodeJS.ProcessEnv = process.env): DetachCliCommand {
  const entrypoint = process.argv[1];
  if (entrypoint && /\.(?:js|ts)$/.test(entrypoint)) {
    return { bin: process.execPath, arg: entrypoint };
  }
  const explicit = env.RAVI_BIN?.trim();
  return { bin: explicit || "ravi", arg: null };
}

export interface RenderDetachScriptOptions {
  cli?: DetachCliCommand;
  /** Limiar padrão gravado no script; o ambiente ainda pode sobrepor. */
  detachAfterMs?: number;
}

export function renderDetachScript(options: RenderDetachScriptOptions = {}): string {
  const cli = options.cli ?? resolveDetachCliCommand();
  const detachAfterMs = options.detachAfterMs ?? resolveDetachAfterMs();
  return DETACH_SCRIPT_SOURCE.replaceAll("@@CLI_BIN@@", shellQuoteInner(cli.bin))
    .replaceAll("@@CLI_ARG@@", shellQuoteInner(cli.arg ?? ""))
    .replaceAll("@@DETACH_AFTER_MS@@", String(detachAfterMs || DEFAULT_DETACH_AFTER_MS));
}

/** O valor entra dentro de `VAR='...'`: aspas simples precisam do truque `'\''`. */
function shellQuoteInner(value: string): string {
  return value.replaceAll("'", `'\\''`);
}

let ensuredPath: string | null = null;

/**
 * Garante que o script existe e corresponde ao código atual.
 *
 * Escreve só quando o conteúdo muda: isso é chamado no começo de sessão e antes
 * de reescrever um comando, não pode custar caro.
 */
export function ensureDetachScript(options: RenderDetachScriptOptions & { env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const path = resolveDetachScriptPath(env);
  if (ensuredPath === path) {
    try {
      // O arquivo pode ter sido removido por limpeza de estado.
      readFileSync(path);
      return path;
    } catch {
      ensuredPath = null;
    }
  }

  const source = renderDetachScript(options);
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }

  if (current !== source) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  ensuredPath = path;
  return path;
}

/** Só para teste: esquece o cache de materialização. */
export function resetDetachScriptCache(): void {
  ensuredPath = null;
}

export { DETACH_AFTER_ENV };
