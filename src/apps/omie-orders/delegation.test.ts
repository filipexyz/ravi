import { SCOPE } from "./test-scope.js";
import { test, expect } from "bun:test";
import { omieDelegation } from "./delegation.js";
const read = [
  "execute:group:apps",
  "use:app:omie-orders",
  "read:omie:produtos.pedido.ListarPedidos",
  "use:credential:omie:example-orders",
  "execute:omie:produtos/pedido:ListarPedidos",
  "use:credential:slack:example-slack-connection",
  "execute:slack:conversations.members",
];
test("list delegates only its read capabilities despite a ceiling containing writes", () => {
  expect(
    omieDelegation(
      "omie-orders.list",
      undefined,
      [],
      [...read, "execute:app:omie-orders", "execute:omie:produtos/pedido:ExcluirPedido"],
      SCOPE,
    ),
  ).toEqual(read);
});
test("generic api-read resolves the exact operation", () => {
  expect(
    omieDelegation("omie-orders.api-read", undefined, ["--operation", "produtos/pedido:ListarPedidos"], read, SCOPE),
  ).toEqual(read);
});
test("missing declared capability fails instead of widening or silently dropping it", () => {
  expect(() => omieDelegation("omie-orders.list", undefined, [], read.slice(1), SCOPE)).toThrow("Manifesto");
});
test("unknown operations and personal account endpoints fail closed", () => {
  expect(() =>
    omieDelegation("omie-orders.api-read", undefined, ["--operation", "portal/apps:ListarAplicativos"], read, SCOPE),
  ).toThrow();
  expect(() => omieDelegation("omie-orders.mystery", undefined, [], read, SCOPE)).toThrow();
  expect(omieDelegation("omie-orders.api-preview", undefined, [], [])).toEqual([]);
});
