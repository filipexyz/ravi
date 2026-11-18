import { findOperation, catalogue } from "./catalogue.js";
import { AppError } from "./domain.js";

/** context.allow remains a ceiling. The host-registered client only requests
 * the capabilities of this invocation, never all writes when launching a read. */
export function convitDelegation(
  operationId: string,
  permission: string | undefined,
  args: string[],
  ceiling: string[],
): string[] {
  const name = operationId.replace(/^convit-omie\./, "");
  if (
    [
      "help",
      "health",
      "check",
      "show",
      "self-test",
      "api-self-test",
      "catalogue",
      "api-describe",
      "api-preview",
      "host-status",
      "webhook-status",
    ].includes(name)
  )
    return [];
  const simple: Record<string, string> = {
    list: "produtos/pedido:ListarPedidos",
    get: "produtos/pedido:ConsultarPedido",
    stages: "produtos/etapafat:ListarEtapasFaturamento",
  };
  const flag = args.indexOf("--operation");
  const id = simple[name] ?? (flag >= 0 ? args[flag + 1] : catalogue.find((op) => op.permission === permission)?.id);
  if (!id) throw new AppError("OMIE_OPERATION_NOT_FOUND", "Operação não disponível no executor de pedidos.");
  const op = findOperation(id);
  const selected = [
    "execute:group:apps",
    "use:app:convit-omie",
    op.permission,
    "use:credential:omie:convit-pedidos",
    `execute:omie:${op.id}`,
    "use:credential:slack:cassia-slack",
    "execute:slack:conversations.members",
  ];
  if (op.classification !== "read")
    throw new AppError("OMIE_READ_ONLY_HOST", "Executor de consultas; escritas não habilitadas.");
  // Exact entries: a manifest may not substitute broader wildcard requests.
  if (selected.some((cap) => !ceiling.includes(cap)))
    throw new AppError("OMIE_DELEGATION_MISSING", "Manifesto não declara a delegação mínima da operação.");
  return [...new Set(selected)];
}
