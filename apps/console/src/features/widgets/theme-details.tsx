"use client";

import { Check, Palette, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import type { Project } from "@/features/console/types";
import { libraryErrorText } from "@/features/library/api";
import type { CatalogWidgetSummary, LibraryFile, LibraryItem, ThemePointer, ThemePointerPlan } from "@/features/library/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { FormMessage } from "@/ui/form";
import { DetailList, Panel, Section } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { Notice, Skeleton } from "@/ui/states";
import { useToast } from "@/ui/toast";
import type { CompiledTheme, Diagnostic } from "@/shared/widgets/types";

import { useActiveThemes, useSetActiveTheme, useWidgetCatalog, useWidgetItems, type SetActiveThemeInput } from "./api";
import { DiagnosticsList } from "./diagnostics-list";
import { defaultCardPreviewDocument, previewTheme, widgetPreview, type PreviewView } from "./preview";
import { PreviewControls, PreviewFrame } from "./preview-frame";
import { ContrastChecks, contrastSummary, ThemeSwatches } from "./theme-report";

const WIDGETS_PAGE = 6;

/** The theme item screen's own sections: active theme, previews, contrast, colors and how to use it. */
export function ThemeItemSections({ files, item, project }: { files: LibraryFile[]; item: LibraryItem; project: Project | null }) {
  const { theme, diagnostics } = useMemo(() => previewTheme(files), [files]);
  return (
    <>
      <ActiveThemePanel item={item} project={project} />
      <ThemePreviewSection diagnostics={diagnostics} project={project} theme={theme} title={item.slug} />
      <Section description={contrastSummary(theme.contrast)} title="Contraste">
        <ContrastChecks report={theme.contrast} />
      </Section>
      <Section description="Cada cor do tema, com o valor que as páginas recebem." title="Cores">
        <div className="grid gap-6 lg:grid-cols-2">
          <ThemeSwatches mode="light" theme={theme} />
          <ThemeSwatches mode="dark" theme={theme} />
        </div>
      </Section>
      <Section description="Páginas com tags ravi-* usam o tema ativo; ravi pages ship --theme escolhe outro só para uma página." title="Use no Ravi">
        <CodeBlock code={`ravi themes show ${item.ref}`} />
      </Section>
    </>
  );
}

/** A theme proposal's preview and contrast, from the proposed files. */
export function ThemeProposalSections({ files, project, title }: { files: readonly LibraryFile[]; project: Project | null; title: string }) {
  const { theme, diagnostics } = useMemo(() => previewTheme(files), [files]);
  return (
    <>
      <ThemePreviewSection diagnostics={diagnostics} project={project} theme={theme} title={title} />
      <Section description={contrastSummary(theme.contrast)} title="Contraste">
        <ContrastChecks report={theme.contrast} />
      </Section>
    </>
  );
}

/**
 * The default card and the org's widgets with `theme`, in sandboxed frames.
 * Shared by the theme item screen and the theme proposal screen.
 */
export function ThemePreviewSection({
  diagnostics,
  project,
  theme,
  title,
}: {
  diagnostics: readonly Diagnostic[];
  project: Project | null;
  theme: CompiledTheme;
  title: string;
}) {
  const [view, setView] = useState<PreviewView>({ mode: "both", variant: "all" });
  const card = useMemo(() => defaultCardPreviewDocument({ theme, title: "Cartão padrão" }), [theme]);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  return (
    <Section
      actions={<PreviewControls onChange={setView} view={view} />}
      description="O cartão padrão e os widgets da organização com este tema, só com dados de exemplo. A prévia não roda scripts nem acessa o Console."
      title="Prévia"
    >
      <div className="space-y-5">
        {errors.length ? (
          <div className="space-y-3">
            <Notice title="Este tema tem erros" tone="warn">
              A prévia usa o valor padrão no lugar de cada token inválido. Um tema com erros não publica.
            </Notice>
            <DiagnosticsList diagnostics={errors} />
          </div>
        ) : null}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Cartão padrão</h3>
          <p className="text-[13px] text-ink-3">O que as páginas mostram quando nenhum widget se aplica.</p>
          <PreviewFrame height={380} html={card} title={`Prévia do cartão padrão com o tema ${title}`} view={view} />
        </div>
        <OrgWidgetPreviews project={project} theme={theme} themeTitle={title} view={view} />
      </div>
    </Section>
  );
}

function OrgWidgetPreviews({ project, theme, themeTitle, view }: { project: Project | null; theme: CompiledTheme; themeTitle: string; view: PreviewView }) {
  const catalog = useWidgetCatalog(project?.id ?? null);
  const [limit, setLimit] = useState(WIDGETS_PAGE);
  const widgets = catalog.data ?? [];
  const shown = widgets.slice(0, limit);
  const items = useWidgetItems(shown.map((widget) => widget.ref));

  if (catalog.isPending) return <Skeleton className="h-64 w-full" />;
  if (catalog.isError) {
    return (
      <Notice title="Os widgets da organização não carregaram" tone="warn">
        <span className="flex flex-wrap items-center gap-2">
          {libraryErrorText(catalog.error) ?? "Tente de novo daqui a pouco."}
          <Button icon={RefreshCw} onClick={() => void catalog.refetch()} size="sm" variant="ghost">
            Tentar de novo
          </Button>
        </span>
      </Notice>
    );
  }
  if (!widgets.length) {
    return <p className="text-[13px] text-ink-3">A organização ainda não tem widgets publicados. Quando tiver, eles aparecem aqui com este tema.</p>;
  }
  return (
    <div className="space-y-5">
      {shown.map((widget, index) => (
        <OrgWidgetPreview
          files={items[index]?.data?.version.files ?? null}
          isError={items[index]?.isError ?? false}
          key={widget.ref}
          theme={theme}
          themeTitle={themeTitle}
          view={view}
          widget={widget}
        />
      ))}
      {widgets.length > limit ? (
        <Button onClick={() => setLimit((current) => current + WIDGETS_PAGE)} variant="secondary">
          {`Mostrar mais widgets (${widgets.length - limit})`}
        </Button>
      ) : null}
    </div>
  );
}

function OrgWidgetPreview({
  files,
  isError,
  theme,
  themeTitle,
  view,
  widget,
}: {
  files: LibraryFile[] | null;
  isError: boolean;
  theme: CompiledTheme;
  themeTitle: string;
  view: PreviewView;
  widget: CatalogWidgetSummary;
}) {
  const html = useMemo(() => (files ? widgetPreview({ files, theme }).html : null), [files, theme]);
  return (
    <div className="space-y-2">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-ink">
        {widget.name}
        <span className="font-mono text-[12px] font-normal text-ink-3">{widget.ref}</span>
      </h3>
      {html ? (
        <PreviewFrame height={420} html={html} title={`Prévia do widget ${widget.ref} com o tema ${themeTitle}`} view={view} />
      ) : isError ? (
        <p className="text-[13px] text-warn">Não deu para abrir este widget.</p>
      ) : files ? (
        <p className="text-[13px] text-warn">A versão atual deste widget não compila; abra o widget para ver os erros.</p>
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tema ativo

type PendingChange = { input: SetActiveThemeInput; plan: ThemePointerPlan };

/**
 * The organization's theme and, inside a project, the project's, with "Usar
 * este tema": a dry run first shows the plan (the Pages hosts that follow
 * the pointer), and only the confirmation applies it. Hidden for callers who
 * cannot set the pointer.
 */
export function ActiveThemePanel({ item, project }: { item: LibraryItem; project: Project | null }) {
  const active = useActiveThemes(project?.id ?? null);
  const change = useSetActiveTheme();
  const toast = useToast();
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (active.isPending) {
    return (
      <Section title="Tema ativo">
        <Skeleton className="h-24 w-full" />
      </Section>
    );
  }
  if (active.isError) {
    return (
      <Section title="Tema ativo">
        <Notice title="Não deu para ver o tema ativo" tone="warn">
          <span className="flex flex-wrap items-center gap-2">
            {libraryErrorText(active.error) ?? "Tente de novo daqui a pouco."}
            <Button icon={RefreshCw} onClick={() => void active.refetch()} size="sm" variant="ghost">
              Tentar de novo
            </Button>
          </span>
        </Notice>
      </Section>
    );
  }

  const data = active.data;
  const can = data.can ?? { setOrg: false, setProject: false };
  const usable = Boolean(item.version) && !item.archived;
  const fitsProject = Boolean(project) && (item.scope === "org" || item.project?.id === project?.id);
  const isOrgTheme = data.org?.ref === item.ref;
  const isProjectTheme = Boolean(project) && data.project?.ref === item.ref;

  const plan = (input: SetActiveThemeInput) => {
    setError(null);
    change.mutate(
      { ...input, dryRun: true },
      {
        onError: (failure) => setError(libraryErrorText(failure) ?? "Não deu para preparar a troca. Tente de novo."),
        onSuccess: (result) => {
          if (result.unchanged) {
            toast.show("Nada muda: este já é o tema ativo.");
            return;
          }
          setPending({ input, plan: result.plan });
        },
      },
    );
  };
  const apply = () => {
    if (!pending) return;
    setError(null);
    change.mutate(pending.input, {
      onError: (failure) => setError(libraryErrorText(failure) ?? "Não deu para trocar o tema. Tente de novo."),
      onSuccess: (result) => {
        setPending(null);
        const where = result.plan.scope === "org" ? "na organização" : `no projeto ${result.plan.project?.name ?? ""}`.trim();
        toast.show(result.plan.to ? `${result.plan.to.ref} é o tema ${where}.` : `O tema ${where} foi removido.`);
      },
    });
  };
  const close = () => {
    setPending(null);
    setError(null);
  };

  const unusableNote = !item.version ? "Publique uma versão antes de usar este tema." : item.archived ? "Este tema está arquivado; publique-o de novo para usar." : null;
  const orgAction = can.setOrg ? (
    isOrgTheme ? (
      <Button loading={change.isPending && !pending} onClick={() => plan({ scope: "org", ref: null })} size="sm" variant="secondary">
        Parar de usar na organização
      </Button>
    ) : item.scope === "org" && usable ? (
      <Button
        icon={Palette}
        loading={change.isPending && !pending}
        onClick={() => plan({ scope: "org", ref: item.ref })}
        size="sm"
        variant={project ? "secondary" : "primary"}
      >
        Usar este tema na organização
      </Button>
    ) : null
  ) : null;
  const projectAction =
    project && can.setProject ? (
      isProjectTheme ? (
        <Button loading={change.isPending && !pending} onClick={() => plan({ scope: "project", project: project.id, ref: null })} size="sm" variant="secondary">
          Parar de usar no projeto
        </Button>
      ) : fitsProject && usable ? (
        <Button
          icon={Palette}
          loading={change.isPending && !pending}
          onClick={() => plan({ scope: "project", project: project.id, ref: item.ref })}
          size="sm"
          variant="primary"
        >
          Usar este tema no projeto
        </Button>
      ) : null
    ) : null;

  return (
    <Section description="O tema que as páginas com tags ravi-* usam. Um projeto pode ter o seu, no lugar do da organização." title="Tema ativo">
      <Panel className="px-5">
        <DetailList
          items={[
            {
              label: "Organização",
              value: (
                <PointerRow action={orgAction} current={isOrgTheme} empty="Nenhum. As páginas usam o tema padrão do Ravi." pointer={data.org} />
              ),
            },
            project
              ? {
                  label: `Projeto ${project.name}`,
                  value: <PointerRow action={projectAction} current={isProjectTheme} empty="Nenhum. Vale o tema da organização." pointer={data.project} />,
                }
              : null,
            project
              ? {
                  label: "Vale nas páginas do projeto",
                  value: data.effective ? `${data.effective.name} (${data.effective.ref}, v${data.effective.version})` : "O tema padrão do Ravi",
                }
              : null,
          ]}
        />
      </Panel>
      {(can.setOrg || can.setProject) && unusableNote ? <p className="text-[13px] text-ink-3">{unusableNote}</p> : null}
      {data.warnings.length ? (
        <Notice title="Atenção" tone="warn">
          <ul className="list-disc space-y-0.5 pl-5">
            {data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {error && !pending ? <FormMessage>{error}</FormMessage> : null}

      <Dialog
        description={
          pending?.plan.scope === "org"
            ? "Vale para todos os projetos que não têm tema próprio."
            : "Vale só para este projeto, no lugar do tema da organização."
        }
        footer={
          <>
            <Button onClick={close} variant="ghost">
              Cancelar
            </Button>
            <Button icon={Check} loading={change.isPending} onClick={apply} variant="primary">
              Aplicar
            </Button>
          </>
        }
        onClose={close}
        open={pending !== null}
        title={pending ? planTitle(pending.plan) : ""}
      >
        {pending ? <PlanDetails plan={pending.plan} /> : null}
        {error ? (
          <div className="pt-3">
            <FormMessage>{error}</FormMessage>
          </div>
        ) : null}
      </Dialog>
    </Section>
  );
}

function PointerRow({ action, current, empty, pointer }: { action: React.ReactNode; current: boolean; empty: string; pointer: ThemePointer | null }) {
  return (
    <span className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {pointer ? (
          <>
            <span>{pointer.name}</span>
            <span className="font-mono text-[12.5px] text-ink-3">{pointer.ref}</span>
            {current ? <Badge tone="ok">Este tema</Badge> : null}
          </>
        ) : (
          <span className="text-ink-3">{empty}</span>
        )}
      </span>
      {action}
    </span>
  );
}

function pointerText(pointer: ThemePointer | null, none: string) {
  return pointer ? `${pointer.name} (${pointer.ref})` : none;
}

function planTitle(plan: ThemePointerPlan) {
  const where = plan.scope === "org" ? "na organização" : `no projeto ${plan.project?.name ?? ""}`.trim();
  return plan.to ? `Usar ${plan.to.ref} ${where}?` : `Parar de usar ${plan.from?.ref ?? "o tema"} ${where}?`;
}

function PlanDetails({ plan }: { plan: ThemePointerPlan }) {
  const none = plan.scope === "org" ? "Nenhum (tema padrão do Ravi)" : "Nenhum (vale o da organização)";
  return (
    <div className="space-y-3 text-sm">
      <DetailList
        items={[
          { label: "Antes", value: pointerText(plan.from, none) },
          { label: "Depois", value: pointerText(plan.to, none) },
        ]}
      />
      <div className="space-y-1.5">
        <h3 className="font-medium text-ink">{`Endereços afetados (${plan.affectedHosts.length})`}</h3>
        {plan.affectedHosts.length ? (
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {plan.affectedHosts.map((host) => (
              <li className="flex items-baseline justify-between gap-3" key={host.siteSlug}>
                <span className="truncate font-mono text-[12.5px] text-ink">{host.hostname}</span>
                <span className="shrink-0 text-[12.5px] text-ink-3">{`${host.routes} ${host.routes === 1 ? "rota" : "rotas"}`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-3">Nenhuma página publicada muda agora.</p>
        )}
      </div>
      <p className="text-[13px] text-ink-3">Páginas privadas pegam o tema novo na próxima visita. Públicas e com senha mudam no próximo ravi pages ship.</p>
    </div>
  );
}
