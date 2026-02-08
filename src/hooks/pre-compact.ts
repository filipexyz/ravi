/**
 * PreCompact Hook
 *
 * SDK PreCompact hook that reads the transcript before compaction
 * and extracts important memories using a cheap model.
 * The model has access to Read/Edit/Write tools restricted to MEMORY.md only.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.js";
import { parseTranscript, formatTranscript } from "./transcript-parser.js";

const log = logger.child("hooks:pre-compact");

/**
 * Hook input structure for PreCompact event.
 */
interface PreCompactHookInput {
  hook_event_name: "PreCompact";
  session_id: string;
  transcript_path: string;
  cwd: string;
  trigger: "manual" | "auto";
  custom_instructions: string | null;
}

/**
 * Hook context from Claude Agent SDK.
 */
interface HookContext {
  signal: AbortSignal;
}

/**
 * Hook callback type from Claude Agent SDK.
 */
type HookCallback = (
  input: PreCompactHookInput,
  toolUseId: string | null,
  context: HookContext
) => Promise<Record<string, unknown>>;

/**
 * Options for PreCompact hook
 */
export interface PreCompactHookOptions {
  /** Model to use for memory extraction (default: "haiku") */
  memoryModel?: string;
  /** Include tool calls in transcript (default: false) */
  includeTools?: boolean;
}

/**
 * Create a PreCompact hook that extracts memories before compaction.
 * Reads the transcript file and sends to a cheap model for extraction.
 * Runs in background (fire-and-forget) to avoid blocking compaction.
 *
 * @param options Hook options
 * @returns A hook callback for PreCompact events
 */
export function createPreCompactHook(
  options: PreCompactHookOptions = {}
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const { session_id: sessionId, cwd: agentCwd } = input;

    log.info("PreCompact hook TRIGGERED", {
      sessionId,
      agentCwd,
      trigger: input.trigger,
      transcriptPath: input.transcript_path,
      hasCustomInstructions: !!input.custom_instructions,
    });

    // Read COMPACT_INSTRUCTIONS.md from agent's cwd
    const instructionsPath = join(agentCwd, "COMPACT_INSTRUCTIONS.md");
    let instructions: string;

    if (existsSync(instructionsPath)) {
      instructions = readFileSync(instructionsPath, "utf-8");
      log.info("Loaded COMPACT_INSTRUCTIONS.md", {
        path: instructionsPath,
        size: instructions.length,
      });
    } else {
      instructions = `Extraia as informações mais importantes desta conversa que devem ser lembradas.
Foque em:
- Decisões tomadas
- Preferências do usuário descobertas
- Problemas resolvidos e suas soluções
- Promessas ou compromissos feitos
- Lições aprendidas e padrões identificados`;
      log.info("Using DEFAULT compact instructions", { sessionId });
    }

    if (input.custom_instructions) {
      log.info("Overriding with custom instructions from /compact");
      instructions = input.custom_instructions;
    }

    // Parse transcript
    if (!existsSync(input.transcript_path)) {
      log.warn("Transcript file not found", { path: input.transcript_path });
      return {};
    }

    const messages = parseTranscript(input.transcript_path);
    log.info("Parsed transcript", {
      totalMessages: messages.length,
      path: input.transcript_path,
    });

    if (messages.length === 0) {
      log.info("No messages in transcript, skipping extraction");
      return {};
    }

    const formattedTranscript = formatTranscript(messages, {
      includeTools: options.includeTools ?? false,
    });

    const memoryPath = join(agentCwd, "MEMORY.md");
    const modelToUse = options.memoryModel ?? "haiku";

    const promptToSend = `Você tem acesso ao arquivo MEMORY.md em: ${memoryPath}

## Sua tarefa
Analise a conversa abaixo e atualize o MEMORY.md com informações importantes.

## Instruções
${instructions}

## Conversa recente
${formattedTranscript}

## O que fazer
1. Primeiro, leia o MEMORY.md atual (se existir)
2. Decida o que adicionar, atualizar ou reorganizar
3. Edite o arquivo diretamente

Seja proativo. Organize as memórias da forma que fizer mais sentido.`;

    log.info("Scheduling background extraction", {
      sessionId,
      model: modelToUse,
      memoryPath,
      transcriptLen: formattedTranscript.length,
    });

    // Fire and forget
    setImmediate(async () => {
      try {
        log.info("STARTING memory extraction", { sessionId, model: modelToUse });

        // Ensure directory exists
        mkdirSync(dirname(memoryPath), { recursive: true });

        // Hook to restrict file access to MEMORY.md only
        const fileAccessHook = async (
          toolInput: Record<string, unknown>,
          _toolUseId: string | null
        ) => {
          const filePath = (toolInput.file_path as string) || "";
          // Resolve to absolute path and normalize (handles ../ traversal)
          const normalizedPath = resolve(agentCwd, filePath);

          if (normalizedPath !== memoryPath) {
            log.warn("Memory agent tried to access unauthorized file", {
              attempted: normalizedPath,
              allowed: memoryPath,
            });
            return {
              decision: "block" as const,
              reason: `Acesso negado. Você só pode acessar: ${memoryPath}`,
            };
          }
          return { decision: "allow" as const };
        };

        // Use query with Read/Edit/Write tools restricted to MEMORY.md
        const result = query({
          prompt: promptToSend,
          options: {
            model: modelToUse,
            cwd: agentCwd,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            allowedTools: ["Read", "Edit", "Write"],
            hooks: {
              PreToolUse: [fileAccessHook],
            },
            systemPrompt: {
              type: "custom",
              content: `Você é um gerenciador de memórias. Você pode APENAS ler e editar o arquivo: ${memoryPath}

REGRAS:
- NUNCA apague memórias antigas - elas são valiosas
- ADICIONE novas memórias ao arquivo existente
- Pode REORGANIZAR ou CONSOLIDAR se fizer sentido, mas sem perder informação
- Se uma memória nova contradiz uma antiga, mantenha ambas com contexto

Organize de forma clara e útil.`,
            },
          },
        });

        for await (const message of result) {
          if (message.type === "assistant") {
            log.debug("Memory agent response", {
              contentBlocks: message.message.content.length,
            });
          }
        }

        log.info("Memory extraction completed", { sessionId, memoryPath });
      } catch (err) {
        log.error("FAILED to extract memories", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    });

    log.info("PreCompact hook returning (extraction scheduled)", { sessionId });
    return {};
  };
}
