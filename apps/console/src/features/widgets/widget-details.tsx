"use client";

import { MousePointerClick, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import type { Project } from "@/features/console/types";
import type { LibraryFile, LibraryItem, LibraryItemVersion } from "@/features/library/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Notice, Skeleton } from "@/ui/states";
import { humanizeFieldKey } from "@/shared/widgets/template/manifest";
import type { WidgetFieldSpec } from "@/shared/widgets/types";

import { useEffectiveTheme, type EffectiveThemeState } from "./api";
import { DiagnosticsList } from "./diagnostics-list";
import { ACTION_VERB_WORDS, actionSummary, FIELD_ROLE_WORDS, FIELD_TYPE_WORDS } from "./labels";
import { PreviewControls, PreviewFrame } from "./preview-frame";
import { widgetPreview, widgetVariants, type PreviewView, type WidgetPreviewResult } from "./preview";
import { WidgetScriptAuditSection } from "./script-audit-section";

/** The widget item screen's own sections: preview, the code's audit, fields, actions and how to use it. */
export function WidgetItemSections({
  files,
  item,
  project,
  version,
}: {
  files: LibraryFile[];
  item: LibraryItem;
  project: Project | null;
  version?: LibraryItemVersion;
}) {
  const themeState = useEffectiveTheme(project?.id ?? null);
  const { effective, isError, isPending, theme } = themeState;
  const preview = useMemo(() => widgetPreview({ files, theme }), [files, theme]);
  return (
    <>
      <WidgetPreviewSection
        isPending={isPending}
        preview={preview}
        themeLoad={themeState}
        themeNote={effectiveThemeNote(effective, isError)}
        title={`Prévia do widget ${item.slug}`}
      />
      {version?.script && !isPending ? <WidgetScriptAuditSection files={files} item={item} theme={theme} version={version} /> : null}
      <WidgetFacts preview={preview} />
      <Section description="O agente põe a tag na página; o ravi pages ship confere os campos com a view e fixa a versão." title="Use numa página">
        <div className="space-y-2">
          <CodeBlock code={`<ravi-view view="<id-da-view>" widget="${item.ref}"></ravi-view>`} label="Na página" />
          <CodeBlock code={`ravi widgets show ${item.ref}`} label="No terminal" />
        </div>
      </Section>
    </>
  );
}

/** A widget proposal's preview and fields, from the proposed files. */
export function WidgetProposalSections({ files, project, title }: { files: readonly LibraryFile[]; project: Project | null; title: string }) {
  const themeState = useEffectiveTheme(project?.id ?? null);
  const { effective, isError, isPending, theme } = themeState;
  const preview = useMemo(() => widgetPreview({ files, theme }), [files, theme]);
  return (
    <>
      <WidgetPreviewSection
        isPending={isPending}
        preview={preview}
        themeLoad={themeState}
        themeNote={effectiveThemeNote(effective, isError)}
        title={title}
      />
      <Section description="O que o widget proposto recebe." title="Campos">
        <FieldsTable fields={preview.manifest?.fields ?? {}} />
      </Section>
    </>
  );
}

/** "o tema Acme (org/acme, v3)", or the default theme, saying so when it stands in for an active theme that did not load. */
export function effectiveThemeNote(effective: { name: string; ref: string; version: number } | null, failed = false) {
  if (effective) return `o tema ${effective.name} (${effective.ref}, v${effective.version})`;
  return failed ? "o tema padrão do Ravi, porque o tema ativo não carregou" : "o tema padrão do Ravi";
}

/**
 * Where a widget preview says the active theme did not load: that the
 * preview uses the default theme meanwhile, and a retry. In PT-BR only (the
 * server's reasons are English). The region is always there (a polite
 * status), so the note is read out once, when it appears.
 */
export function ThemeLoadStatus({ state }: { state: Pick<EffectiveThemeState, "isError" | "isRetrying" | "retry"> }) {
  return (
    <div aria-live="polite" role="status">
      {state.isError ? (
        <Notice title="O tema ativo não carregou" tone="warn">
          <span className="flex flex-wrap items-center gap-2">
            Não deu para carregar o tema ativo ou a versão dele. A prévia usa o tema padrão do Ravi até ele carregar.
            <Button icon={RefreshCw} loading={state.isRetrying} onClick={state.retry} size="sm" variant="ghost">
              Tentar de novo
            </Button>
          </span>
        </Notice>
      ) : null}
    </div>
  );
}

/** A widget preview in a sandboxed frame, with light/dark and variant views; the diagnostics when it does not compile. */
export function WidgetPreviewSection({
  isPending = false,
  preview,
  themeLoad,
  themeNote,
  title,
}: {
  isPending?: boolean;
  preview: WidgetPreviewResult;
  /** The effective theme's load, for the note when it failed. */
  themeLoad?: Pick<EffectiveThemeState, "isError" | "isRetrying" | "retry">;
  themeNote: string;
  title: string;
}) {
  const [view, setView] = useState<PreviewView>({ mode: "both", variant: "all" });
  const variants = preview.widget ? widgetVariants(preview.widget) : [];
  return (
    <Section
      actions={preview.html ? <PreviewControls onChange={setView} variants={variants} view={view} /> : undefined}
      description={`Com ${preview.invented ? "valores inventados pelos tipos dos campos" : "os dados de example.json"} e ${themeNote}. A prévia não roda scripts, não acessa o Console nem carrega imagens de links.`}
      title="Prévia"
    >
      <div className="space-y-3">
        {themeLoad ? <ThemeLoadStatus state={themeLoad} /> : null}
        {isPending ? (
          <Skeleton className="h-[520px] w-full" />
        ) : preview.html ? (
          <PreviewFrame height={520} html={preview.html} title={title} view={view} />
        ) : (
          <div className="space-y-3">
            <Notice title="Estes arquivos não compilam" tone="warn">
              Sem prévia até os erros abaixo serem corrigidos numa nova versão.
            </Notice>
            <DiagnosticsList diagnostics={preview.diagnostics} />
          </div>
        )}
      </div>
    </Section>
  );
}

function WidgetFacts({ preview }: { preview: WidgetPreviewResult }) {
  const fields = preview.manifest?.fields ?? {};
  const actions = preview.widget?.actions ?? [];
  return (
    <>
      <Section description="O que o widget recebe. Na página, cada campo casa com uma coluna da view do mesmo tipo." title="Campos">
        <FieldsTable fields={fields} />
      </Section>
      <Section description="Os botões do widget. Na página, cada um só aparece quando a view deixa quem está vendo fazer aquilo." title="Ações">
        {actions.length ? (
          <List label="Ações do widget">
            {actions.map((action, index) => (
              <ListRow
                description={actionSummary(action)}
                key={index}
                leading={
                  <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
                    <MousePointerClick aria-hidden size={16} />
                  </span>
                }
                meta={<span>{action.confirm || action.verb === "archive" ? "Pede confirmação" : "Sem confirmação"}</span>}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{action.label || ACTION_VERB_WORDS[action.verb]}</span>
                    <Badge>{action.verb}</Badge>
                  </span>
                }
              />
            ))}
          </List>
        ) : (
          <p className="text-sm text-ink-3">Este widget só mostra dados; não tem botões.</p>
        )}
      </Section>
    </>
  );
}

/** The widget's fields: key, type, role, required and label. */
export function FieldsTable({ fields }: { fields: Record<string, WidgetFieldSpec> }) {
  const entries = Object.entries(fields);
  if (!entries.length) return <p className="text-sm text-ink-3">widget.json não declara campos válidos.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">Campos do widget</caption>
        <thead>
          <tr className="border-b border-line text-left text-ink-3">
            <th className="px-3 py-2 font-medium" scope="col">
              Campo
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              Tipo
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              Papel
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              Obrigatório
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              Rótulo
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {entries.map(([key, spec]) => (
            <tr key={key}>
              <th className="px-3 py-2 text-left font-mono font-normal text-ink" scope="row">
                {key}
              </th>
              <td className="px-3 py-2 text-ink-2">
                {FIELD_TYPE_WORDS[spec.type] ?? spec.type} <span className="font-mono text-[12px] text-ink-3">{spec.type}</span>
              </td>
              <td className="px-3 py-2 text-ink-2">
                {spec.role ? (
                  <>
                    {FIELD_ROLE_WORDS[spec.role] ?? spec.role} <span className="font-mono text-[12px] text-ink-3">{spec.role}</span>
                  </>
                ) : (
                  <span className="text-ink-3">Nenhum</span>
                )}
              </td>
              <td className="px-3 py-2 text-ink-2">{spec.required ? "Sim" : "Não"}</td>
              <td className="px-3 py-2 text-ink">{spec.label?.trim() || humanizeFieldKey(key)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
