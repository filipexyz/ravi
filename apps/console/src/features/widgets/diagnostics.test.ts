import { describe, expect, test } from "bun:test";

import type { Diagnostic } from "@/shared/widgets/types";

import {
  countDiagnostics,
  diagnosticLines,
  diagnosticsFromError,
  diagnosticsSummary,
  diagnosticWhere,
  sortDiagnosticsForDisplay,
} from "./diagnostics";

const error = (file: string | undefined, line?: number, column?: number): Diagnostic => ({
  severity: "error",
  code: "X",
  message: "m",
  ...(file ? { file } : {}),
  ...(line ? { line } : {}),
  ...(column ? { column } : {}),
});
const warning = (file: string, line?: number): Diagnostic => ({ ...error(file, line), severity: "warning" });

describe("diagnosticWhere", () => {
  test("says as much of the place as the diagnostic gives", () => {
    expect(diagnosticWhere(error("widget.html", 12, 5))).toBe("widget.html:12:5");
    expect(diagnosticWhere(error("theme.json", 3))).toBe("theme.json:3");
    expect(diagnosticWhere(error("example.json"))).toBe("example.json");
    expect(diagnosticWhere(error(undefined))).toBe("");
  });
});

describe("sortDiagnosticsForDisplay", () => {
  test("puts errors first, then files in editor order, then lines and columns", () => {
    const list = [
      warning("widget.html", 1),
      error("widget.json", 2),
      error("widget.html", 9, 4),
      error("widget.html", 9, 2),
      error(undefined),
      error("README.md"),
    ];
    expect(sortDiagnosticsForDisplay(list).map(diagnosticWhere)).toEqual([
      "widget.html:9:2",
      "widget.html:9:4",
      "widget.json:2",
      "README.md",
      "",
      "widget.html:1",
    ]);
  });

  test("does not change the input", () => {
    const list = [warning("a"), error("b")];
    sortDiagnosticsForDisplay(list);
    expect(list[0]?.severity).toBe("warning");
  });
});

describe("counts and summary", () => {
  test("counts errors and warnings and says them in PT-BR", () => {
    const list = [error("a"), error("b"), warning("c")];
    expect(countDiagnostics(list)).toEqual({ errors: 2, warnings: 1 });
    expect(diagnosticsSummary(list)).toBe("2 erros e 1 aviso");
    expect(diagnosticsSummary([warning("c"), warning("d")])).toBe("2 avisos");
    expect(diagnosticsSummary([error("a")])).toBe("1 erro");
    expect(diagnosticsSummary([])).toBe("Nenhum problema");
  });
});

describe("diagnosticLines", () => {
  test("marks each line of one file, errors winning over warnings", () => {
    const lines = diagnosticLines([warning("widget.html", 3), error("widget.html", 3), warning("widget.html", 5), error("widget.json", 3)], "widget.html");
    expect([...lines.entries()]).toEqual([
      [3, "error"],
      [5, "warning"],
    ]);
  });
});

describe("diagnosticsFromError", () => {
  test("reads details.diagnostics from an API error body", () => {
    const failure = {
      extra: {
        body: {
          error: "PAYLOAD_INVALID",
          details: { diagnostics: [error("widget.html", 2, 3), { severity: "info", code: 1 }, "x"] },
        },
      },
    };
    expect(diagnosticsFromError(failure)).toEqual([error("widget.html", 2, 3)]);
  });

  test("is null without a diagnostics list", () => {
    expect(diagnosticsFromError(null)).toBeNull();
    expect(diagnosticsFromError(new Error("x"))).toBeNull();
    expect(diagnosticsFromError({ extra: { body: { details: { diagnostics: [] } } } })).toBeNull();
  });
});
