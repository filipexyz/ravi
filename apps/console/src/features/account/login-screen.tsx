"use client";

import { AlertTriangle, Settings2 } from "lucide-react";

import { RaviMark } from "@/features/shell/app-shell";
import { Button } from "@/ui/button";
import { Notice } from "@/ui/states";
import { StandaloneFrame } from "./standalone-frame";
import { StandaloneCard } from "./state-card";

export type LoginNotice = "error" | "missing-config" | "access-denied" | "signed-out" | null;

/**
 * The Console's own sign-in screen. With sign-in configured and no local dev
 * mode, the page redirects to the hosted sign-in before this renders, so it
 * shows in development, after a failed sign-in, and when sign-in isn't set up.
 */
export function LoginScreen({
  anonymousHref,
  anonymousMode,
  managedOidc = false,
  notice,
  showSetupDetails,
  signInHref,
  signUpHref,
  signInConfigured,
}: {
  anonymousHref: string;
  anonymousMode: boolean;
  managedOidc?: boolean;
  notice: LoginNotice;
  /** Development builds name the settings that turn sign-in on. */
  showSetupDetails: boolean;
  signInHref: string;
  signUpHref: string;
  signInConfigured: boolean;
}) {
  const nothingConfigured = !signInConfigured && !anonymousMode;

  return (
    <StandaloneFrame brand={false} homeHref={null} width="sm">
      <StandaloneCard className="text-center">
        <RaviMark className="size-11 rounded-lg text-xl" />
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">Sign in to Ravi Console</h1>
        <p className="mx-auto mt-2 max-w-xs text-sm text-ink-2">
          Your projects, the pages your agents publish and the data they keep.
        </p>

        {notice === "error" && !nothingConfigured ? (
          <Notice className="mt-6 text-left" icon={AlertTriangle} title="Sign-in didn't finish" tone="err">
            Something interrupted it. Try again; if it keeps failing, close the tab and start from a new one.
          </Notice>
        ) : null}
        {notice === "access-denied" && !nothingConfigured ? (
          <Notice className="mt-6 text-left" icon={AlertTriangle} title="Access isn't enabled for this account" tone="warn">
            Your account has no active access to this installation. Ask its administrator to check your access, or sign in with another account.
          </Notice>
        ) : null}
        {notice === "signed-out" ? <p className="mt-6 text-sm text-ink-2">You have signed out of this Console.</p> : null}
        {notice === "missing-config" && !nothingConfigured ? (
          <Notice className="mt-6 text-left" icon={Settings2} title="Sign-in isn't fully set up" tone="warn">
            The sign-in service on this Console is missing settings, so it sent you back here.
          </Notice>
        ) : null}

        {nothingConfigured ? (
          <div className="mt-6 space-y-3 text-left">
            <Notice icon={Settings2} title="Sign-in isn't set up on this Console" tone="warn">
              Nobody can sign in until an operator configures it. If you run this Console, finish its setup and reload
              this page.
            </Notice>
            {showSetupDetails ? (
              <p className="text-[13px] text-ink-3">
                {managedOidc ? "Configure this installation's OIDC provider and session settings." : <>
                  Set the WorkOS variables, or set <code className="font-mono text-ink-2">RAVI_CONSOLE_ANONYMOUS_MODE=true</code>{" "}
                  for local development.
                </>}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-2">
            {signInConfigured ? (
              <Button className="h-10 w-full" external href={managedOidc && notice === "access-denied" ? "/logout" : signInHref} variant="primary">
                {managedOidc && notice === "access-denied" ? "Use another account" : "Continue"}
              </Button>
            ) : null}
            {anonymousMode ? (
              <Button className="h-10 w-full" href={anonymousHref} variant={signInConfigured ? "secondary" : "primary"}>
                Continue as local developer
              </Button>
            ) : null}
          </div>
        )}

        {anonymousMode ? (
          <p className="mt-4 text-[13px] text-ink-3">
            Local developer mode is on: you enter without an account, as the owner of a local workspace.
          </p>
        ) : null}
      </StandaloneCard>

      {signInConfigured && !managedOidc ? (
        <p className="mt-5 text-center text-[13px] text-ink-3">
          New to Ravi?{" "}
          <a className="font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline" href={signUpHref}>
            Create an account
          </a>
        </p>
      ) : null}
    </StandaloneFrame>
  );
}
