/**
 * Hook que promove comando longo para job.
 *
 * O agente continua escrevendo o comando que ele quer; se o comando se declara
 * longo, ele vira job em background e o agente recebe o id na hora. O turno nunca
 * fica preso, então a próxima mensagem da pessoa é processada imediatamente.
 *
 * Reescrita, não bloqueio: a decisão de rodar é do comando, e a de autorizar é do
 * hook de permissão. Aqui só trocamos a forma de execução.
 */

import type { HookCallbackMatcher } from "../bash/hook.js";
import { resolveDeclaredToolTimeoutMs } from "../runtime/tool-liveness.js";
import { logger } from "../utils/logger.js";
import {
  decideJobPromotion,
  buildPromotedCommand,
  resolveJobPromotionConfig,
  type JobPromotionDecision,
} from "../jobs/promotion.js";

const log = logger.child("hooks:jobs-promote");

export interface JobPromotionHookOptions {
  sessionName?: string | null;
  agentId?: string | null;
  cwd?: string | null;
  enabled?: boolean;
}

export function createJobPromotionHook(options: JobPromotionHookOptions = {}): HookCallbackMatcher {
  const enabled = options.enabled ?? process.env.RAVI_JOBS_PROMOTE !== "0";

  return {
    matcher: "Bash",
    hooks: [
      async (input) => {
        try {
          if (!enabled) return {};
          const toolInput = input.tool_input as { command?: string; timeout?: number } | undefined;
          const command = toolInput?.command;
          if (!command) return {};

          const config = resolveJobPromotionConfig();
          const decision: JobPromotionDecision = decideJobPromotion(
            { command, declaredTimeoutMs: readDeclaredTimeoutMs(toolInput) },
            config,
          );
          if (!decision.promote) return {};

          const promoted = buildPromotedCommand({
            command,
            sessionName: options.sessionName ?? null,
            agentId: options.agentId ?? null,
            cwd: options.cwd ?? null,
          });

          log.info("Promoting long command to background job", {
            sessionName: options.sessionName ?? null,
            reason: decision.reason,
            detail: decision.detail ?? null,
          });

          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              updatedInput: { ...(toolInput as Record<string, unknown>), command: promoted },
            },
          };
        } catch (error) {
          // Um hook que quebra a tool call por causa da própria decisão é pior que
          // rodar o comando em foreground.
          log.warn("Job promotion hook failed; running the command as-is", { error });
          return {};
        }
      },
    ],
  };
}

/**
 * Timeout declarado pela tool, na semântica canônica (segundos, com margem).
 *
 * Reusa o parser do lease de inatividade em vez de reinterpretar o campo aqui: duas
 * leituras do mesmo campo divergem com o tempo. `null` quando a tool não declarou
 * nada — senão o default do lease promoveria todo comando.
 */
function readDeclaredTimeoutMs(toolInput: Record<string, unknown> | undefined): number | null {
  if (!toolInput || !Object.prototype.hasOwnProperty.call(toolInput, "timeout")) return null;
  const resolved = resolveDeclaredToolTimeoutMs(toolInput);
  return Number.isFinite(resolved) && resolved > 0 ? resolved : null;
}
