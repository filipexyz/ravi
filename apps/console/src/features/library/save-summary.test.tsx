import { describe, expect, mock, test } from "bun:test";
import { useEffect, useRef, useState } from "react";

import { ErrorSummary, type ErrorSummaryItem } from "@/features/widgets/diagnostics-list";
import { fileContent, starterFiles, withFile } from "@/features/widgets/kind-files";
import { act, click, installTestDom, render, waitFor } from "@/features/widgets/test-dom";
import { THEME_DESCRIPTION_FIELD_ID, themeTokenInputId } from "@/features/widgets/theme-editor";
import { widgetFileInputId } from "@/features/widgets/widget-editor";
import { parseThemeDocument } from "@/shared/widgets/theme/tokens";
import type { Diagnostic } from "@/shared/widgets/types";

import { saveProblems, SLUG_FIELD_ID, stillShown, useSaveSummary } from "./save-summary";

installTestDom();

describe("saveProblems", () => {
  const TOKEN = "color.light.background.primary";
  const theme = starterFiles("theme");
  const css = parseThemeDocument(fileContent(theme, "theme.json")!).tokens[TOKEN]!;

  test("a theme token field holding text that does not parse stops the save, linked to its input", () => {
    const items = saveProblems({
      kind: "theme",
      files: theme,
      slugProblem: "Escolha o slug.",
      tokenDrafts: { [TOKEN]: { source: css, text: "#12345" } },
    });
    expect(items.map((item) => [item.key, item.target, item.text])).toEqual([
      ["slug", SLUG_FIELD_ID, "Escolha o slug."],
      ["description", THEME_DESCRIPTION_FIELD_ID, "Escreva a descrição do tema."],
      [`token:${TOKEN}`, themeTokenInputId(TOKEN), "Fundo principal (claro): Use #rgb, #rrggbb ou #rrggbbaa."],
    ]);
    // The same draft once the person fixed it is no problem.
    expect(saveProblems({ kind: "theme", files: theme, slugProblem: null, tokenDrafts: { [TOKEN]: { source: css, text: "#fff" } } })).toHaveLength(1);
  });

  test("a compile error is keyed by what it is, not where, and links to its file", () => {
    const broken = withFile(starterFiles("widget"), "widget.json", '{ "name": ');
    const [item] = saveProblems({ kind: "widget", files: broken, slugProblem: null });
    expect(item?.target).toBe(widgetFileInputId("widget.json"));
    expect(item?.text).toMatch(/^widget\.json:1:\d+: /);
    const moved = saveProblems({ kind: "widget", files: withFile(broken, "widget.json", '\n\n{ "name": '), slugProblem: null });
    expect(moved[0]?.key).toBe(item!.key);
    expect(moved[0]?.text).toMatch(/^widget\.json:3:\d+: /);
  });

  test("adds the server's errors the browser does not find, once", () => {
    const files = starterFiles("widget");
    const server: Diagnostic[] = [
      { severity: "error", code: "WIDGET_NEWER_RULE", message: "Uma regra que só o servidor conhece.", file: "widget.html", line: 2 },
      { severity: "warning", code: "WIDGET_HINT", message: "Só um aviso.", file: "widget.html", line: 3 },
    ];
    expect(saveProblems({ kind: "widget", files, slugProblem: null })).toEqual([]);
    const items = saveProblems({ kind: "widget", files, slugProblem: null, server: [...server, server[0]!] });
    expect(items.map((item) => item.text)).toEqual(["widget.html:2: Uma regra que só o servidor conhece."]);
  });

  test("stillShown keeps what was shown, in the current order, and adds nothing", () => {
    const item = (key: string): ErrorSummaryItem => ({ key, target: "", text: key });
    expect(stillShown(new Set(["a", "b"]), [item("c"), item("b"), item("a")]).map((entry) => entry.key)).toEqual(["b", "a"]);
  });
});

// A stand-in for the Library editor: "err:<x>" words in the text are its problems, and Salvar runs
// the same sequence as `save()` there (check, send, refused).
const controls: { setText?: (text: string) => void } = {};

function problemsOf(text: string, server: readonly Diagnostic[] | null): ErrorSummaryItem[] {
  return [
    ...text
      .split(/\s+/)
      .filter((word) => word.startsWith("err:"))
      .map((word) => ({ key: word, target: "", text: `Problema ${word.slice(4)}` })),
    ...(server ?? []).map((diagnostic) => ({ key: `server:${diagnostic.code}`, target: "", text: diagnostic.message, diagnostic })),
  ];
}

function FakeEditor({ send }: { send: (text: string) => Promise<Diagnostic[] | null> }) {
  const [text, setText] = useState("");
  const summaryElement = useRef<HTMLElement>(null);
  const summary = useSaveSummary(summaryElement, (server) => problemsOf(text, server));
  useEffect(() => {
    controls.setText = (next) => {
      setText(next);
      summary.filesChanged();
    };
  });
  const save = () => {
    if (!summary.check()) return;
    void send(text).then((refused) => {
      if (refused) summary.refused(refused);
    });
  };
  return (
    <>
      {summary.items.length ? <ErrorSummary items={summary.items} onSelect={() => undefined} ref={summaryElement} title={`Corrija ${summary.items.length} problemas`} /> : null}
      <button onClick={save} type="button">
        Salvar
      </button>
    </>
  );
}

const SERVER_ONLY: Diagnostic = { severity: "error", code: "WIDGET_NEWER_RULE", message: "Uma regra que só o servidor conhece.", file: "widget.html", line: 2 };

async function setup(send = mock(async (_text: string): Promise<Diagnostic[] | null> => null)) {
  const view = await render(<FakeEditor send={send} />);
  const summary = () => view.container.querySelector("section");
  const listed = () => [...view.container.querySelectorAll("section li")].map((item) => item.textContent);
  const save = () => click(view.container.querySelector("button:not(section button)"));
  const edit = (text: string) => act(() => controls.setText?.(text));
  return { ...view, edit, listed, save, send, summary };
}

describe("the error summary", () => {
  test("a refused save opens it and moves focus there; it is not a live region", async () => {
    const editor = await setup();
    await editor.edit("err:a err:b");
    expect(editor.summary()).toBeNull();
    await editor.save();
    expect(editor.send).not.toHaveBeenCalled();
    expect(editor.listed()).toEqual(["Problema a", "Problema b"]);
    await waitFor(() => document.activeElement === editor.summary());
    const summary = editor.summary()!;
    expect(summary.getAttribute("role")).toBeNull();
    expect(summary.querySelector("[role=alert], [aria-live]")).toBeNull();
    expect(summary.getAttribute("aria-live")).toBeNull();
    expect(summary.getAttribute("tabindex")).toBe("-1");
    expect(document.getElementById(summary.getAttribute("aria-labelledby")!)?.textContent).toBe("Corrija 2 problemas");
    expect(document.getElementById(summary.getAttribute("aria-describedby")!)?.tagName).toBe("UL");
    await editor.unmount();
  });

  test("while the person types it only drops fixed problems, and closes when none is left", async () => {
    const editor = await setup();
    await editor.edit("err:a err:b");
    await editor.save();
    const summary = editor.summary();
    // A new problem mid-typing is not added, and the summary is the same element (nothing re-mounts).
    await editor.edit("err:a err:b err:c");
    expect(editor.listed()).toEqual(["Problema a", "Problema b"]);
    expect(editor.summary()).toBe(summary);
    await editor.edit("err:b err:c");
    expect(editor.listed()).toEqual(["Problema b"]);
    expect(editor.summary()).toBe(summary);
    await editor.edit("err:c");
    expect(editor.summary()).toBeNull();
    // Closed until a save finds problems again, even for one it listed before.
    await editor.edit("err:c err:a");
    expect(editor.summary()).toBeNull();
    await editor.save();
    expect(editor.listed()).toEqual(["Problema c", "Problema a"]);
    await waitFor(() => document.activeElement === editor.summary());
    await editor.unmount();
  });

  test("after the server refuses a save, the next click sends the request", async () => {
    const send = mock(async (_text: string): Promise<Diagnostic[] | null> => null);
    send.mockImplementationOnce(async () => [SERVER_ONLY]);
    const editor = await setup(send);
    await editor.save();
    await waitFor(() => editor.summary() !== null);
    expect(editor.listed()).toEqual(["Uma regra que só o servidor conhece."]);
    await waitFor(() => document.activeElement === editor.summary());
    // The refused request's diagnostics never block the next try: it goes to the server.
    await editor.save();
    expect(send).toHaveBeenCalledTimes(2);
    expect(editor.summary()).toBeNull();
    await editor.unmount();
  });

  test("the server's problems leave the summary once the files change", async () => {
    const send = mock(async (_text: string): Promise<Diagnostic[] | null> => [SERVER_ONLY]);
    const editor = await setup(send);
    await editor.save();
    await waitFor(() => editor.summary() !== null);
    await editor.edit("corrigido");
    expect(editor.summary()).toBeNull();
    await editor.unmount();
  });
});
