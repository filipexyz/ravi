# Tema da org nas páginas

Parte da skill pages. Tags `ravi-*`: `widgets.md`. Kit rk para página à mão: `design.md`.

O tema é um item da Biblioteca do Console (tipo `theme`): as cores, fontes,
espaços e raios da organização, no claro e no escuro. O `ravi pages ship`
põe o tema ativo na página. Escreva cor, fonte e espaço com as variáveis dele,
nunca com valores literais, e a página fica com a cara da org nos dois modos.

## Qual tema vale

```bash
ravi themes active --json                    # org, projeto e o efetivo (ref, versão, hash)
ravi themes active --project <p> --json
ravi themes search
ravi themes show org/acme
```

- O efetivo é o do projeto; sem ele, o da organização; sem nenhum, nenhum
  tema da Biblioteca (página com tags usa o tema padrão do Ravi).
- Trocar o tema ativo é decisão de pessoa: dentro de agente,
  `ravi themes use` recusa (`LIBRARY_AGENT_CANNOT_SET_THEME`, exit 3). Peça ao
  operador: `ravi themes use org/acme --execute` (com `--project <p>` para
  um projeto só). Sem `--execute` ele mostra o plano e os hosts afetados.

## O que o ship faz

| ship | tema na página |
|---|---|
| sem `--theme` | o efetivo, copiado em `<style id="ravi-theme">` em todo arquivo HTML |
| `--theme org/acme` | esse tema |
| `--theme none` | nenhum tema da Biblioteca; página com tags recebe o padrão do Ravi |
| sem tema ativo e sem tags | o HTML vai como está |

- Rota `private` com o tema efetivo (ship sem `--theme`): fica ao vivo. Ao
  abrir, a página pergunta ao Console o tema atual (`ravi.pages.theme.get`) e
  troca se mudou. Todo host libera esse id: não precisa pôr no `--uses`.
- Rota `public`, `protected_link` ou com senha, ou ship com `--theme`: fica a
  cópia do ship. Tema novo só entra com outro ship da rota.
  `ravi pages outdated` lista as rotas atrás.
- O ship avisa quando o tema da rota mudou desde o último publish
  (`Theme changed since the last publish of /rota: ...`).
- Sem `lang` no `<html>`, o ship põe o do tema. O `--body` sai sem `lang` para
  receber o do tema; quando o kit não põe nenhum (sem tema e sem tags, Console
  antigo), fica `pt-BR`.

## Variáveis

Sempre com fallback: `var(--nome, valor)`. Os fallbacks abaixo são o tema
padrão do Ravi (claro) e mantêm a página legível sem tema.

| uso | variável (fallback) |
|---|---|
| fundo da página, de cartão | `--color-background-primary` (`#fbfcfd`) |
| fundo de faixa, coluna, cabeçalho | `--color-background-secondary` (`#f3f5f8`) |
| trilho, barra, hover (sem texto em cima) | `--color-background-tertiary` (`#e8ecf1`) |
| texto | `--color-text-primary` (`#17202a`), `--color-text-secondary` (`#5f6f80`), `--color-text-tertiary` (`#627181`) |
| fundo e texto invertidos | `--color-background-inverse` (`#17202a`), `--color-text-inverse` (`#fbfcfd`) |
| status: info, success, warning, danger | `--color-text-<status>` (`#1d4f8f`, `#1d6537`, `#7a4a00`, `#a1262b`) sobre `--color-background-<status>` (`#dde9fb`, `#dcf3e3`, `#fdf3c7`, `#fbdcdc`) |
| borda de controle, divisória | `--color-border-primary` (`#838f9c`), `--color-border-secondary` (`#dfe4ea`) |
| foco | `--color-ring-primary` (`#14635a`), `--ravi-focus-width` (`2px`) |
| botão principal | `--ravi-color-accent` (`#14635a`) com texto `--ravi-color-on-accent` (`#ffffff`) |
| chip de opção (`gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red`) | `--ravi-option-<cor>-bg` e `--ravi-option-<cor>-text` (ex.: blue `#dde9fb` / `#1d4f8f`) |
| fontes | `--font-sans` (`system-ui, sans-serif`), `--font-mono` (`ui-monospace, monospace`) |
| peso | `--font-weight-normal` (400), `-medium` (500), `-semibold` (600), `-bold` (700) |
| tamanho de texto | `--font-text-xs-size` (`0.75rem`), `-sm-` (`0.875rem`), `-md-` (`1rem`), `-lg-` (`1.125rem`) |
| tamanho de título | `--font-heading-sm-size` (`1rem`), `-md-` (`1.25rem`), `-lg-` (`1.5rem`), `-xl-` (`1.875rem`) |
| raio | `--border-radius-xs` (`2px`), `-sm` (`4px`), `-md` (`6px`), `-lg` (`8px`), `-xl` (`12px`), `-full` (`9999px`) |
| borda | `--border-width-regular` (`1px`) |
| sombra | `--shadow-sm`, `--shadow-md`, `--shadow-lg` (fallback `none`) |
| espaço | `--ravi-space-1` a `--ravi-space-6` (`0.25rem`, `0.5rem`, `0.75rem`, `1rem`, `1.5rem`, `2rem`) |
| largura de coluna de board | `--ravi-lane-width` (`18rem`) |
| alvo mínimo de toque | `--ravi-touch-target` (`24px`) |

Os nomes sem prefixo são os do MCP Apps; `--ravi-*` são do Ravi.

```css
body {
  margin: 0;
  font: var(--font-text-md-size, 1rem)/1.5 var(--font-sans, system-ui, sans-serif);
  color: var(--color-text-primary, #17202a);
  background: var(--color-background-primary, #fbfcfd);
}
h1 { font-size: var(--font-heading-lg-size, 1.5rem); font-weight: var(--font-weight-semibold, 600); }
.painel { background: var(--color-background-secondary, #f3f5f8); border-radius: var(--border-radius-lg, 8px); padding: var(--ravi-space-4, 1rem); }
.erro { color: var(--color-text-danger, #a1262b); }
button.principal { background: var(--ravi-color-accent, #14635a); color: var(--ravi-color-on-accent, #ffffff); border: 0; border-radius: var(--border-radius-md, 6px); min-height: var(--ravi-touch-target, 24px); }
:focus-visible { outline: var(--ravi-focus-width, 2px) solid var(--color-ring-primary, #14635a); outline-offset: 2px; }
```

## Claro e escuro

- O tema traz os dois modos. O escuro segue `prefers-color-scheme`;
  `<html data-theme="dark">` força o escuro e `data-theme="light"` o claro.
  Em página com tags, `ravi.theme.setMode("dark" | "light" | "auto")` faz o
  mesmo.
- Cor literal quebra um dos modos: nada de `color: #000`, `background: white`
  ou cor de opção fixa num dicionário. Use as variáveis.
- SVG e ícones: `fill="currentColor"` ou `style="fill: var(...)"`; não
  conte com `var()` direto no atributo `fill`.
- Os fallbacks são do modo claro: sem tema, a página fica clara.
- O tema põe `color-scheme` só nas peças `ravi-*`, nunca na página: estilize
  seus links com `var(--color-text-info, #1d4f8f)` e, se quiser que os
  controles nativos (scrollbar, campos) também mudem, ponha
  `color-scheme: light dark` no `:root` da página.
- Tema `compact` aperta os espaços (`--ravi-space-*`); quem usa as variáveis
  acompanha.

## Contraste

O Console recusa publicar um tema com algum par abaixo do mínimo WCAG, no
claro e no escuro. Use só estes pares e a página herda a garantia:

| texto ou traço | sobre | mínimo |
|---|---|---|
| `--color-text-primary`, `-secondary`, `-tertiary` | `--color-background-primary`, `-secondary` | 4,5:1 |
| `--color-text-<status>` | `--color-background-primary` ou `--color-background-<status>` | 4,5:1 |
| `--color-text-inverse` | `--color-background-inverse` | 4,5:1 |
| `--ravi-color-on-accent` | `--ravi-color-accent` | 4,5:1 |
| `--ravi-option-<cor>-text` | `--ravi-option-<cor>-bg` | 4,5:1 |
| `--color-border-primary` | `--color-background-primary` | 3:1 |
| `--color-ring-primary` | `--color-background-primary`, `-secondary` | 3:1 |
| `--ravi-color-accent` | `--color-background-primary` | 3:1 |

Fora da tabela não há garantia: texto sobre `--color-background-tertiary`,
`--color-border-secondary` como borda de controle, accent como cor de texto
pequeno. Cor nunca é o único sinal: escreva o nome do status ao lado.

## Criar ou mudar um tema

Agente propõe; pessoa (admin da org ou do projeto) publica e ativa.

```bash
ravi themes init ./tema-acme                       # theme.json e fields.json do tema padrão
ravi themes check ./tema-acme                      # tokens e contraste nos dois modos; erro = exit 2
ravi themes propose ./tema-acme --scope org        # plano (exit 3)
ravi themes propose ./tema-acme --scope org --note "cores da marca" --execute
```

- `theme.json` é W3C Design Tokens, num conjunto fechado:
  `color.light.*` e `color.dark.*` (background, text, border, ring, accent,
  option), `font.*`, `radius.*`, `border.width.regular`, `shadow.*`,
  `space.1`-`space.6` e `layout.laneWidth`, mais `$description` e
  `$extensions.ravi` (`name`, `locale`, `density`: `comfortable` ou
  `compact`). Token desconhecido é erro; token omitido vem do padrão.
  Alias `{color.light.text.primary}` vale entre tokens do mesmo tipo.
- Fontes só por nome (fontes do sistema): sem `url()`, sem `@import`.
- `fields.json` escolhe como cada tipo aparece por padrão (ex.: `status`
  `pill`, `steps` ou `text`; `date` `date`, `relative` ou `datetime`).
- `logo.svg`: até 64 KiB; o Console limpa e só desenha como `<img>`.
- `check` lista cada par de contraste que falhou, com a razão. Não arredonde:
  escureça o texto ou clareie o fundo.
- Publicar (`ravi themes publish`) e ativar (`ravi themes use`) dentro de
  agente recusam com exit 3. Diga à pessoa que a proposta espera revisão no
  Console.
