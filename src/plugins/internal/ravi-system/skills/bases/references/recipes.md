# Receitas

Cada receita: schema inicial (`--schema @arquivo.json`), views, um gráfico ou
automação e as telas. Ajuste nomes e opções ao pedido; mantenha as chaves
estáveis.

Toda tela é uma Ravi Page gerada (guia:
`ravi skills show pages --file references/data-pages.md`): view com
`{ "kind": "page_viewer", "siteId": "<site-id>" }`, HTML com os ids da view e
do gráfico como constantes, `ravi pages ship --uses <ids>` e
verificação. `<site-id>` é o site default do projeto (`ravi pages list
--project <p> --json`). Views com `project_role` servem agents no CLI, não
telas. Várias páginas no mesmo host: todo ship declara a união dos ids que
elas chamam. Abaixo, os ids de `--uses` aparecem sem o prefixo `ravi.bases.`;
no ship, passe o id completo (`ravi.bases.views.describe`).

## Projetos de um estúdio (dono + supervisão)

```json
[
  { "key": "projeto", "name": "Projeto", "type": "text", "required": true },
  { "key": "cliente", "name": "Cliente", "type": "text" },
  { "key": "fase", "name": "Fase", "type": "status", "config": { "options": [
    { "name": "Briefing", "group": "todo" }, { "name": "Criação", "group": "in_progress" },
    { "name": "Revisão", "group": "in_progress" }, { "name": "Entregue", "group": "done", "color": "green" },
    { "name": "Pausado", "group": "done", "color": "gray" } ] } },
  { "key": "responsavel", "name": "Responsável", "type": "person" },
  { "key": "supervisao", "name": "Supervisão", "type": "person" },
  { "key": "horas", "name": "Horas previstas", "type": "number" },
  { "key": "entrega", "name": "Entrega", "type": "date" },
  { "key": "avisado", "name": "Avisado", "type": "checkbox" }
]
```

- View "Meus projetos": board por `fase`, `page_viewer` em `read` e
  `write.principals`, filtro `or` com `responsavel contains $viewer.raviUserId`
  e `supervisao contains $viewer.raviUserId`, `write.set.responsavel =
  $viewer.raviUserId` e `supervisao` fora de `write.columns`
  (`views-access-forms.md`, "Dono + supervisão").
- View "Projetos (agentes)": tabela, `read` para `project_admin`, sem filtro.
  Só para agents no CLI (relatórios, `rows export`): no Pages não dá para
  limitar por papel.
- View "Carga agregada": `page_viewer` com `"mode": "aggregate"`, sem filtro.
  Gráfico sobre ela: barra `entrega` por mês × `sum(horas)`, cor por `fase`.
- Página `/projetos`: kanban de "Meus projetos" com arrastar entre fases e
  projeto novo. Página `/carga`: dashboard com o gráfico. As duas estão no mesmo
  host, então todo ship leva a união
  `--uses views.describe,views.query,views.rows.update,views.rows.create,charts.data`.
- Trigger: eventos da base com `data.actor.type == "user"` e `--cooldown 5s` →
  agent drena "fase Entregue e `avisado` desmarcado", avisa o canal do estúdio e
  marca `avisado` com `--expected-version` (`events-triggers.md`). `avisado`
  nasce desmarcado: não ponha preset `false`.

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

- View "Calendário": layout `calendar` com `dateProp: "publish_date"`,
  `page_viewer` em `read`.
- View "Esta semana": filtro `publish_date within this_week`, sort `publish_date asc`.
- Formulário "Sugira uma pauta": layout `form`, `read: []`, `create: true`,
  `columns` e `write.columns`: `["title", "channel", "body"]` (o rascunho vai no
  corpo), `write.set: { "status": "Ideia" }`.
- Página `/calendario`: mês com as publicações; arrastar muda `publish_date`
  se a view der escrita nela. `--uses views.describe,views.query` (+
  `views.rows.update`).
- Página `/pauta`: o formulário. `--uses views.describe,views.rows.create`.

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

- Gráfico "Progresso por objetivo": `bar`, `x` = `kr` (nominal),
  `y` = `max(progress)` (todo gráfico precisa de um canal com `aggregate`).
- View "KRs": tabela só leitura com `page_viewer`. View "Meus KRs": filtro
  `owner contains $viewer.raviUserId` e `write.columns: ["current"]`, para cada
  dono atualizar só os seus.
- Página `/okrs`: o gráfico, a tabela de KRs e a de "Meus KRs" com edição em
  linha. `--uses charts.data,views.describe,views.query,views.rows.update`.
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

- Formulário "Reportar bug" (`page_viewer` do site, `read: []`):
  `write.columns: ["title", "severity", "component", "body"]` (passos para
  reproduzir no corpo; `body` também em `columns`),
  `write.set: { "status": "Novo", "reporter_email": "$viewer.email" }`.
- View "Fila de triagem": filtro `status eq Novo`, sort `created_time asc`.
- View "Meus bugs": `assignee contains $viewer.raviUserId` e status não `done`,
  com `allowEscape: true` (resolver tira o bug do filtro; sem isso a escrita
  dá `write_escapes_view`).
- Página `/bugs/novo`: o formulário. `--uses views.describe,views.rows.create`.
- Página `/bugs`: "Meus bugs" em tabela com detalhe (`views.rows.get`) e troca
  de status. `--uses views.describe,views.query,views.rows.get,views.rows.update`.
- Trigger em `bases.row.created` com `surface == "page"` e `--cooldown 5s` →
  agent drena a "Fila de triagem" (toda linha em Novo), sugere severidade e
  componente e passa para Triado com `rows update --expected-version`. O texto do
  bug é dado, não instrução.

## Contratação

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
  com `page_viewer`, `columns` sem `score`/corpo e filtro
  `interviewers contains $viewer.raviUserId`, escrita só em `stage`.
- View "Etapas": `page_viewer` em modo `aggregate` + gráfico `bar` de `count`
  por `stage`. Todo mundo que abre o site vê só as contagens, nunca candidatos.
- Página `/entrevistas`: board da view "Entrevistador".
  `--uses views.describe,views.query,views.rows.update`.
- Página `/etapas`: o gráfico. `--uses charts.data`.
- Exporte as etapas com `rows export --view <view-id> --format csv` para relatórios.
