/**
 * Promoção de comando para job.
 *
 * O agente não deveria precisar saber quando um comando é longo. Esta é a política
 * pura que decide, a partir do comando e do timeout que ele declara, se a chamada
 * vira um job em background.
 *
 * Regra de ouro: **promover é a exceção, não a regra**. Um comando que retorna
 * rápido deve continuar sendo tool normal — a resposta imediata é melhor que um id
 * de job. Só promotamos quando há evidência de que o comando vai bloquear.
 *
 * Evidências aceitas, em ordem de confiança:
 * 1. o comando declara `timeout` alto (é o agente avisando que vai demorar);
 * 2. o comando dorme explicitamente (`sleep N` com N acima do limiar);
 * 3. o comando espera por processo em background no mesmo shell (`nohup ... & ...
 *    wait`), padrão que anula o próprio background.
 *
 * Nada disso depende de adivinhação sobre a intenção: são sinais que o próprio
 * comando carrega.
 */

export interface JobPromotionConfig {
  /** A partir de quanto tempo declarado um comando vira job. */
  declaredTimeoutMs: number;
  /** A partir de quantos segundos um `sleep` explícito vira job. */
  sleepMs: number;
}

export const DEFAULT_JOB_PROMOTION_CONFIG: JobPromotionConfig = {
  declaredTimeoutMs: 45_000,
  sleepMs: 20_000,
};

export interface JobPromotionDecision {
  promote: boolean;
  reason: "declared_timeout" | "sleep" | "background_wait" | "disabled" | "not_long" | "already_background";
  /** Texto curto para log e para o evento de observação. */
  detail?: string;
}

export interface JobPromotionInput {
  command: string;
  /** Timeout que o agente declarou no input da tool, em ms. */
  declaredTimeoutMs?: number | null;
}

const SLEEP_PATTERN = /\bsleep\s+(\d+(?:\.\d+)?)\b/g;
const BACKGROUND_WAIT_PATTERN = /\bnohup\b[\s\S]*&\s*(?:sleep\b|wait\b)/;

export function resolveJobPromotionConfig(env: NodeJS.ProcessEnv = process.env): JobPromotionConfig {
  return {
    declaredTimeoutMs: positiveInt(env.RAVI_JOBS_PROMOTE_TIMEOUT_MS, DEFAULT_JOB_PROMOTION_CONFIG.declaredTimeoutMs),
    sleepMs: positiveInt(env.RAVI_JOBS_PROMOTE_SLEEP_MS, DEFAULT_JOB_PROMOTION_CONFIG.sleepMs),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Maior `sleep N` do comando, em ms. `sleep 1` dentro de outro comando não conta. */
export function maxSleepMs(command: string): number {
  let max = 0;
  for (const match of command.matchAll(SLEEP_PATTERN)) {
    const seconds = Number.parseFloat(match[1] ?? "");
    if (Number.isFinite(seconds)) max = Math.max(max, seconds * 1_000);
  }
  return max;
}

export function decideJobPromotion(
  input: JobPromotionInput,
  config: JobPromotionConfig = DEFAULT_JOB_PROMOTION_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): JobPromotionDecision {
  if (env.RAVI_JOBS_PROMOTE === "0") {
    return { promote: false, reason: "disabled" };
  }

  const command = input.command.trim();
  if (!command) return { promote: false, reason: "not_long" };

  // Já é um job (ou já veio promovido): não promover de novo.
  if (/\bravi\s+jobs\s+run\b/.test(command)) {
    return { promote: false, reason: "already_background" };
  }

  const declaredTimeoutMs = typeof input.declaredTimeoutMs === "number" ? input.declaredTimeoutMs : null;
  if (declaredTimeoutMs !== null && declaredTimeoutMs >= config.declaredTimeoutMs) {
    return {
      promote: true,
      reason: "declared_timeout",
      detail: `timeout declarado ${Math.round(declaredTimeoutMs / 1000)}s`,
    };
  }

  const sleepMs = maxSleepMs(command);
  if (sleepMs >= config.sleepMs) {
    return { promote: true, reason: "sleep", detail: `sleep ${Math.round(sleepMs / 1000)}s no comando` };
  }

  if (BACKGROUND_WAIT_PATTERN.test(command)) {
    return { promote: true, reason: "background_wait", detail: "nohup em background com espera no mesmo shell" };
  }

  return { promote: false, reason: "not_long" };
}

/**
 * Reescreve o comando para rodar como job e voltar na hora.
 *
 * O comando original vai **citado como um único argumento**. Isso não é detalhe de
 * estilo: sem as aspas, `nohup job.sh & sleep 100` seria interpretado pelo shell
 * externo — o `&` destacaria o `ravi jobs run` e o `sleep 100` continuaria rodando
 * no shell do provider, ou seja, exatamente o bloqueio que a promoção existe para
 * eliminar. Citado, o comando inteiro é um argumento só e o job recebe a linha
 * original intacta.
 */
export function buildPromotedCommand(input: {
  command: string;
  sessionName?: string | null;
  agentId?: string | null;
  cwd?: string | null;
}): string {
  const parts = ["ravi", "jobs", "run"];
  if (input.sessionName) parts.push("--session", shellQuote(input.sessionName));
  if (input.agentId) parts.push("--agent", shellQuote(input.agentId));
  if (input.cwd) parts.push("--cwd", shellQuote(input.cwd));
  parts.push("--", shellQuote(input.command));
  return parts.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
