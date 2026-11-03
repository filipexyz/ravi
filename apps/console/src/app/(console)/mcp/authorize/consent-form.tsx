"use client";

import { useState } from "react";

import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";

const ERROR_COPY: Record<string, string> = {
  bridge_not_found: "This bridge no longer exists in the selected organization.",
  network_error: "Could not reach the Console. Check your connection and try again.",
  payload_invalid: "This request is no longer valid. Start connecting again from the app.",
  project_forbidden: "You don't have access to the project this bridge belongs to.",
  unauthorized: "Your session ended. Sign in again, then start connecting again from the app.",
};

export function ConsentForm({
  bridgeId,
  cancelHref = "/projects",
  clientId,
  codeChallenge,
  codeChallengeMethod,
  redirectUri,
  scope,
  state,
}: {
  bridgeId: string;
  cancelHref?: string;
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  scope: string;
  state?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      const response = await fetch("/api/internal/mcp/oauth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bridgeId,
          clientId,
          redirectUri,
          state,
          scope,
          codeChallenge,
          codeChallengeMethod,
        }),
      });
      const body = (await response.json()) as
        | { status: "ok"; redirectTo: string }
        | { status: "error"; code: string };
      if (!response.ok || body.status !== "ok") {
        setError(body.status === "error" ? body.code : "approval_failed");
        return;
      }
      window.location.assign(body.redirectTo);
    } catch {
      setError("network_error");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <FormMessage>
          {ERROR_COPY[error] ?? "Couldn't allow access. Try again."}{" "}
          <span className="font-mono text-xs opacity-80">({error})</span>
        </FormMessage>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button href={cancelHref} variant="secondary">
          Deny
        </Button>
        <Button loading={approving} onClick={approve} variant="primary">
          {approving ? "Allowing…" : "Allow"}
        </Button>
      </div>
    </div>
  );
}
