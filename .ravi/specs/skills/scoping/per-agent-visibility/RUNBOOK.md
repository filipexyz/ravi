# Per-Agent Skill Visibility + Least-Privilege Default / RUNBOOK

Procedimento operacional de deploy, verificação e rollback. Validado em produção 2026-07-03.

## Componentes

1. **Mecanismo (PR #157):** `resolveAgentSkills(agentId)` (núcleo agnóstico) → allowlist por agente → `Options.skills` (enforcement Claude). `withLocalSkillsPreserved` mantém as skills locais do agente.
2. **Least-privilege default:** `runtime-bootstrap-provider.ts` dá a agente novo só `BASELINE_COMMAND_GROUPS` (sessions/tasks/specs/skills + self/doctor) em vez de `execute:group:*`. Domínio/admin é opt-in.

## Pré-deploy — checagens de segurança (todas passaram 2026-07-03)

- `bun run typecheck` limpo · `bun test` (feature + permissions) verde · `bun run build` OK.
- **Órfãos:** 0 de 84 agentes ficariam sem acesso (todos têm admin OU `execute:group:*` explícito). Script: materializar caps de cada agente, checar `admin:system:*` OU `execute:group:*`.
- **Automações:** 26 crons + 47 triggers — todo executor é agente seguro; 4 triggers sem dono são os "hello" de teste, DESLIGADOS.
- **Código assumindo coringa:** varredura `grep 'objectId: "\*"'` — só concessões/gate, nenhum helper que quebra.

## Deploy

O daemon de produção roda de `ravi-src-dev/dist/bundle/index.js` (pm2 `ravi`). Deploy = build + restart:

```bash
cd /home/ravi/ravi-src-dev
git checkout feat/least-privilege-agent-defaults
bun run build
# reinício SEGURO (health-check + auto-rollback pra dev):
setsid nohup bash /tmp/safe-restart.sh >/dev/null 2>&1 < /dev/null &
```

O restart interrompe todas as sessões por ~10-40s (inclui a sessão `main`). HITL: exige "sim" explícito do RM.

## Verificação pós-deploy

```bash
pm2 jlist   # ravi online, restart +1, sem crash-loop
pm2 logs ravi --err --lines 40 --nostream   # zero exceptions
pm2 logs ravi --lines 200 --nostream | grep -ic "permission denied"   # esperado 0
```

**Teste E2E (agente limitado, turno real):**

```bash
R="bun dist/bundle/index.js"
$R agents create canary /tmp/canary --provider claude --model claude-sonnet-4-6
$R permissions allow canary-cron --capabilities execute:group:cron --to agent:canary --apply
$R skills inspect canary --json   # esperado: 5 skills (kit-4 + cron), hasConfiguration=true, NAO admin
$R sessions send canary-test "Liste as skills disponiveis pra voce." --agent canary
$R sessions read canary-test    # esperado: so cron/sessions/skills/specs/tasks — NAO whatsapp/image/crm
```

Resultado 2026-07-03: agente limitado listou só as 5 skills permitidas. Filtro confirmado ponta a ponta.

> Nota: agente novo nasce no provider `codex` (default global) → turno falha 401 sem credencial OpenAI. Para o teste, criar com `--provider claude`. Default codex é config separada a revisar.

## Rollback

Automático via `/tmp/safe-restart.sh` se o daemon não voltar saudável. Manual:

```bash
cd /home/ravi/ravi-src-dev
git checkout dev && bun run build && pm2 restart ravi
```

Rede de segurança do desenho (Invariant F): allowlist ausente/vazia = comportamento atual (todas as skills). Pior caso = "sem filtro", não "agentes quebrados". Agentes existentes (admin/coringa) são inertes à mudança.
