import { describe, expect, test } from "bun:test";

import type { WidgetFieldSpec } from "../types";
import { parseSetExpression } from "./set";

const fields: Record<string, WidgetFieldSpec> = {
  status: { type: "status" },
  etapa: { type: "select" },
  nota: { type: "text" },
  pago: { type: "checkbox" },
  valor: { type: "number" },
  prazo: { type: "date" },
  dono: { type: "person" },
  tags: { type: "multi_select" },
  site: { type: "url" },
};

const codes = (text: string, verb?: "update" | "create") => parseSetExpression(text, fields, { verb }).diagnostics.map((d) => d.code);

describe("parseSetExpression", () => {
  test("every value form by type", () => {
    const { set, diagnostics } = parseSetExpression(
      "status=@done; etapa=Em análise ;nota=Revisado por Ana;pago=true;valor=-2.5;prazo=@today",
      fields,
      { verb: "update" },
    );
    expect(diagnostics).toEqual([]);
    expect(set).toEqual({
      status: { kind: "status_group", group: "done" },
      etapa: { kind: "literal", value: "Em análise" },
      nota: { kind: "literal", value: "Revisado por Ana" },
      pago: { kind: "bool", value: true },
      valor: { kind: "number", value: -2.5 },
      prazo: { kind: "today" },
    });
    expect(parseSetExpression("status=@todo;prazo=@now;dono=@me;pago=false;status_x=1", { ...fields, status_x: { type: "number" } }, { verb: "create" }).set).toEqual({
      status: { kind: "status_group", group: "todo" },
      prazo: { kind: "now" },
      dono: { kind: "me" },
      pago: { kind: "bool", value: false },
      status_x: { kind: "number", value: 1 },
    });
    expect(parseSetExpression("status=@in_progress;", fields).set).toEqual({ status: { kind: "status_group", group: "in_progress" } });
    expect(parseSetExpression("status=Aprovado", fields).set).toEqual({ status: { kind: "literal", value: "Aprovado" } });
    expect(parseSetExpression("nota=", fields).set).toEqual({ nota: { kind: "literal", value: "" } });
  });

  test("syntax errors", () => {
    expect(codes("")).toEqual(["SET_SYNTAX"]);
    expect(codes("status")).toEqual(["SET_SYNTAX"]);
    expect(codes("=@done")).toEqual(["SET_SYNTAX"]);
  });

  test("fields must exist and appear once", () => {
    expect(codes("estado=@done")).toEqual(["SET_UNKNOWN_FIELD"]);
    expect(codes("status=@done;status=@todo")).toEqual(["SET_DUPLICATE"]);
  });

  test("values must fit the field type", () => {
    expect(codes("pago=sim")).toEqual(["SET_TYPE"]);
    expect(codes("valor=dez")).toEqual(["SET_TYPE"]);
    expect(codes("prazo=2026-10-20")).toEqual(["SET_TYPE"]);
    expect(codes("prazo=@done")).toEqual(["SET_TYPE"]);
    expect(codes("etapa=@done")).toEqual(["SET_TYPE"]);
    expect(codes("etapa=")).toEqual(["SET_TYPE"]);
    expect(codes("dono=Ana")).toEqual(["SET_TYPE"]);
    expect(codes("tags=a")).toEqual(["SET_TYPE"]);
    expect(codes("site=https://a.example")).toEqual(["SET_TYPE"]);
    expect(codes("nota=@me")).toEqual(["SET_TYPE"]);
  });

  test("unknown keywords and interpolation are rejected", () => {
    expect(codes("prazo=@tomorrow")).toEqual(["SET_VALUE"]);
    expect(codes("nota={titulo}")).toEqual(["SET_VALUE"]);
  });

  test("@me only on create", () => {
    expect(codes("dono=@me", "update")).toEqual(["SET_ME"]);
    expect(codes("dono=@me", "create")).toEqual([]);
  });

  test("positions are relative to the attribute value", () => {
    const { diagnostics } = parseSetExpression("status=@done; pago=talvez", fields, { at: { line: 4, column: 40 }, file: "widget.html" });
    expect(diagnostics).toEqual([expect.objectContaining({ code: "SET_TYPE", file: "widget.html", line: 4, column: 59 })]);
  });
});
