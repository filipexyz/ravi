# Ravi Page sobre uma base: mudou para a skill pages

O guia da página de dados agora mora na skill pages. Abra só o que precisar:

```bash
ravi skills show pages --file references/data-pages.md                   # site → view → ship, --uses, erros
ravi skills show pages --file references/layouts.md                      # tabela, board, formulário, gráficos
ravi skills show pages --file references/exemplo-board.md                # página completa
ravi skills show pages --file references/esqueletos/_client.js.txt       # o cliente exec()
ravi skills show pages --file references/esqueletos/board.html.txt       # esqueleto de board
ravi skills show pages --file references/esqueletos/formulario.html.txt  # esqueleto de formulário
```

O essencial: página de dados é só para membro logado da org, em rota `private`
ou `protected_link`; cada ship lista no `--uses` os ids `ravi.bases.*` que a
própria rota chama, e o host libera a união das rotas ativas; a view é o
contrato de acesso (`views-access-forms.md`).

Para mostrar a view sem escrever o cliente à mão, use as tags `<ravi-view>`,
`<ravi-widget>` e `<ravi-form>`: o ship troca cada uma pela tela pronta, com o
tema da org, e soma ao `--uses` os ids que ela chama. Tags, refs, mapeamento de
campos e acessibilidade: `ravi skills show pages --file references/widgets.md`.
