import { describe, expect, test } from "bun:test";

import { checkKindFiles, fileContent, starterFiles, withEditedFile, withFile } from "./kind-files";

describe("withFile and withEditedFile", () => {
  const files = [
    { path: "widget.html", content: "a" },
    { path: "widget.json", content: "b" },
  ];

  test("replaces, adds at the end and removes", () => {
    expect(withFile(files, "widget.html", "x").map((file) => file.content)).toEqual(["x", "b"]);
    expect(withFile(files, "example.json", "{}").map((file) => file.path)).toEqual(["widget.html", "widget.json", "example.json"]);
    expect(withFile(files, "widget.json", null).map((file) => file.path)).toEqual(["widget.html"]);
    expect(files[0]?.content).toBe("a");
  });

  test("an optional file left blank is removed; a required one is kept empty", () => {
    const withExample = withFile(files, "example.json", "{}");
    expect(fileContent(withEditedFile(withExample, "example.json", "  \n"), "example.json")).toBeUndefined();
    expect(fileContent(withEditedFile(files, "widget.html", ""), "widget.html")).toBe("");
  });
});

describe("starterFiles and checkKindFiles", () => {
  test("a new widget starts from the catalog's example, which compiles", () => {
    const files = starterFiles("widget");
    expect(files.map((file) => file.path).sort()).toEqual(["example.json", "widget.html", "widget.json"]);
    const check = checkKindFiles("widget", files);
    expect(check.errors).toEqual([]);
    expect(check.name).toBe("Cartão de pedido");
    expect(check.description).toBeTruthy();
  });

  test("a new theme starts from the default tokens without a name or description", () => {
    const files = starterFiles("theme");
    expect(files.map((file) => file.path).sort()).toEqual(["fields.json", "theme.json"]);
    const check = checkKindFiles("theme", files);
    expect(check.errors).toEqual([]);
    expect(check.name).toBeNull();
    expect(check.description).toBeNull();
    expect(check.diagnostics.some((diagnostic) => diagnostic.code === "THEME_DESCRIPTION_MISSING")).toBe(true);
  });

  test("reports the compiler's errors", () => {
    const check = checkKindFiles("widget", [{ path: "widget.html", content: "<ravi-card></ravi-card>" }]);
    expect(check.errors.length).toBeGreaterThan(0);
    expect(check.description).toBeNull();
  });
});
