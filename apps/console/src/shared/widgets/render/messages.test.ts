import { describe, expect, test } from "bun:test";

import { messageLocale, messages } from "./messages";

describe("messages", () => {
  test("pt-BR is the product default for Portuguese; anything else falls back to en", () => {
    expect(messageLocale("pt-BR")).toBe("pt-BR");
    expect(messageLocale("pt")).toBe("pt-BR");
    expect(messageLocale("PT_br")).toBe("pt-BR");
    expect(messageLocale("en-GB")).toBe("en");
    expect(messageLocale("es")).toBe("en");
    expect(messageLocale("")).toBe("en");
    expect(messageLocale(null)).toBe("en");
    expect(messages("fr").locale).toBe("en");
  });

  test("both tables have the same keys", () => {
    expect(Object.keys(messages("pt-BR")).sort()).toEqual(Object.keys(messages("en")).sort());
  });

  test("runtime states in pt-BR", () => {
    const pt = messages("pt-BR");
    expect(pt.loading).toBe("Carregando…");
    expect(pt.conflict).toBe("Alguém mudou esta linha");
    expect(pt.paused).toBe("Dados pausados pelo operador");
    expect(pt.continue).toBe("Continuar");
    expect(pt.statusRegion).toBe("esta página");
    expect(pt.moveTo).toBe("Mover para…");
    expect(pt.moveToFor("Pedido 123")).toBe("Mover para…: Pedido 123");
    expect(pt.laneNoValue).toBe("Sem valor");
    for (const key of ["empty", "error", "noPermission", "writePending", "capture", "sessionExpired"] as const) {
      expect(pt[key].length).toBeGreaterThan(3);
    }
  });

  test("counts and lanes", () => {
    const pt = messages("pt-BR");
    const en = messages("en");
    expect(pt.count(0)).toBe("0 itens");
    expect(pt.count(1)).toBe("1 item");
    expect(pt.count(3)).toBe("3 itens");
    expect(pt.count(1200)).toBe("1.200 itens");
    expect(en.count(3)).toBe("3 items");
    expect(en.count(1)).toBe("1 item");
    expect(pt.lane("A fazer", 3)).toBe("A fazer (3)");
    expect(en.lane("To do", 1200)).toBe("To do (1,200)");
    expect(pt.outOf("4", "5")).toBe("4 de 5");
    expect(en.outOf("4", "5")).toBe("4 of 5");
  });

  test("confirmations come from the action (verb, record, columns, values)", () => {
    const pt = messages("pt-BR");
    const en = messages("en");
    expect(pt.confirmTitle("archive")).toBe("Arquivar este item?");
    expect(pt.confirmBody("archive", "Pedido 123", [])).toBe("“Pedido 123” será arquivado e sai desta lista.");
    expect(pt.confirmBody("update", "Pedido 123", [{ label: "Status", value: "Entregue" }])).toBe("Em “Pedido 123”: Status passa a ser Entregue.");
    expect(pt.confirmBody("create", "", [{ label: "Status", value: "A fazer" }, { label: "Prazo", value: "hoje" }])).toBe(
      "Um item novo será criado com Status: A fazer; Prazo: hoje.",
    );
    expect(pt.confirmBody("update", "", [])).toBe("Este item será alterado.");
    expect(en.confirmBody("archive", "", [])).toBe("This item will be archived and leave this list.");
    expect(pt.confirmAction("archive")).toBe("Arquivar");
    expect(en.confirmBody("update", "Order 1", [{ label: "Status", value: "Done" }])).toBe("In “Order 1”: Status becomes Done.");
    expect(en.confirmAction("create")).toBe("Create");
    expect(en.cancel).toBe("Cancel");
  });
});
