import { describe, expect, test } from "bun:test";

import { cliErrorPayload } from "@/server/cli/errors";

import { pageKitInvalidError } from "./service";

describe("pageKitInvalidError", () => {
  test("error diagnostics become 422 KIT_INVALID with the diagnostics and warnings in details", () => {
    const diagnostics = [
      { severity: "error" as const, code: "WIDGET_FIELD_MISSING", message: "Required widget field titulo (text) matches no column.", path: "index.html", line: 12, column: 5 },
      { severity: "warning" as const, code: "KIT_ATTRIBUTE_UNKNOWN", message: "<ravi-view> does not take colour.", path: "index.html", line: 3, column: 1 },
    ];
    const error = pageKitInvalidError({ diagnostics, warnings: ["Theme changed since the last publish of /: org/acme v2 -> v3."] });
    expect(error?.status).toBe(422);
    expect(cliErrorPayload(error!, "req_1")).toEqual({
      error: {
        code: "KIT_INVALID",
        message: "The page kit found 1 error; fix them and ship again.",
        requestId: "req_1",
        details: { diagnostics, warnings: ["Theme changed since the last publish of /: org/acme v2 -> v3."] },
      },
    });
  });

  test("warnings alone are not an error", () => {
    expect(pageKitInvalidError({ diagnostics: [{ severity: "warning", code: "KIT_VIEW_UNAVAILABLE", message: "x" }], warnings: [] })).toBeNull();
  });
});
