/**
 * PreCompact Hook
 *
 * SDK PreCompact hook that reads the transcript before compaction
 * and extracts important memories using a cheap model.
 * The model has only Read/Edit/Write (`tools`), no settings sources, and a
 * PreToolUse guard that limits writes to MEMORY.md and memory/ and reads to the
 * agent cwd plus a temp transcript file (see createMemoryAgentToolGuard).
 */

import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { query, type HookInput } from "@anthropic-ai/claude-agent-sdk";
import { filterAgentRuntimeBaseEnv } from "../runtime/agent-env-policy.js";
import { applyClaudeRequiredPromptEnv } from "../runtime/claude-prompt-env.js";
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
  toolUseId: string | null | undefined,
  context: HookContext,
) => Promise<Record<string, unknown>>;

/**
 * Options for PreCompact hook
 */
export interface PreCompactHookOptions {
  /** Model to use for memory extraction (default: "haiku") */
  memoryModel?: string;
  /** Include tool calls in transcript (default: false) */
  includeTools?: boolean;
  /** Claude Code executable to spawn (default: the SDK's own resolution). Tests point it at a fake. */
  pathToClaudeCodeExecutable?: string;
}

/**
 * Create a PreCompact hook that extracts memories before compaction.
 * Reads the transcript file and sends to a cheap model for extraction.
 * Runs in background (fire-and-forget) to avoid blocking compaction.
 *
 * @param options Hook options
 * @returns A hook callback for PreCompact events
 */
export function createPreCompactHook(options: PreCompactHookOptions = {}): HookCallback {
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

    // Write full transcript to a private temp file
    const { dir: transcriptTmpDir, path: transcriptTmpPath } = writePrivateTranscriptCopy(
      sessionId,
      formattedTranscript,
    );
    const lineCount = formattedTranscript.split("\n").length;

    log.info("Wrote transcript to temp file", {
      path: transcriptTmpPath,
      chars: formattedTranscript.length,
      lines: lineCount,
    });

    const memoryPath = join(agentCwd, "MEMORY.md");
    const memoryDir = join(agentCwd, "memory");
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const modelToUse = options.memoryModel ?? "haiku";

    const promptToSend = `## Arquivos disponíveis

- **Transcript**: \`${transcriptTmpPath}\` (${lineCount} linhas) — SOMENTE LEITURA
- **MEMORY.md**: \`${memoryPath}\` — leitura e escrita (índice principal)
- **memory/**: \`${memoryDir}/\` — pasta com arquivos por data (leitura e escrita)

Data de hoje: ${today}

## Sua tarefa

Leia a conversa completa no transcript e atualize a memória do agent.

## Instruções específicas
${instructions}

## Estrutura de Memória

A memória é organizada em DOIS NÍVEIS:

### 1. MEMORY.md (índice principal — DEVE ser curto, <100 linhas)
Contém APENAS informações persistentes e de referência rápida:
- **Regras de Operação** — lições aprendidas, regras que não mudam entre sessões
- **Padrões Técnicos** — como o sistema funciona, convenções
- **Contexto de Negócio** — projetos ativos, pessoas-chave, bugs pendentes, deadlines
- **Diário** — tabela com data, tópicos abordados e link pro arquivo detalhado. Os tópicos servem como índice de busca — ex: "session names, bug fixes, outbound" pra saber em qual dia procurar cada assunto

**NÃO coloque detalhes de implementação no MEMORY.md** — esses vão no arquivo por data.

### 2. memory/YYYY-MM-DD.md (arquivos por data)
Cada dia tem seu arquivo com uma descrição fiel do que aconteceu. O objetivo é que, ao ler o arquivo, dê pra entender o que foi feito e onde buscar mais detalhes se necessário. Inclua:
- Features implementadas (o que faz, arquivos principais, commits)
- Bugs encontrados e resolvidos (sintoma, causa, fix)
- Decisões técnicas relevantes (o que foi decidido e por quê)
- Lições aprendidas
- Dados ou resultados concretos quando relevantes
- Contexto de conversas importantes

**Seja fiel mas conciso. O arquivo serve como índice detalhado — não precisa replicar código ou explicar cada linha.**

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
2. Leia os arquivos existentes em memory/ (se houver) para não duplicar
3. Leia o transcript COMPLETO, seção por seção (500 linhas por vez)
4. Determine a data da sessão pelo conteúdo do transcript
5. Crie ou atualize o arquivo \`memory/YYYY-MM-DD.md\` com uma descrição fiel do dia
6. Atualize o MEMORY.md:
   - Adicione/atualize a linha na tabela do diário com os tópicos abordados (ex: "outbound stages, BUG-001 fix, doma-rdp") — esses tópicos são o índice de busca pra saber em qual dia procurar cada assunto
   - Atualize regras de operação se novas lições foram aprendidas
   - Atualize contexto de negócio se mudou (versão, projetos, pessoas, bugs)
   - Atualize padrões técnicos se novos padrões foram descobertos

## Regras

- NUNCA apague memórias antigas — elas são valiosas
- NUNCA coloque detalhes extensos no MEMORY.md — use os arquivos por data
- Pode REORGANIZAR ou CONSOLIDAR se fizer sentido, mas sem perder informação
- Se uma memória nova contradiz uma antiga, mantenha ambas com contexto temporal
- Seja conciso no MEMORY.md, fiel e útil nos arquivos por data`;

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

        // Ensure directories exist
        mkdirSync(dirname(memoryPath), { recursive: true });
        mkdirSync(memoryDir, { recursive: true });

        const fileAccessHook = createMemoryAgentToolGuard({
          agentCwd,
          memoryPath,
          memoryDir,
          transcriptPath: transcriptTmpPath,
        });

        // Use query with Read/Edit/Write tools
        const result = query({
          prompt: promptToSend,
          options: {
            model: modelToUse,
            cwd: agentCwd,
            // Without `env` the SDK spawns Claude Code with the whole daemon env.
            // Same boundary as a Claude turn (see runtime/agent-env-policy.ts).
            env: applyClaudeRequiredPromptEnv(filterAgentRuntimeBaseEnv(process.env, { runtimeProviderId: "claude" })),
            ...(options.pathToClaudeCodeExecutable
              ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
              : {}),
            // `tools` is what removes every other tool (Bash included) from the
            // model; `allowedTools` only auto-approves. `dontAsk` denies what is
            // not pre-approved, so nothing is waved through by bypassPermissions.
            tools: [...MEMORY_AGENT_TOOLS],
            allowedTools: [...MEMORY_AGENT_TOOLS],
            permissionMode: "dontAsk",
            // Do not load the daemon user's ~/.claude/settings.json or the agent
            // cwd's .claude/settings.json (hooks, MCP servers, plugins).
            settingSources: [],
            stderr: (data: string) => {
              const text = data.trim();
              if (text) log.warn("Memory agent stderr", { sessionId, stderr: text.slice(0, 2000) });
            },
            hooks: {
              PreToolUse: [{ hooks: [fileAccessHook] }],
            },
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: `Você é um gerenciador de memórias. Você tem acesso a:
- ${transcriptTmpPath} — transcript da conversa (SOMENTE LEITURA)
- ${memoryPath} — índice principal de memórias (leitura e escrita, MANTER CURTO <100 linhas)
- ${memoryDir}/ — pasta com arquivos detalhados por data (leitura e escrita)

ESTRUTURA:
- MEMORY.md = índice enxuto: regras de operação, padrões técnicos, contexto de negócio, tabela-diário com tópicos + links
- memory/YYYY-MM-DD.md = descrição fiel do dia: features, bugs, decisões, lições. Serve como índice detalhado pra saber onde buscar

REGRAS:
- Leia o transcript COMPLETO, seção por seção (500 linhas por vez)
- NUNCA apague memórias antigas — elas são valiosas
- Detalhes extensos vão no arquivo por data, NÃO no MEMORY.md
- MEMORY.md deve ter apenas informações de referência rápida e a tabela-diário
- Pode REORGANIZAR ou CONSOLIDAR se fizer sentido, mas sem perder informação
- Se uma memória nova contradiz uma antiga, mantenha ambas com contexto`,
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
          rmSync(transcriptTmpDir, { recursive: true, force: true });
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

/** The only tools the memory agent has. Everything else is removed, not just unapproved. */
export const MEMORY_AGENT_TOOLS = ["Read", "Edit", "Write"] as const;

export interface MemoryAgentToolGuardPaths {
  agentCwd: string;
  memoryPath: string;
  memoryDir: string;
  transcriptPath: string;
}

type MemoryAgentGuardOutput = {
  decision: "approve" | "block";
  reason?: string;
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
  };
};

/**
 * PreToolUse guard for the memory agent. It reads the SDK's shape
 * (`tool_name` + nested `tool_input`) and denies by default:
 * - any tool outside Read/Edit/Write;
 * - a missing or non-string `file_path`;
 * - a write (Edit/Write) outside MEMORY.md and memory/;
 * - a read outside the agent cwd and the transcript copy.
 * Paths are resolved through symlinks, so a link inside the cwd cannot reach out.
 */
export function createMemoryAgentToolGuard(paths: MemoryAgentToolGuardPaths) {
  const root = (path: string) => canonicalPath(path) ?? resolve(path);
  const cwd = root(paths.agentCwd);
  const memoryPath = root(paths.memoryPath);
  const memoryDir = root(paths.memoryDir);
  const transcriptPath = root(paths.transcriptPath);
  const allowedTools: readonly string[] = MEMORY_AGENT_TOOLS;

  const approve = (): MemoryAgentGuardOutput => ({
    decision: "approve",
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  });
  const block = (reason: string): MemoryAgentGuardOutput => ({
    decision: "block",
    reason,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });

  return async (hookInput: HookInput): Promise<MemoryAgentGuardOutput> => {
    // Only PreToolUse carries these fields; anything else has no tool and is denied below.
    const input = hookInput as { tool_name?: unknown; tool_input?: unknown };
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    if (!allowedTools.includes(toolName)) {
      log.warn("Memory agent tried to use a tool outside Read/Edit/Write", { tool: toolName || "(none)" });
      return block(`Ferramenta não permitida: ${toolName || "(desconhecida)"}. Apenas Read, Edit e Write.`);
    }

    const toolInput =
      input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    const rawPath = toolInput.file_path;
    if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
      return block("file_path ausente ou inválido.");
    }
    const target = canonicalPath(resolve(paths.agentCwd, rawPath));
    if (target === null) return block("Caminho não verificável.");

    const inMemory = target === memoryPath || target.startsWith(memoryDir + sep);
    if (toolName === "Read") {
      const inCwd = target === cwd || target.startsWith(cwd + sep);
      if (inMemory || inCwd || target === transcriptPath) return approve();
      log.warn("Memory agent tried to read outside allowed paths", { attempted: target });
      return block(`Leitura permitida em: ${cwd}/ e ${transcriptPath}.`);
    }

    if (inMemory) return approve();
    log.warn("Memory agent tried to write unauthorized file", { attempted: target });
    return block(`Escrita permitida apenas em: ${memoryPath} e ${memoryDir}/`);
  };
}

/**
 * realpath of the deepest existing ancestor + the not-yet-existing tail, so symlinks cannot hide an escape.
 * Null when the path cannot be verified (a loop, no permission): the guard blocks it.
 */
function canonicalPath(path: string): string | null {
  const absolute = resolve(path);
  let existing = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        log.warn("Memory agent path could not be verified", { path: absolute, code });
        return null;
      }
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
}

/**
 * The transcript copy the memory extractor reads holds the whole conversation,
 * so it goes in a fresh 0700 directory as a 0600 file created exclusively,
 * never as a umask-default file in the shared tmpdir.
 */
export function writePrivateTranscriptCopy(sessionId: string, content: string): { dir: string; path: string } {
  const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9_:-]/g, "_");
  const dir = mkdtempSync(join(tmpdir(), "ravi-memory-"));
  const path = join(dir, `${sanitizedSessionId}.md`);
  try {
    writeFileSync(path, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, path };
}
