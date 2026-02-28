# Plano: Multi-Ravi com JetStream Session Routing

**Objetivo:** Permitir múltiplos daemons Ravi em VMs diferentes, todos conectados ao mesmo omni central via Tailscale, sem duplicação de sessões, respostas ou side effects.

**Filosofia:** máxima eficiência, sem gambiarras. Resolver o problema na raiz.

---

## Diagnóstico

O problema central está em dois pontos do código:

**1. `bot.ts:717` — subscribeToPrompts**
```typescript
for await (const event of nats.subscribe("ravi.session.*.prompt")) {
```
NATS core pub/sub: **todos os daemons recebem todos os prompts**. Se dois daemons estão rodando, ambos criam `StreamingSession` para a mesma sessão. Dois agentes rodando em paralelo, duas respostas emitidas.

**2. `gateway.ts:130` — subscribeToResponses**
```typescript
this.subscribe("responses", ["ravi.session.*.response"], ...)
```
Mesmo problema invertido: mesmo que só um daemon tenha processado o prompt, ambos os gateways recebem o response e tentam enviar via omni. Usuário recebe mensagem duplicada.

**Raiz:** o Ravi usa NATS core (pub/sub) onde deveria usar JetStream (work queue).

---

## Solução

### Parte 1 — SESSION_PROMPTS stream (elimina sessões duplicadas)

Criar um JetStream stream `SESSION_PROMPTS` com `WorkQueuePolicy`. Cada mensagem é entregue a exatamente um daemon, deletada após ack. Qualquer daemon pode processar qualquer prompt — NATS decide quem, de forma atômica.

**Mudanças:**

**`src/omni/consumer.ts`** — nos dois pontos onde emite prompts (linhas 507 e 558):
```typescript
// Antes:
await nats.emit(`ravi.session.${sessionName}.prompt`, { ... });

// Depois:
const js = getNats().jetstream();
await js.publish(`ravi.session.${sessionName}.prompt`, sc.encode(JSON.stringify({ ... })));
```

**`src/bot.ts:710` — subscribeToPrompts**:
```typescript
// Antes: nats.subscribe("ravi.session.*.prompt")
// Depois: JetStream durable consumer no stream SESSION_PROMPTS
```

Trocar o `for await (nats.subscribe(...))` por um `consumeLoop` idêntico ao do `OmniConsumer` — durable consumer nomeado `ravi-prompts`, filter `ravi.session.*.prompt`, ack explícito após `handlePrompt` completar (não fire-and-forget — ack só depois do turn).

**`src/daemon.ts`** — criar o stream na inicialização:
```typescript
await ensureSessionPromptsStream(nc);
// Stream: SESSION_PROMPTS, subjects: ["ravi.session.*.prompt"], WorkQueuePolicy
```

---

### Parte 2 — Queue groups no Gateway (elimina respostas duplicadas)

O response é emitido pelo daemon que processou o prompt. Qualquer gateway pode enviá-lo — omni é HTTP stateless. Então basta garantir que só um gateway por grupo processa cada response.

NATS core tem queue groups nativos: `conn.subscribe(subject, { queue: "grupo" })`. Todos os daemons no mesmo queue group competem; cada mensagem vai para um só.

**Mudança em `src/nats.ts`** — adicionar suporte opcional a queue group:
```typescript
export async function* subscribe(
  ...patterns: string[]
  // ou: (patterns: string[], opts?: { queue?: string })
)
```

Refatorar a assinatura para aceitar opções:
```typescript
export async function* subscribe(
  patterns: string | string[],
  opts?: { queue?: string }
): AsyncGenerator<...>
```

**Mudança em `src/gateway.ts`** — subscriptions que não devem duplicar:
```typescript
// subscribeToResponses — só um gateway envia por response
this.subscribe("responses", ["ravi.session.*.response"], handler, { queue: "ravi-gateway" });

// subscribeToDirectSend — só um gateway processa por deliver
this.subscribe("directSend", ["ravi.outbound.deliver"], handler, { queue: "ravi-gateway" });

// subscribeToReactions — só um gateway envia por reaction
this.subscribe("reactions", ["ravi.outbound.reaction"], handler, { queue: "ravi-gateway" });

// subscribeToMediaSend — só um gateway envia por media
this.subscribe("mediaSend", ["ravi.media.send"], handler, { queue: "ravi-gateway" });

// subscribeToClaudeEvents — typing indicator: OK ser fan-out (idempotente)
// subscribeToConfigChanges — fan-out intencional, não muda
```

**Ajuste no método `subscribe` do Gateway** para repassar o queue group para `nats.subscribe`.

---

### Parte 3 — Ack correto nos prompts (confiabilidade)

O `OmniConsumer` faz ack imediato + handler fire-and-forget (correto para inbound de mensagens — não queremos bloquear o stream se o agent demorar).

Para SESSION_PROMPTS o comportamento deve ser diferente: o ack deve sinalizar que **o daemon assumiu a sessão**, não que terminou de processar. Isso é suficiente — uma vez que um daemon faz ack, os outros não recebem mais a mensagem.

Portanto: **ack imediato após receber o prompt**, antes de chamar `handlePrompt`. Mesmo comportamento do OmniConsumer. Se o daemon cair no meio do turn, o prompt não é reentregue (já foi acked) — aceitável, pois o usuário pode reenviar. Essa trade-off simplifica muito a implementação.

Se quiser at-least-once com retry em crash: ack só após `handlePrompt` completar. Mais correto mas requer cuidado com o timeout de ack do JetStream (default 30s — pode estourar em turns longos). Configurar `ack_wait` alto (ex: 5min) nesse caso.

**Recomendação:** ack imediato. Turns longos não devem segurar o consumer.

---

### Parte 4 — Leader election para Runners (heartbeat/cron)

Heartbeat e cron usam `setInterval` local. Se dois daemons rodam, ambos disparam — duplicação.

Solução: **NATS KV store como distributed lock**.

```typescript
// src/leader/index.ts
const kv = await js.views.kv("ravi-leader");

async function tryAcquireLeadership(role: string, ttlSec: number): Promise<boolean> {
  try {
    await kv.create(`leader.${role}`, sc.encode(daemonId));
    return true;
  } catch {
    return false; // Key already exists — outro daemon é leader
  }
}

async function renewLeadership(role: string, ttlSec: number): Promise<boolean> {
  try {
    await kv.put(`leader.${role}`, sc.encode(daemonId)); // Renova TTL
    return true;
  } catch { return false; }
}
```

**`src/daemon.ts`** — antes de iniciar runners:
```typescript
const isLeader = await tryAcquireLeadership("runners", 30);
if (isLeader) {
  await startHeartbeatRunner();
  await startCronRunner();
  startLeadershipRenewal("runners", 30); // renova a cada 10s
} else {
  log.info("Not leader — skipping runners (another daemon is running them)");
  watchForLeadershipVacancy("runners", async () => {
    // Leader morreu — assumir
    await startHeartbeatRunner();
    await startCronRunner();
  });
}
```

KV entry com TTL: se o leader morre sem renovar, a chave expira. O próximo daemon que tentar `kv.create` ganha.

---

## Arquivos a modificar

| Arquivo | Mudança |
|---------|---------|
| `src/nats.ts` | Adicionar suporte a `queue` option no `subscribe()` |
| `src/bot.ts` | `subscribeToPrompts()` → JetStream consumer no stream `SESSION_PROMPTS` |
| `src/omni/consumer.ts` | `nats.emit("ravi.session.*.prompt")` → `js.publish()` |
| `src/gateway.ts` | Adicionar `queue: "ravi-gateway"` nas subscriptions relevantes; passar opts pro `subscribe()` helper |
| `src/daemon.ts` | `ensureSessionPromptsStream()` na init; leader election antes dos runners |
| `src/leader/index.ts` | **novo** — NATS KV leader election |

---

## Ordem de implementação

1. **`src/nats.ts`** — queue group support (fundação, não quebra nada)
2. **`src/gateway.ts`** — queue groups nas subscriptions (resolve duplicação de respostas, isolado)
3. **`src/bot.ts` + `src/omni/consumer.ts` + `src/daemon.ts`** — SESSION_PROMPTS stream (resolve duplicação de sessões, a mudança maior)
4. **`src/leader/index.ts` + `src/daemon.ts`** — leader election para runners

Cada etapa é deployável e testável independentemente.

---

## Configuração necessária por VM remota

Apenas duas env vars em `~/.ravi/.env`:
```bash
NATS_URL=nats://100.x.x.x:4222   # IP Tailscale do host omni
OMNI_API_URL=http://100.x.x.x:8882
OMNI_API_KEY=omni_sk_...
```

O NATS no host central precisa escutar em `0.0.0.0:4222` (não só localhost).

---

## O que NÃO muda

- SQLite permanece local em cada VM — cada daemon tem seu próprio `ravi.db` e `chat.db`
- `ravi.config.changed` permanece fan-out (correto — todos os daemons devem ter config atualizada)
- `ravi.inbound.reaction` e `ravi.inbound.reply` permanecem pub/sub (são resolvidos in-process pelo daemon que tem a `PendingApproval` — se outro daemon receber, `pendingApprovals.get()` retorna undefined e ignora)
- OmniConsumer inbound permanece como está — JetStream work queue já funciona

---

## Resultado final

```
VM1 (Ravi A)           VM2 (Ravi B)           omni host (Tailscale)
─────────────          ─────────────          ──────────────────────
OmniConsumer           OmniConsumer           NATS JetStream
  pulls MESSAGE ─────── pulls MESSAGE ──────▶  MESSAGE stream (WQ)
  publishes to ──────── publishes to ────────▶ SESSION_PROMPTS (WQ)

Bot consumes ──────────── Bot consumes ──────▶ SESSION_PROMPTS
  SESSION_PROMPTS           SESSION_PROMPTS      → 1 daemon por prompt

Gateway (queue group) ── Gateway (queue group) → ravi.session.*.response
  "ravi-gateway"            "ravi-gateway"        → 1 gateway envia

HeartbeatRunner ─ leader? ─────────────────────▶ NATS KV ravi-leader
CronRunner        leader?                         → só 1 daemon roda
```
