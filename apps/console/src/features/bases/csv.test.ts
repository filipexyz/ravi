import { describe, expect, test } from "bun:test";

import type { BaseQueryResponse, BaseRow, BaseViewColumn } from "@/shared/bases/types";
import { buildCsv, collectExportRows, csvCell, csvFileName, EXPORT_PAGE_SIZE } from "./csv";

const column = (key: string, name: string, type: BaseViewColumn["type"], config: BaseViewColumn["config"] = {}): BaseViewColumn => ({
  config,
  key,
  name,
  required: false,
  type,
});

function row(id: string, values: BaseRow["values"], body?: string | null): BaseRow {
  return { body, rowId: id, values, version: 1 };
}

describe("csvCell", () => {
  test("quotes commas, quotes, line breaks and edge spaces", () => {
    expect(csvCell("simples")).toBe("simples");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell("linha 1\nlinha 2")).toBe('"linha 1\nlinha 2"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell(" com espaço")).toBe('" com espaço"');
    expect(csvCell("")).toBe("");
  });

  test("neutralizes cells a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("a=b")).toBe("a=b");
  });

  test("keeps plain negative numbers in number columns, never formulas", () => {
    expect(csvCell("-1.234,5", true)).toBe('"-1.234,5"');
    expect(csvCell("-12%", true)).toBe("-12%");
    expect(csvCell("-12", false)).toBe("'-12");
    expect(csvCell("-1+cmd", true)).toBe("'-1+cmd");
    expect(csvCell("=1", true)).toBe("'=1");
  });
});

describe("buildCsv", () => {
  test("projects the columns with the table's display formatting", () => {
    const columns = [
      column("titulo", "Título", "text"),
      column("valor", "Valor", "number", { currency: "BRL", format: "currency" }),
      column("feito", "Feito", "checkbox"),
      column("status", "Status", "select", { options: [{ color: "green", id: "s1", name: "Aberto" }] }),
      column("aprovacao", "Aprovação", "approval"),
      column("resumo", "Resumo", "agent", { output: "text" }),
      column("body", "Corpo", "body"),
    ];
    const users = { u1: { avatarUrl: null, displayName: "Ana", id: "u1" } };
    const csv = buildCsv(
      columns,
      [
        row(
          "r1",
          {
            aprovacao: { decidedAt: "2026-10-19T12:00:00.000Z", decidedBy: "u1", note: null, requestedAt: null, requestedBy: null, state: "approved" },
            feito: true,
            resumo: { error: null, inputsHash: "h", state: "done", updatedAt: "2026-10-19T12:00:00.000Z", value: "=cmd" },
            status: "s1",
            titulo: "Contrato, v2",
            valor: -1234.5,
          },
          "# Nota\nlinha",
        ),
        row("r2", { feito: false }, null),
      ],
      users,
      "America/Sao_Paulo",
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Título,Valor,Feito,Status,Aprovação,Resumo,Corpo");
    // Intl writes "-R$ 1.234,50" with a no-break space; it starts with "-" and has letters, so it gets the quote.
    expect(lines[1]).toBe(`"Contrato, v2","'-R$ 1.234,50",Sim,Aberto,Aprovado por Ana,'=cmd,"# Nota\nlinha"`);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines[2]).toBe(",,Não,,,,");
  });
});

describe("csvFileName", () => {
  test("is <base-slug>-<view-name>.csv with a safe view name", () => {
    expect(csvFileName("tarefas", "Minhas tarefas")).toBe("tarefas-minhas-tarefas.csv");
    expect(csvFileName("vendas", "Ação / Revisão: 2026")).toBe("vendas-acao-revisao-2026.csv");
    expect(csvFileName("vendas", "!!!")).toBe("vendas-view.csv");
  });
});

describe("collectExportRows", () => {
  function pager(total: number) {
    const calls: Array<{ cursor: string | null; limit: number }> = [];
    const fetchPage = async (cursor: string | null, limit: number): Promise<BaseQueryResponse> => {
      calls.push({ cursor, limit });
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(start + limit, total);
      const rows = Array.from({ length: end - start }, (_, index) => row(`r${start + index}`, {}));
      return {
        columns: ["titulo"],
        nextCursor: end < total ? String(end) : null,
        rows,
        users: { [`u${start}`]: { avatarUrl: null, displayName: null, id: `u${start}` } },
      };
    };
    return { calls, fetchPage };
  }

  test("pages until the view ends", async () => {
    const { calls, fetchPage } = pager(1_200);
    const progress: number[] = [];
    const result = await collectExportRows(fetchPage, { onProgress: (count) => progress.push(count) });
    expect(result.rows).toHaveLength(1_200);
    expect(result.truncated).toBe(false);
    expect(result.columns).toEqual(["titulo"]);
    expect(Object.keys(result.users)).toEqual(["u0", "u500", "u1000"]);
    expect(calls.map((call) => call.limit)).toEqual([EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE]);
    expect(progress).toEqual([500, 1_000, 1_200]);
  });

  test("stops at the row limit and says the file is truncated", async () => {
    const { calls, fetchPage } = pager(12_000);
    const result = await collectExportRows(fetchPage);
    expect(result.rows).toHaveLength(10_000);
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(20);
  });

  test("asks only for the rows that still fit", async () => {
    const { calls, fetchPage } = pager(800);
    const result = await collectExportRows(fetchPage, { max: 700 });
    expect(result.rows).toHaveLength(700);
    expect(result.truncated).toBe(true);
    expect(calls.map((call) => call.limit)).toEqual([500, 200]);
  });

  test("a view the member is not admitted to exports only the header", async () => {
    const result = await collectExportRows(async () => ({
      columns: ["titulo"],
      nextCursor: null,
      rows: [],
      users: {},
      viewingAs: { admitted: false, userId: "u1" },
    }));
    expect(result.rows).toEqual([]);
    expect(result.viewingAs).toEqual({ admitted: false, userId: "u1" });
  });

  test("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collectExportRows(pager(10).fetchPage, { signal: controller.signal })).rejects.toThrow();
  });
});
