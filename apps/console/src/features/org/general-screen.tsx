"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiError } from "@/lib/api/client";
import { suggestConsoleSlug } from "@/lib/console/slugs";
import type { OrganizationSettingsData } from "@/features/console/types";
import { CalendarRecordingPanel } from "@/features/calendar/policy-panel";
import { CloudAgentsCredentialPanel } from "@/features/cloud-agents/credential-panel";
import { MeetingsSharingPanel } from "@/features/meetings/meeting-sharing";
import { roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input } from "@/ui/form";
import { Panel } from "@/ui/layout";
import { ErrorState, Notice, Skeleton } from "@/ui/states";
import { useToast } from "@/ui/toast";
import { settingsErrorMessage } from "./labels";
import { OrgArea } from "./org-area";
import { useOrgSettings, useSaveOrgSettings } from "./queries";
import { OnboardingReminder } from "./onboarding-screen";
import { useOrganizationAccess } from "./access";

export function OrgGeneralScreen() {
  return (
    <OrgArea tab="settings">
      <OnboardingReminder />
      <GeneralBody />
    </OrgArea>
  );
}

function GeneralBody() {
  const { organization } = useWorkspace();
  const settings = useOrgSettings();

  if (settings.isPending) return <GeneralSkeleton />;
  if (settings.isError) {
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} role={roleLabel(organization.role)} />;
  }
  return <GeneralForm key={`${settings.data.name}\u0000${settings.data.slug}`} settings={settings.data} />;
}

function CloudAgentsSettings() {
  return useFeature("console.cloud_agents") ? <CloudAgentsCredentialPanel /> : null;
}

function MeetingsSettings() {
  const meetings = useFeature("console.meetings");
  return meetings ? (
    <>
      <MeetingsSharingPanel />
      <CalendarRecordingPanel />
    </>
  ) : null;
}

/** Keeps what the person types, minus characters a slug can never hold. */
function cleanSlugInput(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63);
}

function GeneralForm({ settings }: { settings: OrganizationSettingsData }) {
  const canManage = useOrganizationAccess().allows("organization.settings.manage");
  const router = useRouter();
  const toast = useToast();
  const save = useSaveOrgSettings();
  const [name, setName] = useState(settings.name);
  const [slug, setSlug] = useState(settings.slug);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const finalSlug = suggestConsoleSlug(slug);
  const changed = name.trim() !== settings.name || finalSlug !== settings.slug;
  const slugChanged = Boolean(finalSlug) && finalSlug !== settings.slug;
  const generatedSlug = settings.slug.startsWith("workos-") && !slugChanged;
  const formError =
    save.isError && !(save.error instanceof ApiError && save.error.fieldErrors) ? settingsErrorMessage(save.error) : null;

  return (
    <div className="max-w-2xl space-y-4">
      {!canManage && <Notice title="Somente consulta" tone="info">Você pode consultar a configuração, sem alterar o nome ou endereço da organização.</Notice>}
      {generatedSlug ? (
        <Notice title="Choose a short address first" tone="warn">
          This address was made up automatically when the organization was created. Page hosts can&apos;t be built from
          it, so pick something short, like your company name, before creating projects.
        </Notice>
      ) : null}
      <Panel padded>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canManage) return;
            const next: Record<string, string> = {};
            if (!name.trim()) next.name = "Give the organization a name.";
            if (!finalSlug) next.slug = "Choose an address.";
            setErrors(next);
            if (Object.keys(next).length) return;
            save.mutate(
              { name: name.trim(), slug: finalSlug },
              {
                onError: (error) => {
                  if (error instanceof ApiError && error.fieldErrors) {
                    setErrors({
                      ...error.fieldErrors,
                      ...(error.code === "slug_unavailable" ? { slug: settingsErrorMessage(error) } : {}),
                    });
                  }
                },
                onSuccess: () => {
                  toast.show("Organization saved.");
                  router.refresh();
                },
              },
            );
          }}
        >
          <Field error={errors.name} hint="Shown to everyone in the organization." label="Name">
            {(props) => (
              <Input
                {...props}
                autoComplete="organization"
                readOnly={!canManage}
                maxLength={120}
                onChange={(event) => {
                  setName(event.target.value);
                  setErrors((current) => ({ ...current, name: "" }));
                }}
                value={name}
              />
            )}
          </Field>

          <Field
            error={errors.slug}
            hint="Lowercase letters, numbers and dashes. It starts the address of every new page host."
            label="Address"
          >
            {(props) => (
              <Input
                {...props}
                autoCapitalize="none"
                readOnly={!canManage}
                autoCorrect="off"
                className="font-mono text-[13px]"
                onBlur={() => setSlug(finalSlug)}
                onChange={(event) => {
                  setSlug(cleanSlugInput(event.target.value));
                  setErrors((current) => ({ ...current, slug: "" }));
                }}
                spellCheck={false}
                value={slug}
              />
            )}
          </Field>

          <div className="rounded-md bg-sunken px-3.5 py-3 text-[13px] text-ink-2">
            A new project called “website” gets{" "}
            <span className="font-mono text-ink break-all">{finalSlug || settings.slug}-website.ravi.page</span>.
            {slugChanged ? (
              <>
                {" "}
                Pages that already exist keep their current addresses (
                <span className="font-mono break-all">{settings.slug}-…</span>). If you use the Ravi command line, run{" "}
                <span className="font-mono text-ink">ravi login</span> again after saving.
              </>
            ) : (
              <> Changing the address later doesn&apos;t move pages that already exist.</>
            )}
          </div>

          {formError ? <FormMessage>{formError}</FormMessage> : null}

          {canManage && <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
            {changed ? (
              <Button
                onClick={() => {
                  setName(settings.name);
                  setSlug(settings.slug);
                  setErrors({});
                  save.reset();
                }}
                variant="ghost"
              >
                Discard changes
              </Button>
            ) : null}
            <Button disabled={!changed} loading={save.isPending} type="submit" variant="primary">
              Save
            </Button>
          </div>}
        </form>
      </Panel>
      <p className="text-[13px] text-ink-3">
        Who can open pages is set in each project, not here. Open a project and go to Settings to change it.
      </p>
      <MeetingsSettings />
      <CloudAgentsSettings />
    </div>
  );
}

function GeneralSkeleton() {
  return (
    <div className="max-w-2xl rounded-lg border border-line bg-surface p-5" aria-busy aria-label="Loading" role="status">
      <div className="space-y-5">
        {[0, 1].map((index) => (
          <div className="space-y-2" key={index}>
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <Skeleton className="h-12 w-full" />
        <div className="flex justify-end">
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
    </div>
  );
}
