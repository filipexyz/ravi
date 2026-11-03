"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { api, ApiError, describeError } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { suggestConsoleSlug } from "@/lib/console/slugs";
import type { PageSiteSummary, Project, SettingsData, Visibility } from "@/features/console/types";
import { roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input, Select } from "@/ui/form";
import { Panel } from "@/ui/layout";
import { ErrorState, Skeleton } from "@/ui/states";
import { useToast } from "@/ui/toast";
import {
  defaultSite,
  PUBLIC_PAGES_AUDIENCE,
  useProjectKeys,
  useProjectSettingsQuery,
  useSitesQuery,
  VISIBILITY_LABEL,
} from "./data";
import { CommandBlock } from "./command-block";
import { SettingsFrame } from "./settings-frame";
import { SettingsGroup, SettingsGroupAside } from "./settings-group";

export function GeneralSettingsScreen({ projectId }: { projectId: string }) {
  return (
    <SettingsFrame projectRef={projectId} tab="general">
      {(project) => <General project={project} />}
    </SettingsFrame>
  );
}

const ACCESS_HELP: Record<Visibility, string> = {
  private: "Only people in this organization who can open the project.",
  protected_link: "Signed-in people who can open the project. Today this works the same as Private.",
  public: "Anyone with the link, where the page's host allows it (see below).",
};

function General({ project }: { project: Project }) {
  const { organization } = useWorkspace();
  const pagesOn = useFeature("console.pages");
  const settings = useProjectSettingsQuery(project.id);
  const sites = useSitesQuery(project.id, pagesOn);

  if (settings.isLoading) return <FormSkeleton />;
  if (settings.isError) {
    return (
      <ErrorState
        error={settings.error}
        onRetry={() => void settings.refetch()}
        role={roleLabel(organization.role)}
        title="Settings couldn't load"
      />
    );
  }
  if (!settings.data) return <FormSkeleton />;
  return <GeneralForm project={project} settings={settings.data} sites={sites.data ?? []} sitesLoading={sites.isLoading} />;
}

function FormSkeleton() {
  return (
    <Panel className="max-w-[720px] space-y-6" padded>
      {[0, 1, 2].map((index) => (
        <div className="space-y-2" key={index}>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </Panel>
  );
}

type FormValues = { name: string; slug: string; visibility: Visibility };

function valuesFrom(settings: SettingsData): FormValues {
  return { name: settings.name, slug: settings.slug, visibility: settings.visibility };
}

/** Lowercase, dashes for anything else, but keeps a trailing dash while typing. */
function typingSlug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63);
}

function GeneralForm({
  project,
  settings,
  sites,
  sitesLoading,
}: {
  project: Project;
  settings: SettingsData;
  sites: PageSiteSummary[];
  sitesLoading: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const keys = useProjectKeys(project.id);
  const toast = useToast();
  const [saved, setSaved] = useState<FormValues>(() => valuesFrom(settings));
  const [values, setValues] = useState<FormValues>(() => valuesFrom(settings));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (next: FormValues) =>
      api.post<SettingsData>("/api/console/settings", {
        name: next.name,
        projectId: project.id,
        scope: "project",
        slug: next.slug,
        visibility: next.visibility,
      }),
    onError: (error) => {
      if (error instanceof ApiError && error.fieldErrors) {
        const next: Record<string, string> = {};
        for (const [field, message] of Object.entries(error.fieldErrors)) {
          if (!message) continue;
          next[field] = field === "slug" ? "This slug is taken or not allowed. Try another one." : message;
        }
        setErrors(next);
      }
    },
    onSuccess: async (data) => {
      const next = valuesFrom(data);
      setSaved(next);
      setValues(next);
      setErrors({});
      queryClient.setQueryData(keys.settings, data);
      toast.show("Settings saved");
      await queryClient.invalidateQueries({ queryKey: keys.all });
      router.refresh();
    },
  });

  const dirty = values.name !== saved.name || values.slug !== saved.slug || values.visibility !== saved.visibility;
  const formError =
    save.isError && !(save.error instanceof ApiError && save.error.fieldErrors) ? describeError(save.error) : null;
  const host = defaultSite(sites)?.defaultHostname;
  const activeSites = sites.filter((site) => site.status === "active");

  const update = (patch: Partial<FormValues>) => {
    if (save.isError) save.reset();
    setValues((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };

  return (
    <form
      className="space-y-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const next: FormValues = {
          name: values.name.trim(),
          slug: suggestConsoleSlug(values.slug),
          visibility: values.visibility,
        };
        const problems: Record<string, string> = {};
        if (!next.name) problems.name = "Give the project a name.";
        if (!next.slug) problems.slug = "Choose a slug: lowercase letters, numbers and dashes.";
        setValues(next);
        setErrors(problems);
        if (Object.keys(problems).length) return;
        save.mutate(next);
      }}
    >
      <SettingsGroup description="How the project is called in the Console and in commands." title="Project">
        <Panel className="space-y-5 p-4 sm:p-5" padded>
          <Field error={errors.name} label="Name">
            {(props) => (
              <Input {...props} onChange={(event) => update({ name: event.target.value })} value={values.name} />
            )}
          </Field>

          <Field
            error={errors.slug}
            hint={
              <>
                Lowercase letters, numbers and dashes, used in commands such as{" "}
                <span className="font-mono text-[12px] whitespace-nowrap text-ink-2">--project {saved.slug}</span>.
                Changing it keeps the current page address
                {host ? (
                  <>
                    {" "}
                    <span className="font-mono text-[12px] text-ink-2">{host}</span>
                  </>
                ) : null}
                , but commands that use the old slug stop working.
              </>
            }
            label="Slug"
          >
            {(props) => (
              <Input
                {...props}
                autoCapitalize="none"
                autoCorrect="off"
                className="font-mono text-[13px]"
                onBlur={() => update({ slug: suggestConsoleSlug(values.slug) })}
                onChange={(event) => update({ slug: typingSlug(event.target.value) })}
                spellCheck={false}
                value={values.slug}
              />
            )}
          </Field>
        </Panel>
      </SettingsGroup>

      <SettingsGroup
        description="Who can open a page when it's published without saying so."
        title="Page access"
      >
        <Panel className="space-y-5 p-4 sm:p-5" padded>
          <Field error={errors.visibility} hint={ACCESS_HELP[values.visibility]} label="Default access for new pages">
            {(props) => (
              <Select
                {...props}
                className="sm:max-w-xs"
                onChange={(event) => update({ visibility: event.target.value as Visibility })}
                value={values.visibility}
              >
                <option value="private">Private</option>
                <option value="protected_link">Protected</option>
                <option value="public">Public</option>
              </Select>
            )}
          </Field>
          <div className="space-y-3 border-t border-line pt-5">
            <p className="text-sm text-ink-2">
              Each host also has its own default, and that one decides who opens the pages marked Public. This setting
              doesn&apos;t change it; the host&apos;s is changed from the command line.
            </p>
            {sitesLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : activeSites.length ? (
              activeSites.map((site) => <HostAccess key={site.id} projectSlug={saved.slug} site={site} />)
            ) : (
              <p className="text-sm text-ink-3">This project has no host yet. Publishing its first page creates one.</p>
            )}
          </div>
        </Panel>
      </SettingsGroup>

      <SettingsGroupAside className={cn(dirty && "sticky bottom-4 z-10")}>
        <div
          className={cn(
            "flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end",
            dirty && "rounded-lg border border-line bg-surface px-4 py-3 shadow-pop",
          )}
        >
          {formError ? (
            <div className="sm:mr-auto">
              <FormMessage>{formError}</FormMessage>
            </div>
          ) : dirty ? (
            <span className="text-[13px] text-ink-2 sm:mr-auto">You have unsaved changes.</span>
          ) : null}
          <div className="flex justify-end gap-2">
            {dirty ? (
              <Button
                onClick={() => {
                  setValues(saved);
                  setErrors({});
                  save.reset();
                }}
                variant="ghost"
              >
                Discard
              </Button>
            ) : null}
            <Button disabled={!dirty} loading={save.isPending} type="submit" variant="primary">
              Save changes
            </Button>
          </div>
        </div>
      </SettingsGroupAside>
    </form>
  );
}

/** One host's own default, what it means for pages marked Public, and the command to change it. */
function HostAccess({ projectSlug, site }: { projectSlug: string; site: PageSiteSummary }) {
  const current = site.defaultVisibility;
  const target = current === "public" ? "private" : "public";
  const command = `ravi pages visibility ${site.slug} ${target} --project ${projectSlug} --execute`;
  return (
    <div className="space-y-2.5 rounded-md border border-line bg-sunken/60 p-3 sm:p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-mono text-[13px] text-ink">{site.defaultHostname}</span>
        <span className="text-[13px] text-ink-3">Host default: {VISIBILITY_LABEL[current]}</span>
      </div>
      <p className="text-sm text-ink-2">
        Pages marked Public here open to {PUBLIC_PAGES_AUDIENCE[current]}.{" "}
        {target === "public"
          ? "To let anyone with the link open them, run:"
          : "To make them ask people to sign in again, run:"}
      </p>
      <CommandBlock className="bg-surface" command={command} />
    </div>
  );
}
