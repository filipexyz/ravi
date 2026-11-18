import { test, expect } from "bun:test";
import { convitDelegation } from "./delegation.js";
const read = [
  "execute:group:apps",
  "use:app:convit-omie",
  "read:omie:produtos.pedido.ListarPedidos",
  "use:credential:omie:convit-pedidos",
  "execute:omie:produtos/pedido:ListarPedidos",
  "use:credential:slack:cassia-slack",
  "execute:slack:conversations.members",
];
test("list delegates only its read capabilities despite a ceiling containing writes", () => {
  expect(
    convitDelegation(
      "convit-omie.list",
      undefined,
      [],
      [...read, "execute:app:convit-omie", "execute:omie:produtos/pedido:ExcluirPedido"],
    ),
  ).toEqual(read);
});
test("generic api-read resolves the exact operation", () => {
  expect(
    convitDelegation("convit-omie.api-read", undefined, ["--operation", "produtos/pedido:ListarPedidos"], read),
  ).toEqual(read);
});
test("missing declared capability fails instead of widening or silently dropping it", () => {
  expect(() => convitDelegation("convit-omie.list", undefined, [], read.slice(1))).toThrow("Manifesto");
});
test("unknown operations and personal account endpoints fail closed", () => {
  expect(() =>
    convitDelegation("convit-omie.api-read", undefined, ["--operation", "portal/apps:ListarAplicativos"], read),
  ).toThrow();
  expect(() => convitDelegation("convit-omie.mystery", undefined, [], read)).toThrow();
  expect(convitDelegation("convit-omie.api-preview", undefined, [], [])).toEqual([]);
});
