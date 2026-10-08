# Ravi Page sobre uma base: mudou para a skill pages

O guia da página de dados agora mora na skill pages. Abra só o que precisar:

```bash
ravi skills show pages --file references/data-pages.md                   # site → view → ship, --uses do host, erros
ravi skills show pages --file references/layouts.md                      # tabela, board, formulário, gráficos
ravi skills show pages --file references/exemplo-board.md                # página completa
ravi skills show pages --file references/esqueletos/_client.js.txt       # o cliente exec()
ravi skills show pages --file references/esqueletos/board.html.txt       # esqueleto de board
ravi skills show pages --file references/esqueletos/formulario.html.txt  # esqueleto de formulário
```

O essencial: página de dados é só para membro logado da org, em rota `private`
ou `protected_link`; todo ship no host lista a união dos ids `ravi.bases.*` de
todas as páginas de dados; a view é o contrato de acesso (`views-access-forms.md`).
