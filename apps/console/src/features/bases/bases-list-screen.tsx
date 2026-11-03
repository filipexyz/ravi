"use client";

import { useQueries } from "@tanstack/react-query";
import { CircleHelp, Database } from "lucide-react";
import { useState } from "react";

import type { Project } from "@/features/console/types";
import { roleCapabilities, roleLabel, useOrgKey, useWorkspace } from "@/features/shell/workspace";
import type { BaseSummary } from "@/shared/bases/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { PageHeader } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { CreateBaseHelp } from "./agent-help";
import { baseDetailQuery, useBasesList } from "./api";
import { plural } from "./format";
import { BasesProjectGate } from "./project-gate";
import { When } from "./when";

/** Above this many bases the list skips loading each base to count its views. */
const VIEW_COUNT_LIMIT = 30;

export function BasesListScreen({ projectId }: { projectId: string }) {
  return <BasesProjectGate projectRef={projectId}>{(project) => <BasesList project={project} />}</BasesProjectGate>;
}

function BasesList({ project }: { project: Project }) {
  const { organization } = useWorkspace();
  const [showArchived, setShowArchived] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const bases = useBasesList(project.id, showArchived);
  const list = bases.data ?? [];
  const canManage = roleCapabilities(organization.role).canWriteProjects || list.some((base) => base.capabilities.manage);

  return (
    <>
      <PageHeader
        actions={
          list.length ? (
            <Button icon={CircleHelp} onClick={() => setHelpOpen(true)} variant="ghost">
              Como bases são feitas
            </Button>
          ) : null
        }
        description="Os dados que seus agentes guardam para este projeto: o que cada base armazena, quais views a leem e quem pode abri-las. Para mudar algo, peça a um agente."
        title="Bases"
      />

      {bases.isPending ? (
        <ListSkeleton rows={3} />
      ) : bases.isError ? (
        <ErrorState error={bases.error} onRetry={() => void bases.refetch()} role={roleLabel(organization.role)} title="As bases não carregaram" />
      ) : list.length === 0 ? (
        <EmptyState
          description={
            showArchived
              ? "Este projeto não tem bases, arquivadas ou não. Bases são criadas por agentes na conversa."
              : canManage
                ? "Bases são criadas pelos seus agentes na conversa. Peça a um para guardar algo deste projeto, e a base aparece aqui."
                : "Nenhuma base deste projeto tem uma view que você possa abrir. Peça a quem administra o projeto para compartilhar uma, ou peça a um agente para criar."
          }
          icon={Database}
          title="Nenhuma base ainda"
        >
          {canManage || showArchived ? <CreateBaseHelp projectSlug={project.slug} /> : null}
        </EmptyState>
      ) : (
        <BaseRows bases={list} projectId={project.id} />
      )}

      {canManage && !bases.isError ? (
        <div className="mt-3 flex justify-end">
          <Button aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)} size="sm" variant="ghost">
            {showArchived ? "Esconder bases arquivadas" : "Mostrar bases arquivadas"}
          </Button>
        </div>
      ) : null}

      <Dialog
        className="max-w-lg"
        description="Uma base é uma tabela com tipos que agentes criam e preenchem. As pessoas a usam por páginas que os agentes constroem sobre as views dela."
        onClose={() => setHelpOpen(false)}
        open={helpOpen}
        title="Como bases são feitas"
      >
        <CreateBaseHelp projectSlug={project.slug} />
      </Dialog>
    </>
  );
}

function BaseRows({ bases, projectId }: { bases: BaseSummary[]; projectId: string }) {
  const orgKey = useOrgKey();
  const details = useQueries({
    queries: bases.map((base) => ({
      ...baseDetailQuery(orgKey, projectId, base.slug),
      enabled: bases.length <= VIEW_COUNT_LIMIT && base.status === "active",
    })),
  });

  return (
    <List label="Bases">
      {bases.map((base, index) => {
        const viewCount = details[index]?.data?.views.length;
        const meta = [
          base.rowCount !== null ? plural(base.rowCount, "linha") : null,
          viewCount !== undefined ? plural(viewCount, "view") : null,
        ].filter(Boolean);
        return (
          <ListRow
            chevron
            description={
              <>
                <span className="font-mono text-[12px]">{base.slug}</span>
                {base.description ? <span> · {base.description}</span> : null}
                {base.rowCount !== null ? <span className="md:hidden"> · {plural(base.rowCount, "linha")}</span> : null}
              </>
            }
            href={`/p/${projectId}/bases/${base.slug}`}
            key={base.id}
            leading={
              <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
                <Database aria-hidden size={16} />
              </span>
            }
            meta={
              <>
                {meta.length ? <span>{meta.join(" · ")}</span> : null}
                <span>
                  Atualizada <When value={base.updatedAt} />
                </span>
              </>
            }
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{base.name}</span>
                {base.status === "archived" ? <Badge>Arquivada</Badge> : null}
              </span>
            }
          />
        );
      })}
    </List>
  );
}
