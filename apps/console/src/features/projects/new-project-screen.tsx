"use client";

import { useMutation } from "@tanstack/react-query";
import { useOrgRouter } from "@/lib/org-href";
import { useState } from "react";

import { api, ApiError, describeError } from "@/lib/api/client";
import { suggestConsoleSlug } from "@/lib/console/slugs";
import type { Project, Visibility } from "@/features/console/types";
import { useWorkspace } from "@/features/shell/workspace";
import { useOrganizationAccess } from "@/features/org/access";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input, Select, Textarea } from "@/ui/form";
import { PageHeader, Panel } from "@/ui/layout";
import { ErrorState, NoAccess, Skeleton } from "@/ui/states";

type CreateProjectResponse = { project: Project; redirectTo: string };

/** Light cleanup while typing, so a trailing dash survives until blur. */
function typingSlug(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-/, "")
    .slice(0, 63);
}

const VISIBILITY_HELP: Record<Visibility, string> = {
  private: "People in this organization who can open the project.",
  public: "Anyone with the link.",
  protected_link: "Signed-in people who can open the project. Today this works the same as Private.",
};

export function NewProjectScreen() {
  const router = useOrgRouter();
  const { organization } = useWorkspace();
  const access = useOrganizationAccess();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () =>
      api.post<CreateProjectResponse>("/api/console/projects", {
        createDefaultPageSite: true,
        defaultVisibility: visibility,
        description: description.trim() || null,
        name: name.trim(),
        slug: suggestConsoleSlug(slug),
      }),
    onError: (error) => {
      if (error instanceof ApiError && error.fieldErrors) setErrors(error.fieldErrors);
    },
    onSuccess: (result) => {
      router.push(result.redirectTo || `/p/${result.project.id}`);
      router.refresh();
    },
  });

  if (access.isPending) return <Skeleton className="h-48" />;
  if (access.isError) return <ErrorState error={access.error} onRetry={() => void access.refetch()} />;
  if (!access.allows("organization.projects.create")) {
    return (
      <NoAccess
        description="Your current access policy does not permit project creation. An organization role name alone does not grant access."
        title="You can't create projects"
      />
    );
  }

  const host = slug ? `${organization.slug}-${slug}.ravi.page` : null;
  const formError =
    create.isError && !(create.error instanceof ApiError && create.error.fieldErrors)
      ? create.error instanceof ApiError && create.error.code === "project_creation_forbidden"
        ? "Creation or the required data access was not granted. Ask a policy manager to review your access before retrying."
        : describeError(create.error) : null;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader description="A project gets its own address for pages, and its own bases." title="New project" />
      <p className="mb-4 text-sm text-ink-2">Creation also requires explicit read and write access to new projects. Creating a project does not assign you a role or change its access policy.</p>
      <Panel padded>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!access.allows("organization.projects.create") || create.isPending) return;
            const next: Record<string, string> = {};
            if (!name.trim()) next.name = "Give the project a name.";
            if (!slug) next.slug = "Choose an address.";
            setErrors(next);
            if (Object.keys(next).length) return;
            create.mutate();
          }}
        >
          <Field error={errors.name} label="Name">
            {(props) => (
              <Input
                {...props}
                autoFocus
                onChange={(event) => {
                  setName(event.target.value);
                  if (!slugEdited) setSlug(suggestConsoleSlug(event.target.value));
                }}
                placeholder="Acme website"
                value={name}
              />
            )}
          </Field>

          <Field
            error={errors.slug}
            hint="Lowercase letters, numbers and dashes. Renaming the project later keeps this address."
            label="Address"
          >
            {(props) => (
              <div className="flex items-center rounded-md border border-line-strong bg-surface focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/25">
                <span className="hidden pl-3 font-mono text-[13px] text-ink-3 select-none sm:inline">{organization.slug}-</span>
                <input
                  {...props}
                  className="h-9 min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] text-ink outline-none sm:px-0"
                  onBlur={() => setSlug(suggestConsoleSlug(slug))}
                  onChange={(event) => {
                    setSlugEdited(true);
                    setSlug(typingSlug(event.target.value));
                  }}
                  placeholder="acme-website"
                  value={slug}
                />
                <span className="pr-3 font-mono text-[13px] text-ink-3 select-none">.ravi.page</span>
              </div>
            )}
          </Field>
          {host ? (
            <p className="-mt-2 text-[13px] text-ink-2">
              Pages will be published at <span className="font-mono text-ink">{host}</span>
            </p>
          ) : null}

          <Field error={errors.description} label="Description" optional>
            {(props) => (
              <Textarea
                {...props}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this project for?"
                rows={3}
                value={description}
              />
            )}
          </Field>

          <Field error={errors.defaultVisibility} hint={VISIBILITY_HELP[visibility]} label="Who can open its pages by default">
            {(props) => (
              <Select {...props} onChange={(event) => setVisibility(event.target.value as Visibility)} value={visibility}>
                <option value="private">Private</option>
                <option value="protected_link">Protected</option>
                <option value="public">Public</option>
              </Select>
            )}
          </Field>

          {formError ? <FormMessage>{formError}</FormMessage> : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button href="/projects" variant="ghost">
              Cancel
            </Button>
            <Button loading={create.isPending} type="submit" variant="primary">
              Create project
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
