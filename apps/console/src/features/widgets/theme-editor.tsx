"use client";

import { CircleAlert } from "lucide-react";
import { forwardRef, useId, useImperativeHandle, useMemo, useRef, useState } from "react";

import { Field, Input, Select, Textarea } from "@/ui/form";
import { Notice } from "@/ui/states";
import { Segmented } from "@/ui/tabs";
import { EXAMPLE_WIDGET_FILES } from "@/shared/widgets/template/catalog-text";
import { compileTheme } from "@/shared/widgets/theme/compile";
import { defaultCompiledTheme } from "@/shared/widgets/theme/default";
import { parseFieldsJson } from "@/shared/widgets/theme/fields";
import { parseThemeDocument, THEME_TOKENS, type ThemeTokenType } from "@/shared/widgets/theme/tokens";
import { FIELD_ROLE_DISPLAYS, FIELD_ROLES, FIELD_TYPE_DISPLAYS, type Diagnostic, type FieldDisplayKey, type ThemeDensity, type ThemeMode } from "@/shared/widgets/types";

import { CodeEditor, type CodeEditorHandle } from "./code-editor";
import { diagnosticLines, diagnosticsSummary } from "./diagnostics";
import { DiagnosticsList } from "./diagnostics-list";
import { fileContent, withEditedFile, withFile, type EditorFile } from "./kind-files";
import { DISPLAY_KEY_WORDS, displayWord, FIELD_ROLE_WORDS } from "./labels";
import { defaultCardPreviewDocument, widgetPreview, type PreviewView } from "./preview";
import { PreviewControls, PreviewFrame } from "./preview-frame";
import {
  BASE_GROUPS,
  colorGroups,
  colorPickerValue,
  MODE_WORDS,
  readThemeSource,
  tokenFieldError,
  tokenFieldText,
  tokenLabel,
  tokenMode,
  tokenType,
  typedTokenInput,
  withPickedColor,
  writeFieldsDisplay,
  writeThemeMeta,
  writeThemeToken,
  type TokenDraft,
  type TokenDrafts,
} from "./theme-form";
import { ContrastChecks, contrastSummary } from "./theme-report";
import { Tabs, TabPanel } from "./tabs";
import { useDebounced } from "./use-debounced";
import { PREVIEW_DELAY_MS, type KindEditorHandle } from "./widget-editor";

type ThemeTab = "form" | "json" | "fields" | "files";
const TABS: { id: ThemeTab; label: string }[] = [
  { id: "form", label: "Tokens" },
  { id: "json", label: "JSON" },
  { id: "fields", label: "Campos" },
  { id: "files", label: "Logo e README" },
];
const TEXT_FILES = ["theme.json", "fields.json", "logo.svg", "README.md"] as const;
type ThemeTextFile = (typeof TEXT_FILES)[number];
const LOCALES = [
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "en", label: "English" },
];
const DENSITIES: { value: ThemeDensity; label: string }[] = [
  { value: "comfortable", label: "Confortável" },
  { value: "compact", label: "Compacta" },
];

/** Wraps the description field; the error summary links here and focus goes to its text area. */
export const THEME_DESCRIPTION_FIELD_ID = "theme-meta-description";

export function themeTokenInputId(path: string) {
  return `theme-token-${path.replace(/\./g, "-")}`;
}

export function themeFileInputId(path: string) {
  return `theme-file-${path.replace(/[^a-z0-9]/gi, "-")}`;
}

/**
 * A theme's files with a token form over theme.json (grouped by Claro and
 * Escuro, color pickers paired with hex fields), a JSON tab for the file
 * itself, fields.json as selects, and beside it the live contrast report
 * and previews (the default card and an example widget), recompiled in the
 * browser a moment after each change. Text typed into a token field that
 * does not parse stays in `tokenDrafts` (the caller holds them, so its save
 * check sees them) and never reaches theme.json.
 */
export const ThemeFilesEditor = forwardRef<
  KindEditorHandle,
  {
    files: EditorFile[];
    onChange: (files: EditorFile[]) => void;
    onTokenDraft: (path: string, draft: TokenDraft) => void;
    tokenDrafts: TokenDrafts;
  }
>(function ThemeFilesEditor({ files, onChange, onTokenDraft, tokenDrafts }, ref) {
  const idPrefix = useId().replace(/:/g, "");
  const [tab, setTab] = useState<ThemeTab>("form");
  const [mode, setMode] = useState<ThemeMode>("light");
  const [view, setView] = useState<PreviewView>({ mode: "both", variant: "all" });
  const editors = {
    "theme.json": useRef<CodeEditorHandle>(null),
    "fields.json": useRef<CodeEditorHandle>(null),
    "logo.svg": useRef<CodeEditorHandle>(null),
    "README.md": useRef<CodeEditorHandle>(null),
  } satisfies Record<ThemeTextFile, React.RefObject<CodeEditorHandle | null>>;

  const themeText = fileContent(files, "theme.json") ?? "";
  const fieldsText = fileContent(files, "fields.json");
  const parsed = useMemo(() => parseThemeDocument(themeText), [themeText]);
  const formWorks = useMemo(() => readThemeSource(themeText) !== null, [themeText]);
  const fieldRules = useMemo(() => parseFieldsJson(fieldsText).rules, [fieldsText]);

  const debounced = useDebounced(files, PREVIEW_DELAY_MS);
  const compiled = useMemo(() => compileTheme(debounced.value), [debounced.value]);
  const theme = compiled.theme ?? compiled.draft ?? defaultCompiledTheme();
  const previews = useMemo(
    () => ({
      card: defaultCardPreviewDocument({ theme, title: "Cartão padrão" }),
      widget: widgetPreview({ files: EXAMPLE_WIDGET_FILES, theme }).html,
    }),
    [theme],
  );
  const failing = theme.contrast.checks.filter((check) => !check.ok);
  const failingTokens = new Set(failing.map((check) => check.pair[0]));
  // Contrast failures are in the report beside the form; the list holds the rest.
  const diagnostics = compiled.diagnostics.filter((diagnostic) => diagnostic.code !== "THEME_CONTRAST");
  const announcement =
    debounced.tick === 0
      ? ""
      : `${compiled.theme ? "Prévia atualizada." : `Prévia atualizada, com ${diagnosticsSummary(compiled.diagnostics)}.`}${debounced.tick % 2 ? "" : " "}`;

  const setTheme = (next: string | null) => {
    if (next !== null) onChange(withFile(files, "theme.json", next));
  };
  const focusLater = (selector: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
  const focusToken = (path: string) => {
    const tokenModeValue = tokenMode(path);
    if (tokenModeValue) setMode(tokenModeValue);
    setTab("form");
    focusLater(`#${themeTokenInputId(path)}`);
  };
  const locate = (diagnostic: Diagnostic) => {
    const file = diagnostic.file as ThemeTextFile | undefined;
    if (!file || !TEXT_FILES.includes(file)) return;
    if (file === "theme.json" && diagnostic.code === "THEME_DESCRIPTION_MISSING" && formWorks) {
      setTab("form");
      focusLater(`#${THEME_DESCRIPTION_FIELD_ID} textarea`);
      return;
    }
    // "color.light.text.secondary on color.light.background.primary has contrast …": go to the text color.
    const contrastToken = diagnostic.code === "THEME_CONTRAST" ? /^(color\.(?:light|dark)\.[a-z.]+?) on /.exec(diagnostic.message)?.[1] : undefined;
    if (contrastToken && formWorks && tokenType(contrastToken)) {
      focusToken(contrastToken);
      return;
    }
    setTab(file === "theme.json" ? "json" : file === "fields.json" ? "fields" : "files");
    requestAnimationFrame(() => editors[file].current?.focusLine(diagnostic.line ?? 1, diagnostic.column));
  };
  // The error summary links a token field by its input id.
  const focusTarget = (id: string) => {
    const token = formWorks ? THEME_TOKENS.find((spec) => themeTokenInputId(spec.path) === id) : undefined;
    if (!token) return false;
    focusToken(token.path);
    return true;
  };
  useImperativeHandle(ref, () => ({ focusDiagnostic: locate, focusTarget }));

  const fileEditor = (path: ThemeTextFile, label: string, rows: number, hint?: string) => {
    const marks = diagnosticLines(compiled.diagnostics, path);
    return (
      <CodeEditor
        hint={hint}
        id={themeFileInputId(path)}
        invalid={[...marks.values()].includes("error")}
        label={label}
        marks={marks}
        onChange={(content) => onChange(withEditedFile(files, path, content))}
        ref={editors[path]}
        rows={rows}
        value={fileContent(files, path) ?? ""}
      />
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Tabs idPrefix={idPrefix} label="Partes do tema" onChange={setTab} tabs={TABS} value={tab} />

        <TabPanel active={tab === "form"} className="space-y-6" id="form" idPrefix={idPrefix}>
          {formWorks ? (
            <>
              <fieldset className="space-y-4">
                <legend className="mb-2 text-sm font-semibold text-ink">Geral</legend>
                <MetaTextField
                  hint="Como o tema aparece na Biblioteca. Vazio usa o slug."
                  label="Nome"
                  onCommit={(name) => setTheme(writeThemeMeta(themeText, { name }))}
                  value={parsed.meta.name ?? ""}
                />
                <div id={THEME_DESCRIPTION_FIELD_ID}>
                  <MetaTextField
                    hint="Obrigatória para publicar. Diga para que serve o tema."
                    label="Descrição"
                    multiline
                    onCommit={(description) => setTheme(writeThemeMeta(themeText, { description }))}
                    value={parsed.meta.description ?? ""}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field hint="Idioma dos textos que as páginas mostram." label="Idioma">
                    {(props) => (
                      <Select {...props} onChange={(event) => setTheme(writeThemeMeta(themeText, { locale: event.target.value }))} value={parsed.meta.locale}>
                        {LOCALES.some((locale) => locale.value === parsed.meta.locale) ? null : <option value={parsed.meta.locale}>{parsed.meta.locale}</option>}
                        {LOCALES.map((locale) => (
                          <option key={locale.value} value={locale.value}>
                            {locale.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field hint="Compacta reduz os espaços em 25%." label="Densidade">
                    {(props) => (
                      <Select
                        {...props}
                        onChange={(event) => setTheme(writeThemeMeta(themeText, { density: event.target.value as ThemeDensity }))}
                        value={parsed.meta.density}
                      >
                        {DENSITIES.map((density) => (
                          <option key={density.value} value={density.value}>
                            {density.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
              </fieldset>

              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span aria-hidden className="text-sm font-semibold text-ink">
                    Cores do modo
                  </span>
                  <Segmented<ThemeMode>
                    label="Cores do modo"
                    onChange={setMode}
                    options={[
                      { value: "light", label: MODE_WORDS.light },
                      { value: "dark", label: MODE_WORDS.dark },
                    ]}
                    value={mode}
                  />
                </div>
                {colorGroups(mode).map((group) => (
                  <fieldset className="space-y-3" key={group.id}>
                    <legend className="mb-2 text-sm font-semibold text-ink">{`${group.title} (${MODE_WORDS[mode].toLowerCase()})`}</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {group.paths.map((path) => (
                        <ColorTokenField
                          css={parsed.tokens[path] ?? ""}
                          draft={tokenDrafts[path]}
                          explicit={parsed.explicit.has(path)}
                          failing={failingTokens.has(path)}
                          key={path}
                          onCommit={(raw) => setTheme(writeThemeToken(themeText, path, raw))}
                          onDraft={(draft) => onTokenDraft(path, draft)}
                          path={path}
                        />
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>

              {BASE_GROUPS.map((group) => (
                <fieldset className="space-y-3" key={group.id}>
                  <legend className="mb-2 text-sm font-semibold text-ink">{group.title}</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {group.paths.map((path) => (
                      <TextTokenField
                        css={parsed.tokens[path] ?? ""}
                        draft={tokenDrafts[path]}
                        explicit={parsed.explicit.has(path)}
                        key={path}
                        onCommit={(raw) => setTheme(writeThemeToken(themeText, path, raw))}
                        onDraft={(draft) => onTokenDraft(path, draft)}
                        path={path}
                        type={tokenType(path) ?? "dimension"}
                      />
                    ))}
                  </div>
                </fieldset>
              ))}
              <p className="text-[13px] text-ink-3">Sombras, espessura da borda e largura das colunas do quadro ficam na aba JSON.</p>
            </>
          ) : (
            <Notice title="O formulário precisa de um theme.json válido" tone="warn">
              theme.json não é um objeto JSON agora. Corrija na aba JSON e o formulário volta.
            </Notice>
          )}
        </TabPanel>

        <TabPanel active={tab === "json"} className="space-y-3" id="json" idPrefix={idPrefix}>
          {fileEditor("theme.json", "theme.json", 28, "Tokens no formato W3C Design Tokens. Os que faltarem usam o valor do tema padrão.")}
        </TabPanel>

        <TabPanel active={tab === "fields"} className="space-y-5" id="fields" idPrefix={idPrefix}>
          <p className="text-sm text-ink-2">Como cada tipo de campo aparece nas páginas quando o widget não escolhe. Um widget ainda pode pedir outro jeito.</p>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold text-ink">Por tipo</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(Object.keys(FIELD_TYPE_DISPLAYS) as FieldDisplayKey[]).map((key) => (
                <DisplaySelect
                  displays={FIELD_TYPE_DISPLAYS[key]}
                  key={key}
                  label={DISPLAY_KEY_WORDS[key]}
                  onChange={(display) => onChange(withFile(files, "fields.json", writeFieldsDisplay(fieldsText, "types", key, display)))}
                  value={fieldRules.types[key]}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold text-ink">Por papel</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELD_ROLES.map((role) => (
                <DisplaySelect
                  displays={FIELD_ROLE_DISPLAYS[role]}
                  key={role}
                  label={FIELD_ROLE_WORDS[role]}
                  onChange={(display) => onChange(withFile(files, "fields.json", writeFieldsDisplay(fieldsText, "roles", role, display)))}
                  value={fieldRules.roles[role]}
                />
              ))}
            </div>
          </fieldset>
          {fileEditor("fields.json", "fields.json", 12, "O mesmo, em texto. Vazio usa o padrão de cada tipo.")}
        </TabPanel>

        <TabPanel active={tab === "files"} className="space-y-5" id="files" idPrefix={idPrefix}>
          {fileEditor("logo.svg", "logo.svg", 10, "Opcional. SVG de até 64 KiB, sem scripts nem links externos; as páginas o mostram com texto alternativo.")}
          {fileEditor("README.md", "README.md", 8, "Opcional. Quando usar o tema; entra na busca.")}
        </TabPanel>
      </div>

      <div className="min-w-0 space-y-5 lg:sticky lg:top-4 lg:self-start">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[15px] font-semibold text-ink">Prévia</h3>
            <PreviewControls onChange={setView} view={view} />
          </div>
          <PreviewFrame height={360} html={previews.card} title="Prévia do cartão padrão com este tema" view={view} />
          {previews.widget ? <PreviewFrame height={420} html={previews.widget} title="Prévia de um widget de exemplo com este tema" view={view} /> : null}
        </section>

        <section className="space-y-2">
          <h3 className="text-[15px] font-semibold text-ink">Contraste</h3>
          <p className={failing.length ? "text-[13px] text-err" : "text-[13px] text-ink-3"}>
            {failing.length
              ? `${contrastSummary(theme.contrast)} ${failing.length === 1 ? "Um par fica" : `${failing.length} pares ficam`} abaixo do mínimo e impede${failing.length === 1 ? "" : "m"} a publicação.`
              : contrastSummary(theme.contrast)}
          </p>
          <ContrastChecks onSelect={(check) => focusToken(check.pair[0])} report={theme.contrast} />
        </section>

        <DiagnosticsList canLocate={(diagnostic) => TEXT_FILES.includes(diagnostic.file as ThemeTextFile)} diagnostics={diagnostics} onLocate={locate} />
        <p aria-live="polite" className="sr-only" role="status">
          {announcement}
        </p>
      </div>
    </div>
  );
});

/**
 * Local text for an input whose value the parent rewrites (canonical form,
 * trimmed): typing keeps the person's text while it stands for the same
 * value, and an outside change (the JSON tab) replaces it.
 */
function useDraftText(external: string) {
  const [state, setState] = useState({ source: external, text: external });
  const text = state.source === external ? state.text : external;
  return [text, (next: string, committed: string) => setState({ source: committed, text: next })] as const;
}

function MetaTextField({
  hint,
  label,
  multiline,
  onCommit,
  value,
}: {
  hint: string;
  label: string;
  multiline?: boolean;
  onCommit: (value: string) => void;
  value: string;
}) {
  const [text, setText] = useDraftText(value);
  const change = (next: string) => {
    setText(next, next.trim());
    onCommit(next);
  };
  return (
    <Field hint={hint} label={label}>
      {(props) =>
        multiline ? (
          <Textarea {...props} maxLength={1024} onChange={(event) => change(event.target.value)} rows={3} value={text} />
        ) : (
          <Input {...props} maxLength={120} onChange={(event) => change(event.target.value)} value={text} />
        )
      }
    </Field>
  );
}

function TokenLabel({ explicit, htmlFor, path }: { explicit: boolean; htmlFor: string; path: string }) {
  return (
    <label className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] font-medium text-ink" htmlFor={htmlFor}>
      {tokenLabel(path)}
      {explicit ? null : <span className="text-xs font-normal text-ink-3">(padrão)</span>}
    </label>
  );
}

type TokenFieldProps = {
  css: string;
  /** What the person typed, while it still applies. */
  draft: TokenDraft | undefined;
  explicit: boolean;
  onCommit: (raw: unknown) => void;
  onDraft: (draft: TokenDraft) => void;
  path: string;
};

function ColorTokenField({ css, draft, explicit, failing, onCommit, onDraft, path }: TokenFieldProps & { failing: boolean }) {
  const id = themeTokenInputId(path);
  const text = tokenFieldText("color", css, draft);
  const error = tokenFieldError("color", css, text);
  const describedBy = [error ? `${id}-error` : null, failing ? `${id}-contrast` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex items-start gap-2">
      <input
        aria-label={`${tokenLabel(path)}: seletor de cor`}
        className="mt-6 h-8 w-10 shrink-0 cursor-pointer rounded border border-line-strong bg-surface p-0.5"
        onChange={(event) => {
          const next = withPickedColor(css, event.target.value);
          onDraft({ source: next, text: next });
          onCommit(next);
        }}
        type="color"
        value={colorPickerValue(css)}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <TokenLabel explicit={explicit} htmlFor={id} path={path} />
        <Input
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          className="h-8 font-mono text-[12.5px]"
          id={id}
          onChange={(event) => {
            const typed = typedTokenInput("color", css, event.target.value);
            onDraft(typed.draft);
            if (typed.ok) onCommit(typed.raw);
          }}
          spellCheck={false}
          value={text}
        />
        {error ? (
          <p className="text-[12px] text-err" id={`${id}-error`}>
            {error}
          </p>
        ) : null}
        {failing ? (
          <p className="flex items-center gap-1 text-[12px] font-medium text-err" id={`${id}-contrast`}>
            <CircleAlert aria-hidden size={12} />
            Contraste abaixo do mínimo
          </p>
        ) : null}
      </div>
    </div>
  );
}

function TextTokenField({ css, draft, explicit, onCommit, onDraft, path, type }: TokenFieldProps & { type: ThemeTokenType }) {
  const id = themeTokenInputId(path);
  const text = tokenFieldText(type, css, draft);
  const error = tokenFieldError(type, css, text);
  return (
    <div className="min-w-0 space-y-1">
      <TokenLabel explicit={explicit} htmlFor={id} path={path} />
      <Input
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        className="h-8 font-mono text-[12.5px]"
        id={id}
        inputMode={type === "fontWeight" ? "numeric" : undefined}
        onChange={(event) => {
          const typed = typedTokenInput(type, css, event.target.value);
          onDraft(typed.draft);
          if (typed.ok) onCommit(typed.raw);
        }}
        spellCheck={false}
        value={text}
      />
      {error ? (
        <p className="text-[12px] text-err" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function DisplaySelect({
  displays,
  label,
  onChange,
  value,
}: {
  displays: readonly string[];
  label: string;
  onChange: (display: string) => void;
  value: string;
}) {
  return (
    <Field label={label}>
      {(props) => (
        <Select {...props} onChange={(event) => onChange(event.target.value)} value={value}>
          {displays.map((display, index) => (
            <option key={display} value={display}>
              {index === 0 ? `${displayWord(display)} (padrão)` : displayWord(display)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
