import { loadOmieScope, OMIE_APP_ACCESS, type OmieScope } from "./scope.js";
import { findOperation, catalogue } from "./catalogue.js";
import { AppError } from "./domain.js";
import { resolveOmieConversationAuthority } from "./conversation-authority.js";

/** context.allow remains a ceiling. The host-registered client only requests
 * the capabilities of this invocation, never all writes when launching a read. */
export function omieDelegation(
  operationId: string,
  permission: string | undefined,
  args: string[],
  ceiling: string[],
  scope?: OmieScope,
): string[] {
  const name = operationId.replace(/^omie-orders\./, "");
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
  const binding = scope ?? loadOmieScope();
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
    // The caller's own form of access to `apps run`, the first one the manifest ceiling declares.
    OMIE_APP_ACCESS.find((access) => ceiling.includes(access)) ?? OMIE_APP_ACCESS[OMIE_APP_ACCESS.length - 1],
    "use:app:omie-orders",
    op.permission,
    `use:credential:omie:${binding.connection}`,
    `execute:omie:${op.id}`,
    ...resolveOmieConversationAuthority(binding.channelType).capabilities(binding),
  ];
  if (op.classification !== "read")
    throw new AppError("OMIE_READ_ONLY_HOST", "Executor de consultas; escritas não habilitadas.");
  // Exact entries: a manifest may not substitute broader wildcard requests.
  if (selected.some((cap) => !ceiling.includes(cap)))
    throw new AppError("OMIE_DELEGATION_MISSING", "Manifesto não declara a delegação mínima da operação.");
  return [...new Set(selected)];
}
