# Por Que Credenciais De Canais São Um Domínio Próprio

Credenciais de canal autorizam ações externas: conectar Socket Mode, enviar mensagens, baixar arquivos, reagir e administrar recursos de plataforma.

Isso é diferente de:

- `RAVI_CONTEXT_KEY`, que autentica o runtime context do Ravi;
- `runtime.credentials`, que escolhe credenciais de providers de modelo;
- cloud auth, que autentica a CLI contra o Console.

Hermes mostra bons padrões de storage local: arquivo 0600, diretório 0700, locks, escrita atômica e supressão de fontes removidas. O Ravi deve copiar esses princípios, mas preferir um broker com metadata em SQLite e secret backend separado.

