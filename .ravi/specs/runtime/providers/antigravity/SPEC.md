---
id: runtime/providers/antigravity
title: "Antigravity Runtime Provider (agy CLI)"
kind: feature
domain: runtime
capabilities:
  - providers
  - antigravity
  - rpc
  - runtime-control
tags:
  - runtime-provider
  - google
  - gemini
  - claude-via-antigravity
applies_to:
  - src/runtime/antigravity-provider.ts
  - src/runtime/antigravity-transport.ts
  - src/runtime/provider-registry.ts
  - src/runtime/types.ts
  - src/runtime/provider-contract.test.ts
owners:
  - dev-do-ravi
status: draft
normative: true
---

# Antigravity Runtime Provider (agy CLI)

**See:** `docs/proposals/antigravity-provider-prd.md` (PRD v0.1 humano-legível, 14 seções)

## Intent

Adicionar 4º runtime provider ao Ravi (`antigravity`) que delega execução a `agy` CLI (Google, lançado 19/05/2026, GA 1.0.2). Substitui Gemini CLI deprecada. Permite agentes Ravi rodarem com modelos Gemini (gemini-3.5-pro/flash) e Claude via backend Antigravity, sem proxy reverse-engineered.

## Invariants

- **Provider id:** `"antigravity"` (string canônica em `RuntimeProviderId` union)
- **Binário:** `agy` (não "antigravity"). Localização: `~/.local/bin/agy` (Unix) ou `%LOCALAPPDATA%\Antigravity\` (Windows). Provider deve detectar via `which agy` + fallback nos paths conhecidos
- **Padrão de implementação:** spawn de CLI externa + parser de stream-json. Clone estrutural de `src/runtime/codex-provider.ts`
- **Built-in:** registrar em `runtimeProviderFactories` E adicionar a `builtInRuntimeProviderIds` em `provider-registry.ts` (não removível via `unregisterRuntimeProvider`)
- **Flags canônicas pra invocação:**
  - `agy -p "<prompt>"` ou `--print` — single-prompt non-interactive
  - `-o stream-json` — saída newline-delimited JSON
  - `--model <id>` — override de modelo
- **Auth headless obrigatório**: provider deve passar flag pra forçar fluxo OAuth com URL + one-time code quando detectar SSH/CI
- **Cost tracking obrigatório**: cada invocação grava em `cost_events` (provider, model, input_tokens, output_tokens, total_tokens, cost_usd)
- **Contract test**: provider deve passar `src/runtime/provider-contract.test.ts` (compartilhado com claude/codex/pi)
- **Spike empírico Fase 0 OBRIGATÓRIO** antes de codar provider: rodar 5 prompts diversos via `agy -p ... -o stream-json` e capturar payloads em `spike/runtime/antigravity-payloads.jsonl`. Sem o spike, hipótese §6 do PRD é especulação

## Validation

```bash
# Fase 0 — spike empírico (1-2h, OBRIGATÓRIO)
which agy                                          # binary detection
agy -p "diga oi" -o stream-json                    # smoke
agy -p "leia /tmp/teste.txt" -o stream-json        # tool-use
agy -p "explique X" -o stream-json --model gemini-3.5-flash

# Fase 1-4 — pós spike
bun test src/runtime/antigravity-provider.test.ts  # unit (fixtures)
RAVI_LIVE_TESTS=1 bun test src/runtime/antigravity-provider.live.test.ts  # live
bun test src/runtime/provider-contract.test.ts    # contract compartilhado
ravi tasks create --agent <agente-com-antigravity> --profile default "smoke"  # E2E
```

## Known Failure Modes

- **`agy` é jovem (1.0.2, GA em 19/05/2026)**: edge cases conhecidos limitados. Esperar 30 dias + monitorar issues de `google-antigravity/antigravity-cli` antes de prod
- **Stream-json pode divergir da hipótese §6 do PRD** — sem spike empírico Fase 0, parser será especulativo e quebra cedo. NUNCA pular spike
- **OAuth quebra em CI/headless sem flag específica** — provider deve detectar SSH/CI e forçar fluxo correto. Falha silenciosa = sessão pendurada
- **Modelos Claude via Antigravity backend ≠ Claude API direto** — latência/qualidade podem divergir do `claude-provider`. Documentar no spec e nas capabilities
- **Rate limit OAuth (60 req/min free, 1k/dia)** — provider deve mapear erro 429 e expor backoff
- **Reverse-engineered proxies estão sendo banidos pelo Google (ToS violation)** — NUNCA implementar provider que use endpoint não-oficial. Sempre via binário `agy` oficial
- **Versionamento**: Google pode mudar flags/output do `agy` sem aviso. Provider deve declarar versão mínima testada e checar `agy --version` no `prepareSession`
- **Sunset de `gemini-provider` standalone**: já que Gemini CLI foi oficialmente deprecada, NÃO implementar `gemini-provider` separado. Antigravity cobre.
