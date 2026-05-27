# Catalog Research — Mapa de CLIs

**Owner:** dev-do-ravi · **Task:** task-efca803d · **Data:** 2026-05-27 · **Consumer:** researcher (próxima task)

Mapa funcional dos comandos `ravi *` e `sde *` que respondem às 6 perguntas centrais sobre comportamento do cliente do setordaembalagem.com. Cada comando foi executado para confirmar formato real do output (zero chute).

---

## TL;DR pro researcher

**FONTE PRIMÁRIA: transcripts brutos do WhatsApp.** O processo de atendimento real (cliente perguntando, atendente respondendo) é o que mostra a árvore de decisão verdadeira. Análise pré-mastigada do CRM mostra OUTPUT (qual SKU comprou), não o PROCESSO (qual pergunta cliente fez, sequência, objeções).

**Use estas fontes nessa ordem:**

1️⃣ **`ravi chats messages <chatId>`** → transcript BRUTO do WhatsApp omni Ravi instância `sde`. Sample real funcionando:
```
- 27/05, 16:28 contact:a3337c2dde63: [image]
- 27/05, 16:28 contact:a3337c2dde63: 2 caixas
- 27/05, 16:28 contact:a3337c2dde63: Manda 3 caixas na vdd
```
Esse é o material primário. Listar via `ravi chats list --instance sde --limit N`.

2️⃣ **`sde gmail buscar "<termo>" --conta setor`** + **`sde gmail thread <id>`** → email de cotação bruto (B2B grande).

3️⃣ **`sde crm cliente-contexto --phone <num>`** → contexto AUXILIAR do cliente identificado no transcript (qual SKU já comprou, ticket médio, frequência). NÃO É fonte primária — só pra enriquecer entendimento após ler o transcript.

4️⃣ **`sde crm oportunidades-pendentes`** → 1961 oportunidades já preanalisadas por LLM. **Não usar como fonte primária** — viés do LLM que gerou. Usar SÓ pra validar agregados depois (cross-check).

---

## 1. Histórico WhatsApp Setor da Embalagem (omni Ravi)

| Pergunta | Comando | Output sample |
|---|---|---|
| Quais chats existem na instância sde? | `ravi chats list --instance sde --limit N` | `chat_9284f8859aec548c4a8de760 dm whatsapp/... title: status@broadcast messages: 16 participants: 13 last: 27/05, 17:49` |
| Ler mensagens de um chat | `ravi chats messages <chatId> --limit N` | (a confirmar formato com chat real) |
| Listar contatos descobertos | `ravi contacts list --limit N` | 17 contatos discovered. Ex: `Setor da Embalagem 📱 +55113772520636`, `Fukuoka Asian Food 📱 +55 (11) 98550-5414` |
| Mensagens atribuídas a contato | `ravi contacts messages <contactId>` | ⚠️ retorna vazio pra contatos `discovered` não-aprovados. Rodar `ravi contacts backfill` ou usar `ravi chats messages` |
| Timeline de eventos | `ravi contacts timeline <contactId>` | (a confirmar) |
| Atividade de sessão | `ravi contacts activity <contactId>` | (a confirmar) |
| Trace de sessão SQLite | `ravi sessions trace <sessionId>` | (a confirmar — útil pra debug) |

**Estado da instância omni `sde`:** `connected (Setor da Embalagem)`, intake=`discovered`, 17 contatos sem aprovação. **Mensagens chegam no chat.db**, mas atribuição a contatos canônicos exige backfill ou aprovação.

---

## 2. Pedidos / vendas recentes (Tiny ERP)

| Pergunta | Comando | Output sample |
|---|---|---|
| Pedidos por período | `sde tiny pedidos --data-inicial DD/MM/YYYY --data-final DD/MM/YYYY` | JSON paginado (3 páginas em ~30 dias). Cada pedido: `id, numero, data_pedido, nome cliente, valor, situacao` (ex: "Entregue", "Cancelado") |
| Detalhe de pedido | `sde tiny pedido <id>` | Itens com SKU+quantidade+preço (não verificado neste mapa, fluxo similar a `sde tiny produto`) |
| Estoque tempo-real | `sde tiny estoque <produtoId>` | `saldo: 40, saldoReservado: 38, depositos: [...]` ⭐ |
| Produto detalhe | `sde tiny produto <id>` | Schema completo (já demonstrado em `spike/catalog/ficha-g240.ts`) |
| Sync Tiny → Postgres replica | `sde sync` | (a investigar — para queries SQL ad-hoc no histórico) |

**Volume amostrado em maio 2026:** 50+ pedidos em 27 dias, situações mistas (Entregue, Cancelado, Em separação).

---

## 3. CRM oportunidades — ⭐ a fonte mais rica pro researcher

| Pergunta | Comando | Output sample |
|---|---|---|
| Oportunidades pendentes (1961 total) | `sde crm oportunidades-pendentes` | JSON com `opportunity_id, customer_id, scenario, suggested_message, reasoning, telefone, total_pedidos, ticket_medio, frequencia_compra_dias, dias_desde_ultima_compra` |
| Discovery diário | `sde crm oportunidades-descobrir` | Roda discovery do dia |
| Próxima candidata | `sde crm oportunidades-proxima` | Pega 1 não-processada |
| Conversa completa | `sde crm conversa <convId>` | Transcript analisado |
| Relatório agregado do dia | `sde crm relatorio-conversas [-d YYYY-MM-DD]` | Agregação diária |
| Pendentes de consolidação | `sde crm consolidar-pendentes` | conversations_daily → conversations |

**Exemplo real de scenario `timing_proativo`:**
```
"TIMING_PROATIVO: 3 pedidos consecutivos PP33S com volume crescente
 (2k->2k->4k), atraso 34d vs ciclo 25d (1.36x), conversa fev/2026
 positiva (testou, gostou, recomprou). Sem vendedor responsavel."
```

🎯 **Por que isso é ouro:** cada oportunidade já tem:
- **SKU efetivamente comprado** (PP33S no exemplo)
- **Padrão de volume** (2k→2k→4k crescente)
- **Frequência de recompra** (ciclo 25d)
- **Análise de conversa** já feita (testou/gostou/recomprou)
- **Ticket médio + total de pedidos**

Pro researcher minerar 1961 = amostra estatisticamente forte sem precisar ler transcripts cru.

---

## 4. Contexto rico de cliente individual

| Pergunta | Comando | Output sample |
|---|---|---|
| Cliente por telefone | `sde crm cliente-contexto --phone <num>` | Cliente + N pedidos + itens (SKU, qtd, valor unitário) + transportador + forma pagamento |
| Cliente por Tiny ID | `sde crm cliente-contexto <tinyId>` | Mesmo schema |

**Sample real (Bruno do Nascimento Silva, 4 pedidos):**
```json
{
  "cliente": {
    "tiny_id": "630035024", "nome": "Bruno do Nascimento silva",
    "telefone": "(11) 97364-9798", "email": "ACASADORISOTO@GMAIL.COM",
    "cidade": "SAO PAULO", "uf": "SP", "cpf_cnpj": "36.085.961/0001-93",
    "total_pedidos": 4
  },
  "pedidos": [
    { "numero": "22058", "data": "2026-05-18", "situacao": "Entregue",
      "valor": 806.7, "forma_pagamento": "link_pagamento",
      "itens_pedido": [
        { "codigo": "G330PR", "descricao": "Embalagem marmita 3 divisórias
          funda 1150mL 100un Galvanotek G330 - Preto",
          "quantidade": "3.000", "valor_unitario": "253.90" }
      ]
    },
    ...
  ]
}
```

🎯 **Conexão direta:** comprou `G330PR` (1150ml, 3 divisórias, preto) 3 caixas = 300un. Padrão: caldo de pizzaria buscando marmita robusta com divisória.

---

## 5. Email / cotação (Gmail)

| Pergunta | Comando | Output sample |
|---|---|---|
| Busca por assunto | `sde gmail buscar "cotação" --conta setor` | 20 emails com `id, from, subject, date, snippet` |
| Ler email | `sde gmail ler <messageId>` | Body completo |
| Thread completa | `sde gmail thread <threadId>` | Conversa de email |
| Inbox não-lidos | `sde gmail inbox` | Pendentes |

**Conta Gmail conectada:** `contato@setordaembalagem.com` (alias `setor`). Outras: `gouveia`.

**Sample:** "Cotação de frete" de NB Log oferecendo serviços de transporte (não é cotação de cliente, mas mostra padrão de email B2B).

---

## 6. Campanhas WhatsApp / Opt-out

| Pergunta | Comando | Output sample |
|---|---|---|
| Listar campanhas | `sde campaigns list` | Agrupadas por nome |
| Status campanha | `sde campaigns status <nome>` | Resumo |
| Show campanha | `sde campaigns show <nome>` | Detalhes envios |
| Opt-out list | `sde campaigns optout-list` | Telefones bloqueados |

Útil pra researcher entender: que mensagens já foram enviadas em massa, quais clientes deram opt-out (sinal de fricção).

---

## 7. Comandos transversais úteis

| Pergunta | Comando | Para que |
|---|---|---|
| SQL ad-hoc no replica Postgres | `sde query "<SQL>"` | Agregações customizadas (Tiny sincronizado) |
| Export CSV | `sde export "<SQL>"` | Pra análise externa |
| Identidade cliente cross-platform | (via `cliente-contexto --phone`) | Resolve telefone → Tiny ID |
| CRM nativo Ravi | `ravi crm board / opportunity / contact` | ⚠️ retorna `No open CRM opportunities` (CRM Ravi não está sendo populado pra esse cliente; CRM real está no `sde crm`) |

---

## Gaps conhecidos

❌ **`ravi contacts messages <contactId>`** retorna vazio pra contatos `discovered` não-aprovados (17 dos 17 contatos do sde estão nesse estado). Pra acessar histórico, rodar `ravi contacts backfill` ANTES OU usar `ravi chats messages <chatId>` direto.

❌ **`ravi crm`** não está sendo populado (0 oportunidades). O CRM ativo do setordaembalagem vive em `sde crm` (1961 oportunidades).

❌ **Ravi sessions** — não verifiquei se há sessões de chatbot ativas do setordaembalagem (provavelmente NÃO, instância `sde` está com `agent=-` sem agent atribuído).

❌ **Sample de `ravi chats messages`** não capturado neste mapa (priorizei `sde crm oportunidades-pendentes` como fonte primária). Researcher deve coletar 5-10 chats manualmente como evidência qualitativa.

---

## Recomendação ao researcher (REVISADO 2026-05-27 18:08)

⚠️ **NÃO** começar pelo CRM. RM exigiu transcript bruto explicitamente: análise CRM mostra output (SKU comprado), não processo (decisão).

**Plano em 3 fases:**

🔹 **Fase A — Coleta de transcripts brutos (ravi chats messages, N=30-50 chats)**
- Listar todos os chats da instância `sde`: `ravi chats list --instance sde --limit 100`
- Ler 30-50 chats completos com `ravi chats messages <chatId> --limit 100`
- Priorizar chats com 5+ mensagens (excluir spam/saudação)
- Salvar amostra anotada em TASK.md

🔹 **Fase B — Anotação manual (codificação qualitativa)**
Pra cada transcript:
- Sequência de perguntas do cliente (1ª, 2ª, 3ª)
- Atributo do produto mencionado (capacidade? material? cor? divisória? preço? uso?)
- Objeções levantadas (preço? estoque? prazo? compatibilidade?)
- Trigger inicial ("vendo macarrão" / "preciso pra delivery" / "tem 500ml?")
- SKU final mencionado (se houver)
- Resolveu ou não

🔹 **Fase C — Síntese 80/20**
- Frequência de cada atributo nas conversas (em quantos % dos chats foi mencionado)
- Árvore de decisão real ("vendo X" → "tem essa caract?" → "tem esse tamanho?" → "tem essa cor?")
- Tabela atributo → hot/cold/markdown baseada em FREQUÊNCIA REAL
- Cross-check com `sde crm oportunidades-pendentes` pra validar agregados (auxiliar, não primária)

🔹 **Fase D — Aprofundamento de 5-10 clientes (auxiliar)**
- 5 que viraram pedido + 5 que NÃO viraram pedido
- Cruzar transcript com `sde crm cliente-contexto --phone <num>` (já que o número está no chat title)
- Comparar: pediu X falou de Y vs pediu X falou de Z

---

## Comandos prontos pra copiar/colar

```bash
# Fase A — mineração
sde crm oportunidades-pendentes > /tmp/opps.json
jq '.oportunidades | length' /tmp/opps.json   # confirma N
jq '[.oportunidades[].reasoning]' /tmp/opps.json | head -50

# Fase B — aprofundamento
sde crm cliente-contexto --phone "5511973649798"
ravi chats list --instance sde --limit 20
ravi chats messages <chatId> --limit 50

# Útil
sde tiny pedidos --data-inicial "01/04/2026" --data-final "27/05/2026"
sde tiny pedido <id>   # detalhe com itens SKU+qtd
sde gmail buscar "cotação preço pote marmita" --conta setor
```
