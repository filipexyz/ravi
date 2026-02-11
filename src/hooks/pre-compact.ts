/**
 * PreCompact Hook
 *
 * SDK PreCompact hook that reads the transcript before compaction
 * and extracts important memories using a cheap model.
 * The model has access to Read/Edit/Write tools restricted to MEMORY.md
 * and Read-only access to a temp transcript file.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
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

    // Format the full transcript (no truncation)
    const formattedTranscript = formatTranscript(messages, {
      includeTools: options.includeTools ?? false,
    });

    // Write full transcript to temp file
    const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9_:-]/g, "_");
    const transcriptTmpPath = join(
      tmpdir(),
      `ravi-memory-${sanitizedSessionId}-${Date.now()}.md`
    );
    writeFileSync(transcriptTmpPath, formattedTranscript, "utf-8");
    const lineCount = formattedTranscript.split("\n").length;

    log.info("Wrote transcript to temp file", {
      path: transcriptTmpPath,
      chars: formattedTranscript.length,
      lines: lineCount,
    });

    const memoryPath = join(agentCwd, "MEMORY.md");
    const modelToUse = options.memoryModel ?? "haiku";

    const promptToSend = `## Arquivos disponíveis

- **Transcript**: \`${transcriptTmpPath}\` (${lineCount} linhas) — SOMENTE LEITURA
- **MEMORY.md**: \`${memoryPath}\` — leitura e escrita

## Sua tarefa

Leia a conversa completa no transcript e atualize o MEMORY.md com todas as informações importantes.

## Instruções específicas
${instructions}

## Como ler o transcript

O transcript tem ${lineCount} linhas. Leia em seções de 500 linhas:
1. Read file_path="${transcriptTmpPath}" offset=1 limit=500
2. Read file_path="${transcriptTmpPath}" offset=501 limit=500
3. Continue até cobrir todas as ${lineCount} linhas

**IMPORTANTE**: Leia TODAS as seções sistematicamente. Não pule nenhuma parte.

## O que extrair

Preste atenção especial a:
- **Pessoas**: nomes, papéis, relações, preferências mencionadas
- **Decisões**: escolhas técnicas, de negócio, de produto
- **Contexto de negócio**: empresas, projetos, clientes, metas
- **Problemas e soluções**: bugs resolvidos, workarounds, padrões que funcionaram
- **Padrões de comportamento**: como o usuário gosta de trabalhar, convenções
- **Compromissos**: promessas feitas, prazos, tarefas pendentes
- **Mudanças de opinião**: quando algo que era de um jeito mudou
- **Informação implícita**: contexto que não foi dito explicitamente mas se deduz

## Processo

1. Leia o MEMORY.md atual (se existir)
2. Leia o transcript COMPLETO, seção por seção (500 linhas por vez)
3. Edite o MEMORY.md com as novas memórias

## Regras

- NUNCA apague memórias antigas — elas são valiosas
- ADICIONE novas memórias ao arquivo existente
- Pode REORGANIZAR ou CONSOLIDAR se fizer sentido, mas sem perder informação
- Se uma memória nova contradiz uma antiga, mantenha ambas com contexto temporal
- Seja conciso mas completo — não perca detalhes importantes`;

    log.info("Scheduling background extraction", {
      sessionId,
      model: modelToUse,
      memoryPath,
      transcriptTmpPath,
      transcriptLines: lineCount,
      transcriptChars: formattedTranscript.length,
    });

    // Fire and forget
    setImmediate(async () => {
      try {
        log.info("STARTING memory extraction", { sessionId, model: modelToUse });

        // Ensure directory exists
        mkdirSync(dirname(memoryPath), { recursive: true });

        // Hook to restrict file access
        // - Transcript file: Read only
        // - MEMORY.md: Read/Edit/Write
        // - Everything else: blocked
        const fileAccessHook = async (
          toolInput: Record<string, unknown>,
          _toolUseId: string | null
        ) => {
          const filePath = (toolInput.file_path as string) || "";
          const normalizedPath = resolve(agentCwd, filePath);

          const isRead = !("old_string" in toolInput) && !("content" in toolInput);
          const isTranscript = normalizedPath === transcriptTmpPath;
          const isMemory = normalizedPath === memoryPath;

          if (isTranscript) {
            if (isRead) {
              return { decision: "allow" as const };
            }
            log.warn("Memory agent tried to write to transcript file", {
              attempted: normalizedPath,
            });
            return {
              decision: "block" as const,
              reason: `O transcript é somente leitura. Você só pode escrever em: ${memoryPath}`,
            };
          }

          if (isMemory) {
            return { decision: "allow" as const };
          }

          log.warn("Memory agent tried to access unauthorized file", {
            attempted: normalizedPath,
            allowed: [transcriptTmpPath, memoryPath],
          });
          return {
            decision: "block" as const,
            reason: `Acesso negado. Arquivos permitidos: ${transcriptTmpPath} (leitura) e ${memoryPath} (leitura/escrita)`,
          };
        };

        // Use query with Read/Edit/Write tools
        const result = query({
          prompt: promptToSend,
          options: {
            model: modelToUse,
            cwd: agentCwd,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            allowedTools: ["Read", "Edit", "Write"],
            hooks: {
              PreToolUse: [{ hooks: [fileAccessHook] }],
            },
            systemPrompt: {
              type: "custom",
              content: `Você é um gerenciador de memórias. Você tem acesso a dois arquivos:
- ${transcriptTmpPath} — transcript da conversa (SOMENTE LEITURA)
- ${memoryPath} — arquivo de memórias (leitura e escrita)

REGRAS:
- Leia o transcript COMPLETO, seção por seção (500 linhas por vez)
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
      } finally {
        // Cleanup temp transcript file
        try {
          unlinkSync(transcriptTmpPath);
          log.debug("Cleaned up transcript temp file", { path: transcriptTmpPath });
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    log.info("PreCompact hook returning (extraction scheduled)", { sessionId });
    return {};
  };
}
