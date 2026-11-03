"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppPathname } from "@/lib/org-href";
import { useState } from "react";

import { api, describeError } from "@/lib/api/client";
import type { FeedbackItem, FeedbackKind } from "@/features/console/types";
import { projectRefFromPath } from "@/features/shell/routes";
import { useOrgKey } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { Field, FormMessage, Select, Textarea } from "@/ui/form";

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  idea: "Idea",
  ux: "Hard to use",
  bug: "Something is broken",
  docs: "Docs",
  performance: "Slow",
  security: "Security",
  other: "Other",
};

const KIND_ORDER: FeedbackKind[] = ["idea", "ux", "bug", "docs", "performance", "security", "other"];

export function useSubmitFeedback() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (input: { kind: FeedbackKind; message: string; projectRef?: string | null; url?: string }) =>
      api.post<FeedbackItem>("/api/console/feedback", { ...input, source: "console", surface: "console" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("feedback") }),
  });
}

/** The compact feedback form, shared by the account menu dialog and /org/feedback. */
export function FeedbackForm({
  autoFocus,
  onCancel,
  onSubmitted,
  submitLabel = "Send feedback",
}: {
  autoFocus?: boolean;
  onCancel?: () => void;
  onSubmitted?: (item: FeedbackItem) => void;
  submitLabel?: string;
}) {
  const pathname = useAppPathname();
  const submit = useSubmitFeedback();
  const [kind, setKind] = useState<FeedbackKind>("idea");
  const [message, setMessage] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!message.trim()) {
          setFieldError("Write a few words first.");
          return;
        }
        setFieldError(null);
        submit.mutate(
          {
            kind,
            message: message.trim(),
            projectRef: projectRefFromPath(pathname) ?? null,
            url: typeof window === "undefined" ? undefined : window.location.href.slice(0, 600),
          },
          {
            onSuccess: (item) => {
              setMessage("");
              onSubmitted?.(item);
            },
          },
        );
      }}
    >
      <Field label="What is it about?">
        {(props) => (
          <Select {...props} onChange={(event) => setKind(event.target.value as FeedbackKind)} value={kind}>
            {KIND_ORDER.map((value) => (
              <option key={value} value={value}>
                {FEEDBACK_KIND_LABELS[value]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field error={fieldError} hint="The page you are on is attached." label="Message">
        {(props) => (
          <Textarea
            {...props}
            autoFocus={autoFocus}
            maxLength={8000}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="What happened, or what would make this better?"
            rows={5}
            value={message}
          />
        )}
      </Field>
      {submit.isError ? <FormMessage>{describeError(submit.error)}</FormMessage> : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
        ) : null}
        <Button loading={submit.isPending} type="submit" variant="primary">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
