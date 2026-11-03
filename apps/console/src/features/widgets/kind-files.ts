// Files of a theme or widget as the editors hold them, and the check a save
// runs first: the same compile the server runs, so an error is shown in the
// editor before the request instead of coming back as `PAYLOAD_INVALID`.

import { compileWidget, EXAMPLE_WIDGET_FILES } from "@/shared/widgets/template";
import { DEFAULT_THEME_FILES } from "@/shared/widgets/theme/default";
import { compileTheme } from "@/shared/widgets/theme/compile";
import type { Diagnostic } from "@/shared/widgets/types";

import { writeThemeMeta } from "./theme-form";

export type EditorFile = { path: string; content: string };

/** Theme and widget files a person may leave out; an empty one is removed instead of saved. */
export const OPTIONAL_KIND_FILES = new Set(["example.json", "README.md", "widget.js", "fields.json", "logo.svg"]);

export function fileContent(files: readonly EditorFile[], path: string) {
  return files.find((file) => file.path === path)?.content;
}

/** `files` with `path` set to `content` (added at the end when new), or removed when `content` is null. */
export function withFile(files: readonly EditorFile[], path: string, content: string | null): EditorFile[] {
  if (content === null) return files.filter((file) => file.path !== path);
  if (!files.some((file) => file.path === path)) return [...files, { path, content }];
  return files.map((file) => (file.path === path ? { ...file, content } : file));
}

/** Sets an editor's text area: an optional file left blank is removed. */
export function withEditedFile(files: readonly EditorFile[], path: string, content: string): EditorFile[] {
  return withFile(files, path, OPTIONAL_KIND_FILES.has(path) && !content.trim() ? null : content);
}

export type KindCheck = {
  diagnostics: Diagnostic[];
  errors: Diagnostic[];
  /** The name and description the files declare, which the server stores when the body has none. */
  name: string | null;
  description: string | null;
};

export function checkKindFiles(kind: "theme" | "widget", files: readonly EditorFile[]): KindCheck {
  if (kind === "theme") {
    const { diagnostics, draft } = compileTheme(files);
    return {
      diagnostics,
      errors: diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      name: draft?.name ?? null,
      description: draft?.description ?? null,
    };
  }
  const { diagnostics, manifest } = compileWidget(files);
  return {
    diagnostics,
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    name: manifest?.name ?? null,
    description: manifest?.description ?? null,
  };
}

/** Where a new theme or widget starts: the default theme without its name, or the catalog's example widget. */
export function starterFiles(kind: "theme" | "widget"): EditorFile[] {
  if (kind === "widget") return EXAMPLE_WIDGET_FILES.map((file) => ({ path: file.path, content: file.content }));
  return DEFAULT_THEME_FILES.map((file) =>
    file.path === "theme.json" ? { path: file.path, content: writeThemeMeta(file.content, { name: null, description: null }) ?? file.content } : { ...file },
  );
}
