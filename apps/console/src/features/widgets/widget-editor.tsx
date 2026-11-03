"use client";

import { Wand2 } from "lucide-react";
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";

import type { Project } from "@/features/console/types";
import { libraryErrorText } from "@/features/library/api";
import { useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { Field, FormMessage, Select } from "@/ui/form";
import { Panel } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { Notice, Skeleton } from "@/ui/states";
import { useToast } from "@/ui/toast";
import { sha256Hex } from "@/shared/widgets/hash";
import type { Diagnostic } from "@/shared/widgets/types";

import { useEffectiveTheme, useScaffoldBases, useScaffoldViews, useWidgetScaffold } from "./api";
import { CodeEditor, type CodeEditorHandle } from "./code-editor";
import { countDiagnostics, diagnosticLines, diagnosticsSummary } from "./diagnostics";
import { DiagnosticsList } from "./diagnostics-list";
import { fileContent, withEditedFile, withFile, type EditorFile } from "./kind-files";
import { PreviewControls, PreviewFrame } from "./preview-frame";
import { widgetPreview, widgetVariants, type PreviewView } from "./preview";
import { runWidgetAudit, type ScriptAuditOutcome } from "./script-audit";
import { ScriptAuditReport, ScriptPreviewFrame } from "./script-audit-panel";
import { TabPanel, Tabs } from "./tabs";
import { useDebounced } from "./use-debounced";
import { ThemeLoadStatus } from "./widget-details";

export const PREVIEW_DELAY_MS = 300;

/**
 * What the Library editor asks of a theme or widget editor: take the caret
 * to a diagnostic, or to one of its own fields by id (switching its tab or
 * mode first); `focusTarget` is false for an id the editor does not own.
 */
export type KindEditorHandle = {
  focusDiagnostic: (diagnostic: Diagnostic) => void;
  focusTarget?: (id: string) => boolean;
  /**
   * Widgets: the accessibility audit of the files as they are now, with
   * widget.js running (null without widget.js or when the files do not
   * compile). A publish from the editor runs it first and stops on a fail.
   */
  audit?: () => Promise<ScriptAuditOutcome | null>;
};

const WIDGET_FILES = ["widget.html", "widget.json", "example.json", "widget.js", "README.md"] as const;
type WidgetFile = (typeof WIDGET_FILES)[number];
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function widgetFileInputId(path: string) {
  return `widget-file-${path.replace(/[^a-z0-9]/gi, "-")}`;
}

const FILE_HINTS: Record<WidgetFile, string> = {
  "widget.html": "O template: peças ravi-* e os campos entre chaves, como {titulo}.",
  "widget.json": "Nome, descrição, campos com tipo e papel, e variantes.",
  "example.json": 'Opcional. Um registro de exemplo, ou { "records": [ … ] }. Sem ele, a prévia inventa valores pelos tipos. Use só dados inventados.',
  "widget.js":
    "Opcional. Um módulo ES, sem import, que exporta mount(card, ctx) e desenha nas peças ravi-canvas depois do template. Só lê os dados. Só owner ou admin da organização publica um widget com código, e a auditoria de acessibilidade precisa passar.",
  "README.md": "Opcional. Para quem vai usar o widget.",
};

const FILE_ROWS: Record<WidgetFile, number> = { "widget.html": 18, "widget.json": 14, "example.json": 10, "widget.js": 18, "README.md": 8 };

/**
 * A widget's files side by side with its live preview: one tab per file
 * (widget.html, widget.json, example.json, widget.js, README.md) in text
 * areas with line numbers, the compiler's diagnostics (each one takes the
 * caret to its line), and the preview recompiled in the browser a moment
 * after typing stops, with the caller's effective theme and only example
 * data. With widget.js, the preview runs the code in a frame that may run
 * scripts (opaque origin) and shows the axe-core audit.
 */
export const WidgetFilesEditor = forwardRef<
  KindEditorHandle,
  {
    files: EditorFile[];
    onChange: (files: EditorFile[]) => void;
    project: Project | null;
    /** Shown on a new widget: start from a view's columns. */
    scaffoldSlug?: string | null;
  }
>(function WidgetFilesEditor({ files, onChange, project, scaffoldSlug }, ref) {
  const htmlRef = useRef<CodeEditorHandle>(null);
  const manifestRef = useRef<CodeEditorHandle>(null);
  const exampleRef = useRef<CodeEditorHandle>(null);
  const scriptRef = useRef<CodeEditorHandle>(null);
  const readmeRef = useRef<CodeEditorHandle>(null);
  const [tab, setTab] = useState<WidgetFile>("widget.html");
  const editors = useMemo<Record<WidgetFile, React.RefObject<CodeEditorHandle | null>>>(
    () => ({ "widget.html": htmlRef, "widget.json": manifestRef, "example.json": exampleRef, "widget.js": scriptRef, "README.md": readmeRef }),
    [],
  );
  const [outcome, setOutcome] = useState<ScriptAuditOutcome | null>(null);

  const themeState = useEffectiveTheme(project?.id ?? null);
  const { theme, effective, isPending: themePending } = themeState;
  const debounced = useDebounced(files, PREVIEW_DELAY_MS);
  const preview = useMemo(() => widgetPreview({ files: debounced.value, theme }), [debounced.value, theme]);
  // The last preview without errors stays on screen while the files have errors.
  const [lastHtml, setLastHtml] = useState<string | null>(null);
  if (preview.html && preview.html !== lastHtml) setLastHtml(preview.html);
  const html = preview.html ?? lastHtml;
  const [view, setView] = useState<PreviewView>({ mode: "both", variant: "all" });
  const variants = preview.widget ? widgetVariants(preview.widget) : [];
  const shownView: PreviewView = view.variant === "all" || variants.includes(view.variant) ? view : { ...view, variant: "all" };

  const debouncedCode = fileContent(debounced.value, "widget.js");
  const script =
    preview.html && preview.widget?.script && debouncedCode !== undefined
      ? { code: debouncedCode, sha: sha256Hex(debouncedCode), html: preview.html, records: preview.records, fields: preview.widget.fields }
      : null;

  const diagnostics = [...preview.diagnostics, ...preview.dataDiagnostics];
  const { errors } = countDiagnostics(preview.diagnostics);
  const announcement =
    debounced.tick === 0
      ? ""
      : `${errors ? `Prévia não atualizada: ${diagnosticsSummary(preview.diagnostics)}.` : "Prévia atualizada."}${debounced.tick % 2 ? "" : " "}`;

  const locate = (diagnostic: Diagnostic) => {
    const file = diagnostic.file as WidgetFile | undefined;
    if (!file || !WIDGET_FILES.includes(file)) return;
    setTab(file);
    // The tab's panel shows on the next render.
    requestAnimationFrame(() => editors[file].current?.focusLine(diagnostic.line ?? 1, diagnostic.column));
  };
  useImperativeHandle(ref, () => ({ focusDiagnostic: locate, audit: () => runWidgetAudit(files, theme) }));

  const edit = (path: WidgetFile) => (content: string) => onChange(withEditedFile(files, path, content));
  const editorProps = (path: WidgetFile) => {
    const marks = diagnosticLines(diagnostics, path);
    return {
      id: widgetFileInputId(path),
      invalid: [...marks.values()].includes("error"),
      marks,
      onChange: edit(path),
      value: fileContent(files, path) ?? "",
    };
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        {scaffoldSlug !== undefined ? (
          <ScaffoldPanel onFiles={(next) => onChange(mergeScaffold(files, next))} project={project} slug={scaffoldSlug ?? ""} />
        ) : null}
        <div>
          <Tabs
            idPrefix="widget-files"
            label="Arquivos do widget"
            onChange={setTab}
            tabs={WIDGET_FILES.map((path) => {
              const marks = diagnosticLines(diagnostics, path);
              const hasError = [...marks.values()].includes("error");
              return {
                id: path,
                label: (
                  <>
                    <span className="font-mono text-[13px]">{path}</span>
                    {hasError ? (
                      <>
                        <span aria-hidden className="size-1.5 rounded-full bg-err" />
                        <span className="sr-only">(com erros)</span>
                      </>
                    ) : null}
                  </>
                ),
              };
            })}
            value={tab}
          />
          {WIDGET_FILES.map((path) => (
            <TabPanel active={tab === path} className="pt-4" id={path} idPrefix="widget-files" key={path}>
              <CodeEditor {...editorProps(path)} hint={FILE_HINTS[path]} label={path} ref={editors[path]} rows={FILE_ROWS[path]} />
            </TabPanel>
          ))}
        </div>
      </div>

      <div className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:self-start">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-ink">Prévia</h3>
          <PreviewControls onChange={setView} variants={variants} view={shownView} />
        </div>
        <ThemeLoadStatus state={themeState} />
        {script ? (
          <ScriptPreviewFrame
            code={script.code}
            fields={script.fields}
            html={script.html}
            onOutcome={setOutcome}
            records={script.records}
            scriptSha256={script.sha}
            title={`Prévia do widget ${preview.widget?.name ?? ""} com código`.trim()}
            view={shownView}
          />
        ) : html ? (
          <PreviewFrame html={html} title={`Prévia do widget ${preview.widget?.name ?? ""}`.trim()} view={shownView} />
        ) : themePending ? (
          <Skeleton className="h-[480px] w-full" />
        ) : (
          <Notice title="Ainda sem prévia" tone="warn">
            Corrija os erros abaixo e a prévia aparece aqui.
          </Notice>
        )}
        {!preview.html && lastHtml ? <p className="text-[13px] text-warn">A prévia mostra a última versão sem erros.</p> : null}
        {script ? (
          <div className="space-y-1.5">
            <h4 className="text-sm font-semibold text-ink">Acessibilidade com o código</h4>
            <ScriptAuditReport outcome={outcome?.scriptSha256 === script.sha ? outcome : null} running={!outcome || outcome.scriptSha256 !== script.sha} />
            <p className="text-[13px] text-ink-3">O axe-core confere o que a prévia mostra. Ao publicar, a auditoria roda de novo nos dois modos e em todas as variantes.</p>
          </div>
        ) : null}
        <p className="text-[13px] text-ink-3">
          {`Tema: ${effective ? `${effective.name} (${effective.ref}, v${effective.version})` : themeState.isError ? "padrão do Ravi, porque o tema ativo não carregou" : "padrão do Ravi"}. Dados: ${preview.invented ? "inventados pelos tipos dos campos" : "example.json"}.`}
        </p>
        <DiagnosticsList canLocate={(diagnostic) => WIDGET_FILES.includes(diagnostic.file as WidgetFile)} diagnostics={diagnostics} onLocate={locate} />
        <p aria-live="polite" className="sr-only" role="status">
          {announcement}
        </p>
      </div>
    </div>
  );
});

/** Scaffolded widget.html, widget.json and example.json replace the editor's; README.md stays. */
function mergeScaffold(files: EditorFile[], scaffold: EditorFile[]) {
  let next = files.filter((file) => file.path === "README.md");
  for (const file of scaffold) if (file.path !== "README.md") next = withFile(next, file.path, file.content);
  return next;
}

/** "Começar de uma view": fields from a view's columns (schema only, never rows) through `widgets/scaffold`. */
function ScaffoldPanel({ onFiles, project, slug }: { onFiles: (files: EditorFile[]) => void; project: Project | null; slug: string }) {
  const { projects } = useWorkspace();
  const toast = useToast();
  const [projectId, setProjectId] = useState(project?.id ?? "");
  const [baseId, setBaseId] = useState("");
  const [viewId, setViewId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const scaffold = useWidgetScaffold();

  const run = () => {
    scaffold.mutate(
      { slug: SLUG_PATTERN.test(slug) ? slug : "widget", view: viewId, project: projectId },
      {
        onSuccess: (result) => {
          setConfirming(false);
          onFiles(result.files);
          toast.show("Arquivos criados a partir da view. Confira os campos e a prévia.");
        },
      },
    );
  };

  return (
    <Panel className="space-y-4 p-4">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-ink">Começar de uma view</h3>
        <p className="text-[13px] text-ink-3">Os campos saem das colunas da view, só o esquema; nenhuma linha é lida. Os valores de exemplo são inventados.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {project ? null : (
          <Field label="Projeto">
            {(props) => (
              <Select
                {...props}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setBaseId("");
                  setViewId("");
                }}
                value={projectId}
              >
                <option value="">Escolha um projeto</option>
                {projects.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {projectId ? (
          <BaseAndViewPickers
            baseId={baseId}
            onBase={(id) => {
              setBaseId(id);
              setViewId("");
            }}
            onView={setViewId}
            projectId={projectId}
            viewId={viewId}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!viewId} icon={Wand2} onClick={() => setConfirming(true)} size="sm">
          Criar arquivos da view
        </Button>
        {!viewId ? <span className="text-[13px] text-ink-3">Escolha {projectId ? "a base e a view" : "o projeto, a base e a view"}.</span> : null}
      </div>
      <Dialog
        description="widget.html, widget.json e example.json são trocados pelos que a view sugere. O README.md fica."
        footer={
          <>
            <Button onClick={() => setConfirming(false)} variant="ghost">
              Cancelar
            </Button>
            <Button loading={scaffold.isPending} onClick={run} variant="primary">
              Substituir
            </Button>
          </>
        }
        onClose={() => {
          scaffold.reset();
          setConfirming(false);
        }}
        open={confirming}
        title="Substituir os arquivos?"
      >
        {scaffold.isError ? <FormMessage>{libraryErrorText(scaffold.error) ?? "Não deu para criar os arquivos. Tente de novo."}</FormMessage> : null}
      </Dialog>
    </Panel>
  );
}

function BaseAndViewPickers({
  baseId,
  onBase,
  onView,
  projectId,
  viewId,
}: {
  baseId: string;
  onBase: (id: string) => void;
  onView: (id: string) => void;
  projectId: string;
  viewId: string;
}) {
  const bases = useScaffoldBases(projectId);
  const views = useScaffoldViews(projectId, baseId || null);
  return (
    <>
      <Field error={bases.isError ? (libraryErrorText(bases.error) ?? "Não deu para carregar as bases.") : null} label="Base">
        {(props) => (
          <Select {...props} disabled={bases.isPending || bases.isError} onChange={(event) => onBase(event.target.value)} value={baseId}>
            <option value="">{bases.isPending ? "Carregando…" : bases.data?.length ? "Escolha uma base" : "Nenhuma base neste projeto"}</option>
            {(bases.data ?? []).map((base) => (
              <option key={base.id} value={base.id}>
                {base.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field error={views.isError ? (libraryErrorText(views.error) ?? "Não deu para carregar as views.") : null} label="View">
        {(props) => (
          <Select {...props} disabled={!baseId || views.isPending || views.isError} onChange={(event) => onView(event.target.value)} value={viewId}>
            <option value="">{!baseId ? "Escolha a base antes" : views.isPending ? "Carregando…" : views.data?.length ? "Escolha uma view" : "Nenhuma view aberta a você"}</option>
            {(views.data ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}
