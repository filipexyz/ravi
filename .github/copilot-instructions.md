# Instruções do GitHub Copilot

## Revisão de pull requests

Ao revisar uma pull request, inspecione a descrição da PR antes de revisar o código.

Uma descrição revisável precisa responder com clareza:

- Qual problema esta PR resolve?
- Qual comportamento muda depois do merge?
- O que não muda?
- Quem ou qual fluxo é afetado?
- Como a mudança foi validada?
- Quais são os riscos?
- Como desfazer ou mitigar a mudança?

Marque a PR quando a descrição estiver vaga, genérica ou focada demais em histórico
de implementação. Peça uma reescrita antes de uma revisão profunda de código quando
a descrição não deixar a decisão de merge óbvia para quem revisa.

Prefira comentários que identifiquem o detalhe decisivo que está faltando. Não peça
detalhes sensíveis de negócio quando um resumo técnico seguro for suficiente.

Procure estes problemas na descrição da PR:

- ausência de problema claro;
- ausência de mudança concreta de comportamento;
- ausência de comandos ou evidências de validação;
- ausência de seção de riscos ou rollback;
- logs, histórico de chat ou cronologia de implementação irrelevantes;
- afirmações como "testado" sem dizer o que foi testado;
- dados sensíveis de negócio ou cliente que deveriam ser resumidos com segurança.

Na revisão de código, mantenha o feedback acionável e focado em comportamento,
segurança, compatibilidade, testes e manutenibilidade.
