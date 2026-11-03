# Ravi Console Fleet

- Use Bun; mantenha o lockfile. Não execute deploy, SSH ou operações destrutivas por inferência.
- Luis autorizou e exige deploy desta branch no ambiente de teste existente. Inspecione inventário/runbooks, preserve dados e serviços alheios e valide URL, revisão e jornada publicada. Não há autorização de merge ou produção.
- Não publique segredos, dados de instalação, arquivos `.private`, backups ou evidências brutas.
- Este Console faz parte do monorepo Ravi OSS MIT. Preserve a proveniência em docs/PROVENANCE.md e as licenças de terceiros.
- Diferencie implementação, teste histórico e proposta. O gateway HTTP/SSE substitui o protocolo bridge v2; veja docs/gateway/IMPLEMENTATION.md para contrato, cobertura e validação.
- Preserve Pages/Bases/Executor e a identidade do usuário. SSH não substitui autorização.
- Mantenha o motor IA do Console/Pages desligado; os agentes pertencem às instalações Ravi.
- Qualquer alteração de interface exige análise Gestalt antes do código e validação renderizada.
- Nunca reative workflows/publicação externa ou mude a visibilidade sem autorização.
