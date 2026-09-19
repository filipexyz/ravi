/**
 * Vigia de tool demorada.
 *
 * **O que este módulo NÃO faz:** não manda mensagem no chat. A primeira versão
 * emitia "ainda rodando: bash há 2 min" como resposta da sessão e isso virou ruído
 * na conversa — cada tool longa gerava uma mensagem nova, e um agente que roda
 * vários comandos lentos spammava a pessoa. Estado operacional não é conversa.
 *
 * **O que ele faz:** mantém a sessão visivelmente viva (presença) e publica o estado
 * ao vivo da tool em execução — quanto tempo, qual tool, quantas mensagens
 * esperando. Estado é contínuo e sobrescrito; mensagem é discreta e acumula. A
 * transparência mora no estado.
 *
 * A solução estrutural para chamada longa é outra: virar job em background
 * (`ravi jobs run`), com o agente no controle (`wait`, `tail`, `kill`).
 */

export interface SlowToolWatchConfig {
  /** A partir de quanto tempo a tool passa a ser anunciada no estado ao vivo. */
  announceAfterMs: number;
  /** Cadência do tick que mantém a presença viva. */
  tickMs: number;
}

export const DEFAULT_SLOW_TOOL_ANNOUNCE_MS = 90_000;
export const SLOW_TOOL_TICK_MS = 30_000;

export function resolveSlowToolWatchConfig(env: NodeJS.ProcessEnv = process.env): SlowToolWatchConfig {
  const announceAfterMs = positiveInt(env.RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS, DEFAULT_SLOW_TOOL_ANNOUNCE_MS);
  return {
    announceAfterMs,
    tickMs: Math.min(announceAfterMs, SLOW_TOOL_TICK_MS),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Texto do estado ao vivo (aparece no UI, nunca como mensagem na conversa). */
export function buildSlowToolStatusText(toolName: string, elapsedMs: number, queuedMessages: number): string {
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  const tool = toolName?.trim() || "uma tool";
  // Plural de "mensagem" não é "mensagem"+"s": é "mensagens".
  const noun = queuedMessages === 1 ? "mensagem" : "mensagens";
  const queued = queuedMessages > 0 ? ` · ${queuedMessages} ${noun} na fila` : "";
  return `${tool} rodando há ${minutes} min${queued}`;
}
