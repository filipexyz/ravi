# Por Que Este Roadmap

Existem duas linhas de implementação úteis, mas incompletas:

- uma branch com Slack nativo básico rodando dentro do daemon;
- uma branch com runner/outbound separado, mas sem adapter Slack.

Mergear a branch Slack diretamente colocaria Socket Mode e token de plataforma dentro do `ravi daemon`, contrariando a arquitetura-alvo.

O roadmap consolida as duas metades na ordem correta: credenciais, processo separado, adapter, outbound durável e smoke real.

