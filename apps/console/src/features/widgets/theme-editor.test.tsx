import { describe, expect, test } from "bun:test";
import { createRef, useEffect, useState } from "react";

import { parseThemeDocument } from "@/shared/widgets/theme/tokens";

import { fileContent, starterFiles, type EditorFile } from "./kind-files";
import { act, installTestDom, render, type, waitFor } from "./test-dom";
import { ThemeFilesEditor, themeTokenInputId } from "./theme-editor";
import { tokenInputErrors, type TokenDrafts } from "./theme-form";
import type { KindEditorHandle } from "./widget-editor";

installTestDom();

const LIGHT = "color.light.background.primary";
const DARK = "color.dark.text.danger";

type HostState = { files: EditorFile[]; drafts: TokenDrafts };

/** The Library editor's side of the theme editor: it holds the files and the token drafts. */
function Host({ handle, onState }: { handle: React.Ref<KindEditorHandle>; onState: (state: HostState) => void }) {
  const [files, setFiles] = useState(() => starterFiles("theme"));
  const [drafts, setDrafts] = useState<TokenDrafts>({});
  useEffect(() => onState({ files, drafts }), [files, drafts, onState]);
  return (
    <ThemeFilesEditor
      files={files}
      onChange={setFiles}
      onTokenDraft={(path, draft) => setDrafts((current) => ({ ...current, [path]: draft }))}
      ref={handle}
      tokenDrafts={drafts}
    />
  );
}

async function setup() {
  const handle = createRef<KindEditorHandle>();
  let state: HostState = { files: [], drafts: {} };
  const onState = (next: HostState) => {
    state = next;
  };
  const view = await render(<Host handle={handle} onState={onState} />);
  return {
    ...view,
    handle,
    input: (path: string) => view.container.querySelector<HTMLInputElement>(`#${themeTokenInputId(path)}`),
    state: () => state,
    themeText: () => fileContent(state.files, "theme.json")!,
    focusTarget: async (id: string) => {
      let found = false;
      await act(() => {
        found = handle.current?.focusTarget?.(id) ?? false;
      });
      return found;
    },
  };
}

describe("ThemeFilesEditor token fields", () => {
  test("text that does not parse stays in the field, is reported to the editor, and never reaches theme.json", async () => {
    const editor = await setup();
    await type(editor.input(LIGHT), "#123");
    expect(parseThemeDocument(editor.themeText()).tokens[LIGHT]).toBe("#112233");
    await type(editor.input(LIGHT), "#12345");
    const input = editor.input(LIGHT)!;
    expect(input.value).toBe("#12345");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!)?.textContent).toBe("Use #rgb, #rrggbb ou #rrggbbaa.");
    expect(parseThemeDocument(editor.themeText()).tokens[LIGHT]).toBe("#112233");
    expect(tokenInputErrors(editor.themeText(), editor.state().drafts)).toEqual([{ path: LIGHT, message: "Use #rgb, #rrggbb ou #rrggbbaa." }]);
    await editor.unmount();
  });

  test("the summary's link to a field in the other mode switches the mode and focuses it; the typed text survives the switch", async () => {
    const editor = await setup();
    await type(editor.input(LIGHT), "#12345");
    expect(editor.input(DARK)).toBeNull();
    expect(await editor.focusTarget(themeTokenInputId(DARK))).toBe(true);
    await waitFor(() => document.activeElement?.id === themeTokenInputId(DARK));
    expect(editor.input(LIGHT)).toBeNull();
    expect(await editor.focusTarget(themeTokenInputId(LIGHT))).toBe(true);
    await waitFor(() => document.activeElement?.id === themeTokenInputId(LIGHT));
    expect(editor.input(LIGHT)?.value).toBe("#12345");
    expect(await editor.focusTarget("library-editor-slug")).toBe(false);
    await editor.unmount();
  });
});
