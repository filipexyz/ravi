/**
 * Aviso de tool demorada.
 *
 * O runtime já sabe quando uma tool parou de produzir evento — mas só depois do
 * lease de inatividade expirar. E o lease respeita o timeout que a própria tool
 * declara (correto: um build de 15 minutos não pode ser morto pelo watchdog
 * genérico). A consequência é um buraco: uma tool que trava **e** declara timeout
 * longo compra silêncio pelo tempo inteiro do que declarou.
 *
 * Foi o que aconteceu em 18/09: um comando declarou 900s, travou esperando um
 * editor interativo, e o watchdog esperou 1125s em silêncio. Seis mensagens
 * ficaram na fila, a presença de digitando expirou em 2 minutos, e do lado de fora
 * a sessão parecia morta.
 *
 * Este aviso separa as duas coisas: a **paciência** continua sendo do timeout
 * declarado (a tool não é interrompida), mas o **silêncio** acaba num limiar
 * curto, com uma linha visível para quem está esperando.
 */

export interface SlowToolNoticeConfig {
  /** Quando avisar pela primeira vez. */
  noticeAfterMs: number;
  /** Intervalo entre avisos seguintes. */
  repeatEveryMs: number;
  /** Teto de avisos por tool: avisar para sempre também é ruído. */
  maxNotices: number;
  /** Cadência do tick que mantém a presença viva. */
  tickMs: number;
}

export interface SlowToolNoticeState {
  startedAt: number;
  noticesSent: number;
  nextNoticeAt: number;
}

export const DEFAULT_SLOW_TOOL_NOTICE_MS = 90_000;
export const DEFAULT_SLOW_TOOL_REPEAT_MS = 180_000;
export const DEFAULT_SLOW_TOOL_MAX_NOTICES = 5;
export const SLOW_TOOL_TICK_MS = 30_000;

export function resolveSlowToolNoticeConfig(env: NodeJS.ProcessEnv = process.env): SlowToolNoticeConfig {
  const noticeAfterMs = positiveInt(env.RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS, DEFAULT_SLOW_TOOL_NOTICE_MS);
  const repeatEveryMs = positiveInt(env.RAVI_RUNTIME_SLOW_TOOL_REPEAT_MS, DEFAULT_SLOW_TOOL_REPEAT_MS);
  return {
    noticeAfterMs,
    repeatEveryMs,
    maxNotices: positiveInt(env.RAVI_RUNTIME_SLOW_TOOL_MAX_NOTICES, DEFAULT_SLOW_TOOL_MAX_NOTICES),
    tickMs: Math.min(noticeAfterMs, SLOW_TOOL_TICK_MS),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function initialSlowToolNoticeState(startedAt: number, config: SlowToolNoticeConfig): SlowToolNoticeState {
  return { startedAt, noticesSent: 0, nextNoticeAt: startedAt + config.noticeAfterMs };
}

export function decideSlowToolNotice(
  state: SlowToolNoticeState,
  now: number,
  config: SlowToolNoticeConfig,
): { notify: boolean; state: SlowToolNoticeState } {
  if (state.noticesSent >= config.maxNotices || now < state.nextNoticeAt) {
    return { notify: false, state };
  }
  return {
    notify: true,
    state: {
      ...state,
      noticesSent: state.noticesSent + 1,
      nextNoticeAt: now + config.repeatEveryMs,
    },
  };
}

/** Linha curta e visível para quem está esperando, no mesmo tom do aviso de inatividade. */
export function buildSlowToolNoticeText(toolName: string, elapsedMs: number, queuedMessages: number): string {
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  const tool = toolName?.trim() || "uma tool";
  // Plural de "mensagem" não é "mensagem"+"s": é "mensagens".
  const noun = queuedMessages === 1 ? "mensagem" : "mensagens";
  const queued = queuedMessages > 0 ? ` ${queuedMessages} ${noun} na fila.` : "";
  return `ainda rodando: ${tool} há ${minutes} min.${queued}`;
}
