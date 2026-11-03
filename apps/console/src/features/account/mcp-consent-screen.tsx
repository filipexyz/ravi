"use client";

import { AlertTriangle, Check, Plug } from "lucide-react";

import { DetailList } from "@/ui/layout";
import { IconTile, StandaloneCard } from "./state-card";

/** What each requested MCP scope lets the app do, in plain words. */
const SCOPE_COPY: Record<string, { text: string; caution?: string }> = {
  "mcp.bridge.connect": { text: "Connect to this bridge and check that it's online" },
  "mcp.bridge.tools.read": { text: "See the list of tools the bridge offers" },
  "mcp.bridge.tools.invoke": { text: "Use tools that read or change things" },
  "mcp.bridge.tools.invoke_destructive": {
    caution: "You'll still be asked to confirm each time before one of them runs.",
    text: "Use tools that delete things or can't be undone",
  },
  "mcp.bridge.resources.read": { text: "Read the files and data the bridge shares" },
  "mcp.bridge.prompts.read": { text: "Read the prompts the bridge offers" },
  "mcp.console.tools.read": { text: "Use the Console as you: see your projects, Pages and the Bases views you can open" },
  "mcp.console.tools.write": {
    caution: "You'll see a preview and must agree before each change.",
    text: "Add or change Bases rows as you",
  },
};

/**
 * The consent card for `/mcp/authorize`: who is asking, what it gets, and
 * where you go back to. `actions` is the existing consent form.
 */
export function McpConsentScreen({
  actions,
  bridgeName,
  clientName,
  projectName,
  redirectUri,
  scopes,
}: {
  actions: React.ReactNode;
  bridgeName: string;
  clientName: string;
  projectName: string;
  redirectUri: string;
  scopes: string[];
}) {
  return (
    <div className="mx-auto max-w-[520px] pt-2 sm:pt-6">
      <StandaloneCard>
        <IconTile icon={Plug} tone="info" />
        <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">
          Allow {clientName} to use {bridgeName}?
        </h1>
        <p className="mt-1.5 text-sm text-ink-2">
          {clientName} is asking to connect to the {bridgeName} bridge in the {projectName} project, as you.
        </p>

        <div className="mt-6">
          <h2 className="text-sm font-medium text-ink">It will be able to</h2>
          <ul className="mt-2.5 space-y-2.5">
            {scopes.map((scope) => {
              const copy = SCOPE_COPY[scope];
              const caution = Boolean(copy?.caution);
              const Icon = caution ? AlertTriangle : Check;
              return (
                <li className="flex gap-2.5" key={scope}>
                  <Icon aria-hidden className={caution ? "mt-0.5 shrink-0 text-warn" : "mt-0.5 shrink-0 text-ok"} size={16} />
                  <div className="min-w-0 text-sm">
                    <div className="text-ink">{copy?.text ?? "A permission this Console doesn't describe yet"}</div>
                    {copy?.caution ? <div className="text-[13px] text-ink-2">{copy.caution}</div> : null}
                    <div className="font-mono text-xs break-all text-ink-3">{scope}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <DetailList
          className="mt-6 border-t border-line [&>div]:grid-cols-[104px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-2.5 sm:[&>div]:grid-cols-[136px_minmax(0,1fr)]"
          items={[
            { label: "App", value: clientName },
            { label: "Bridge", value: bridgeName },
            { label: "Project", value: projectName },
            {
              label: "Sends you back to",
              value: (
<span className="block font-mono text-[13px] break-all text-ink">{redirectUri}</span>
              ),
            },
          ]}
        />

        <div className="mt-2 border-t border-line pt-6">{actions}</div>
      </StandaloneCard>
      <p className="mt-4 px-1 text-center text-[13px] text-ink-3">Only allow apps you trust. Nothing is shared if you deny.</p>
    </div>
  );
}

