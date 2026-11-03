# Auditoria desta publicação

Data: 23/10/2026. Escopo: pacote de código, não validação de uma instalação nova.

## Verificações

- Exportação sem histórico de Console `96bb3be745568569f4096ef0f0717cec17ff00ad`.
- 1.528 arquivos originais preservados com o mesmo Git blob e modo. Alterações limitadas
  aos três arquivos de exemplos/ignore e exclusão do manifesto local descritos em PROVENANCE.
- Sem symlinks, workflows, envs reais, chaves, bancos, dumps, arquivos binários de mídia,
  dependências instaladas, dados operacionais ou diretórios privados no conjunto publicado.
- Patch Executor aplicável (`git apply --check`) à base upstream exata, sem tocar na origem.
- Licenças MIT do Executor e Apache-2.0 do perfil Moby incluídas integralmente.
- Repositório GitHub criado privado; Actions desabilitado antes do primeiro push.

## Scanner de segredos

Gitleaks **8.30.1**, asset oficial darwin_arm64 verificado por SHA256
`b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`.
Scan completo com `--redact=100 --ignore-gitleaks-allow`, sem exclusão ampla de testes.
O scanner bruto retorna **17 alertas/exit 1**, não zero. Revisão confirmou fixtures
sintéticas determinísticas de criptografia/redação e um identificador de campo de schema.
`SECRET-SCAN-REVIEW.json` fixa caminho, linha, regra e SHA256 da linha revisada;
o gate exige correspondência exata e recusa alerta novo ou alteração de fixture.
Resultado da revisão: **zero achados não classificados / nenhuma credencial real identificada**.
Isso não é garantia matemática de ausência de qualquer segredo.

Relatórios brutos ficam fora do repositório. Não foi aplicado allowlist genérico por
extensão `.test.ts` e nenhum valor suspeito foi copiado para a documentação.

## Limites e resultado negativo preservado

`git diff --cached --check` no snapshot completo aponta whitespace já existente em
migrations/código e linhas de contexto do patch exportado. Não foi declarado PASS:
reescrever SQL histórico alteraria checksums e não faz parte da publicação. O check dos
documentos novos é separado. Não houve build, teste funcional, login, SSH, deploy,
bootstrap, geração de credenciais ou alteração de serviço nesta tarefa.

Após o push, o responsável deve verificar `main` remoto = commit local, privacidade,
Actions desligado, um único commit raiz e preservação das fontes. Hash/URL finais são
registrados no handoff da tarefa, sem criar referência circular no próprio commit.
