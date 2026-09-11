# Fixture com destinos globais do Codex

Data: 2026-09-10
Estado: hook experimental desativado com autorização; perda de skills não comprovada.

## Ocorrência

Na etapa inicial de testes da visibilidade de skills, uma fixture alcançou rotinas legadas de configuração de hook e sincronização sem fornecer diretórios isolados. Essas rotinas usaram os destinos pessoais padrão.

A inspeção posterior confirmou gravações no hook global do Codex e no manifesto global de skills gerenciadas, às 18:41:36 UTC. O hook passou a apontar para o executável da worktree experimental `global-skill-visibility`; o manifesto ficou com a lista de diretórios gerenciados vazia.

## Impacto e limites da evidência

O hook global pode executar código experimental em chamadas correspondentes. A sincronização com lista vazia também pode remover diretórios enumerados pelo manifesto anterior. Não há pré-imagem imediata desse manifesto; portanto, a inspeção não permite afirmar se alguma skill foi removida nem identificar quais seriam.

Os backups de hooks encontrados eram anteriores à sessão e não comprovam o estado imediatamente anterior ao teste. Não foram usados para restauração automática. Este incidente não envolveu deploy na VPS.

## Contenção

O usuário autorizou arquivar o hook atual e retirar somente sua entrada RAVI. A cópia `hooks.before-global-skill-visibility-removal-20260910.json`, no diretório de configuração do Codex, preserva os bytes anteriores; seu SHA-256 é `5dd3c4851c898ad2e26829c3a7a35f7cd0ece7c9dbffe050c0211a5cb4336144`. O arquivo ativo manteve suas chaves e ficou com `PreToolUse` vazio, pois a entrada RAVI era a única. Ambos os arquivos foram validados como JSON. O manifesto não foi alterado e nenhuma recuperação de skills foi presumida.

As próximas execuções de testes devem isolar ambiente, diretório pessoal, estado do RAVI, configurações, hooks e manifestos antes de importar adapters. O runner de testes deve verificar os caminhos resolvidos, inclusive `os.homedir()`, e recusar destinos não isolados. Credenciais reais não podem chegar às fixtures.

## Critério de encerramento

Encerrar somente após comprovar o isolamento do runner e das fixtures nativas e repetir os testes pertinentes sem alterações nos destinos pessoais. A ausência de pré-imagem do manifesto deve continuar registrada, sem transformar a incerteza em afirmação de recuperação.
