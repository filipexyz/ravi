# Receitas

Cada receita: schema inicial (`--schema @arquivo.json`), views e um gráfico ou
automação. Ajuste nomes e opções ao pedido; mantenha as chaves estáveis.

## CRM (pipeline de vendas)

```json
[
  { "key": "name", "name": "Deal", "type": "text", "required": true },
  { "key": "company", "name": "Empresa", "type": "text" },
  { "key": "stage", "name": "Estágio", "type": "status", "config": { "options": [
    { "name": "Lead", "group": "todo" }, { "name": "Qualificado", "group": "in_progress" },
    { "name": "Proposta", "group": "in_progress" }, { "name": "Ganho", "group": "done", "color": "green" },
    { "name": "Perdido", "group": "done", "color": "red" } ] } },
  { "key": "owner", "name": "Vendedor", "type": "person" },
  { "key": "amount", "name": "Valor", "type": "number", "config": { "format": "currency", "currency": "BRL" } },
  { "key": "close_date", "name": "Fechamento previsto", "type": "date" },
  { "key": "contact_email", "name": "E-mail do contato", "type": "email" },
  { "key": "source", "name": "Origem", "type": "select", "config": { "options": [
    { "name": "Inbound" }, { "name": "Outbound" }, { "name": "Indicação" } ] } }
]
```

- View "Meus deals": board por `stage`, filtro `owner contains $viewer.raviUserId`,
  `write.set.owner = $viewer.raviUserId` (ver `views-access-forms.md`).
- View "Pipeline (gestão)": tabela, `read` para `project_admin`, sem filtro.
- Gráfico: barra `close_date` por mês × `sum(amount)`, cor por `stage`.
- Trigger: `bases.row.updated` na base → agent lê a linha e avisa quando `stage` vira Ganho.

## Calendário de conteúdo

```json
[
  { "key": "title", "name": "Título", "type": "text", "required": true },
  { "key": "status", "name": "Status", "type": "status", "config": { "options": [
    { "name": "Ideia", "group": "todo" }, { "name": "Escrevendo", "group": "in_progress" },
    { "name": "Revisão", "group": "in_progress" }, { "name": "Publicado", "group": "done" } ] } },
  { "key": "channel", "name": "Canal", "type": "multi_select", "config": { "options": [
    { "name": "Blog" }, { "name": "LinkedIn" }, { "name": "Newsletter" }, { "name": "YouTube" } ] } },
  { "key": "publish_date", "name": "Publicação", "type": "date" },
  { "key": "author", "name": "Autor", "type": "person" },
  { "key": "url", "name": "Link", "type": "url" }
]
```

- View "Calendário": layout `calendar` com `dateProp: "publish_date"`.
- View "Esta semana": filtro `publish_date within this_week`, sort `publish_date asc`.
- Formulário "Sugira uma pauta": `create: true`, `write.columns: ["title", "channel"]`,
  `write.set: { "status": "Ideia" }`. O rascunho vai no corpo da linha.

## OKRs

Duas bases: objetivos e key results.

```json
[
  { "key": "objective", "name": "Objetivo", "type": "text", "required": true },
  { "key": "quarter", "name": "Trimestre", "type": "select", "config": { "options": [
    { "name": "2026-Q4" }, { "name": "2027-Q1" } ] } },
  { "key": "owner", "name": "Dono", "type": "person" },
  { "key": "status", "name": "Status", "type": "status", "config": { "options": [
    { "name": "No ritmo", "group": "in_progress", "color": "green" },
    { "name": "Em risco", "group": "in_progress", "color": "yellow" },
    { "name": "Atrasado", "group": "in_progress", "color": "red" },
    { "name": "Concluído", "group": "done" } ] } }
]
```

Key results: `kr` (text), `objective` (`ref` com `{ "type": "base_row", "id": "<rowId do objetivo>" }`),
`baseline`, `target`, `current` (number), `progress` (number, `format: "percent"`),
`owner` (person), `due` (date).

- Gráfico "Progresso por objetivo": `bar`, `x` = `kr` (nominal), `y` = `progress`.
- Rotina: cron semanal pede ao agent para atualizar `current`/`progress` com
  `--expected-version` lido na mesma execução.

## Triagem de bugs

```json
[
  { "key": "title", "name": "Bug", "type": "text", "required": true },
  { "key": "severity", "name": "Severidade", "type": "select", "config": { "options": [
    { "name": "S1", "color": "red" }, { "name": "S2", "color": "orange" },
    { "name": "S3", "color": "yellow" }, { "name": "S4", "color": "gray" } ] } },
  { "key": "status", "name": "Status", "type": "status", "config": { "options": [
    { "name": "Novo", "group": "todo" }, { "name": "Triado", "group": "todo" },
    { "name": "Em correção", "group": "in_progress" }, { "name": "Resolvido", "group": "done" },
    { "name": "Não reproduz", "group": "done" } ] } },
  { "key": "assignee", "name": "Responsável", "type": "person" },
  { "key": "component", "name": "Componente", "type": "select" },
  { "key": "reporter_email", "name": "Reportado por", "type": "email" },
  { "key": "links", "name": "Links", "type": "ref" }
]
```

- Formulário "Reportar bug" (membros ou `page_viewer` de uma Page interna):
  `write.columns: ["title", "severity", "component"]`,
  `write.set: { "status": "Novo", "reporter_email": "$viewer.email" }`. Passos para
  reproduzir no corpo.
- View "Fila de triagem": filtro `status eq Novo`, sort `created_time asc`.
- View "Meus bugs": `assignee contains $viewer.raviUserId` e status não `done`.
- Trigger em `bases.row.created` com `surface == "page"` → agent faz a triagem
  inicial (lê a linha, sugere severidade e componente com `rows update --expected-version`).

## Contratação (hiring)

```json
[
  { "key": "candidate", "name": "Candidato", "type": "text", "required": true },
  { "key": "role", "name": "Vaga", "type": "select" },
  { "key": "stage", "name": "Etapa", "type": "status", "config": { "options": [
    { "name": "Triagem", "group": "todo" }, { "name": "Entrevista técnica", "group": "in_progress" },
    { "name": "Entrevista final", "group": "in_progress" }, { "name": "Oferta", "group": "in_progress" },
    { "name": "Contratado", "group": "done", "color": "green" }, { "name": "Recusado", "group": "done", "color": "red" } ] } },
  { "key": "recruiter", "name": "Recrutador", "type": "person" },
  { "key": "interviewers", "name": "Entrevistadores", "type": "person" },
  { "key": "email", "name": "E-mail", "type": "email" },
  { "key": "resume", "name": "Currículo", "type": "url" },
  { "key": "score", "name": "Nota", "type": "number" }
]
```

- Dados sensíveis: notas de entrevista no corpo da linha; view "Entrevistador"
  com `columns` sem `score`/corpo e filtro `interviewers contains $viewer.raviUserId`,
  escrita só em `stage`.
- View "Funil" em modo `aggregate` para a liderança + gráfico `bar` de `count`
  por `stage`: ninguém vê candidatos individuais.
- Exporte o funil com `rows export --view <view-id> --format csv` para relatórios.
