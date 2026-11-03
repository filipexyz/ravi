"use client";

import { CalendarClock, MoreHorizontal, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import type { CloudAgent, CloudSchedule } from "@/server/console/cloud-agents/types";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { Field, FormMessage, Input, Select, Switch, Textarea } from "@/ui/form";
import { List, ListRow } from "@/ui/list";
import { Dialog, Menu, MenuItem, MenuSeparator } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Skeleton } from "@/ui/states";
import { Segmented } from "@/ui/tabs";
import { formatDate, RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";

import {
  cloudErrorText,
  useAgentHeartbeat,
  useCloudAgents,
  useCloudSchedules,
  useCreateCloudSchedule,
  useDeleteCloudSchedule,
  useUpdateCloudSchedule,
} from "./api";
import { CloudFrame, CloudProjectGate, type CloudScope } from "./cloud-frame";
import { browserTimezone, describeCron, formatUsd, parseBudgetInput, SCHEDULE_PRESETS } from "./format";

export function CloudSchedulesScreen({ projectId }: { projectId: string }) {
  return (
    <CloudProjectGate projectRef={projectId}>
      {(scope) => (
        <CloudFrame scope={scope} tab="schedules">
          <SchedulesList scope={scope} />
        </CloudFrame>
      )}
    </CloudProjectGate>
  );
}

type Editing = { mode: "create" } | { mode: "edit"; schedule: CloudSchedule };

function SchedulesList({ scope }: { scope: CloudScope }) {
  const { organization } = useWorkspace();
  const { project, availability } = scope;
  const schedules = useCloudSchedules(project.id);
  const agents = useCloudAgents(project.id);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<CloudSchedule | null>(null);
  const list = schedules.data ?? [];
  const deployed = (agents.data ?? []).filter((agent) => agent.status !== "archived");
  const canWrite = availability.canWrite;

  if (schedules.isPending) return <ListSkeleton rows={3} />;
  if (schedules.isError) return <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} role={roleLabel(organization.role)} />;

  return (
    <>
      {list.length === 0 ? (
        agents.data && deployed.length === 0 ? (
          <EmptyState
            action={<Button href={`/p/${project.id}/cloud`}>Go to agents</Button>}
            description="A schedule starts runs of a cloud agent at set times. Deploy an agent from the Library first."
            headingLevel={2}
            icon={CalendarClock}
            title="No cloud agents to schedule yet"
          />
        ) : (
          <EmptyState
            action={
              canWrite ? (
                <Button icon={Plus} onClick={() => setEditing({ mode: "create" })} variant="primary">
                  Add a schedule
                </Button>
              ) : null
            }
            description="Run an agent every weekday morning, every hour or on any cron. Each run acts as the person who scheduled it, with its own budget."
            headingLevel={2}
            icon={CalendarClock}
            title="No schedules yet"
          >
            <CodeBlock code={'ravi cloud schedules add <agent> --cron "0 9 * * 1-5" --execute'} label="From the terminal" />
          </EmptyState>
        )
      ) : (
        <div className="space-y-3">
          {canWrite ? (
            <div className="flex justify-end">
              <Button icon={Plus} onClick={() => setEditing({ mode: "create" })}>
                Add a schedule
              </Button>
            </div>
          ) : null}
          <List label="Schedules">
            {list.map((schedule) => (
              <ScheduleRow
                canWrite={canWrite}
                key={schedule.id}
                onDelete={() => setDeleting(schedule)}
                onEdit={() => setEditing({ mode: "edit", schedule })}
                projectId={project.id}
                schedule={schedule}
              />
            ))}
          </List>
          <p className="text-[13px] text-ink-3">A scheduled run acts as the person who scheduled it. Turning a schedule back on makes you that person.</p>
        </div>
      )}

      {editing ? <ScheduleDialog agents={deployed} editing={editing} onClose={() => setEditing(null)} projectId={project.id} /> : null}
      <DeleteDialog onClose={() => setDeleting(null)} projectId={project.id} schedule={deleting} />
    </>
  );
}

function ScheduleRow({
  canWrite,
  onDelete,
  onEdit,
  projectId,
  schedule,
}: {
  canWrite: boolean;
  onDelete: () => void;
  onEdit: () => void;
  projectId: string;
  schedule: CloudSchedule;
}) {
  const toast = useToast();
  const update = useUpdateCloudSchedule(projectId);
  const toggle = () =>
    update.mutate(
      { id: schedule.id, enabled: !schedule.enabled },
      {
        onError: (error) => toast.show(cloudErrorText(error), "err"),
        onSuccess: () => toast.show(schedule.enabled ? "The schedule is paused." : "The schedule is on again and runs as you."),
      },
    );
  const when = describeCron(schedule.cron);
  return (
    <ListRow
      actions={
        canWrite ? (
          <Menu
            align="end"
            label={`Actions for the ${schedule.agentName} schedule`}
            trigger={(props) => <IconButton {...props} icon={MoreHorizontal} label={`Actions for the ${schedule.agentName} schedule`} size="sm" />}
          >
            <MenuItem icon={Pencil} onSelect={onEdit}>
              Edit
            </MenuItem>
            <MenuItem icon={schedule.enabled ? Pause : Play} onSelect={toggle}>
              {schedule.enabled ? "Pause" : "Turn on"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} onSelect={onDelete} tone="danger">
              Delete
            </MenuItem>
          </Menu>
        ) : null
      }
      description={
        <>
          <span>{schedule.prompt ? schedule.prompt : "Runs the agent's HEARTBEAT.md"}</span>
        </>
      }
      leading={
        <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
          <CalendarClock aria-hidden size={16} />
        </span>
      }
      meta={
        <>
          <span>{schedule.actor.name}</span>
          {schedule.enabled && schedule.nextRunAt ? (
            <span title={formatDate(schedule.nextRunAt, true)}>
              Next <RelativeTime value={schedule.nextRunAt} />
            </span>
          ) : null}
          {schedule.lastRunAt ? (
            <span>
              Last <RelativeTime value={schedule.lastRunAt} />
            </span>
          ) : null}
        </>
      }
      onClick={canWrite ? onEdit : undefined}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{schedule.agentName}</span>
          <span className="truncate font-normal text-ink-3">
            {when === schedule.cron ? <span className="font-mono text-[12px]">{when}</span> : when} · {schedule.timezone}
          </span>
          {schedule.enabled ? null : <Badge>Paused</Badge>}
        </span>
      }
    />
  );
}

function ScheduleDialog({
  agents,
  editing,
  onClose,
  projectId,
}: {
  agents: CloudAgent[];
  editing: Editing;
  onClose: () => void;
  projectId: string;
}) {
  const toast = useToast();
  const create = useCreateCloudSchedule(projectId);
  const update = useUpdateCloudSchedule(projectId);
  const current = editing.mode === "edit" ? editing.schedule : null;
  const firstAgent = agents.length === 1 ? agents[0] : undefined;
  const [agentId, setAgentId] = useState(current?.agentId ?? firstAgent?.id ?? "");
  const agent = agents.find((item) => item.id === agentId);
  const [cron, setCron] = useState(current?.cron ?? agent?.config.schedule?.cron ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(current?.timezone ?? agent?.config.schedule?.timezone ?? browserTimezone());
  const [promptMode, setPromptMode] = useState<"heartbeat" | "custom">(current && !current.prompt ? "heartbeat" : current ? "custom" : "heartbeat");
  const [prompt, setPrompt] = useState(current?.prompt ?? "");
  const [budget, setBudget] = useState(current?.budgetUsd ? String(current.budgetUsd) : "");
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const heartbeat = useAgentHeartbeat(agentId || null);
  const noHeartbeat = heartbeat.isSuccess && heartbeat.data === null;
  const mode = noHeartbeat ? "custom" : promptMode;
  const mutation = current ? update : create;
  const preset = SCHEDULE_PRESETS.find((item) => item.cron === cron.trim().split(/\s+/).join(" "));

  const close = () => {
    mutation.reset();
    onClose();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseBudgetInput(budget);
    const next: Record<string, string | null> = {
      agent: agentId ? null : "Pick the agent to run.",
      cron: cron.trim().split(/\s+/).length === 5 ? null : "Five fields: minute, hour, day of month, month, day of week.",
      timezone: timezone.trim() ? null : "A timezone such as America/Sao_Paulo.",
      prompt: mode === "custom" && !prompt.trim() ? "Say what the agent should do on each run." : null,
      budget: parsed.error,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    const input = {
      cron: cron.trim(),
      timezone: timezone.trim(),
      prompt: mode === "custom" ? prompt.trim() : null,
      budgetUsd: parsed.value,
    };
    const onSuccess = () => {
      toast.show(current ? "The schedule is saved." : enabled ? "The schedule is on. Its runs act as you." : "The schedule is saved, paused.");
      close();
    };
    if (current) update.mutate({ id: current.id, ...input }, { onSuccess });
    else create.mutate({ agent: agentId, ...input, enabled }, { onSuccess });
  };

  const formId = "cloud-schedule-form";
  return (
    <Dialog
      className="max-w-xl"
      description="Each run acts as you, with the agent's budget unless you set one here."
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button form={formId} loading={mutation.isPending} type="submit" variant="primary">
            {current ? "Save" : "Add schedule"}
          </Button>
        </>
      }
      onClose={close}
      open
      title={current ? `Edit the ${current.agentName} schedule` : "Add a schedule"}
    >
      <form className="space-y-4" id={formId} noValidate onSubmit={submit}>
        {current ? null : (
          <Field error={errors.agent} label="Agent">
            {(props) => (
              <Select
                {...props}
                onChange={(event) => {
                  const next = agents.find((item) => item.id === event.target.value);
                  setAgentId(event.target.value);
                  if (next?.config.schedule) {
                    setCron(next.config.schedule.cron);
                    setTimezone(next.config.schedule.timezone);
                  }
                }}
                value={agentId}
              >
                <option disabled value="">
                  Choose an agent
                </option>
                {agents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Repeats">
            {(props) => (
              <Select {...props} onChange={(event) => event.target.value && setCron(event.target.value)} value={preset?.cron ?? ""}>
                {SCHEDULE_PRESETS.map((item) => (
                  <option key={item.cron} value={item.cron}>
                    {item.label}
                  </option>
                ))}
                <option value="">Custom</option>
              </Select>
            )}
          </Field>
          <Field error={errors.cron} hint="Minute, hour, day of month, month, day of week." label="Cron">
            {(props) => (
              <Input
                {...props}
                autoCapitalize="none"
                autoCorrect="off"
                className="font-mono text-[13px]"
                onChange={(event) => setCron(event.target.value)}
                spellCheck={false}
                value={cron}
              />
            )}
          </Field>
        </div>

        <Field error={errors.timezone} hint="IANA name, such as America/Sao_Paulo." label="Timezone">
          {(props) => (
            <Input
              {...props}
              autoCapitalize="none"
              autoCorrect="off"
              className="font-mono text-[13px]"
              onChange={(event) => setTimezone(event.target.value)}
              spellCheck={false}
              value={timezone}
            />
          )}
        </Field>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink" id="schedule-prompt-label">
              What each run does
            </span>
            {noHeartbeat ? null : (
              <Segmented
                label="What each run does"
                onChange={setPromptMode}
                options={[
                  { value: "heartbeat", label: "HEARTBEAT.md" },
                  { value: "custom", label: "Custom prompt" },
                ]}
                value={mode}
              />
            )}
          </div>
          {mode === "heartbeat" ? (
            agentId ? (
              heartbeat.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : heartbeat.isError ? (
                <FormMessage>{cloudErrorText(heartbeat.error)}</FormMessage>
              ) : (
                <>
                  <pre
                    aria-labelledby="schedule-prompt-label"
                    className="max-h-48 overflow-auto rounded-md border border-line bg-sunken px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink-2"
                    tabIndex={0}
                  >
                    {heartbeat.data}
                  </pre>
                  <p className="text-[13px] text-ink-3">The agent&apos;s HEARTBEAT.md from its deployed Library version. Change it in the Library and redeploy.</p>
                </>
              )
            ) : (
              <p className="text-[13px] text-ink-3">Pick an agent to see its HEARTBEAT.md.</p>
            )
          ) : (
            <Field
              error={errors.prompt}
              hint={noHeartbeat ? "This agent has no HEARTBEAT.md, so the schedule needs a prompt." : undefined}
              label="Prompt"
            >
              {(props) => (
                <Textarea
                  {...props}
                  maxLength={100_000}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Check yesterday's support tickets and post a summary."
                  value={prompt}
                />
              )}
            </Field>
          )}
        </div>

        <Field
          error={errors.budget}
          hint={agent ? `Leave empty for the agent's ${formatUsd(agent.config.budgetUsd)} per run.` : "Leave empty for the agent's budget."}
          label="Budget per run (US$)"
          optional
        >
          {(props) => <Input {...props} className="w-32" inputMode="decimal" onChange={(event) => setBudget(event.target.value)} value={budget} />}
        </Field>

        {current ? null : (
          <Switch checked={enabled} description="Off saves it paused; turn it on from the list later." label="Start right away" onChange={setEnabled} />
        )}

        {mutation.isError ? <FormMessage>{cloudErrorText(mutation.error)}</FormMessage> : null}
      </form>
    </Dialog>
  );
}

function DeleteDialog({ onClose, projectId, schedule }: { onClose: () => void; projectId: string; schedule: CloudSchedule | null }) {
  const toast = useToast();
  const remove = useDeleteCloudSchedule(projectId);
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      description="No more runs start from it. Runs it already started stay in the list."
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Keep it
          </Button>
          <Button
            loading={remove.isPending}
            onClick={() =>
              schedule &&
              remove.mutate(schedule.id, {
                onSuccess: () => {
                  toast.show("The schedule is deleted.");
                  close();
                },
              })
            }
            variant="danger"
          >
            Delete
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(schedule)}
      title={schedule ? `Delete the ${schedule.agentName} schedule?` : "Delete schedule"}
    >
      {remove.isError ? <FormMessage>{cloudErrorText(remove.error)}</FormMessage> : null}
    </Dialog>
  );
}
