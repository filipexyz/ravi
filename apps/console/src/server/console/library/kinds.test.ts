import { describe, expect, test } from "bun:test";

import { CliApiError } from "@/server/cli/errors";

import { assertSlugAllowed, kindFromSegment, kindSearchBody, kindText, prepareKindFiles, widgetFieldsSearchText } from "./kinds";

function caught(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return error as CliApiError;
  }
  throw new Error("expected an error");
}

describe("library kinds", () => {
  test("URL segments name the four kinds and nothing else", () => {
    expect(["skills", "agents", "themes", "widgets"].map(kindFromSegment)).toEqual(["skill", "agent", "theme", "widget"]);
    for (const segment of ["skill", "constructor", "toString", "__proto__", "", undefined]) expect(kindFromSegment(segment)).toBeNull();
  });

  test("route words are reserved per kind", () => {
    expect(caught(() => assertSlugAllowed("theme", "active")).details).toEqual({ reason: "slug_reserved", conflict: "slug_reserved" });
    expect(caught(() => assertSlugAllowed("widget", "preview")).details).toEqual({ reason: "slug_reserved", conflict: "slug_reserved" });
    expect(caught(() => assertSlugAllowed("skill", "pages")).details).toEqual({ reason: "slug_reserved", conflict: "slug_reserved" });
    // A bare `none` or `default` ref means no theme or the built-in one; `none` unbinds a view's widget.
    for (const slug of ["none", "default"]) expect(caught(() => assertSlugAllowed("theme", slug)).details).toEqual({ reason: "slug_reserved", conflict: "slug_reserved" });
    expect(caught(() => assertSlugAllowed("widget", "none")).details).toEqual({ reason: "slug_reserved", conflict: "slug_reserved" });
    expect(() => assertSlugAllowed("widget", "default")).not.toThrow();
    expect(() => assertSlugAllowed("widget", "active")).not.toThrow();
    expect(() => assertSlugAllowed("theme", "pages")).not.toThrow();
    expect(() => assertSlugAllowed("agent", "proposals")).not.toThrow();
  });

  test("themes and widgets hold only their files", () => {
    const theme = (extra: { path: string; content: string }[]) => () => prepareKindFiles("theme", [{ path: "theme.json", content: "{}" }, ...extra]);
    expect(caught(theme([{ path: "app.js", content: "x" }])).message).toContain("app.js");
    expect(caught(() => prepareKindFiles("widget", [{ path: "widget.html", content: "" }])).message).toContain("widget.json");
    expect(caught(() => prepareKindFiles("theme", [{ path: "README.md", content: "x" }])).message).toContain("theme.json");
  });

  test("names and descriptions fall back to the files for themes and widgets only", () => {
    const meta = { name: " Clínica ", description: "Do arquivo" };
    expect(kindText({ kind: "theme", name: undefined, description: undefined, meta, fallbackName: "slug", what: "publish" })).toEqual({
      name: "Clínica",
      description: "Do arquivo",
    });
    expect(kindText({ kind: "widget", name: "Corpo", description: "Do corpo", meta, fallbackName: "slug", what: "publish" })).toEqual({
      name: "Corpo",
      description: "Do corpo",
    });
    expect(caught(() => kindText({ kind: "skill", name: undefined, description: undefined, meta, fallbackName: "slug", what: "publish" })).code).toBe(
      "PAYLOAD_INVALID",
    );
    expect(kindText({ kind: "theme", name: undefined, description: "x", meta: { name: null, description: null }, fallbackName: "slug", what: "publish" }).name).toBe(
      "slug",
    );
    expect(
      caught(() => kindText({ kind: "theme", name: undefined, description: undefined, meta: { name: null, description: "x".repeat(1025) }, fallbackName: "s", what: "publish" }))
        .code,
    ).toBe("PAYLOAD_INVALID");
  });

  test("a widget's search body lists its fields", () => {
    const manifest = JSON.stringify({
      name: "Pedido",
      description: "x",
      fields: { prazo_final: { type: "date", label: "Prazo" }, responsavel: { type: "person", role: "avatar", description: "Quem cuida" } },
    });
    expect(widgetFieldsSearchText(manifest)).toBe("prazo_final Prazo date\nresponsavel person avatar Quem cuida");
    expect(widgetFieldsSearchText("{not json")).toBe("");
    expect(kindSearchBody("widget", [{ path: "widget.json", content: manifest }, { path: "README.md", content: "Leia" }])).toContain("Leia");
    expect(kindSearchBody("theme", [{ path: "theme.json", content: "{}" }])).toBe("");
    expect(kindSearchBody("skill", [{ path: "SKILL.md", content: "body" }])).toBe("body");
  });
});
