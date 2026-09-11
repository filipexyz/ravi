# Postmortem — ambiente herdado em fixture do SDK

Data: 2026-09-10
Estado: contenção aplicada ao teste; risco do registro anterior comunicado ao usuário.

Esperava-se reproduzir a falta de filtragem em uma integração simulada do Claude. Uma asserção sobre o objeto completo de chamadas falhou e o runner imprimiu as opções, incluindo valores herdados do ambiente local. Isso criou possibilidade de exposição de credenciais no log do teste.

A causa identificada é a combinação de herança de ambiente real com uma asserção que serializa a estrutura completa ao falhar. Isolar somente o transporte do SDK não isola os dados que entram na fixture.

A fixture foi corrigida para usar ambiente controlado e comparar contagens e campos específicos. Provas posteriores usam valores sintéticos, não liberam prompts para modelos externos e não registram headers ou ambientes completos.

O usuário foi informado. Nenhuma credencial foi rotacionada, nenhum log foi apagado e os valores não foram reproduzidos neste documento. A avaliação ou rotação de credenciais potencialmente expostas depende de autorização separada; corrigir a fixture não elimina o registro já produzido.

Regra para os testes restantes: ambiente por lista explícita, credenciais fictícias e asserções que nunca imprimam snapshots, opções de SDK ou requisições completas. Evidências versionáveis guardam somente identificadores não sensíveis, contagens e resultados.
