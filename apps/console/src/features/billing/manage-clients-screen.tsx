"use client";

import { useRouter } from "next/navigation";
import { Building2, Plus } from "lucide-react";
import { useState } from "react";

import { ApiError, describeError } from "@/lib/api/client";
import { Avatar, Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input, Textarea } from "@/ui/form";
import { PageHeader } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { accountState, formatMoney, formatPeriod, invoiceState } from "./format";
import { useCreateClient, useManageClients } from "./manage-queries";

export function ManageClientsScreen() {
  const clients = useManageClients();
  const [creating, setCreating] = useState(false);
  const addButton = (
    <Button icon={Plus} onClick={() => setCreating(true)} variant="primary">
      New client
    </Button>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        actions={addButton}
        description="Each client is an organization. Its contract decides what it pays each month; usage and installations are shown, not billed, unless the contract has a metered item."
        title="Clients"
      />
      {clients.isPending ? (
        <ListSkeleton rows={4} />
      ) : clients.isError ? (
        <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
      ) : clients.data.length === 0 ? (
        <EmptyState
          action={addButton}
          description="Create the client's organization, or ask the client to sign in and create one."
          icon={Building2}
          title="No organizations yet"
        />
      ) : (
        <List label="Clients">
          {clients.data.map((client) => {
            const state = accountState(client.billingStatus);
            const invoice = client.lastInvoice ? invoiceState(client.lastInvoice.status) : null;
            return (
              <ListRow
                chevron
                description={
                  client.contract
                    ? `Contract v${client.contract.version} · ${formatMoney(client.contract.monthlyFixedCents)} a month${
                        client.contract.meteredItems ? ` + ${client.contract.meteredItems} metered` : ""
                      }`
                    : "No contract"
                }
                href={`/manage/clients/${client.id}`}
                key={client.id}
                leading={<Avatar label={client.name} seed={client.id} size="sm" />}
                meta={
                  <>
                    <span>
                      {client.installations.billable}/{client.installations.active} billable installations
                    </span>
                    {client.lastInvoice && invoice ? (
                      <Badge tone={invoice.tone}>
                        {formatPeriod(client.lastInvoice.period)}: {invoice.label}
                      </Badge>
                    ) : null}
                    {client.contract ? <Badge tone={state.tone}>{state.label}</Badge> : null}
                  </>
                }
                title={
                  <span className="flex items-center gap-2">
                    <span className="truncate">{client.name}</span>
                    <span className="truncate font-mono text-xs font-normal text-ink-3">{client.slug}</span>
                  </span>
                }
              />
            );
          })}
        </List>
      )}
      <CreateClientDialog onClose={() => setCreating(false)} open={creating} />
    </div>
  );
}

const CREATE_ERRORS: Record<string, string> = {
  organization_slug_taken: "Another organization already uses this slug.",
  owner_user_not_found: "This person hasn't signed in to the Console yet. Ask them to sign in once, then try again.",
};

function slugify(name: string) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function CreateClientDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const router = useRouter();
  const create = useCreateClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [reason, setReason] = useState("");

  const fieldErrors = create.error instanceof ApiError ? (create.error.fieldErrors ?? {}) : {};
  const errorCode = create.error instanceof ApiError ? create.error.code : null;
  const fieldError = (key: string) => {
    const code = fieldErrors[key];
    return code ? (CREATE_ERRORS[code] ?? "Check this field.") : null;
  };

  function close() {
    create.reset();
    onClose();
  }

  return (
    <Dialog
      description="The owner must have signed in to the Console once. They become the organization's owner."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button form="create-client" loading={create.isPending} type="submit" variant="primary">
            Create organization
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title="New client"
    >
      <form
        className="space-y-4"
        id="create-client"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            { name, ownerEmail, reason, slug },
            { onSuccess: (data) => router.push(`/manage/clients/${data.organization.id}`) },
          );
        }}
      >
        <Field error={fieldError("name")} label="Name">
          {(props) => (
            <Input
              {...props}
              onChange={(event) => {
                setName(event.target.value);
                if (!slugEdited) setSlug(slugify(event.target.value));
              }}
              required
              value={name}
            />
          )}
        </Field>
        <Field error={fieldError("slug")} hint="Lowercase letters, numbers and dashes." label="Slug">
          {(props) => (
            <Input
              {...props}
              className="font-mono"
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value);
              }}
              required
              value={slug}
            />
          )}
        </Field>
        <Field error={fieldError("ownerEmail")} label="Owner's email">
          {(props) => (
            <Input {...props} onChange={(event) => setOwnerEmail(event.target.value)} required type="email" value={ownerEmail} />
          )}
        </Field>
        <Field error={fieldError("reason")} hint="Kept in the audit trail." label="Reason">
          {(props) => <Textarea {...props} className="min-h-16" onChange={(event) => setReason(event.target.value)} required value={reason} />}
        </Field>
        {create.isError && !Object.keys(fieldErrors).length ? (
          <FormMessage>{errorCode && CREATE_ERRORS[errorCode] ? CREATE_ERRORS[errorCode] : describeError(create.error)}</FormMessage>
        ) : null}
      </form>
    </Dialog>
  );
}
