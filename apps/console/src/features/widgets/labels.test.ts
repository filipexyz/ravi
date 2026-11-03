import { describe, expect, test } from "bun:test";

import { FIELD_ROLE_DISPLAYS, FIELD_ROLES, FIELD_TYPE_DISPLAYS, WIDGET_FIELD_TYPES } from "@/shared/widgets/types";

import { actionSummary, DISPLAY_KEY_WORDS, DISPLAY_WORDS, FIELD_ROLE_WORDS, FIELD_TYPE_WORDS, setValueText } from "./labels";

describe("words", () => {
  test("cover every type, role and display of the closed lists", () => {
    for (const type of WIDGET_FIELD_TYPES) expect(FIELD_TYPE_WORDS[type]).toBeTruthy();
    for (const role of FIELD_ROLES) expect(FIELD_ROLE_WORDS[role]).toBeTruthy();
    for (const [key, displays] of Object.entries(FIELD_TYPE_DISPLAYS)) {
      expect(DISPLAY_KEY_WORDS[key as keyof typeof DISPLAY_KEY_WORDS]).toBeTruthy();
      for (const display of displays) expect(DISPLAY_WORDS[display]).toBeTruthy();
    }
    for (const displays of Object.values(FIELD_ROLE_DISPLAYS)) for (const display of displays) expect(DISPLAY_WORDS[display]).toBeTruthy();
  });
});

describe("actions", () => {
  test("writes set values as the template does", () => {
    expect(setValueText({ kind: "status_group", group: "done" })).toBe("@done");
    expect(setValueText({ kind: "today" })).toBe("@today");
    expect(setValueText({ kind: "bool", value: false })).toBe("false");
    expect(setValueText({ kind: "number", value: 12.5 })).toBe("12.5");
    expect(setValueText({ kind: "literal", value: "Pago" })).toBe("Pago");
  });

  test("says what a button does", () => {
    expect(
      actionSummary({ verb: "update", set: { status: { kind: "status_group", group: "done" }, pago: { kind: "bool", value: true } }, href: null, confirm: false, label: "Concluir" }),
    ).toBe("Atualiza o registro: status=@done; pago=true");
    expect(actionSummary({ verb: "archive", set: {}, href: null, confirm: true, label: "Arquivar" })).toBe("Arquiva o registro");
    expect(actionSummary({ verb: "open", set: {}, href: "link", confirm: false, label: "Abrir" })).toBe("Abre o link do campo link");
    expect(actionSummary({ verb: "open", set: {}, href: null, confirm: false, label: "Ver" })).toBe("Abre os detalhes do registro");
  });
});
