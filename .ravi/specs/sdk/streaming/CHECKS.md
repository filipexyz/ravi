# Streaming / CHECKS

## Checks

### Pre-implementation Guardrails (ativos hoje)

Estas verificações garantem que o bug latente do gateway permanece fechado
até a spec ser materializada.

1. **Nenhum handler streaming/process/interactive escapa pra route-table**

   ```bash
   bun -e '
   import { getRegistry } from "./src/cli/registry-snapshot.js";
   import { buildRouteTable } from "./src/sdk/gateway/route-table.js";
   const reg = getRegistry();
   const table = buildRouteTable(reg);
   const banned = ["events.stream","events.replay","tasks.watch","tmux.watch","tmux.attach","instances.connect","sessions.debug","daemon.run","daemon.dev"];
   const leaked = banned.filter(name => {
     const cmd = reg.commands.find(c => c.fullName === name);
     return cmd && [...table.byPath.values()].includes(cmd);
   });
   if (leaked.length) { console.error("LEAK:", leaked); process.exit(1); }
   console.log("ok: all banned handlers excluded");
   '
   ```

   Espera-se: `ok: all banned handlers excluded`.

2. **OpenAPI spec não inclui paths streaming**

   ```bash
   jq -r '.paths | keys[] | select(test("/(stream|watch|connect|debug|attach|run|dev)$"))' \
     docs/openapi.json
   ```

   Espera-se: vazio.

3. **SDK codegen não emite método pra cliOnly**

   ```bash
   grep -E "(stream|watch|connect|debug|attach):" \
     packages/sdk/src/client.ts | grep -v "^//"
   ```

   Espera-se: vazio (modulo descrições/comments).

### Post-implementation Checks (a ativar quando primeiro channel for materializado)

4. **Auth obrigatória em /api/v1/_stream/**: request sem Bearer retorna 401.

5. **Audit envelope casado**: `sdk.gateway.stream.opened` sempre tem
   `sdk.gateway.stream.closed` correspondente em até 1 hora.

6. **Keepalive presente**: cliente conectado por 30s+ recebe pelo menos 1
   `: ping`.

7. **Drop-tail funciona**: cliente com socket lento não trava o publisher
   upstream — sem backpressure no NATS subject.

8. **Reconnect com Last-Event-ID**: cliente reconectando recebe eventos a
   partir do último `id:` reportado, não desde o início.

### Regressões a Prevenir

- **Bug que esta spec consertou:** request `/api/v1/events/stream` ficar
  pendurada eternamente sem audit. Garantir que adicionar handler streaming
  novo sem `@CliOnly()` (ou sem registrar como channel) seja erro de build,
  não erro silencioso em runtime.

- **Vazamento de context-key:** stream que abre context-key e não fecha em
  desconexão deixa context vivo no DB. Quando implementar, garantir cleanup
  no `onclose` do socket SSE.

- **Confusão de prefixos:** se algum handler novo tentar registrar
  `/_stream/<channel>` colidindo com handler dispatcher, gateway MUST
  detectar collision em build do route-table e falhar.
