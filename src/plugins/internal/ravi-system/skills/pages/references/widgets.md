# Widgets e tags de página

Parte da skill pages. Cores, fontes e claro/escuro: `theme.md`. Site, view,
`--uses` e quem passa numa página de dados: `data-pages.md`.

Um widget é um cartão da Biblioteca da org: um template das peças `ravi-*`
com campos tipados (os tipos do Bases). Não é código (salvo o widget com
código, no fim). Você não escreve o cartão: escolhe um widget numa tag e o
`ravi pages ship` faz o resto.

## Tag primeiro, cliente à mão só no que falta

| tela | use |
|---|---|
| lista, board, tabela ou galeria sobre uma view | `<ravi-view>` |
| formulário que cria linha | `<ravi-form>` |
| cartão com números fixos (KPI, snapshot) | `<ravi-widget data>` |
| calendário, gráfico, detalhe próprio, filtro na tela, campo `body` no formulário | esqueleto + `client.js` (`layouts.md`) |

A tag já sai com o tema, campos por tipo, teclado, leitor de tela e
mensagens de erro, e o ship deriva o `--uses` dela. Pode misturar tags e HTML
seu na mesma página.

## 1. Procure um widget

```bash
ravi widgets search "pedido status valor" --json   # nome, descrição e campos (chave, rótulo, tipo)
ravi widgets show org/pedido-card                  # widget.json: os campos que ele espera
ravi widgets catalog                               # peças, filtros, tipos, regras e os widgets da org
```

- Nenhum serve? Não crie um para esta página: `<ravi-view>` sem `widget`
  desenha o cartão padrão, já com o tema e os campos por tipo.
- Ref: `pedido-card` (o do projeto da página, senão o da org),
  `org/pedido-card` ou `<projeto>/pedido-card`. Use o ref completo do search.

## 2. Escreva a tag

Feche toda tag (`<ravi-view ...></ravi-view>`, nunca `/>`). Tags não vão uma
dentro da outra. O id da view sai de `ravi bases views list <base> --json`.

```html
<ravi-view view="<uuid da view>" layout="board" widget="org/pedido-card" variant="compact"></ravi-view>
<ravi-view view="<uuid da view>" layout="list" widget="org/pedido-card" fields="titulo:nome_cliente,valor:total"></ravi-view>
<ravi-view view="<uuid da view>" layout="table" columns="titulo,status,valor" sort="-valor" where="status=@in_progress"></ravi-view>
<ravi-form view="<uuid da view>" fields="titulo,prazo,valor" submit-label="Enviar pedido" success="Pedido recebido."></ravi-form>
<ravi-widget use="org/kpi-mes" data='{"titulo": "Vendas de outubro", "valor": 1200}'></ravi-widget>
```

### `<ravi-view>`

| atributo | valor |
|---|---|
| `view` | uuid da view (obrigatório) |
| `layout` | `list`, `board`, `table` ou `gallery`; padrão: o da view. Outro valor vira `list`; board sem coluna select/status vira `list` |
| `widget` | ref do widget. Sem ele: o widget da view (`ravi bases views bind`), senão o cartão padrão |
| `fields` | `campoDoWidget:coluna,...` quando o nome não casa sozinho |
| `variant` | `compact`, `default` ou `detail`, só as que o widget lista (outra vira `default`, com aviso) |
| `group-by` | coluna select ou status das colunas do board; padrão: a da view |
| `card-title`, `card-fields` | só no cartão padrão: coluna do título; colunas mostradas (padrão: as 4 seguintes) |
| `columns` | colunas da tabela, na ordem (a tabela ignora o widget) |
| `sort` | `chave,-chave2` (menos = decrescente), até 3 |
| `where` | `chave=valor;...` somado ao filtro da view: igualdade; `@me`, `@today`, `@now`, `@todo`/`@in_progress`/`@done`; `chave=` = vazio |
| `create` | botão "Novo item" (se a view deixa criar) |
| `archive` | botão de arquivar no cartão padrão; com widget, vale o botão do widget |
| `readonly` | nenhuma escrita, nem editor nem arrastar |
| `heading-level` | nível dos títulos da view (padrão 2): colunas do board nesse nível e cartões no seguinte; na lista, os cartões nesse nível |
| `page-size` | linhas por consulta (padrão 50, até 200) |

Casamento de campos, nesta ordem: o `fields` da tag (por cima do mapa da
view), a coluna com a mesma chave, a coluna cujo nome (minúsculo, sem acento,
espaço vira `_`) é a chave ou o rótulo do campo, e a única coluna livre do
mesmo tipo. `text` aceita qualquer coluna; `date` aceita date, created_time e
updated_time; `select` aceita select e status; `person` aceita person,
created_by e updated_by; os outros, só o mesmo tipo. Campo obrigatório sem
coluna derruba o ship (exit 2) e a mensagem lista as colunas candidatas;
campo opcional sem coluna só avisa e sai vazio.

### `<ravi-widget>`

`use` (obrigatório), `data`, `variant` e `heading-level` (1 a 6, padrão 2: o
nível do título do cartão; dentro de uma seção com `<h2>`, use
`heading-level="3"`). `data` é um objeto JSON por campo do widget, com aspas simples por fora. O ship desenha no HTML (quem lê sem JS
também vê). Formatos: texto, url, email e phone em string; número; checkbox
`true`/`false`; data `"YYYY-MM-DD"` ou ISO; select/status `"Pago"` ou
`{ "name": "Pago", "color": "green" }`; multi_select uma lista disso; pessoa
`"Ana Souza"` ou `{ "name": "Ana Souza", "avatarUrl": "https://..." }`.

`data` é igual para todo visitante: números que a pessoa escolheu publicar,
nunca linhas de uma view. Em rota pública, nome, e-mail e telefone em `data`
ficam públicos, e o ship avisa `KIT_PERSONAL_DATA_PUBLIC`: publique numa rota
privada ou tire esses valores de `data`.

### `<ravi-form>`

`view` (obrigatório), `fields` (chaves de coluna, na ordem; padrão: as que a
view deixa escrever), `submit-label` e `success`. Desenha text, number, date,
checkbox, select, status, multi_select, url, email e phone; `person`, `ref` e
`body` ficam de fora (dono vem do `write.set` da view; `body` pede o
esqueleto). O erro de cada campo aparece sob ele.

## 3. Ship

```bash
ravi pages ship --project <p> --title "Pedidos" --route /pedidos --html ./pedidos.html --json
```

O ship manda o HTML (de uma cópia, nunca da sua pasta) ao kit do Console:

- aplica o tema (`theme.md`) e o CSS das peças;
- fixa na página a versão publicada de cada widget e do `ravi.js`: versão
  nova só entra com outro ship;
- confere os campos contra a view, lida como você (quem roda o ship);
- desenha `<ravi-widget data>` no HTML e põe "Carregando…" em `<ravi-view>`;
- soma ao `--uses` os ids que as tags pedem: `describe` e `query` sempre;
  `rows.update` em board sem `readonly`, botão update ou campo editável
  (select, status, checkbox); `rows.create` com `create` ou botão create;
  `rows.archive` com `archive` ou botão archive; `rows.get` em botão open sem
  link; `<ravi-form>` leva `describe` e `rows.create`.

O `--uses` continua do host inteiro (regra 2 de `data-pages.md`): o ship soma
só os ids das tags deste HTML. Ponha no `--uses` os das outras páginas de
dados do host. Tag de dados em rota `public` cai na mesma recusa do
`ravi.bases.*` (exit 2, nada sobe).

O JSON traz `kit: { status, changedFiles, warnings, theme, widgets }` e
`presentation`. `status` é `applied`; `skipped` quando não há HTML ou ele
passa do limite (aviso `KIT_TOO_LARGE`: 2 MiB por arquivo, 4 MiB no total);
`unavailable` num Console antigo (aviso `KIT_UNAVAILABLE`). Nos dois últimos
o HTML vai como está, sem tema, e as tags não funcionam.

Erro sai com exit 2, uma linha por problema (`arquivo:linha:coluna severidade
código mensagem`), e nada sobe:

| código | conserte |
|---|---|
| `KIT_TAG_UNCLOSED`, `KIT_TAG_NESTED` | feche com `</ravi-view>`; tire a tag de dentro da outra |
| `KIT_VIEW_REQUIRED`, `KIT_VIEW_INVALID` | `view="<uuid>"` (`ravi bases views list`) |
| `KIT_VIEW_UNAVAILABLE` | você não lê a view: erro só se o widget tem campo obrigatório |
| `WIDGET_FIELD_MISSING` | campo obrigatório sem coluna: `fields="campo:coluna"` com uma candidata da mensagem |
| `WIDGET_FIELD_INCOMPATIBLE`, `WIDGET_FIELD_COLUMN_MISSING`, `WIDGET_FIELD_UNKNOWN` | o `fields` aponta coluna de outro tipo, fora da view, ou campo que o widget não tem |
| `KIT_WIDGET_NOT_FOUND`, `KIT_WIDGET_OUT_OF_SCOPE`, `KIT_WIDGET_UNPUBLISHED` | ref errado, de outro projeto ou sem versão publicada: `ravi widgets search` |
| `KIT_DATA_INVALID` | `data` precisa ser um objeto JSON |
| `KIT_FORM_FIELD_MISSING` | `fields` do formulário com coluna que a view não projeta |
| `KIT_THEME_*` | `--theme` com ref errado (`theme.md`) |
| `KIT_TOO_LARGE` | o HTML montado (com tema e `ravi.js`) passou do limite do Console: divida em mais rotas |
| `KIT_WIDGET_UNAUDITED` | widget com código sem auditoria aprovada: um owner ou admin da org abre a URL do `suggestedAction` no Console e roda a auditoria; depois, o mesmo ship |

Avisos não bloqueiam: atributo desconhecido (`KIT_ATTRIBUTE_UNKNOWN`),
variante que o widget não tem (`KIT_VARIANT_UNKNOWN`), `fields` sem widget
(`KIT_FIELDS_UNUSED`), widget da view indisponível
(`KIT_LAYOUT_WIDGET_UNAVAILABLE`, sai o cartão padrão), valor de atributo
inválido ou `page-size` acima de 200, que vira 200 (`KIT_ATTRIBUTE_INVALID`),
nome, e-mail ou telefone em `data` numa rota pública
(`KIT_PERSONAL_DATA_PUBLIC`), tema mudado desde o último publish da rota.

## 4. Depois do ship

```bash
ravi pages outdated --project <p> --json   # rotas com tema, widget ou ravi.js mais velhos que os atuais
```

Para atualizar uma rota, faça o ship dela de novo com o mesmo comando.

Para que toda página sobre uma view use o mesmo widget sem `widget=` na tag,
ligue o widget à view (board, list, gallery ou calendar). Aplica na hora,
sem `--execute`, e exige gerenciar a base:

```bash
ravi bases views bind <base> <view-id> org/pedido-card --variant compact --field valor=total
ravi bases views bind <base> <view-id> none
```

Atenção: no `bind` o mapa é `--field campo=coluna` (com `=`); na tag é
`fields="campo:coluna"` (com `:`).

## Criar um widget

Só quando a pessoa pede, ou quando o mesmo cartão se repete em várias
páginas. Agente propõe; pessoa publica.

```bash
ravi widgets init ./pedido-card --from-view <uuid da view>   # campos das colunas (só o esquema, nunca linhas)
ravi widgets check ./pedido-card                             # compila e roda o lint; erro = exit 2
ravi widgets preview ./pedido-card                           # preview.html: variantes, claro e escuro, sem script
ravi widgets propose ./pedido-card --scope org               # plano (exit 3)
ravi widgets propose ./pedido-card --scope org --note "cartão de pedido" --execute
```

- Leia `ravi widgets catalog` antes de editar `widget.html`: lá estão as
  peças, atributos, filtros, `set` dos botões e um exemplo completo.
- `init`, `check` e `preview` não têm freio. `preview` aceita `--data
  <arquivo.json>`, `--theme <ref>` e `--out <arquivo.html>`.
- `example.json` só com dados inventados (`@example.com`); e-mail ou telefone
  com cara de real gera aviso.
- Dentro de agente, `ravi widgets publish` recusa (`LIBRARY_AGENT_CANNOT_PUBLISH`,
  exit 3). Diga à pessoa que a proposta espera revisão no Console. Até ela
  publicar, o ship não acha o widget: use o cartão padrão ou o widget atual.
- Revisão: `ravi widgets proposal org/pedido-card <n>` mostra os comentários;
  responda com `ravi widgets propose ./pedido-card --scope org --update <n> --execute`.

## Widget com código

Só para o desenho que o template não faz: gráfico, mapa. O `widget.html`
continua obrigatório: é o que o ship desenha no HTML e o que agentes e quem
lê sem JS recebem. O `widget.js` só melhora o cartão por cima.

- `widget.js` na pasta do widget: um módulo ES, até 128 KiB, com as
  bibliotecas empacotadas dentro. Nada de `import` (nem `import()`), `export
  ... from`, `<script src>`, `importScripts` ou `new Worker`.
- Exporte `mount(card, ctx)`; ele devolve `{ update, destroy }` (os dois
  opcionais). `update(ctx)` roda quando o registro do cartão muda; `destroy()`
  quando o cartão sai da tela. Erro no `mount` deixa o cartão estático.
- `ctx`: `record` (`{ id, values }` pelos campos do widget), `fields`,
  `canvas(i = 0)` (o `<ravi-canvas>` de índice `i` do cartão, ou `null`),
  `locale`, `timeZone`, `mode` (`light`/`dark`), `theme(nome)` (variável CSS
  do tema), `announce(texto)` (região `aria-live`), `el` (o mesmo de
  `ravi.el`), `onModeChange(fn)` (devolve o cancelamento).
- Desenhe só dentro de `<ravi-canvas label="Vendas por mês" height="16rem">`:
  a única área livre, com `label` obrigatório (texto ou `{campo}`) e só em
  widget com `widget.js`. Sem JS ela fica vazia: o resumo do gráfico vai no
  template (números, uma tabela).
- Só leitura por enquanto: não há `ctx.run`; `scriptActions` no
  `widget.json` é recusado (`WIDGET_JS_ACTIONS_UNSUPPORTED`). Botões do
  template (`ravi-button`) seguem funcionando.
- `ravi widgets check` e `preview` mandam o `widget.js`; os erros saem como
  `widget.js:linha:coluna` (`WIDGET_JS_*`).
- Só owner ou admin da org publica um widget com código; agente propõe como
  sempre. O Console roda a auditoria de acessibilidade (axe, sobre o
  `example.json`) antes de liberar a versão: sem ela aprovada, o ship que usa o
  widget sai com `KIT_WIDGET_UNAUDITED` (exit 2) e a URL da auditoria no
  `suggestedAction`.

## Acessibilidade

As peças garantem, e o publish do widget recusa o que quebra:

- imagem com `alt` (campo, texto curto ou `decorative`); avatar com `name`;
- botão, link e badge com `tone` ou `color` com texto que todo registro tem:
  texto fixo, um campo `required`, um campo testado por um `{#if}` em volta,
  um item de `{#each}`, ou um `{#if}` com texto nos dois ramos (link cujo texto
  é o próprio endereço, `<ravi-link href="{site}">{site}</ravi-link>`, também
  vale); cor nunca é o único sinal (texto com `tone` ou `color` precisa de
  texto); status e select sempre mostram o nome da opção;
- títulos sem pular nível; todo cartão é um `article` com título;
- botão com nome "rótulo: título do registro" (ex.: "Concluir: Pedido 1042"),
  confirmação montada da ação, `archive` sempre confirma;
- foco visível com a cor do tema, alvos de 24 px, mover no board pelo menu
  "Mover para…" além de arrastar, Esc fecha, mudanças anunciadas numa região
  `aria-live`, `prefers-reduced-motion` e `forced-colors` respeitados;
- para agentes: cada registro leva `data-ravi-row`, cada campo
  `data-ravi-field` e `data-ravi-value` (valor cru: data ISO, número sem
  formato, nome da opção). Não apague esses atributos.

No HTML que é seu, você ainda faz:

- um `<h1>` e títulos em ordem; `heading-level` da tag encaixa nessa ordem
  (seção `<h2>` com lista dentro: `heading-level="3"`);
- `<html lang>` (o ship põe o do tema se faltar; no `--body`, sem tema e sem
  tags, `pt-BR`) e `<title>`;
- rótulo em todo controle seu (`<label>`, ou `aria-label` em botão só com
  ícone) e texto alternativo em imagem e gráfico (`role="img"` com
  `aria-label`, ou uma tabela ao lado);
- cores pelas variáveis do tema, nos pares de `theme.md`; nunca tire o
  `outline` de foco;
- mensagens suas que mudam na tela num elemento `aria-live="polite"`;
- nada de esconder uma tag com `aria-hidden` nem pôr tag dentro de `<button>`
  ou `<a>`;
- não sobrescreva o CSS das classes `ravi-*`: ajuste pelo tema.
