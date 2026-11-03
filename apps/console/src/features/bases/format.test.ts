import { describe, expect, test } from "bun:test";

import type { BaseProperty, BaseViewColumn } from "@/shared/bases/types";
import {
  approvalWords,
  asAgentValue,
  asApprovalValue,
  defaultViewId,
  eventWords,
  filterUsesViewer,
  filterWords,
  plainValue,
  safeHttpUrl,
  sortWords,
  type AnyView,
  type DescribeContext,
} from "./format";

const ctx: DescribeContext = {
  base: {
    properties: [
      { config: {}, id: "p1", key: "dono", name: "Dono", type: "person" },
      { config: {}, id: "p2", key: "prazo", name: "Prazo", type: "date" },
    ] as unknown as BaseProperty[],
    timezone: "America/Sao_Paulo",
  },
  members: {},
};

function view(id: string, name: string, extra: { filter?: unknown; read?: boolean; aggregateOnly?: boolean } = {}) {
  return {
    access: { readers: [], writers: [] },
    capabilities: { aggregateOnly: extra.aggregateOnly ?? false, read: extra.read ?? true },
    id,
    name,
    query: { filter: extra.filter ?? null, sort: [] },
  } as unknown as AnyView;
}

describe("bases inspector helpers", () => {
  test("only http and https values become links", () => {
    expect(safeHttpUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });

  test("managers land on the unfiltered All rows view, never an aggregate-only one", () => {
    const mine = view("v-mine", "Minhas tarefas", { filter: { op: "contains_any", prop: "dono", value: "$viewer.raviUserId" } });
    expect(defaultViewId([mine, view("v-all", "All rows")])).toBe("v-all");
    expect(defaultViewId([mine, view("v-other", "Everything")])).toBe("v-other");
    expect(defaultViewId([view("v-agg", "All rows", { aggregateOnly: true }), mine])).toBe("v-mine");
    expect(defaultViewId([view("v-closed", "All rows", { read: false })])).toBeNull();
  });

  test("viewer filters are detected and described", () => {
    const filter = { op: "contains_any" as const, prop: "dono", value: "$viewer.raviUserId" };
    expect(filterUsesViewer(filter)).toBe(true);
    expect(filterUsesViewer({ and: [{ op: "is_not_empty" as const, prop: "prazo" }] })).toBe(false);
    expect(filterUsesViewer(null)).toBe(false);
    expect(filterWords(filter, ctx)).toBe("Dono inclui a pessoa que está vendo");
    expect(filterWords({ op: "nin", prop: "prazo", value: ["$today"] }, ctx)).toBe("Prazo não é hoje");
    expect(filterWords(null, ctx)).toBe("Todas as linhas");
  });

  test("sorts read as words, with the default order spelled out", () => {
    expect(sortWords([], ctx)).toBe("Na ordem em que as linhas foram adicionadas, as mais antigas primeiro");
    expect(sortWords([{ dir: "asc", prop: "prazo" }], ctx)).toBe("Prazo, mais cedo primeiro");
  });

  test("approval values read as state, who and note", () => {
    const users = { u1: { avatarUrl: null, displayName: "Ana", id: "u1" }, u2: { avatarUrl: null, displayName: "Bruno", id: "u2" } };
    const decided = asApprovalValue({
      decidedAt: "2026-10-19T12:00:00.000Z",
      decidedBy: "u1",
      note: "ok, segue",
      requestedAt: "2026-10-18T12:00:00.000Z",
      requestedBy: "u2",
      state: "approved",
    });
    expect(decided && approvalWords(decided, users)).toBe("Aprovado por Ana: “ok, segue”");
    const pending = asApprovalValue({ requestedBy: "u2", state: "pending" });
    expect(pending && approvalWords(pending, users)).toBe("Pendente, pedido por Bruno");
    expect(asApprovalValue({ state: "maybe" })).toBeNull();
    expect(asApprovalValue(null)).toBeNull();
  });

  test("agent values show the output-typed value and their state", () => {
    const column: Pick<BaseViewColumn, "type" | "config"> = {
      config: { options: [{ color: "green", id: "o1", name: "Quente" }], output: "select" },
      type: "agent",
    };
    const base = { error: null, inputsHash: "abc", updatedAt: "2026-10-19T12:00:00.000Z" };
    expect(plainValue(column, { ...base, state: "done", value: "o1" }, {}, "UTC")).toBe("Quente");
    expect(plainValue(column, { ...base, state: "pending", value: "o1" }, {}, "UTC")).toBe("Quente (preenchendo…)");
    expect(plainValue(column, { ...base, state: "pending", value: null }, {}, "UTC")).toBe("Preenchendo…");
    expect(plainValue(column, { ...base, error: "sem dados", state: "error", value: null }, {}, "UTC")).toBe("Erro: sem dados");
    const checkbox: Pick<BaseViewColumn, "type" | "config"> = { config: { output: "checkbox" }, type: "agent" };
    expect(plainValue(checkbox, { ...base, state: "done", value: false }, {}, "UTC")).toBe("Não");
    expect(asAgentValue({ state: "nope" })).toBeNull();
  });

  test("audit events get an entity and a verb, unknown ones a readable fallback", () => {
    expect(eventWords("bases.view.created")).toEqual({ entity: "view", verb: "View criada" });
    expect(eventWords("bases.view.viewed_as")).toEqual({ entity: "view", verb: "View vista como outra pessoa" });
    expect(eventWords("bases.something_new.happened")).toEqual({ entity: "base", verb: "Something new happened" });
  });
});
