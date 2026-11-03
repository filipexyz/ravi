"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";

import type { CloudCredential } from "@/server/console/cloud-agents/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input } from "@/ui/form";
import { DetailList, Mono, Panel } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { Skeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";

import {
  cloudErrorText,
  useCloudAvailability,
  useCloudCredential,
  useRemoveCloudCredential,
  useSetCloudCredential,
  useSetCloudMonthlyAlert,
} from "./api";
import { credentialState, formatUsd } from "./format";

/**
 * The organization's Anthropic key for cloud agents, in Organization settings.
 * Owners and admins set, replace and remove it; everyone else reads its state.
 * The key is never shown again after it is saved, only its last four characters.
 */
export function CloudAgentsCredentialPanel() {
  const availability = useCloudAvailability();
  const state = availability.data?.availability;
  const credential = useCloudCredential(state?.state === "available");

  return (
    <Panel as="section" padded>
      <div className="space-y-3" id="cloud-agents">
        <div className="space-y-0.5">
          <h2 className="text-[15px] font-semibold text-ink">Cloud agents</h2>
          <p className="text-[13px] text-ink-3">
            Library agents run on Anthropic&apos;s cloud with this organization&apos;s own API key, and Anthropic bills the
            organization for them. Ravi keeps the key encrypted and never shows it again.
          </p>
        </div>
        {availability.isPending || (state?.state === "available" && credential.isPending) ? (
          <Skeleton className="h-16 w-full" />
        ) : availability.isError ? (
          <p className="text-[13px] text-ink-3">{cloudErrorText(availability.error)}</p>
        ) : state?.state === "unconfigured" ? (
          <p className="text-[13px] text-ink-3">Not set up on this Console yet: it needs RAVI_CLOUD_AGENTS_KEY before it can keep a key.</p>
        ) : state?.state === "not_enabled" ? (
          <p className="text-[13px] text-ink-3">Cloud agents aren&apos;t open to this organization yet.</p>
        ) : credential.isError ? (
          <p className="text-[13px] text-ink-3">{cloudErrorText(credential.error)}</p>
        ) : credential.data ? (
          <CredentialBody canManage={state?.canManageKey ?? false} credential={credential.data} />
        ) : null}
      </div>
    </Panel>
  );
}

function CredentialBody({ canManage, credential }: { canManage: boolean; credential: CloudCredential }) {
  const [keyOpen, setKeyOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const status = credentialState(credential);
  const hasKey = credential.status !== "missing";

  return (
    <>
      <DetailList
        items={[
          { label: "Provider", value: "Anthropic" },
          {
            label: "API key",
            value: (
              <span className="flex flex-wrap items-center gap-2">
                {credential.keyHint ? <Mono>sk-ant-…{credential.keyHint}</Mono> : null}
                <Badge dot tone={status.tone}>
                  {status.label}
                </Badge>
                {credential.verifiedAt ? (
                  <span className="text-[13px] text-ink-3">
                    checked <RelativeTime value={credential.verifiedAt} />
                  </span>
                ) : null}
              </span>
            ),
          },
          { label: "This month", value: `${formatUsd(credential.monthCostUsd)} at Anthropic's list prices` },
          hasKey ? { label: "Monthly alert", value: <MonthlyAlert canManage={canManage} credential={credential} /> } : null,
        ]}
      />
      {canManage ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          {hasKey ? (
            <Button icon={Trash2} onClick={() => setRemoveOpen(true)} variant="danger">
              Remove key
            </Button>
          ) : null}
          <Button icon={KeyRound} onClick={() => setKeyOpen(true)} variant={hasKey && credential.status === "active" ? "secondary" : "primary"}>
            {hasKey ? "Replace key" : "Add API key"}
          </Button>
        </div>
      ) : (
        <p className="text-[13px] text-ink-3">Only owners and admins change the key and the alert.</p>
      )}
      <KeyDialog hasKey={hasKey} onClose={() => setKeyOpen(false)} open={keyOpen} />
      <RemoveDialog onClose={() => setRemoveOpen(false)} open={removeOpen} />
    </>
  );
}

function MonthlyAlert({ canManage, credential }: { canManage: boolean; credential: CloudCredential }) {
  const save = useSetCloudMonthlyAlert();
  const toast = useToast();
  const [value, setValue] = useState(credential.monthlyAlertUsd ? String(credential.monthlyAlertUsd) : "");
  const [error, setError] = useState<string | null>(null);
  if (!canManage) {
    return credential.monthlyAlertUsd ? <span>Owners and admins hear when the month passes {formatUsd(credential.monthlyAlertUsd)}</span> : <span>None</span>;
  }
  const changed = value.trim() !== (credential.monthlyAlertUsd ? String(credential.monthlyAlertUsd) : "");
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    const amount = text ? Number(text) : null;
    if (amount !== null && (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000)) {
      setError("A whole number of US$, or empty for no alert.");
      return;
    }
    setError(null);
    save.mutate(amount, {
      onError: (failure) => setError(cloudErrorText(failure)),
      onSuccess: () => toast.show(amount ? `Owners and admins hear when the month passes ${formatUsd(amount)}.` : "The monthly alert is off."),
    });
  };
  return (
    <form className="space-y-1.5" noValidate onSubmit={submit}>
      <Field
        error={error}
        hint="Owners and admins get an inbox message once a month when spending passes it. Runs don't stop: each run has its own budget."
        label={<span className="sr-only">Monthly alert in US$</span>}
      >
        {(props) => (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              {...props}
              className="w-32"
              inputMode="numeric"
              onChange={(event) => {
                save.reset();
                setValue(event.target.value);
              }}
              placeholder="No alert"
              value={value}
            />
            <Button disabled={!changed} loading={save.isPending} size="sm" type="submit">
              Save
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
}

function KeyDialog({ hasKey, onClose, open }: { hasKey: boolean; onClose: () => void; open: boolean }) {
  const set = useSetCloudCredential();
  const toast = useToast();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    set.reset();
    setApiKey("");
    setError(null);
    onClose();
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key.startsWith("sk-ant-")) {
      setError("Paste an Anthropic API key. It starts with sk-ant-.");
      return;
    }
    setError(null);
    set.mutate(
      { apiKey: key },
      {
        onSuccess: (credential) => {
          toast.show(`Saved the key ending in ${credential.credential.keyHint ?? "…"}. Anthropic accepted it.`);
          close();
        },
      },
    );
  };
  const formId = "cloud-agents-key-form";
  return (
    <Dialog
      description="Ravi checks the key with Anthropic before it saves it. Create one in the Anthropic Console under API keys; runs are billed to that account."
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button form={formId} loading={set.isPending} type="submit" variant="primary">
            {hasKey ? "Replace key" : "Save key"}
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title={hasKey ? "Replace the Anthropic API key" : "Add an Anthropic API key"}
    >
      <form className="space-y-4" id={formId} noValidate onSubmit={submit}>
        <Field error={error} hint={hasKey ? "The old key stops being used as soon as this one is saved." : undefined} label="API key">
          {(props) => (
            <Input
              {...props}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              autoFocus
              className="font-mono text-[13px]"
              onChange={(event) => {
                set.reset();
                setApiKey(event.target.value);
              }}
              placeholder="sk-ant-…"
              spellCheck={false}
              type="password"
              value={apiKey}
            />
          )}
        </Field>
        {set.isError ? <FormMessage>{cloudErrorText(set.error)}</FormMessage> : null}
      </form>
    </Dialog>
  );
}

function RemoveDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const remove = useRemoveCloudCredential();
  const toast = useToast();
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      description="Ravi deletes the key. New runs and schedules can't start until someone adds a key again; runs already going stop updating here until a key is back."
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Keep the key
          </Button>
          <Button
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  toast.show("The key is removed.");
                  close();
                },
              })
            }
            variant="danger"
          >
            Remove key
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title="Remove the Anthropic API key?"
    >
      {remove.isError ? <FormMessage>{cloudErrorText(remove.error)}</FormMessage> : null}
    </Dialog>
  );
}
