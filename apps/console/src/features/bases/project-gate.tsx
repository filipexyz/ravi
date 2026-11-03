"use client";

import { SearchX } from "lucide-react";

import type { Project } from "@/features/console/types";
import { findProject, roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { EmptyState, NoAccess } from "@/ui/states";

/**
 * Resolves the project from the route and checks that Bases is on for this
 * organization and role. The server still enforces both on every call.
 */
export function BasesProjectGate({ children, projectRef }: { children: (project: Project) => React.ReactNode; projectRef: string }) {
  const { organization, projects } = useWorkspace();
  const enabled = useFeature("console.bases");
  const project = findProject(projects, projectRef);

  if (!project) {
    return (
      <EmptyState
        action={<Button href="/projects">Todos os projetos</Button>}
        description="Confira o endereço, ou escolha um projeto da lista."
        icon={SearchX}
        title="Este projeto não existe ou você não tem acesso"
      />
    );
  }
  if (!enabled) {
    return (
      <NoAccess
        description="Bases não está ligado para esta organização, ou o seu papel não inclui Bases."
        role={roleLabel(organization.role)}
        title="Bases não está disponível aqui"
      />
    );
  }
  return <>{children(project)}</>;
}
