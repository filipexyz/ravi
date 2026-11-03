"use client";

import { Check, Clipboard, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button, Tag } from "@/components/ui";

interface StepUpPanelProps {
  challengeId: string;
  capability: string;
  userEmail: string;
}

type StepUpState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "ready"; token: string; expiresAt: string }
  | { phase: "error"; message: string };

export function StepUpPanel({ challengeId, capability, userEmail }: StepUpPanelProps) {
  const [state, setState] = useState<StepUpState>({ phase: "idle" });
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password) return;
    setState({ phase: "submitting" });
    setCopied(false);
    try {
      const response = await fetch("/api/internal/connectors/step-up/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId,
          factor: "password",
          password,
        }),
      });
      const body = (await response.json()) as
        | { status: "ok"; token: string; expiresAt: string }
        | { status: "error"; code: string };
      setPassword("");
      if (!response.ok || body.status !== "ok") {
        const code = body.status === "error" ? body.code : "step_up_failed";
        setState({ phase: "error", message: friendlyMessage(code) });
        return;
      }
      setState({ phase: "ready", token: body.token, expiresAt: body.expiresAt });
    } catch {
      setPassword("");
      setState({ phase: "error", message: "Network error. Try again." });
    }
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (state.phase === "ready") {
    return (
      <div className="col gap-12">
        <Tag dot tone="ok">
          <Check size={12} />
          factor verified
        </Tag>
        <div className="col gap-4">
          <span className="t-tiny t-mute">Paste this code into the CLI prompt</span>
          <code
            className="t-mono"
            style={{
              padding: "10px 12px",
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              wordBreak: "break-all",
            }}
          >
            {state.token}
          </code>
        </div>
        <div className="row gap-8">
          <Button icon={Clipboard} onClick={() => copyToken(state.token)} variant="primary">
            {copied ? "Copied" : "Copy code"}
          </Button>
        </div>
        <p className="t-tiny t-mute" style={{ margin: 0 }}>
          Expires at {state.expiresAt}. Single-use.
        </p>
      </div>
    );
  }

  return (
    <form className="col gap-12" onSubmit={submit}>
      <div className="col gap-4">
        <label className="t-tiny t-mute" htmlFor="step-up-email">
          Account
        </label>
        <input
          autoComplete="username"
          style={inputStyle}
          id="step-up-email"
          readOnly
          type="email"
          value={userEmail}
        />
      </div>
      <div className="col gap-4">
        <label className="t-tiny t-mute" htmlFor="step-up-password">
          Password
        </label>
        <input
          autoComplete="current-password"
          autoFocus
          style={inputStyle}
          id="step-up-password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>
      {state.phase === "error" ? <Tag tone="err">{state.message}</Tag> : null}
      <Button
        disabled={state.phase === "submitting" || !password}
        icon={ShieldCheck}
        type="submit"
        variant="primary"
      >
        {state.phase === "submitting" ? "Verifying…" : `Confirm ${capability || "action"}`}
      </Button>
      <p className="t-tiny t-mute" style={{ margin: 0 }}>
        TOTP and passkey factor support is coming next.
      </p>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "9px 11px",
  background: "var(--bg-1)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--fg)",
  fontFamily: "inherit",
  fontSize: 13,
  outline: "none",
  width: "100%",
};

function friendlyMessage(code: string): string {
  switch (code) {
    case "factor_verification_failed":
      return "Password was not accepted. Try again.";
    case "challenge_not_found":
      return "Challenge expired or was already used. Re-run the CLI command.";
    case "challenge_expired":
      return "Challenge expired (5 minutes). Re-run the CLI command.";
    case "challenge_already_consumed":
      return "This challenge was already consumed.";
    case "factor_too_weak":
      return "The factor used is not strong enough for this action.";
    case "actor_mismatch":
      return "You are not the user who initiated this challenge.";
    case "workos_unavailable":
      return "Identity provider could not verify the password right now. Try again.";
    case "server_not_configured":
      return "Connectors are not configured on this Console environment.";
    case "factor_not_supported":
      return "This factor is not supported yet.";
    default:
      return "Step-up failed. Re-run the CLI command and try again.";
  }
}
