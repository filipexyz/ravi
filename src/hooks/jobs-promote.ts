/**
 * Hook que reescreve comando de Bash para o wrapper de detach.
 *
 * O agente continua escrevendo o comando que quer; o comando passa a rodar dentro
 * de `ravi-jobs-exec`, que decide **pelo relógio** se ele vira job. A decisão não é
 * mais tomada aqui, por sintaxe — era exatamente isso que deixava `bun test`,
 * `docker build` e deploy presos no turno.
 *
 * Reescrita, não bloqueio: a decisão de rodar é do comando, e a de autorizar é do
 * hook de permissão (que roda antes deste). Aqui só trocamos a forma de execução.
 *
 * Modos:
 * - padrão: toda chamada de Bash passa pelo wrapper;
 * - `RAVI_JOBS_WRAP=0`: volta à promoção antiga, por sintaxe (rollback);
 * - `RAVI_JOBS_PROMOTE=0`: não mexe em nada.
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
import { buildWrappedBashCommand, shouldWrapBashCommand } from "../jobs/detach.js";
import { ensureDetachScript, resolveDetachScriptPath } from "../jobs/detach-script.js";

const log = logger.child("hooks:jobs-promote");

export interface JobPromotionHookOptions {
  sessionName?: string | null;
  agentId?: string | null;
  cwd?: string | null;
  enabled?: boolean;
  /** Injetável no teste: evita materializar o script no estado real. */
  scriptPath?: string | null;
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

          if (process.env.RAVI_JOBS_WRAP === "0") {
            return promoteBySyntax(command, toolInput, options);
          }

          const scriptPath = options.scriptPath ?? resolveDetachScriptPath();
          if (!shouldWrapBashCommand(command, { scriptPath })) return {};
          // O script é gerado no começo de sessão; esta chamada cobre o caso de
          // ele ter sido apagado (limpeza de estado) sem derrubar o turno.
          const resolvedPath = options.scriptPath ?? ensureDetachScript();

          const wrapped = buildWrappedBashCommand({
            scriptPath: resolvedPath,
            command,
            sessionName: options.sessionName ?? null,
            agentId: options.agentId ?? null,
          });

          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              updatedInput: { ...(toolInput as Record<string, unknown>), command: wrapped },
            },
          };
        } catch (error) {
          // Um hook que quebra a tool call por causa da própria decisão é pior que
          // rodar o comando em foreground.
          log.warn("Long-tool detach hook failed; running the command as-is", { error });
          return {};
        }
      },
    ],
  };
}

/** Rollback: política antiga, decidida antes do comando rodar. */
function promoteBySyntax(
  command: string,
  toolInput: Record<string, unknown>,
  options: JobPromotionHookOptions,
): Record<string, unknown> {
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
      updatedInput: { ...toolInput, command: promoted },
    },
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
