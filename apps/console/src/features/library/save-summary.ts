"use client";

// What stops a theme or widget save, and the error summary that lists it.
// The summary follows the error summary pattern: a refused save shows it and
// moves focus to it, which is what announces it. While the person then fixes
// things it only shrinks (a fixed problem drops off, and it closes when none
// is left) and never announces again: a problem that shows up mid-typing
// (half-typed JSON) goes to the editors' own polite status, not here.

import { useState, type RefObject } from "react";

import { diagnosticWhere } from "@/features/widgets/diagnostics";
import type { ErrorSummaryItem } from "@/features/widgets/diagnostics-list";
import { checkKindFiles, fileContent, type EditorFile } from "@/features/widgets/kind-files";
import { THEME_DESCRIPTION_FIELD_ID, themeFileInputId, themeTokenInputId } from "@/features/widgets/theme-editor";
import { tokenFieldName, tokenInputErrors, type TokenDrafts } from "@/features/widgets/theme-form";
import { widgetFileInputId } from "@/features/widgets/widget-editor";
import type { Diagnostic } from "@/shared/widgets/types";

import type { CompiledKind } from "./kind";

export type SaveProblemsInput = {
  kind: CompiledKind;
  files: readonly EditorFile[];
  /** A new item's slug problem ("Escolha o slug."), or null. */
  slugProblem: string | null;
  /** Theme token fields holding text the form could not write to theme.json. */
  tokenDrafts?: TokenDrafts;
  /** What a refused save reported that the browser's check does not find (an older engine in this tab, say). */
  server?: readonly Diagnostic[] | null;
};

/** The id of the slug field's wrapper; the summary links there. */
export const SLUG_FIELD_ID = "library-editor-slug";

/**
 * Each problem that stops a theme or widget save, linked to its field or
 * line. Keys name the problem, not where it is, so a problem keeps its key
 * while the lines around it move.
 */
export function saveProblems({ files, kind, server = null, slugProblem, tokenDrafts = {} }: SaveProblemsInput): ErrorSummaryItem[] {
  const items: ErrorSummaryItem[] = [];
  if (slugProblem) items.push({ key: "slug", target: SLUG_FIELD_ID, text: slugProblem });
  const check = checkKindFiles(kind, files);
  if (kind === "theme" && !check.description) {
    const missing: Diagnostic = { severity: "error", code: "THEME_DESCRIPTION_MISSING", message: "", file: "theme.json", line: 1 };
    items.push({ key: "description", target: THEME_DESCRIPTION_FIELD_ID, text: "Escreva a descrição do tema.", diagnostic: missing });
  }
  if (kind === "theme") {
    for (const { path, message } of tokenInputErrors(fileContent(files, "theme.json") ?? "", tokenDrafts)) {
      items.push({ key: `token:${path}`, target: themeTokenInputId(path), text: `${tokenFieldName(path)}: ${message}` });
    }
  }
  const errors = [...check.errors];
  for (const diagnostic of server ?? []) {
    if (diagnostic.severity !== "error") continue;
    if (!errors.some((entry) => entry.code === diagnostic.code && entry.message === diagnostic.message && diagnosticWhere(entry) === diagnosticWhere(diagnostic))) {
      errors.push(diagnostic);
    }
  }
  const seen = new Map<string, number>();
  for (const diagnostic of errors) {
    const name = `${diagnostic.code}:${diagnostic.file ?? ""}:${diagnostic.message}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    const where = diagnosticWhere(diagnostic);
    items.push({
      key: `diagnostic:${name}:${count}`,
      target: diagnostic.file ? (kind === "widget" ? widgetFileInputId(diagnostic.file) : themeFileInputId(diagnostic.file)) : "",
      text: where ? `${where}: ${diagnostic.message}` : diagnostic.message,
      diagnostic,
    });
  }
  return items;
}

/** The problems found now that were in the summary when it opened: fixed ones drop off, new ones are not added. */
export function stillShown(shown: ReadonlySet<string>, current: readonly ErrorSummaryItem[]): ErrorSummaryItem[] {
  return current.filter((item) => shown.has(item.key));
}

/**
 * The editor's error summary, rendered into `summary` (focused when it
 * opens). `problems` lists the draft's problems as it is now, plus the
 * server's when given; the check before a save never counts the server's
 * (they were about the files of the refused request).
 */
export function useSaveSummary(summary: RefObject<HTMLElement | null>, problems: (server: readonly Diagnostic[] | null) => ErrorSummaryItem[]) {
  // Keys of the problems the summary opened with; null while it is closed.
  const [shown, setShown] = useState<ReadonlySet<string> | null>(null);
  const [server, setServer] = useState<readonly Diagnostic[] | null>(null);

  const items = shown ? stillShown(shown, problems(server)) : [];
  // Everything was fixed: close, so a later problem does not bring the summary back until a save finds it.
  if (shown && !items.length) setShown(null);

  const open = (found: readonly ErrorSummaryItem[]) => {
    setShown(new Set(found.map((item) => item.key)));
    requestAnimationFrame(() => summary.current?.focus());
  };

  return {
    items,
    /** Before a save: true when nothing stops it; otherwise opens the summary on what does and returns false. */
    check() {
      const found = problems(null);
      if (found.length) {
        open(found);
        return false;
      }
      setShown(null);
      setServer(null);
      return true;
    },
    /** A save the server refused with diagnostics: true when the summary opened on them. */
    refused(diagnostics: readonly Diagnostic[]) {
      const found = problems(diagnostics);
      if (!found.length) return false;
      setServer(diagnostics);
      open(found);
      return true;
    },
    /** The files changed: the server's diagnostics were about the files it was sent. */
    filesChanged() {
      setServer(null);
    },
  };
}
