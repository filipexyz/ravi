"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "@/lib/api/client";
import { CONNECTION_NAME_MAX_LENGTH } from "@/shared/integrations/connection-limits";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input } from "@/ui/form";
import { Dialog } from "@/ui/overlay";
import { useToast } from "@/ui/toast";
import { connectionLabel, connectionName, connectorErrorText, renameEndpoint, type Connection } from "./model";

/** A label for one connection, to tell accounts apart. The email stays the name. */
export function RenameDialog({
  connection,
  listKey,
  onClose,
}: {
  connection: Connection | null;
  listKey: readonly unknown[];
  onClose: () => void;
}) {
  return (
    <Dialog
      description={connection ? `Shown next to ${connectionName(connection)} here and in the CLI. Only you see it.` : undefined}
      onClose={onClose}
      open={Boolean(connection)}
      title="Rename connection"
    >
      {connection ? <RenameForm connection={connection} key={connection.id} listKey={listKey} onClose={onClose} /> : null}
    </Dialog>
  );
}

function RenameForm({
  connection,
  listKey,
  onClose,
}: {
  connection: Connection;
  listKey: readonly unknown[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(() => connectionLabel(connection) ?? "");
  const rename = useMutation({
    mutationFn: (displayName: string) => api.post<{ status: "ok"; ok: boolean }>(renameEndpoint(connection.id), { displayName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: listKey });
      toast.show("Renamed.");
      onClose();
    },
  });
  const trimmed = name.trim();

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed || rename.isPending) return;
        rename.mutate(trimmed);
      }}
    >
      <Field hint="For example Work or Personal." label="Name">
        {(props) => (
          <Input {...props} autoFocus maxLength={CONNECTION_NAME_MAX_LENGTH} onChange={(event) => setName(event.target.value)} value={name} />
        )}
      </Field>
      {rename.isError ? <FormMessage>{connectorErrorText(rename.error, "rename")}</FormMessage> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={rename.isPending} onClick={onClose} variant="ghost">
          Cancel
        </Button>
        <Button disabled={!trimmed} loading={rename.isPending} type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}
