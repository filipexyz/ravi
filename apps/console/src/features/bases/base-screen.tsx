"use client";

import { Archive, ArrowLeft, CircleHelp, Lock } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import type { Project } from "@/features/console/types";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import type { BaseDetail } from "@/shared/bases/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CopyButton, CopyValue } from "@/ui/copy";
import { PageHeader } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Notice, Skeleton } from "@/ui/states";
import { TabNav } from "@/ui/tabs";
import { ActivityTab } from "./activity-tab";
import { ChangeBaseHelp } from "./agent-help";
import { useBaseDetail } from "./api";
import { plural } from "./format";
import { BasesProjectGate } from "./project-gate";
import { RowsTab } from "./rows-tab";
import { SchemaTab } from "./schema-tab";
import { ViewsTab } from "./views-tab";

export type BaseTab = "rows" | "schema" | "views" | "activity";

const TAB_PATHS: Record<BaseTab, string> = { activity: "/activity", rows: "", schema: "/schema", views: "/views" };

export function BaseScreen({ baseRef, projectId, tab }: { baseRef: string; projectId: string; tab: BaseTab }) {
  return (
    <BasesProjectGate projectRef={projectId}>
      {(project) => <BaseFrame baseRef={baseRef} project={project} tab={tab} />}
    </BasesProjectGate>
  );
}

function BackLink({ projectId }: { projectId: string }) {
  return (
    <Button className="-ml-2.5 mb-3 text-ink-3" href={`/p/${projectId}/bases`} icon={ArrowLeft} size="sm" variant="ghost">
      Bases
    </Button>
  );
}

/**
 * Meta item with its separator in front, so a wrapped line never ends on a dot. On phones the slug takes its
 * own line and the first item after it drops its dot, so the second line doesn't start with one.
 */
function MetaItem({ children, className, first = false }: { children: React.ReactNode; className?: string; first?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <span aria-hidden className={first ? "hidden sm:inline" : undefined}>
        ·
      </span>
      <span>{children}</span>
    </span>
  );
}

function BaseFrame({ baseRef, project, tab }: { baseRef: string; project: Project; tab: BaseTab }) {
  const { organization } = useWorkspace();
  const detail = useBaseDetail(project.id, baseRef);

  if (detail.isPending) {
    return (
      <>
        <BackLink projectId={project.id} />
        <div aria-busy aria-label="Carregando" className="mb-6 space-y-3" role="status">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <ListSkeleton rows={5} />
      </>
    );
  }
  if (detail.isError) {
    return (
      <>
        <BackLink projectId={project.id} />
        <ErrorState
          error={detail.error}
          onRetry={() => void detail.refetch()}
          role={roleLabel(organization.role)}
          title="Esta base não existe, ou nenhuma view dela está aberta para você"
        />
      </>
    );
  }

  return <BaseLoaded base={detail.data} project={project} tab={tab} />;
}

function BaseLoaded({ base, project, tab }: { base: BaseDetail; project: Project; tab: BaseTab }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const manage = base.capabilities.manage;
  const root = `/p/${project.id}/bases/${base.slug}`;
  const tabs: BaseTab[] = manage ? ["rows", "schema", "views", "activity"] : ["rows", "views"];
  const labels: Record<BaseTab, string> = { activity: "Atividade", rows: "Linhas", schema: "Esquema", views: "Views" };

  return (
    <>
      <BackLink projectId={project.id} />
      <PageHeader
        actions={
          <>
            <CopyButton label="Copiar id da base" size="md" value={base.id} variant="secondary">
              Copiar id
            </CopyButton>
            {manage ? (
              <Button icon={CircleHelp} onClick={() => setHelpOpen(true)} variant="ghost">
                Como mudar
              </Button>
            ) : null}
          </>
        }
        className="mb-5"
        description={base.description}
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <span className="min-w-0 break-words">{base.name}</span>
            {base.status === "archived" ? <Badge>Arquivada</Badge> : null}
          </span>
        }
      >
        <div className="flex flex-col items-start gap-y-1 pt-0.5 text-[13px] text-ink-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
          <CopyValue className="-my-1" value={base.slug} />
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <MetaItem first>Datas em {base.timezone}</MetaItem>
            <MetaItem className="hidden sm:inline-flex">Versão do esquema {base.schemaVersion}</MetaItem>
            {base.rowCount !== null ? <MetaItem>{plural(base.rowCount, "linha")}</MetaItem> : null}
          </span>
        </div>
      </PageHeader>

      {base.status === "archived" ? (
        <Notice className="mb-5" icon={Archive} title="Esta base está arquivada" tone="warn">
          Ela é só de leitura e não aparece na lista do projeto. Páginas que usam as views dela deixam de mostrar linhas. Um
          agente pode restaurá-la.
        </Notice>
      ) : null}

      <div className="mb-6 border-b border-line">
        <TabNav
          items={tabs.map((key) => ({
            active: key === tab,
            count: key === "views" ? base.views.length : undefined,
            href: `${root}${TAB_PATHS[key]}`,
            label: labels[key],
          }))}
          label="Base"
        />
      </div>

      {!tabs.includes(tab) ? (
        <EmptyState
          description="O esquema e o histórico de uma base aparecem para quem administra ou desenvolve o projeto. Você pode ler linhas pelas views abertas para você."
          icon={Lock}
          title="Só quem administra ou desenvolve o projeto vê isto"
        />
      ) : tab === "rows" ? (
        <RowsTab base={base} projectId={project.id} />
      ) : tab === "schema" ? (
        <SchemaTab base={base} />
      ) : tab === "views" ? (
        <ViewsTab base={base} projectId={project.id} />
      ) : (
        <ActivityTab base={base} projectId={project.id} />
      )}

      <Dialog
        className="max-w-lg"
        description="Agentes fazem toda mudança numa base. O Console mostra o resultado."
        onClose={() => setHelpOpen(false)}
        open={helpOpen}
        title="Como mudar esta base"
      >
        <ChangeBaseHelp baseSlug={base.slug} projectSlug={project.slug} />
      </Dialog>
    </>
  );
}
