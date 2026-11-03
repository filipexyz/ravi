"use client";

import { Pin, PinOff } from "lucide-react";
import { useState } from "react";

import type { Project } from "@/features/console/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FormMessage, Select } from "@/ui/form";
import { Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { ErrorState, Notice, Skeleton } from "@/ui/states";
import { formatDate } from "@/ui/time";
import { useToast } from "@/ui/toast";

import { libraryErrorText, useLibraryInstallations, useLibraryPinAction, useLibraryPins } from "./api";
import type { LibraryItem, LibraryPin } from "./types";

/** Where a skill is pinned, and (for the scope's admins) pin and unpin. */
export function LibraryPinsSection({ item }: { item: LibraryItem; project: Project | null }) {
  const [scope, slug] = item.ref.split("/") as [string, string];
  const pins = useLibraryPins(scope, slug);
  const canPin = pins.data?.can.pin ?? false;
  const list = pins.data?.pins ?? [];
  if (!pins.isPending && !pins.isError && list.length === 0 && !canPin) return null;

  return (
    <Section
      actions={canPin && !item.archived ? <PinButton item={item} pinned={list} /> : undefined}
      description="A pinned skill is always loaded in that agent, on that machine, at its latest version."
      title="Pinned in agents"
    >
      {pins.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : pins.isError ? (
        <ErrorState error={pins.error} onRetry={() => void pins.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-[13px] text-ink-3">Not pinned in any agent. Agents still find it and load it when they need it.</p>
      ) : (
        <List label="Pinned in agents">
          {list.map((pin) => (
            <ListRow
              actions={canPin ? <UnpinButton item={item} pin={pin} /> : undefined}
              description={pin.agent.reported ? undefined : "This agent no longer reports to the Console, so the pin has no effect for now."}
              key={pin.id}
              meta={
                <>
                  {pin.pinnedBy?.name ? <span>{pin.pinnedBy.name}</span> : null}
                  <span>{formatDate(pin.createdAt, true)}</span>
                </>
              }
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span>{pin.agent.name}</span>
                  <span className="text-ink-3">{`on ${pin.installation.name}`}</span>
                  {pin.agent.reported ? null : <Badge tone="warn">Not reporting</Badge>}
                </span>
              }
            />
          ))}
        </List>
      )}
    </Section>
  );
}

function PinButton({ item, pinned }: { item: LibraryItem; pinned: LibraryPin[] }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [installationId, setInstallationId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [scope, slug] = item.ref.split("/") as [string, string];
  const installations = useLibraryInstallations(item.scope === "project" ? (item.project?.id ?? null) : null, open);
  const action = useLibraryPinAction(scope, slug);
  const options = installations.data ?? [];
  const installation = options.find((entry) => entry.id === installationId) ?? options[0] ?? null;
  const taken = new Set(pinned.filter((pin) => pin.installation.id === installation?.id).map((pin) => pin.agent.id));
  const agents = (installation?.agents ?? []).filter((agent) => !taken.has(agent.id));
  const agent = agents.find((entry) => entry.id === agentId) ?? agents[0] ?? null;

  const close = () => {
    action.reset();
    setOpen(false);
    setInstallationId("");
    setAgentId("");
  };
  return (
    <>
      <Button icon={Pin} onClick={() => setOpen(true)} variant="secondary">
        Pin to an agent
      </Button>
      <Dialog
        description="The agent keeps this skill loaded and may use it. It follows every new version you publish."
        footer={
          <>
            <Button onClick={close} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={!installation || !agent}
              loading={action.isPending}
              onClick={() => {
                if (!installation || !agent) return;
                action.mutate(
                  { action: "pin", installationId: installation.id, agentId: agent.id },
                  {
                    onSuccess: () => {
                      close();
                      toast.show(`${item.slug} is pinned in ${agent.name} on ${installation.name}.`);
                    },
                  },
                );
              }}
            >
              Pin
            </Button>
          </>
        }
        onClose={close}
        open={open}
        title={`Pin ${item.slug}`}
      >
        {installations.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : installations.isError ? (
          <ErrorState error={installations.error} onRetry={() => void installations.refetch()} />
        ) : options.length === 0 ? (
          <Notice title="No agents to pick yet">
            {item.scope === "project"
              ? `Agents show up here once a Ravi linked to this organization reports them in the ${item.project?.name ?? ""} project.`
              : "Agents show up here once a Ravi linked to this organization reports them. Update Ravi and keep the daemon running."}
          </Notice>
        ) : (
          <div className="space-y-4">
            <Field label="Machine">
              {(props) => (
                <Select {...props} onChange={(event) => setInstallationId(event.target.value)} value={installation?.id ?? ""}>
                  {options.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field hint={agents.length === 0 ? "Every agent on this machine already has it pinned." : undefined} label="Agent">
              {(props) => (
                <Select {...props} disabled={agents.length === 0} onChange={(event) => setAgentId(event.target.value)} value={agent?.id ?? ""}>
                  {agents.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name === entry.id ? entry.id : `${entry.name} (${entry.id})`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {action.isError ? <FormMessage>{libraryErrorText(action.error) ?? "It couldn't be pinned. Try again."}</FormMessage> : null}
          </div>
        )}
      </Dialog>
    </>
  );
}

function UnpinButton({ item, pin }: { item: LibraryItem; pin: LibraryPin }) {
  const toast = useToast();
  const [scope, slug] = item.ref.split("/") as [string, string];
  const action = useLibraryPinAction(scope, slug);
  return (
    <Button
      icon={PinOff}
      loading={action.isPending}
      onClick={() =>
        action.mutate(
          { action: "unpin", installationId: pin.installation.id, agentId: pin.agent.id },
          {
            onError: (error) => toast.show(libraryErrorText(error) ?? "It couldn't be unpinned. Try again.", "err"),
            onSuccess: () => toast.show(`${item.slug} is no longer pinned in ${pin.agent.name}.`),
          },
        )
      }
      size="sm"
      variant="secondary"
    >
      Unpin
    </Button>
  );
}
