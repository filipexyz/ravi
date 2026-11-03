"use client";

import { Archive, Bot, CloudUpload, KeyRound, MoreHorizontal, Play, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useOrgRouter } from "@/lib/org-href";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import type { CloudLibraryAgent } from "@/server/console/cloud-agents/library-agents";
import type { CloudAgent } from "@/server/console/cloud-agents/types";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { Field, FormMessage, Input, Select, Textarea } from "@/ui/form";
import { DetailList, Mono } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog, Drawer, Menu, MenuItem, MenuSeparator } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Notice } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";

import { cloudErrorText, useArchiveCloudAgent, useCloudAgents, useDeployableAgents, useDeployCloudAgent, useStartCloudRun } from "./api";
import { CloudFrame, CloudProjectGate, type CloudScope } from "./cloud-frame";
import { agentStatus, describeCron, formatUsd, parseBudgetInput } from "./format";

const PUBLISH_COMMAND = "ravi agents publish <agent> --scope org --execute";

export function CloudAgentsScreen({ projectId }: { projectId: string }) {
  return (
    <CloudProjectGate projectRef={projectId}>
      {(scope) => (
        <CloudFrame scope={scope} tab="agents">
          <AgentsList scope={scope} />
        </CloudFrame>
      )}
    </CloudProjectGate>
  );
}

function AgentsList({ scope }: { scope: CloudScope }) {
  const { organization } = useWorkspace();
  const { project, availability, credential } = scope;
  const agents = useCloudAgents(project.id);
  const library = useDeployableAgents(project.id);
  const [deployOpen, setDeployOpen] = useState(false);
  const [running, setRunning] = useState<CloudAgent | null>(null);
  const [details, setDetails] = useState<CloudAgent | null>(null);
  const [archiving, setArchiving] = useState<CloudAgent | null>(null);
  const list = agents.data ?? [];
  const canWrite = availability.canWrite;
  const keyMissing = credential?.status === "missing";

  return (
    <>
      {agents.isPending ? (
        <ListSkeleton rows={3} />
      ) : agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} role={roleLabel(organization.role)} />
      ) : list.length === 0 ? (
        <AgentsEmpty
          canManageKey={availability.canManageKey}
          canWrite={canWrite}
          keyMissing={keyMissing}
          library={library.data}
          onDeploy={() => setDeployOpen(true)}
        />
      ) : (
        <div className="space-y-3">
          {canWrite ? (
            <div className="flex justify-end">
              <Button icon={CloudUpload} onClick={() => setDeployOpen(true)}>
                Deploy an agent
              </Button>
            </div>
          ) : null}
          <List label="Cloud agents">
            {list.map((agent) => (
              <AgentRow
                agent={agent}
                canWrite={canWrite}
                key={agent.id}
                library={library.data?.find((item) => item.itemId === agent.library.itemId)}
                onArchive={() => setArchiving(agent)}
                onOpen={() => setDetails(agent)}
                onRun={() => setRunning(agent)}
                projectId={project.id}
              />
            ))}
          </List>
          {!canWrite ? (
            <p className="text-[13px] text-ink-3">
              Your role reads cloud agents and their runs. Owners, admins and developers deploy and run them.
            </p>
          ) : null}
        </div>
      )}

      <DeployDialog onClose={() => setDeployOpen(false)} open={deployOpen} projectId={project.id} />
      {running ? <RunDialog agent={running} onClose={() => setRunning(null)} projectId={project.id} /> : null}
      <AgentDrawer agent={details} onClose={() => setDetails(null)} />
      <ArchiveDialog agent={archiving} onClose={() => setArchiving(null)} projectId={project.id} />
    </>
  );
}

function AgentsEmpty({
  canManageKey,
  canWrite,
  keyMissing,
  library,
  onDeploy,
}: {
  canManageKey: boolean;
  canWrite: boolean;
  keyMissing: boolean;
  library: CloudLibraryAgent[] | undefined;
  onDeploy: () => void;
}) {
  if (keyMissing) {
    return (
      <EmptyState
        action={canManageKey ? <Button href="/org/settings#cloud-agents" icon={KeyRound} variant="primary">Add the API key</Button> : null}
        description={
          canManageKey
            ? "Cloud agents run with this organization's own Anthropic API key. Add it in Organization settings, then deploy an agent from the Library."
            : "Cloud agents run with this organization's own Anthropic API key. Ask an owner or admin to add it in Organization settings."
        }
        headingLevel={2}
        icon={KeyRound}
        title="Add an Anthropic API key first"
      />
    );
  }
  if (library && library.length === 0) {
    return (
      <EmptyState
        description="A cloud agent is a Library agent: its AGENTS.md, skills and agent.json. Publish one from a machine where Ravi is logged in to this organization, then deploy it here."
        headingLevel={2}
        icon={Bot}
        title="No Library agents to deploy yet"
      >
        <CodeBlock code={PUBLISH_COMMAND} label="From the terminal" />
      </EmptyState>
    );
  }
  return (
    <EmptyState
      action={
        canWrite ? (
          <Button icon={CloudUpload} onClick={onDeploy} variant="primary">
            Deploy an agent
          </Button>
        ) : null
      }
      description={
        canWrite
          ? "Pick an agent from the Library. Ravi prepares it on Anthropic once; after that each run starts in seconds."
          : "Nobody has deployed a Library agent to this project yet. Owners, admins and developers can."
      }
      headingLevel={2}
      icon={Bot}
      title="No cloud agents in this project yet"
    />
  );
}

function AgentRow({
  agent,
  canWrite,
  library,
  onArchive,
  onOpen,
  onRun,
  projectId,
}: {
  agent: CloudAgent;
  canWrite: boolean;
  library: CloudLibraryAgent | undefined;
  onArchive: () => void;
  onOpen: () => void;
  onRun: () => void;
  projectId: string;
}) {
  const toast = useToast();
  const deploy = useDeployCloudAgent(projectId);
  const status = agentStatus(agent);
  const newer = library && agent.library.version !== null && library.version > agent.library.version ? library.version : null;
  const redeploy = () =>
    deploy.mutate(
      { agent: agent.library.itemId },
      {
        onError: (error) => toast.show(cloudErrorText(error), "err"),
        onSuccess: ({ agent: deployed, changed }) =>
          toast.show(changed ? `${deployed.name} now runs version ${deployed.library.version ?? "latest"}.` : `${deployed.name} was already up to date.`),
      },
    );

  return (
    <ListRow
      actions={
        <>
          {canWrite ? (
            <Button icon={Play} onClick={onRun} size="sm">
              Run
            </Button>
          ) : null}
          {canWrite ? (
            <Menu
              align="end"
              label={`Actions for ${agent.name}`}
              trigger={(props) => <IconButton {...props} icon={MoreHorizontal} label={`Actions for ${agent.name}`} size="sm" />}
            >
              <MenuItem
                description={newer ? `Version ${newer} is in the Library` : "Picks up the latest Library version"}
                icon={RefreshCw}
                onSelect={redeploy}
              >
                Redeploy
              </MenuItem>
              <MenuSeparator />
              <MenuItem description="Its schedules stop; runs stay" icon={Archive} onSelect={onArchive} tone="danger">
                Archive
              </MenuItem>
            </Menu>
          ) : null}
        </>
      }
      description={
        <>
          <span className="font-mono text-[12px]">
            {agent.library.scope}/{agent.library.slug}
            {agent.library.version ? ` v${agent.library.version}` : ""}
          </span>
          {agent.model ? <span> · {agent.model}</span> : null}
          <span> · {formatUsd(agent.config.budgetUsd)} per run</span>
        </>
      }
      leading={
        <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
          <Bot aria-hidden size={16} />
        </span>
      }
      meta={agent.deployedAt ? <span>Deployed <RelativeTime value={agent.deployedAt} /></span> : null}
      onClick={onOpen}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{agent.name}</span>
          <Badge dot={agent.status !== "ready"} tone={status.tone}>
            {status.label}
          </Badge>
          {newer ? <Badge tone="info">Version {newer} available</Badge> : null}
        </span>
      }
    />
  );
}

function AgentDrawer({ agent, onClose }: { agent: CloudAgent | null; onClose: () => void }) {
  const status = agent ? agentStatus(agent) : null;
  return (
    <Drawer
      description={agent ? `${agent.library.scope}/${agent.library.slug}` : undefined}
      onClose={onClose}
      open={Boolean(agent)}
      title={agent?.name ?? ""}
    >
      {agent && status ? (
        <div className="space-y-4">
          {agent.lastError ? (
            <Notice title="The last deploy failed" tone="err">
              {agent.lastError}
            </Notice>
          ) : null}
          <DetailList
            items={[
              { label: "Status", value: <Badge tone={status.tone}>{status.label}</Badge> },
              { label: "Library version", value: agent.library.version ? `Version ${agent.library.version}` : "Not deployed yet" },
              { label: "Model", value: agent.model ? <Mono>{agent.model}</Mono> : "Not set" },
              { label: "Budget per run", value: `${formatUsd(agent.config.budgetUsd)}, a run stops when it reaches it` },
              {
                label: "Network",
                value: agent.config.networking === "limited" ? "Package registries and its tool servers only" : "Unrestricted",
              },
              { label: "Web search", value: agent.config.webSearch ? "On" : "Off" },
              {
                label: "Changes outside its sandbox",
                value: agent.config.writes === "ask" ? "Ask a person first" : "Allowed without asking",
              },
              { label: "Ravi tools", value: agent.config.raviMcp ? "On, as the person who starts the run" : "Off" },
              agent.config.mcpServers.length
                ? { label: "Other tool servers", value: agent.config.mcpServers.join(", ") }
                : null,
              agent.config.repositories.length
                ? { label: "Repositories", value: <Mono>{agent.config.repositories.join(", ")}</Mono> }
                : null,
              agent.config.schedule
                ? { label: "Suggested schedule", value: `${describeCron(agent.config.schedule.cron)} (${agent.config.schedule.timezone})` }
                : null,
              agent.deployedAt
                ? {
                    label: "Deployed",
                    value: `${formatDate(agent.deployedAt, true)}${agent.deployedBy ? ` by ${agent.deployedBy.name}` : ""}`,
                  }
                : null,
            ]}
          />
          <p className="text-[13px] text-ink-3">
            These come from the agent&apos;s <span className="font-mono">agent.json</span> in the Library. Change them there and
            redeploy.
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}

function DeployDialog({ onClose, open, projectId }: { onClose: () => void; open: boolean; projectId: string }) {
  const toast = useToast();
  const library = useDeployableAgents(projectId, open);
  const deploy = useDeployCloudAgent(projectId);
  const [choice, setChoice] = useState("");
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const options = library.data ?? [];
  const selected = options.find((item) => item.itemId === choice) ?? null;

  const close = () => {
    deploy.reset();
    setChoice("");
    setChoiceError(null);
    onClose();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) {
      setChoiceError("Pick the agent to deploy.");
      return;
    }
    setChoiceError(null);
    deploy.mutate(
      { agent: selected.itemId },
      {
        onSuccess: ({ agent, warnings }) => {
          toast.show(warnings.length ? `${agent.name} is deployed. ${warnings.join(" ")}` : `${agent.name} is deployed and ready to run.`);
          close();
        },
      },
    );
  };

  const formId = "deploy-cloud-agent-form";
  return (
    <Dialog
      className="max-w-lg"
      description="Ravi turns the agent's Library version into an agent on Anthropic, with its instructions, skills and tools. Deploying again picks up a newer version."
      footer={
        options.length ? (
          <>
            <Button onClick={close} variant="ghost">
              Cancel
            </Button>
            <Button form={formId} loading={deploy.isPending} type="submit" variant="primary">
              Deploy
            </Button>
          </>
        ) : undefined
      }
      onClose={close}
      open={open}
      title="Deploy a Library agent"
    >
      {library.isPending ? (
        <ListSkeleton rows={2} />
      ) : library.isError ? (
        <ErrorState error={library.error} onRetry={() => void library.refetch()} />
      ) : options.length === 0 ? (
        <div className="space-y-3 text-sm text-ink-2">
          <p>No agent is published to this project&apos;s or the organization&apos;s Library yet. Publish one from your machine first.</p>
          <CodeBlock code={PUBLISH_COMMAND} label="From the terminal" />
        </div>
      ) : (
        <form className="space-y-4" id={formId} noValidate onSubmit={submit}>
          <Field error={choiceError} hint={selected?.description || "Agents of this project and of the whole organization."} label="Agent">
            {(props) => (
              <Select
                {...props}
                autoFocus
                onChange={(event) => {
                  deploy.reset();
                  setChoice(event.target.value);
                  setChoiceError(null);
                }}
                value={choice}
              >
                <option disabled value="">
                  Choose an agent
                </option>
                {options.map((item) => (
                  <option key={item.itemId} value={item.itemId}>
                    {item.name} ({item.scope === "org" ? "organization" : item.scope}), v{item.version}
                    {item.deployed ? (item.deployed.version === item.version ? ", deployed" : `, v${item.deployed.version ?? "?"} deployed`) : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {deploy.isError ? <FormMessage>{cloudErrorText(deploy.error)}</FormMessage> : null}
        </form>
      )}
    </Dialog>
  );
}

function RunDialog({ agent, onClose, projectId }: { agent: CloudAgent; onClose: () => void; projectId: string }) {
  const router = useOrgRouter();
  const start = useStartCloudRun(projectId);
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  // One key per dialog: a double submit starts one run.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const close = () => {
    start.reset();
    onClose();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseBudgetInput(budget);
    setPromptError(prompt.trim() ? null : "Say what the agent should do.");
    setBudgetError(parsed.error);
    if (!prompt.trim() || parsed.error) return;
    start.mutate(
      { agent: agent.id, prompt: prompt.trim(), idempotencyKey, ...(parsed.value !== null ? { budgetUsd: parsed.value } : {}) },
      { onSuccess: ({ run }) => router.push(`/p/${projectId}/cloud/runs/${run.id}`) },
    );
  };

  const formId = "start-cloud-run-form";
  return (
    <Dialog
      className="max-w-lg"
      description={`The run acts as you, uses this organization's Anthropic credits and stops at its budget. ${agent.config.writes === "ask" ? "Changes outside its sandbox wait for your approval." : "This agent makes changes without asking."}`}
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button form={formId} icon={Play} loading={start.isPending} type="submit" variant="primary">
            Start run
          </Button>
        </>
      }
      onClose={close}
      open
      title={`Run ${agent.name}`}
    >
      <form className="space-y-4" id={formId} noValidate onSubmit={submit}>
        <Field error={promptError} label="What should it do?">
          {(props) => (
            <Textarea
              {...props}
              autoFocus
              className="min-h-32"
              maxLength={100_000}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Summarize this week's open issues and draft a status update."
              value={prompt}
            />
          )}
        </Field>
        <Field error={budgetError} hint={`Leave empty for the agent's ${formatUsd(agent.config.budgetUsd)}. From US$ 0.50 to US$ 200.`} label="Budget (US$)" optional>
          {(props) => (
            <Input
              {...props}
              className="w-32"
              inputMode="decimal"
              onChange={(event) => setBudget(event.target.value)}
              placeholder={agent.config.budgetUsd.toFixed(2)}
              value={budget}
            />
          )}
        </Field>
        {start.isError ? <FormMessage>{cloudErrorText(start.error)}</FormMessage> : null}
      </form>
    </Dialog>
  );
}

function ArchiveDialog({ agent, onClose, projectId }: { agent: CloudAgent | null; onClose: () => void; projectId: string }) {
  const toast = useToast();
  const archive = useArchiveCloudAgent(projectId);
  const close = () => {
    archive.reset();
    onClose();
  };
  return (
    <Dialog
      description="It leaves this list and its schedules are turned off. Its runs and their results stay. You can deploy it again from the Library."
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Keep it
          </Button>
          <Button
            loading={archive.isPending}
            onClick={() =>
              agent &&
              archive.mutate(agent.id, {
                onSuccess: () => {
                  toast.show(`${agent.name} is archived.`);
                  close();
                },
              })
            }
            variant="danger"
          >
            Archive
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(agent)}
      title={agent ? `Archive ${agent.name}?` : "Archive"}
    >
      {archive.isError ? <FormMessage>{cloudErrorText(archive.error)}</FormMessage> : null}
    </Dialog>
  );
}
