// The built-in default theme: what `ravi themes init` writes, what a page
// with widget tags gets when no theme applies, and the values a smaller theme
// falls back to.

import type { CompiledTheme, LibraryFileText } from "../types";
import { compileTheme } from "./compile";
import { DEFAULT_TOKEN_VALUES } from "./default-tokens";
import { defaultFieldDisplayRules, FIELDS_FILE, fieldsJsonFromRules } from "./fields";
import { THEME_DEFAULT_LOCALE, THEME_FILE, themeJsonFromValues } from "./tokens";

export const DEFAULT_THEME_NAME = "Ravi";
export const DEFAULT_THEME_DESCRIPTION =
  "Tema padrão do Ravi: tinta escura sobre fundo claro, acento verde-petróleo, modo escuro e fontes do sistema.";

export const DEFAULT_THEME_FILES: readonly LibraryFileText[] = Object.freeze([
  Object.freeze({
    path: THEME_FILE,
    content: themeJsonFromValues(DEFAULT_TOKEN_VALUES, {
      name: DEFAULT_THEME_NAME,
      description: DEFAULT_THEME_DESCRIPTION,
      locale: THEME_DEFAULT_LOCALE,
      density: "comfortable",
    }),
  }),
  Object.freeze({ path: FIELDS_FILE, content: fieldsJsonFromRules(defaultFieldDisplayRules()) }),
]);

let compiled: CompiledTheme | null = null;

/** The default theme compiled once per process (frozen; copy before changing). */
export function defaultCompiledTheme(): CompiledTheme {
  if (!compiled) {
    const result = compileTheme(DEFAULT_THEME_FILES);
    if (!result.theme) {
      const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
      throw new Error(`The default theme does not compile: ${messages}`);
    }
    compiled = deepFreeze(result.theme);
  }
  return compiled;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
