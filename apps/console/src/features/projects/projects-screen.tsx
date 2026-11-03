"use client";

import { FolderPlus, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { useWorkspace } from "@/features/shell/workspace";
import { useOrganizationAccess } from "@/features/org/access";
import { Avatar } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/form";
import { PageHeader } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { EmptyState, NoAccess } from "@/ui/states";
import { RelativeTime } from "@/ui/time";

export function ProjectsScreen() {
  const { projects } = useWorkspace();
  const canCreate = useOrganizationAccess().allows("organization.projects.create");
  const [filter, setFilter] = useState("");
  const sorted = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return [...projects]
      .filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.slug.includes(needle))
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  }, [filter, projects]);

  return (
    <>
      <PageHeader
        actions={
          canCreate && projects.length > 0 ? (
            <Button href="/projects/new" icon={Plus} variant="primary">
              New project
            </Button>
          ) : null
        }
        description="Each project has its own pages, bases and settings."
        title="Projects"
      />

      {projects.length === 0 ? (
        canCreate ? (
          <EmptyState
            action={
              <Button href="/projects/new" icon={Plus} variant="primary">
                Create a project
              </Button>
            }
            description="A project holds what your agents publish (pages) and the data they keep (bases). It comes with its own address on ravi.page."
            icon={FolderPlus}
            title="Create your first project"
          />
        ) : (
          <NoAccess
            description="No project is currently available under your access policy. Organization membership alone does not open projects."
            title="No projects to show"
          />
        )
      ) : (
        <div className="space-y-3">
          {projects.length > 8 ? (
            <Input
              aria-label="Find a project"
              className="max-w-xs"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a project"
              type="search"
              value={filter}
            />
          ) : null}
          <List label="Projects">
            {sorted.map((project) => (
              <ListRow
                chevron
                description={project.description || project.slug}
                href={`/p/${project.id}`}
                key={project.id}
                leading={<Avatar label={project.name} seed={project.id} />}
                meta={
                  <span>
                    Active <RelativeTime value={project.lastActive} />
                  </span>
                }
                title={project.name}
              />
            ))}
          </List>
          {!sorted.length ? <p className="px-1 text-sm text-ink-3">No project matches “{filter}”.</p> : null}
        </div>
      )}
    </>
  );
}
