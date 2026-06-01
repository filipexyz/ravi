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
  - src/runtime/provider-registry.ts
  - src/runtime/types.ts
  - src/runtime/provider-contract.test.ts
owners:
  - dev-do-ravi
status: merged
normative: true
---

# Antigravity Runtime Provider (agy CLI)

**See:** `docs/proposals/antigravity-provider-prd.md` (PRD v0.2 humano-legível, spike findings + implementation summary)

## Intent

Adicionar 4º runtime provider ao Ravi (`antigravity`) que delega execução a `agy` CLI (Google, lançado 19/05/2026, GA 1.0.2). Substitui Gemini CLI deprecada. Permite agentes Ravi rodarem com modelos Gemini (gemini-3.5-pro/flash) e Claude via backend Antigravity, sem proxy reverse-engineered.

## Invariants

### Implementado (v0.2, Option B)

- **Provider id:** `"antigravity"` (string canônica em `RuntimeProviderId` union)
- **Binário:** `agy` (não "antigravity"). Localização: `~/.local/bin/agy` (Unix). Provider detecta via `existsSync(join(homedir(), ".local", "bin", "agy"))` + fallback `isCommandInPath()`
- **Padrão de implementação:** spawn de CLI externa + captura texto plano. Clone estrutural inspirado em `src/runtime/codex-provider.ts`
- **Built-in:** registrado em `runtimeProviderFactories` + `builtInRuntimeProviderIds` em `provider-registry.ts` ✅
- **Flags de invocação (implementado):**
  - `agy -p "<prompt>"` — single-prompt non-interactive ✅
  - `--print-timeout 60s` — tentativa para estender timeout OAuth (limitado a 30s internamente) ✅
  - `AGY_NON_INTERACTIVE=1` — env var para headless mode ✅
- **Output:** Texto plano (stdout + stderr fallback). Nenhuma estrutura JSON esperada.
- **Contract test:** passa `src/runtime/provider-contract.test.ts` ✅
- **Cost tracking:** hardcoded como 0 (não disponível de `agy` text output). Deferred para Sprint 3+ se agy expõe API key ou --output-format

### Deferred (Sprint 3+)

- **Stream-json parsing:** agy 1.0.3 não expõe flag `--output-format stream-json`. Blocado por feature request google-antigravity/antigravity-cli#XX. PRD v0.2 §13 documenta spike findings.
- **Auth via API key:** Feature request #78. Quando disponível, permite headless em CI sem 30s timeout OAuth
- **Cost tracking real:** Requer stream-json ou API key suporte
- **Session resume:** Não documentado em agy 1.0.3

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

### Bloqueadores (Spike Fase 0 validado 2026-05-28)

- **OAuth 30s timeout hardcoded em agy 1.0.3**: não é extensível via `--print-timeout` (RM tentou, expirou código). Bloqueia headless flow em prod. **Mitigação:** Option B (text-only) dispensa JSON parsing, funciona via manual code paste em dev. Produção require API key support (feature request #78) ou esperar agy 1.0.4+.
- **Stream-json flag não existe**: `--output-format stream-json` não implementado em agy 1.0.3 (contrário a artigos terceirizados aspiracionais). Spike provou via `agy -p "test" -o stream-json` → erro "unknown flag". **Mitigação:** Option B ignora. Futuro: esperar Google implementar ou use alternative (jq parse stdout).
- **API key não funciona**: `ANTIGRAVITY_API_KEY` / `GEMINI_API_KEY` são feature requests apenas (issue #78). Bloqueia headless CI. **Mitigação:** Option B manual para dev, Sprint 3+ retoma com API key.

### Operacionais

- **`agy` é jovem (1.0.3, GA em 19/05/2026)**: edge cases esperados. Monitorar google-antigravity/antigravity-cli para 30 dias antes de classificar produção-ready
- **Modelos Claude via Antigravity backend ≠ Claude API direto** — latência/qualidade podem divergir. Documentado nas capabilities (usage.semantics = "unavailable")
- **Rate limit OAuth (60 req/min free, 1k/dia)** — manual mode + Sprint 3+ API key mode quando avail
- **Reverse-engineered proxies sendo banidos pelo Google** — usando `agy` oficial, não proxy (ToS compliant)
- **Versionamento**: Google pode mudar flags/output. Provider hardcoda agy binary path + testado contra agy 1.0.3
