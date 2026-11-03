"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { ApiError, describeError } from "@/lib/api/client";
import type { PageSiteSummary } from "@/features/console/types";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Button, IconButton } from "@/ui/button";
import { Field, FormMessage, Input, Textarea } from "@/ui/form";
import { Dialog } from "@/ui/overlay";
import { ErrorState, ListSkeleton } from "@/ui/states";
import { useToast } from "@/ui/toast";
import { useAddAudience, useAudiences, useRemoveAudience, type ViewerAssertionAudience } from "./data";
import { Collapsible } from "./parts";

/** Developer settings for one host, collapsed by default. Today: viewer identity for a page's own API. */
export function AdvancedSection({ canWrite, projectId, site }: { canWrite: boolean; projectId: string; site: PageSiteSummary }) {
  return (
    <Collapsible id="advanced" title="Advanced">
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-ink">Viewer identity for your own API</h3>
          <p className="max-w-2xl text-sm text-ink-3">
            If a page calls an API you run, register that API here. The page can then ask for a token, valid for 60 seconds,
            that tells your API who is viewing.
          </p>
        </div>
        <AudienceList canWrite={canWrite} projectId={projectId} site={site} />
      </div>
    </Collapsible>
  );
}

function AudienceList({ canWrite, projectId, site }: { canWrite: boolean; projectId: string; site: PageSiteSummary }) {
  const { organization } = useWorkspace();
  const audiences = useAudiences(projectId, site.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ViewerAssertionAudience | null>(null);
  const items = audiences.data?.items ?? [];

  return (
    <div className="space-y-2">
      {canWrite && audiences.data ? (
        <Button icon={Plus} onClick={() => setAdding(true)} size="sm">
          Register an API
        </Button>
      ) : null}
      {audiences.isPending ? (
        <ListSkeleton rows={1} />
      ) : audiences.isError ? (
        <ErrorState error={audiences.error} onRetry={() => audiences.refetch()} role={roleLabel(organization.role)} />
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-3">No API registered.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {items.map((item) => (
            <li className="flex items-center gap-3 px-4 py-2.5" key={item.id}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px] text-ink">{item.audience}</div>
                <div className="truncate text-xs text-ink-3">For pages at {item.origins.map((origin) => origin.replace(/^https:\/\//, "")).join(", ")}</div>
              </div>
              {canWrite ? (
                <IconButton icon={Trash2} label={`Remove ${item.audience}`} onClick={() => setRemoving(item)} size="sm" />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? <AddAudienceDialog onClose={() => setAdding(false)} projectId={projectId} site={site} /> : null}
      <RemoveAudienceDialog audience={removing} onClose={() => setRemoving(null)} projectId={projectId} siteId={site.id} />
    </div>
  );
}

function AddAudienceDialog({ onClose, projectId, site }: { onClose: () => void; projectId: string; site: PageSiteSummary }) {
  const add = useAddAudience(projectId, site.id);
  const toast = useToast();
  const [audience, setAudience] = useState("");
  const [origins, setOrigins] = useState(`https://${site.defaultHostname}`);
  const fieldErrors = add.error instanceof ApiError ? add.error.fieldErrors : undefined;
  const formError = add.isError && !fieldErrors ? describeError(add.error) : null;

  return (
    <Dialog
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button form="add-audience-form" loading={add.isPending} type="submit" variant="primary">
            Register
          </Button>
        </>
      }
      onClose={onClose}
      open
      title="Register an API"
    >
      <form
        className="space-y-4"
        id="add-audience-form"
        onSubmit={(event) => {
          event.preventDefault();
          const list = origins
            .split(/[\s,]+/)
            .map((origin) => origin.trim())
            .filter(Boolean);
          if (!audience.trim() || !list.length) return;
          add.mutate(
            { audience: audience.trim(), origins: list },
            {
              onSuccess: () => {
                toast.show("API registered.");
                onClose();
              },
            },
          );
        }}
      >
        <Field error={fieldErrors?.audience} hint="The exact name your API checks, usually its URL." label="API">
          {(props) => (
            <Input
              {...props}
              autoFocus
              className="font-mono text-[13px]"
              onChange={(event) => setAudience(event.target.value)}
              placeholder="https://api.example.com"
              spellCheck={false}
              value={audience}
            />
          )}
        </Field>
        <Field
          error={fieldErrors?.origins}
          hint="Addresses of this host whose pages may ask for the token, one per line."
          label="Pages that can use it"
        >
          {(props) => (
            <Textarea
              {...props}
              className="min-h-20 font-mono text-[13px]"
              onChange={(event) => setOrigins(event.target.value)}
              rows={2}
              spellCheck={false}
              value={origins}
            />
          )}
        </Field>
        {formError ? <FormMessage>{formError}</FormMessage> : null}
      </form>
    </Dialog>
  );
}

function RemoveAudienceDialog({
  audience,
  onClose,
  projectId,
  siteId,
}: {
  audience: ViewerAssertionAudience | null;
  onClose: () => void;
  projectId: string;
  siteId: string;
}) {
  const remove = useRemoveAudience(projectId, siteId);
  const toast = useToast();
  return (
    <Dialog
      description={
        audience ? (
          <>
            Pages stop getting tokens for <span className="font-mono text-[13px] text-ink">{audience.audience}</span>{" "}
            right away, so calls they make to that API will fail.
          </>
        ) : null
      }
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            icon={Trash2}
            loading={remove.isPending}
            onClick={() => {
              if (!audience) return;
              remove.mutate(audience.id, {
                onError: (error) => toast.show(describeError(error), "err"),
                onSuccess: () => {
                  toast.show("API removed.");
                  onClose();
                },
              });
            }}
            variant="danger"
          >
            Remove
          </Button>
        </>
      }
      onClose={onClose}
      open={Boolean(audience)}
      title="Remove this API?"
    />
  );
}
