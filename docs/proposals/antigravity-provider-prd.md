# Antigravity Runtime Provider — PRD técnico v0.1

**Status:** Proposta · **Owner:** dev-do-ravi · **Data:** 2026-05-28 · **Provider id:** `antigravity` · **Binário:** `agy`

## Histórico

- **v0.1** (2026-05-28 10:40) — primeira versão, sem spike empírico ainda

---

## 1. Resumo executivo

Adicionar um quarto runtime provider ao Ravi (`antigravity`) que delega execução de agente pro **Antigravity CLI** (`agy`) — substituto oficial do Gemini CLI lançado pelo Google em 19/05/2026 (Antigravity 2.0 GA). Permite agentes Ravi rodarem com modelos Gemini (gemini-3.5-pro, gemini-3.5-flash) e Claude via backend Antigravity, sem proxy reverse-engineered.

**Padrão de implementação:** clone de `src/runtime/codex-provider.ts` — mesma técnica (spawn de CLI externa + parser de stream-json).

**Esforço estimado:** 10-16h (1-2 dias). Spike empírico de 1-2h obrigatório antes do dev real.

---

## 2. Motivação

🔹 **Gemini CLI foi deprecada oficialmente** em favor do Antigravity CLI (Google Developers Blog 19/05/2026)
🔹 **Antigravity 2.0 inclui CLI nativo** (`agy`, built in Go) — não é mais só desktop IDE
🔹 **Mesmo backend** que Antigravity 2.0 desktop app — modelos gerenciados pelo Google
🔹 **Ravi hoje só suporta** `claude` (Anthropic), `codex` (OpenAI), `pi` (Inflection). Falta player Google
🔹 **Cliente pode escolher provider por agent** (`agentConfig.runtimeProvider`) — fleet pode ter agentes Ravi com Claude + agentes com Gemini lado a lado

---

## 3. Escopo

### Incluído

✅ `src/runtime/antigravity-provider.ts` — implementa `SessionRuntimeProvider`
✅ Registro em `src/runtime/provider-registry.ts` como built-in
✅ Atualização do tipo `RuntimeProviderId` (union) em `src/runtime/types.ts`
✅ Parser de `stream-json` do `agy` → `RuntimeEvent`
✅ Auth flow (OAuth headless / SSH + one-time code)
✅ Capabilities map (modelos disponíveis, tool-use, thinking)
✅ Testes unit (fixtures de stream) + live (com auth real)
✅ Skill `ravi-system:antigravity-provider` ensinando uso
✅ ADR formal no vault `area/ravi-dev/adr/`

### Não incluído (Sprint futuro)

❌ Gemini CLI legacy provider (`gemini-provider`) — Google deprecou, redundante
❌ Antigravity Desktop App integration (IDE, não CLI)
❌ Custom auth provider para enterprise (`gcli-migration` doc) — sai pra Sprint dedicado de enterprise
❌ Multi-agent subagent orchestration nativo do agy — Ravi já orquestra via `ravi tasks`

---

## 4. Arquitetura

### Contrato `RuntimeProvider` (lido de `src/runtime/types.ts`)

```ts
interface RuntimeProvider {
  id: RuntimeProviderId;                                    // "antigravity"
  getCapabilities(): RuntimeCapabilities;                   // modelos, tool-use, etc
  prepareSession?(input): RuntimePrepareSessionResult;      // setup auth/env
}

interface SessionRuntimeProvider extends RuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}
```

### Padrão de referência

`src/runtime/codex-provider.ts` — provider que faz spawn de CLI externa (codex) + parser de stream. Mesma estrutura serve pro `agy`.

### Fluxo runtime

```
Ravi runtime
   │
   │ startSession({ agent, prompt, sessionCwd, ... })
   ▼
antigravity-provider
   │
   │ spawn `agy -p "<prompt>" -o stream-json [--model gemini-3.5-pro]`
   ▼
agy process (background)
   │
   │ stdout: { "type": "message", "content": "...", "model": "...", ... }
   │ stdout: { "type": "tool_call", "name": "shell", "args": {...} }
   │ stdout: { "type": "result", "tokens": {...}, "duration_ms": ... }
   ▼
parser
   │
   │ → RuntimeEvent { kind: "message" | "tool_call" | "result", ... }
   ▼
RuntimeSessionHandle (consumido pelo host-event-loop)
```

---

## 5. Capabilities do `agy` (baseado em docs públicas e third-party)

### Flags relevantes

| Flag | Função |
|---|---|
| `-p`, `--print "<prompt>"` | Single prompt non-interactive (igual `gemini -p`) |
| `-o`, `--output-format text\|json\|stream-json` | Saída estruturada |
| `--model <model-id>` | Override de modelo (gemini-3.5-pro, gemini-3.5-flash, claude-sonnet-4-6, claude-opus-4-6-thinking) |
| `--auth-headless` | Forces OAuth flow com URL + código (SSH/CI) |

### Modelos expostos

🔹 **Gemini** — gemini-3.5-pro, gemini-3.5-flash (e variantes -low/-high)
🔹 **Claude** — claude-sonnet-4-6, claude-opus-4-6-thinking (via Antigravity backend Google)

⚠️ **Caveat:** modelos Claude via Antigravity ≠ Claude API direto. Custom routing pode adicionar latência. Spike vai validar.

### Tool-use

🔹 MCP (Model Context Protocol) nativo
🔹 Built-in tools: shell, filesystem, web fetch
🔹 Multi-agent subagents (assíncronos)

### Auth

🔹 **OAuth Google** (60 req/min, 1k/dia free) — primário
🔹 **Headless mode**: detecta SSH/CI, gera URL + one-time code
🔹 **API key** (não confirmado se `agy` aceita igual `gemini`)
🔹 **Vertex AI** (enterprise)

### Multi-turn

🔹 Conversation checkpointing (sessão persistente)
🔹 `--print` gera per-conversation ID (issue #7 do `google-antigravity/antigravity-cli`)

---

## 6. Mapeamento `agy` stream-json → `RuntimeEvent`

⚠️ **Especulativo até spike validar formato real do JSON.**

Hipótese (baseada em padrão Gemini CLI / OpenAI Codex):

| Tipo agy | RuntimeEvent.kind | Campos mapeados |
|---|---|---|
| `{"type":"message", "content":"..."}` | `message` | text, model |
| `{"type":"tool_call", "name":"...", "args":{...}}` | `tool-use` | name, input |
| `{"type":"tool_result", "result":{...}}` | `tool-result` | output |
| `{"type":"thinking", "content":"..."}` | `thinking` (se RuntimeEvent suportar) | text |
| `{"type":"result", "usage":{...}, "duration_ms":...}` | `done` | tokens, costUsd, durationMs |
| `{"type":"error", "message":"..."}` | `error` | message, code |

**Spike vai capturar formato real e ajustar.**

---

## 7. Auth & segurança

### Auth flow

1. Primeira invocação: `agy` detecta ausência de auth → roda OAuth flow
2. Se SSH/headless: imprime URL + one-time code no stdout
3. Token persiste em `~/.config/antigravity/` (default agy)
4. Renovação automática pelo `agy` (Ravi não gerencia tokens)

### Considerações de segurança

🔹 **REBAC**: agentes Ravi com `runtimeProvider: "antigravity"` requerem permission `runtime.antigravity.use` (a criar)
🔹 **Sandbox**: `agy` usa próprio sandbox built-in pra shell tools. Ravi mantém skill-gates separados
🔹 **Audit**: cada invocação loga em `cost_events` (já existe na infra) — model, tokens, custo
🔹 **Data flow**: prompt → agy local → Google backend → modelo. Mesma surface de risco que `codex` (também sai do laptop)

---

## 8. Plano de implementação (10-16h)

### Fase 0 — Spike empírico (1-2h, OBRIGATÓRIO)

🔹 Instalar `agy`: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (requer autorização RM)
🔹 Rodar 5 prompts diversos:
  1. Texto simples ("explique X em 3 frases")
  2. Tool-use (pedir leitura de arquivo)
  3. Multi-turn (--print com session resume)
  4. Erro intencional (modelo inválido)
  5. Thinking/reasoning (claude-opus-4-6-thinking)
🔹 Capturar payloads stream-json reais em `spike/runtime/antigravity-payloads.jsonl`
🔹 Documentar diferenças vs hipótese §6
🔹 Estimar esforço final (se parser complexo, +4-8h)

### Fase 1 — Provider core (6h)

🔹 `src/runtime/antigravity-provider.ts` (~400 linhas, clone codex-provider)
🔹 `src/runtime/antigravity-transport.ts` (spawn + IPC, paralelo a `codex-transport.ts`)
🔹 Update `src/runtime/provider-registry.ts`:
  ```ts
  import { createAntigravityRuntimeProvider } from "./antigravity-provider.js";
  // ...
  runtimeProviderFactories.set("antigravity", createAntigravityRuntimeProvider);
  builtInRuntimeProviderIds.add("antigravity");
  ```
🔹 Update `src/runtime/types.ts`: adicionar `"antigravity"` ao `RuntimeProviderId` union

### Fase 2 — Testes (3h)

🔹 `antigravity-provider.test.ts` — unit com fixtures de `spike/runtime/antigravity-payloads.jsonl`
🔹 `antigravity-provider.live.test.ts` — live com `RAVI_LIVE_TESTS=1` (requer `agy` instalado + auth)
🔹 Adicionar `src/runtime/antigravity-provider.test.ts` no `package.json` test chain

### Fase 3 — Skill + ADR (2h)

🔹 `src/plugins/internal/ravi-system/skills/antigravity-provider/SKILL.md`
🔹 ADR no vault `area/ravi-dev/adr/2026-05-28-antigravity-provider.md`
🔹 Update `docs/proposals/antigravity-provider-prd.md` v0.2 com findings

### Fase 4 — PR + review (~3h)

🔹 PR draft cross-fork `filipexyz/ravi`
🔹 Task `code-reviewer` com profile default
🔹 Iteração até aprovado

---

## 9. Testes

### Unit (fixtures stream-json)

🔹 Mensagem texto simples
🔹 Tool-use (shell, filesystem, web)
🔹 Thinking blocks
🔹 Error responses (auth fail, model invalid, rate limit)
🔹 Multi-turn resume
🔹 Token usage / cost

### Live (com `agy` instalado)

🔹 Round-trip completo: prompt → resposta texto
🔹 Tool-use real (ler arquivo, rodar shell command)
🔹 Switch model entre invocações (gemini-pro vs claude-sonnet)
🔹 Auth headless flow (validar URL+code path)

### Smoke E2E

🔹 Criar agente Ravi com `runtimeProvider: "antigravity"`
🔹 Despachar task via `ravi tasks create --agent <agente>`
🔹 Confirmar execução E2E + cost_events registrado

---

## 10. Riscos

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Stream-json do `agy` diverge MUITO da hipótese §6 | M | A | Spike Fase 0 valida antes do dev real |
| `agy` é jovem (1.0.2, 9 dias após GA), edge cases não conhecidos | A | M | Esperar 30 dias + monitorar Issues do repo upstream |
| Auth OAuth quebra em CI/headless | M | A | Doc do `agy` cobre auth headless explicitamente |
| Modelos Claude via Antigravity backend ≠ Claude API direto (latência/qualidade) | B | M | Live test com 10 prompts compara qualidade |
| Google muda flags/output do `agy` sem aviso | M | A | Pin major version no installer + monitor changelog |
| Latência alta vs codex (agy é Go binary, JSON parser mais pesado) | B | B | Stress test 100 prompts comparando vs codex |
| Rate limit OAuth (60 req/min free) limita uso em high-throughput | B | M | Documentar limite + sugerir API key (1k/dia) ou Vertex AI |

---

## 11. Decisões pendentes (RM)

- **D1.** Spike Fase 0 — autorizar instalar `agy` agora? (curl install.sh)
- **D2.** Modelo default do provider — gemini-3.5-pro OU claude-sonnet-4-6 (via Antigravity)?
- **D3.** Auth mode default — OAuth Google OU API key (se `agy` aceitar)?
- **D4.** Prioridade — Sprint 3 (após Tiny adapter) OU paralelo ao Sprint 2 catalog?
- **D5.** Manter `pi-provider` ou sunset (já que Antigravity cobre Gemini)?

---

## 12. Métricas de aceite

### MVP

🔹 Provider registra em `provider-registry.ts` e aparece em `listRegisteredRuntimeProviderIds()`
🔹 Agente Ravi com `runtimeProvider: "antigravity"` executa prompt simples sem erro
🔹 Stream-json parser cobre ≥95% dos eventos reais capturados no spike (≥5 prompts diversos)
🔹 Latência média <30s pra prompt simples (gemini-3.5-flash)
🔹 Tool-use round-trip funciona (shell + filesystem)
🔹 `cost_events` registra tokens + custo

### 30 dias produção (após merge)

🔹 ≥3 agentes Ravi usando `antigravity` provider
🔹 0 incidentes de auth quebrada em runtime
🔹 Latência média <50s p99
🔹 Custo médio comparable a `claude` provider (±20%)

---

## 13. Status atual

🔹 **Fase 0 (spike)**: aguardando autorização RM
🔹 **Fases 1-4**: bloqueadas pelo spike
🔹 **Total entregue até agora**: este PRD v0.1

---

## 14. Referências

🔹 [TechCrunch Antigravity 2.0 launch 2026-05-19](https://techcrunch.com/2026/05/19/google-launches-antigravity-2-0-with-an-updated-desktop-app-and-cli-tool-at-io-2026/)
🔹 [Google Developers Blog — Transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
🔹 [Antigravity CLI Deep Dive — agentpedia.codes](https://agentpedia.codes/blog/antigravity-cli-deep-dive)
🔹 [Antigravity CLI Tutorial — Google Cloud Community](https://medium.com/google-cloud/antigravity-cli-tutorial-series-12b46cfe3bf2)
🔹 [DataCamp Antigravity CLI: Orchestrating Parallel AI Agents](https://www.datacamp.com/tutorial/antigravity-cli)
🔹 [DEV.to Antigravity CLI hands-on](https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7)
🔹 [Discussion #27274 Gemini CLI → Antigravity CLI transition](https://github.com/google-gemini/gemini-cli/discussions/27274)
🔹 Padrão Ravi interno: `src/runtime/codex-provider.ts`, `src/runtime/provider-registry.ts`, `src/runtime/types.ts`
